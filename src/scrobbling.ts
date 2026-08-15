import { createHash } from "node:crypto";
import type { Store } from "./store.ts";

const lastFmEndpoint = "https://ws.audioscrobbler.com/2.0/";
const listenBrainzEndpoint = "https://api.listenbrainz.org/1";

export type ScrobbleTrack = {
  id: string;
  requesterId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  automatic?: boolean;
};

class LastFmError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class ListenBrainzError extends Error {
  constructor(readonly status: number) {
    super(`ListenBrainz HTTP ${status}`);
  }
}

export class ScrobbleDispatcher {
  private flushing = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private store: Store,
    private config: { lastFmApiKey?: string; lastFmSharedSecret?: string },
    private request: typeof fetch = fetch,
  ) {}

  start() {
    void this.flush();
    this.timer = setInterval(() => void this.flush(), 60_000);
  }

  async stop() {
    clearInterval(this.timer);
    await this.flushing;
  }

  playback(sessionId: string, botUserId: string) {
    return new PlaybackScrobbler(this, sessionId, botUserId);
  }

  settings(userId: string) {
    const value = this.store.getUserScrobbling(userId);
    return {
      lastFmAvailable: Boolean(
        this.config.lastFmApiKey && this.config.lastFmSharedSecret,
      ),
      lastFmConnected: Boolean(value.lastFmSessionKey),
      lastFmUsername: value.lastFmUsername,
      lastFmEnabled: value.lastFmEnabled,
      listenBrainzConnected: Boolean(value.listenBrainzToken),
      listenBrainzUsername: value.listenBrainzUsername,
      listenBrainzEnabled: value.listenBrainzEnabled,
    };
  }

  async beginLastFm(userId: string) {
    const token = String((await this.lastFm("auth.getToken")).token ?? "");
    if (!token) throw new Error("Last.fm returned no authentication token");
    this.store.setLastFmPending(userId, token, Date.now());
    return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(this.config.lastFmApiKey!)}&token=${encodeURIComponent(token)}`;
  }

  async finishLastFm(userId: string) {
    const pending = this.store.getUserScrobbling(userId);
    if (
      !pending.lastFmPendingToken ||
      !pending.lastFmPendingAt ||
      Date.now() - pending.lastFmPendingAt > 60 * 60_000
    )
      throw new Error("Last.fm login expired; start again");
    const result = await this.lastFm("auth.getSession", {
      token: pending.lastFmPendingToken,
    });
    const session = result.session as
      { key?: string; name?: string } | undefined;
    if (!session?.key || !session.name)
      throw new Error("Last.fm returned no session");
    this.store.connectLastFm(userId, session.name, session.key);
    return session.name;
  }

  disconnectLastFm(userId: string) {
    this.store.disconnectLastFm(userId);
    this.store.clearPendingScrobbles(userId, "lastfm");
  }

  setLastFmEnabled(userId: string, enabled: boolean) {
    const settings = this.store.getUserScrobbling(userId);
    if (enabled && !settings.lastFmSessionKey)
      throw new Error("Connect Last.fm before enabling scrobbling");
    this.store.setLastFmEnabled(userId, enabled);
    if (!enabled) this.store.clearPendingScrobbles(userId, "lastfm");
  }

  async setListenBrainz(
    userId: string,
    token: string | undefined,
    enabled: boolean,
  ) {
    const current = this.store.getUserScrobbling(userId);
    let username = current.listenBrainzUsername;
    if (token) {
      const response = await this.request(
        `${listenBrainzEndpoint}/validate-token`,
        {
          headers: { authorization: `Token ${token}` },
        },
      );
      const result = (await response.json()) as {
        valid?: boolean;
        user_name?: string;
      };
      if (!response.ok || !result.valid || !result.user_name)
        throw new Error("That ListenBrainz user token is invalid");
      username = result.user_name;
      this.store.setListenBrainzToken(userId, token, username);
    }
    if (enabled && !(token || current.listenBrainzToken))
      throw new Error(
        "Enter a ListenBrainz user token before enabling scrobbling",
      );
    this.store.setListenBrainzEnabled(userId, enabled);
    if (!enabled) this.store.clearPendingScrobbles(userId, "listenbrainz");
    return username;
  }

  nowPlaying(userIds: Iterable<string>, track: ScrobbleTrack) {
    for (const userId of userIds)
      void this.sendNowPlaying(userId, track).catch((error) =>
        console.error(
          `[scrobbling] now playing failed for ${userId}: ${safeError(error)}`,
        ),
      );
  }

  reached(
    sessionId: string,
    userId: string,
    track: ScrobbleTrack,
    listenedAt: number,
    listenedSeconds: number,
  ) {
    const settings = this.store.getUserScrobbling(userId);
    const threshold = track.duration ? Math.min(track.duration / 2, 240) : 240;
    if (listenedSeconds < threshold) return;
    if (
      settings.lastFmEnabled &&
      settings.lastFmSessionKey &&
      (track.duration === undefined || track.duration > 30)
    )
      this.store.queueScrobble(
        sessionId,
        track.id,
        userId,
        "lastfm",
        listenedAt,
        track,
      );
    if (settings.listenBrainzEnabled && settings.listenBrainzToken)
      this.store.queueScrobble(
        sessionId,
        track.id,
        userId,
        "listenbrainz",
        listenedAt,
        track,
      );
    void this.flush();
  }

  flush() {
    const next = this.flushing.then(
      () => this.flushPending(),
      () => this.flushPending(),
    );
    this.flushing = next.catch(() => undefined);
    return next;
  }

  private async sendNowPlaying(userId: string, track: ScrobbleTrack) {
    const settings = this.store.getUserScrobbling(userId);
    const errors: unknown[] = [];
    if (settings.lastFmEnabled && settings.lastFmSessionKey)
      try {
        await this.lastFm(
          "track.updateNowPlaying",
          trackParams(track, settings.lastFmSessionKey),
        );
      } catch (error) {
        if (error instanceof LastFmError && error.code === 9)
          this.disconnectLastFm(userId);
        errors.push(error);
      }
    if (settings.listenBrainzEnabled && settings.listenBrainzToken)
      try {
        await this.listenBrainz(
          settings.listenBrainzToken,
          "playing_now",
          track,
        );
      } catch (error) {
        if (error instanceof ListenBrainzError && error.status === 401)
          this.setListenBrainz(userId, undefined, false);
        errors.push(error);
      }
    if (errors.length) throw errors[0];
  }

  private async flushPending() {
    for (const item of this.store.pendingScrobbles(Date.now())) {
      const settings = this.store.getUserScrobbling(item.userId);
      try {
        if (item.service === "lastfm") {
          if (!settings.lastFmEnabled || !settings.lastFmSessionKey) continue;
          const result = await this.lastFm("track.scrobble", {
            ...trackParams(item.track, settings.lastFmSessionKey),
            timestamp: String(item.listenedAt),
            ...(item.track.automatic ? { chosenByUser: "0" } : {}),
          });
          const scrobbles = result.scrobbles as
            { "@attr"?: { ignored?: number | string } } | undefined;
          if (Number(scrobbles?.["@attr"]?.ignored))
            throw new LastFmError(0, "Last.fm ignored the scrobble");
        } else {
          if (!settings.listenBrainzEnabled || !settings.listenBrainzToken)
            continue;
          await this.listenBrainz(
            settings.listenBrainzToken,
            "single",
            item.track,
            item.listenedAt,
          );
        }
        this.store.finishScrobble(item.id, "sent");
      } catch (error) {
        if (error instanceof LastFmError && error.code === 9) {
          this.disconnectLastFm(item.userId);
          continue;
        }
        if (error instanceof ListenBrainzError && error.status === 401) {
          await this.setListenBrainz(item.userId, undefined, false);
          continue;
        }
        const retry =
          error instanceof LastFmError
            ? error.code === 11 || error.code === 16 || error.code === 29
            : !(error instanceof ListenBrainzError) ||
              error.status === 429 ||
              error.status >= 500;
        if (retry)
          this.store.retryScrobble(
            item.id,
            item.attempts + 1,
            Date.now() + Math.min(3_600_000, 30_000 * 2 ** item.attempts),
          );
        else this.store.finishScrobble(item.id, "failed");
        console.error(
          `[scrobbling] ${item.service} submission failed for ${item.userId}: ${safeError(error)}`,
        );
        if (retry) break;
      }
    }
  }

  private async lastFm(method: string, params: Record<string, string> = {}) {
    if (!this.config.lastFmApiKey || !this.config.lastFmSharedSecret)
      throw new Error("Last.fm is not configured");
    const signed = { api_key: this.config.lastFmApiKey, method, ...params };
    const signature =
      Object.entries(signed)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => key + value)
        .join("") + this.config.lastFmSharedSecret;
    const response = await this.request(lastFmEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        ...signed,
        api_sig: createHash("md5").update(signature, "utf8").digest("hex"),
        format: "json",
      }),
    });
    const result = (await response.json()) as Record<string, unknown> & {
      error?: number;
      message?: string;
    };
    if (!response.ok || result.error)
      throw new LastFmError(
        result.error ?? response.status,
        result.message ?? `HTTP ${response.status}`,
      );
    return result;
  }

  private async listenBrainz(
    token: string,
    listenType: "single" | "playing_now",
    track: ScrobbleTrack,
    listenedAt?: number,
  ) {
    const response = await this.request(
      `${listenBrainzEndpoint}/submit-listens`,
      {
        method: "POST",
        headers: {
          authorization: `Token ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          listen_type: listenType,
          payload: [
            {
              ...(listenedAt === undefined ? {} : { listened_at: listenedAt }),
              track_metadata: {
                artist_name: track.artist,
                track_name: track.title,
                ...(track.album ? { release_name: track.album } : {}),
                additional_info: {
                  submission_client: "HuddleFM",
                  ...(track.duration
                    ? { duration_ms: track.duration * 1000 }
                    : {}),
                },
              },
            },
          ],
        }),
      },
    );
    if (!response.ok) throw new ListenBrainzError(response.status);
  }
}

export class PlaybackScrobbler {
  private current?: {
    track: ScrobbleTrack;
    playing: boolean;
    lastPosition: number;
    listeners: Map<
      string,
      { listenedAt: number; seconds: number; active: boolean }
    >;
  };

  constructor(
    private dispatcher: ScrobbleDispatcher,
    private sessionId: string,
    private botUserId: string,
  ) {}

  start(
    track: ScrobbleTrack,
    userIds: Iterable<string>,
    playing = true,
    position = 0,
  ) {
    const listeners = new Map<
      string,
      { listenedAt: number; seconds: number; active: boolean }
    >();
    for (const userId of userIds)
      if (userId !== this.botUserId)
        listeners.set(userId, {
          listenedAt: Math.floor(Date.now() / 1000),
          seconds: 0,
          active: true,
        });
    this.current = { track, playing, lastPosition: position, listeners };
    if (playing) this.dispatcher.nowPlaying(listeners.keys(), track);
  }

  memberJoined(userId: string) {
    if (!this.current || userId === this.botUserId) return;
    const existing = this.current.listeners.get(userId);
    if (existing?.active) return;
    if (existing) existing.active = true;
    else
      this.current.listeners.set(userId, {
        listenedAt: Math.floor(Date.now() / 1000),
        seconds: 0,
        active: true,
      });
    if (this.current.playing)
      this.dispatcher.nowPlaying([userId], this.current.track);
  }

  memberLeft(userId: string) {
    const listener = this.current?.listeners.get(userId);
    if (listener) listener.active = false;
  }

  pause() {
    if (this.current) this.current.playing = false;
  }

  resume() {
    if (!this.current) return;
    this.current.playing = true;
    this.dispatcher.nowPlaying(
      this.current.listeners.keys(),
      this.current.track,
    );
  }

  settingsEnabled(userId: string) {
    if (this.current?.playing)
      this.dispatcher.nowPlaying([userId], this.current.track);
  }

  position(seconds: number) {
    if (!this.current) return;
    const delta = seconds - this.current.lastPosition;
    this.current.lastPosition = seconds;
    if (!this.current.playing || delta < 0 || delta > 5) return;
    for (const [userId, listener] of this.current.listeners) {
      if (!listener.active) continue;
      listener.seconds += delta;
      this.dispatcher.reached(
        this.sessionId,
        userId,
        this.current.track,
        listener.listenedAt,
        listener.seconds,
      );
    }
  }

  finish() {
    this.current = undefined;
  }
}

function trackParams(track: ScrobbleTrack, sessionKey: string) {
  return {
    artist: track.artist,
    track: track.title,
    ...(track.album ? { album: track.album } : {}),
    ...(track.duration ? { duration: String(Math.round(track.duration)) } : {}),
    sk: sessionKey,
  };
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /(token|authorization|sk)[^\s,]*/gi,
    "$1[redacted]",
  );
}
