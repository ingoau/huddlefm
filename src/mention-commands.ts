import type { Coordinator } from "./coordinator.ts";
import { logger } from "./logger.ts";
import type { LoopMode, MediaMode } from "./store.ts";

const log = logger.child({ component: "mention-commands" });

// Mentions are read as commands first: a message that is exactly one of these
// phrases runs straight away, with no AI call. Anything else goes to the agent,
// which is there for what these can't say, like adding several songs.

export type MentionCommand =
  | { type: "help" }
  | { type: "end" }
  | { type: "skip" }
  | { type: "previous" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "shuffle" }
  | { type: "clear" }
  | { type: "volume"; change: number }
  | { type: "volume"; percent: number }
  | { type: "seek"; seconds: number }
  | { type: "loop"; mode: LoopMode }
  | { type: "autoplay"; on: boolean }
  | { type: "mode"; mode: MediaMode }
  | { type: "captions"; on: boolean }
  | { type: "now-playing" }
  | { type: "queue" }
  | { type: "host" }
  | { type: "add"; url: string };

/** How far `volume up` and `volume down` move it, in percent. */
export const volumeStep = 10;
/** How far `forward` and `rewind` move without a number, in seconds. */
export const seekStep = 10;

const fixed: Record<string, MentionCommand> = {};
const phrase = (command: MentionCommand, ...phrases: string[]) => {
  for (const text of phrases) fixed[text] = command;
};
phrase({ type: "help" }, "help", "commands", "what can you do");
phrase(
  { type: "end" },
  "end",
  "end session",
  "end the session",
  "stop session",
  "stop the session",
  "leave",
  "leave huddle",
  "leave the huddle",
  "disconnect",
);
phrase(
  { type: "skip" },
  "skip",
  "next",
  "skip song",
  "skip track",
  "skip this",
  "skip this song",
  "skip it",
  "next song",
  "next track",
);
phrase(
  { type: "previous" },
  "previous",
  "prev",
  "back",
  "go back",
  "previous song",
  "previous track",
);
phrase(
  { type: "pause" },
  "pause",
  "pause music",
  "pause the music",
  "pause playback",
  "stop",
  "stop music",
  "stop the music",
);
phrase(
  { type: "resume" },
  "resume",
  "play",
  "unpause",
  "continue",
  "resume music",
  "resume playback",
  "play music",
);
phrase({ type: "shuffle" }, "shuffle", "shuffle queue", "shuffle the queue");
phrase({ type: "clear" }, "clear", "clear queue", "clear the queue");
phrase(
  { type: "volume", change: volumeStep },
  "volume up",
  "vol up",
  "louder",
  "turn it up",
  "turn up",
  "turn up the volume",
  "turn the volume up",
);
phrase(
  { type: "volume", change: -volumeStep },
  "volume down",
  "vol down",
  "quieter",
  "softer",
  "turn it down",
  "turn down",
  "turn down the volume",
  "turn the volume down",
);
phrase(
  { type: "loop", mode: "track" },
  "loop",
  "loop song",
  "loop track",
  "loop this",
  "loop this song",
  "repeat",
  "repeat song",
  "repeat track",
  "repeat this",
);
phrase({ type: "loop", mode: "queue" }, "loop queue", "repeat queue");
phrase(
  { type: "loop", mode: "off" },
  "loop off",
  "repeat off",
  "unloop",
  "stop looping",
  "stop repeating",
  "no loop",
);
phrase({ type: "autoplay", on: true }, "autoplay", "autoplay on");
phrase({ type: "autoplay", on: false }, "autoplay off", "no autoplay");
phrase({ type: "mode", mode: "video" }, "video mode", "watch mode");
phrase({ type: "mode", mode: "music" }, "music mode");
phrase({ type: "captions", on: true }, "captions", "captions on", "subtitles");
phrase({ type: "captions", on: false }, "captions off", "subtitles off");
phrase(
  { type: "now-playing" },
  "now playing",
  "np",
  "whats playing",
  "what is playing",
  "whats this song",
  "what song is this",
  "status",
);
phrase(
  { type: "queue" },
  "queue",
  "show queue",
  "show the queue",
  "whats next",
  "up next",
);
phrase(
  { type: "host" },
  "take host",
  "claim host",
  "make me host",
  "make me the host",
  "take over",
);

/** Lowercase, without the punctuation and politeness around a command. */
export function normalizeCommand(text: string) {
  let normalized = text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[.!?,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  normalized = normalized.replace(/^please /, "").replace(/ please$/, "");
  return normalized;
}

// A Slack link, as `<url>` or `<url|label>`, or a bare URL. Only a link on its
// own: "add <link> and <song>" is the agent's.
const linkPattern = /^<?(https?:\/\/[^\s|>]+)(?:\|[^>]*)?>?$/i;

// Typos in these could do something that can't be undone, so they have to be
// typed exactly; a near miss goes to the agent instead.
const exactOnly = new Set<MentionCommand["type"]>(["end", "clear", "host"]);

/**
 * How many typos a word of this length may have. Short words have to be exact:
 * a typo there turns on into no, up into dn, or skip into stop.
 */
function typosAllowed(length: number) {
  if (length >= 10) return 2;
  if (length >= 5) return 1;
  return 0;
}

/**
 * Edits between `a` and `b`, counting a swap of two neighbours as one
 * (optimal string alignment), or `limit + 1` once it's over `limit`.
 */
export function typoDistance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows = [...Array(a.length + 1)].map((_, i) =>
    [...Array(b.length + 1)].map((_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
  }
  return Math.min(rows[a.length]![b.length]!, limit + 1);
}

/**
 * Typos between `text` and `phrase`, counted word by word, or undefined when
 * a word is further off than it may be. Words are never joined, split or
 * swapped. Exact-only phrases allow a typo in any word, so that a near miss of
 * one is seen as one.
 */
function phraseTypos(text: string[], phrase: string[], strict: boolean) {
  if (text.length !== phrase.length) return undefined;
  let total = 0;
  for (const [index, word] of phrase.entries()) {
    const limit = strict
      ? Math.max(1, typosAllowed(word.length))
      : typosAllowed(word.length);
    const distance = typoDistance(text[index]!, word, limit);
    if (distance > limit) return undefined;
    total += distance;
  }
  return total;
}

/**
 * The phrase `text` is a typo of, when there's exactly one command it could
 * be. Anything as close to an exact-only phrase, or to two different
 * commands, is left to the agent.
 */
function closestPhrase(text: string) {
  const words = text.split(" ");
  let best: { distance: number; phrases: string[] } | undefined;
  for (const candidate of Object.keys(fixed)) {
    const distance = phraseTypos(
      words,
      candidate.split(" "),
      exactOnly.has(fixed[candidate]!.type),
    );
    if (distance === undefined) continue;
    if (!best || distance < best.distance) best = { distance, phrases: [] };
    if (distance === best.distance) best.phrases.push(candidate);
  }
  if (!best) return undefined;
  const commands = new Set(
    best.phrases.map((candidate) => JSON.stringify(fixed[candidate])),
  );
  if (commands.size !== 1) return undefined;
  const [match] = best.phrases;
  if (exactOnly.has(fixed[match!]!.type)) return undefined;
  return match;
}

export type ParsedMentionCommand = MentionCommand & {
  /** The phrase a typo was read as. */
  readAs?: string;
};

/** The command `text` says, or undefined to ask the agent. */
export function parseMentionCommand(
  text: string,
): ParsedMentionCommand | undefined {
  const trimmed = text.trim();
  const link = linkPattern.exec(trimmed)?.[1];
  // Slack escapes &, < and > in the text it sends.
  if (link)
    return {
      type: "add",
      url: link
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    };

  const normalized = normalizeCommand(trimmed);
  const known = fixed[normalized];
  if (known) return known;

  const volume =
    /^(?:set )?(?:the )?(?:volume|vol)(?: to)? (\d{1,3}) ?%?$/.exec(
      normalized,
    )?.[1];
  if (volume !== undefined) {
    const percent = Number(volume);
    if (percent <= 100) return { type: "volume", percent };
  }

  const seek =
    /^(forward|fast forward|ff|skip ahead|rewind|back)(?: (\d{1,4}) ?(s|sec|secs|seconds?)?)?$/.exec(
      normalized,
    );
  // `back` alone is the previous song, matched above.
  if (seek && (seek[1] !== "back" || seek[2])) {
    const seconds = seek[2] ? Number(seek[2]) : seekStep;
    const backwards = seek[1] === "rewind" || seek[1] === "back";
    return { type: "seek", seconds: backwards ? -seconds : seconds };
  }

  const typo = closestPhrase(normalized);
  return typo ? { ...fixed[typo]!, readAs: typo } : undefined;
}

type Outcome = { ok: boolean; text: string };

const failure = (result: { ok: false; error?: unknown }): Outcome => ({
  ok: false,
  text:
    typeof result.error === "string" && result.error
      ? result.error
      : "I couldn't do that. Try again in a moment.",
});

const describe = (track: { title: string; artist?: string }) =>
  track.artist ? `*${track.title}* by ${track.artist}` : `*${track.title}*`;

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

export const commandHelp = [
  "Mention me with one of these and it happens straight away:",
  "• `skip`, `previous`, `pause`, `resume`",
  "• `volume up`, `volume down`, `volume 40`",
  "• `forward`, `rewind`, `forward 30`",
  "• `shuffle`, `clear queue`, `queue`, `now playing`",
  "• `loop`, `loop queue`, `loop off`, `autoplay on`, `autoplay off`",
  "• `video mode`, `music mode`, `captions on`, `captions off`",
  "• `take host`, `end session`",
  "• a link on its own to add it to the queue",
  "Mention me with nothing else to bring the player to the bottom.",
].join("\n");

/** Run a parsed command as `userId`, with the same access as the buttons. */
export async function runMentionCommand(
  coordinator: Coordinator,
  userId: string,
  command: ParsedMentionCommand,
  options: { agentAvailable?: boolean } = {},
): Promise<Outcome> {
  let outcome: Outcome;
  try {
    // Permissions are checked from a cache, so make sure this user's roles,
    // like a channel manager's, are in it first.
    await coordinator.primeManager(userId);
    outcome = await runCommand(coordinator, userId, command, options);
  } catch (error) {
    log.warn(
      {
        event: "mention_command_failed",
        userId,
        type: command.type,
        err: error,
      },
      "Mention command failed",
    );
    return { ok: false, text: "I couldn't do that. Try again in a moment." };
  }
  // Say what a typo was taken for, so a wrong guess is plain to see.
  return command.readAs
    ? { ...outcome, text: `${outcome.text} (Read as \`${command.readAs}\`.)` }
    : outcome;
}

async function runCommand(
  coordinator: Coordinator,
  userId: string,
  command: MentionCommand,
  options: { agentAvailable?: boolean },
): Promise<Outcome> {
  switch (command.type) {
    case "help":
      return {
        ok: true,
        text: options.agentAvailable
          ? `${commandHelp}\nFor anything else, like adding several songs, just ask in your own words.`
          : commandHelp,
      };
    case "end": {
      const result = await coordinator.agentEnd(userId);
      return result.ok
        ? { ok: true, text: "Ended the session." }
        : failure(result);
    }
    case "skip": {
      const result = await coordinator.agentSkip(userId);
      if (!result.ok) return failure(result);
      return {
        ok: true,
        text: result.nowPlaying
          ? `Skipped. Now playing ${describe(result.nowPlaying)}.`
          : "Skipped.",
      };
    }
    case "previous": {
      const result = await coordinator.agentPrevious(userId);
      if (!result.ok) return failure(result);
      if (result.nowPlaying)
        return {
          ok: true,
          text: `Now playing ${describe(result.nowPlaying)}.`,
        };
      return {
        ok: true,
        text: result.title ? `Restarted ${describe(result)}.` : "Restarted.",
      };
    }
    case "pause": {
      const result = await coordinator.agentPause(userId);
      return result.ok ? { ok: true, text: "Paused." } : failure(result);
    }
    case "resume": {
      const result = await coordinator.agentResume(userId);
      return result.ok ? { ok: true, text: "Playing." } : failure(result);
    }
    case "shuffle": {
      const result = await coordinator.agentShuffle(userId);
      return result.ok
        ? { ok: true, text: "Shuffled the queue." }
        : failure(result);
    }
    case "clear": {
      const result = await coordinator.agentClear(userId);
      return result.ok
        ? { ok: true, text: "Cleared the queue." }
        : failure(result);
    }
    case "volume": {
      const result =
        "percent" in command
          ? await coordinator.agentSetVolume(userId, command.percent)
          : await coordinator.agentChangeVolume(userId, command.change);
      return result.ok
        ? { ok: true, text: `Volume ${result.volumePercent}%.` }
        : failure(result);
    }
    case "seek": {
      const result = await coordinator.agentSeek(userId, command.seconds);
      return result.ok
        ? { ok: true, text: `At ${clock(result.playbackSeconds)}.` }
        : failure(result);
    }
    case "loop": {
      const result = await coordinator.agentUpdateSettings(userId, {
        loopMode: command.mode,
      });
      if (!result.ok) return failure(result);
      return {
        ok: true,
        text:
          command.mode === "off"
            ? "Loop is off."
            : command.mode === "track"
              ? "Looping this song."
              : "Looping the queue.",
      };
    }
    case "autoplay": {
      const result = await coordinator.agentUpdateSettings(userId, {
        autoplay: command.on,
      });
      return result.ok
        ? {
            ok: true,
            text: command.on ? "Autoplay is on." : "Autoplay is off.",
          }
        : failure(result);
    }
    case "mode": {
      const result = await coordinator.agentUpdateSettings(userId, {
        mode: command.mode,
      });
      return result.ok
        ? {
            ok: true,
            text:
              command.mode === "video"
                ? "Video mode is on."
                : "Music mode is on.",
          }
        : failure(result);
    }
    case "captions": {
      const result = await coordinator.agentSetCaptions(userId, command.on);
      if (!result.ok) return failure(result);
      const note = "note" in result && result.note ? ` ${result.note}` : "";
      return {
        ok: true,
        text: `${command.on ? "Captions are on." : "Captions are off."}${note}`,
      };
    }
    case "now-playing": {
      const status = coordinator.agentStatus(userId);
      if (!status.ok) return failure(status);
      const current = status.nowPlaying;
      if (!current) return { ok: true, text: "Nothing is playing." };
      const at = current.live
        ? " (live)"
        : current.durationSeconds
          ? ` (${clock(status.playbackSeconds)} / ${clock(current.durationSeconds)})`
          : "";
      const paused = status.state === "paused" ? " Paused." : "";
      return {
        ok: true,
        text: `Now playing ${describe(current)}${at}.${paused}`,
      };
    }
    case "queue": {
      const status = coordinator.agentStatus(userId);
      if (!status.ok) return failure(status);
      if (!status.queue.length)
        return { ok: true, text: "The queue is empty." };
      const shown = status.queue.slice(0, 10);
      const more = status.queue.length - shown.length;
      return {
        ok: true,
        text: [
          "Up next:",
          ...shown.map((track) => `${track.position}. ${describe(track)}`),
          ...(more > 0 ? [`and ${more} more`] : []),
        ].join("\n"),
      };
    }
    case "host": {
      const result = await coordinator.agentClaimHost(userId);
      return result.ok
        ? { ok: true, text: "You're the host." }
        : failure(result);
    }
    case "add": {
      const result = await coordinator.agentAdd(
        userId,
        command.url,
        undefined,
        {
          awaitPreparation: false,
        },
      );
      if (!result.ok) return failure(result);
      const [first] = result.added;
      return {
        ok: true,
        text:
          result.added.length === 1 && first
            ? `Added ${describe(first)}.`
            : `Added ${result.added.length} tracks.`,
      };
    }
  }
}
