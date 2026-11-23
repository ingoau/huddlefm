// HuddleFM's song in the system's media controls, and the media keys working
// the player, through the browser's Media Session API. The browser sends
// media keys only to a page playing a media element, and a huddle's sound
// isn't one, so a silent one plays alongside HuddleFM, in the window the
// huddle was last shown in.

import type { HuddleFMClient, Result, Track } from "./protocol.ts";

/** How long the silent sound is: a browser leaves out ones under 5 seconds. */
const SILENCE_SECONDS = 10;
const SILENCE_RATE = 3000;

/** Silence, as an 8-bit mono WAV file. */
function silence() {
  const samples = SILENCE_RATE * SILENCE_SECONDS;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(at + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENCE_RATE, true);
  view.setUint32(28, SILENCE_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  // 8-bit samples are silent at their middle
  new Uint8Array(buffer, 44).fill(128);
  return buffer;
}

const handled = [
  "play",
  "pause",
  "nexttrack",
  "previoustrack",
  "seekto",
] as const;

export class MediaKeys {
  /** the windows the huddle may play in, the one it was last shown in last */
  private windows = new Set<Window>();
  /** the song each window shows, so it's only set again for a new one */
  private shown = new WeakMap<Window, string>();
  /** the names of who added songs, looked up once each */
  private names = new Map<string, string | undefined>();
  private players = new WeakMap<Window, HTMLAudioElement>();
  /** takes back the listeners added to each window */
  private listening = new Map<Window, AbortController>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private client: HuddleFMClient,
    /** shows what a refused key press was told */
    private report: (result: Result) => void,
    /** the name to show for a Slack user */
    private userName: (userId: string) => Promise<string | undefined>,
  ) {}

  start() {
    this.unsubscribe ??= this.client.state.subscribe(() => this.update());
    this.update();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const win of this.windows) {
      this.clear(win);
      this.silence(win, "remove");
    }
    this.windows.clear();
    for (const controller of this.listening.values()) controller.abort();
    this.listening.clear();
  }

  /** A window the huddle is shown in now. */
  add(win: Window) {
    const known = this.windows.delete(win);
    this.windows.add(win);
    if (!known) {
      const controller = new AbortController();
      this.listening.set(win, controller);
      const { signal } = controller;
      win.addEventListener(
        "pagehide",
        () => {
          this.windows.delete(win);
          this.listening.get(win)?.abort();
          this.listening.delete(win);
          this.update();
        },
        { once: true, signal },
      );
      // a window that couldn't play before it was used can once it is
      for (const event of ["pointerdown", "keydown"])
        win.addEventListener(event, () => this.update(), {
          capture: true,
          signal,
        });
    }
    this.update();
  }

  private update() {
    const state = this.client.state.get();
    const track = state?.nowPlaying;
    const playing = state?.session.state === "playing";
    const last = [...this.windows].at(-1);
    for (const win of this.windows) {
      const session = win.navigator?.mediaSession;
      if (!session) continue;
      // only the window the browser sends the keys to: elsewhere, what
      // else plays there keeps its own keys
      if (!state || !track || win !== last) {
        this.clear(win);
        this.silence(win, "remove");
        continue;
      }
      this.silence(win, playing ? "play" : "pause");
      const album = this.album(track);
      const shown = `${track.id}\n${album}`;
      if (this.shown.get(win) !== shown) {
        this.shown.set(win, shown);
        // the window's own, as it's from the window it describes
        const { MediaMetadata } = win as unknown as typeof globalThis;
        session.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist ?? "",
          album,
          artwork: track.artwork
            ? [{ src: track.artwork, sizes: "512x512" }]
            : [],
        });
        this.handle(session);
      }
      session.playbackState =
        state.session.state === "playing" ? "playing" : "paused";
      try {
        if (track.duration && !track.live)
          session.setPositionState({
            duration: track.duration,
            position: Math.min(track.duration, this.client.position()),
            playbackRate: 1,
          });
        else session.setPositionState();
      } catch {}
    }
  }

  /**
   * The album line, which the system shows after the artist: a song with no
   * album says who added it instead, rather than leave a dash after the
   * artist with nothing after it.
   */
  private album(track: Track) {
    if (track.album) return track.album;
    if (track.automatic) return "Autoplay";
    const userId = track.addedBy;
    if (!userId) return "";
    if (!this.names.has(userId)) {
      this.names.set(userId, undefined);
      this.userName(userId)
        .then((name) => {
          if (!name || !this.unsubscribe) return;
          this.names.set(userId, name);
          this.update();
        })
        .catch(() => {});
    }
    const name = this.names.get(userId);
    return name ? `Added by ${name}` : "";
  }

  private handle(session: MediaSession) {
    const run = (command: { type: string; [key: string]: unknown }) =>
      this.client.command(command).then(this.report);
    const actions: Record<
      (typeof handled)[number],
      (details: MediaSessionActionDetails) => void
    > = {
      play: () => run({ type: "resume" }),
      pause: () => run({ type: "pause" }),
      nexttrack: () => run({ type: "skip" }),
      previoustrack: () => run({ type: "previous" }),
      seekto: (details) => {
        // a held key seeks again and again; only where it stops is sent
        if (details.seekTime !== undefined && !details.fastSeek)
          this.client.seek(details.seekTime).then(this.report);
      },
    };
    for (const action of handled)
      try {
        session.setActionHandler(action, actions[action]);
      } catch {}
  }

  /** The silent sound that has the browser send media keys to the window. */
  private silence(win: Window, want: "play" | "pause" | "remove") {
    let player = this.players.get(win);
    if (want === "remove") {
      if (!player) return;
      player.pause();
      player.remove();
      (win as unknown as typeof globalThis).URL.revokeObjectURL(player.src);
      this.players.delete(win);
      return;
    }
    if (!player) {
      const { Blob, URL: WindowURL } = win as unknown as typeof globalThis;
      player = win.document.createElement("audio");
      player.loop = true;
      player.src = WindowURL.createObjectURL(
        new Blob([silence()], { type: "audio/wav" }),
      );
      player.hidden = true;
      win.document.body.append(player);
      this.players.set(win, player);
    }
    if (want === "play" && player.paused)
      // a window that hasn't been clicked in can't play yet; the next
      // change tries again
      player.play().catch(() => {});
    else if (want === "pause" && !player.paused) player.pause();
  }

  /** Leaves the window's media controls to whatever else plays in it. */
  private clear(win: Window) {
    const session = win.navigator?.mediaSession;
    if (!session || !this.shown.has(win)) return;
    this.shown.delete(win);
    session.metadata = null;
    session.playbackState = "none";
    for (const action of handled)
      try {
        session.setActionHandler(action, null);
      } catch {}
  }
}
