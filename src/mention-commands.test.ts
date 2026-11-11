import { expect, test } from "bun:test";
import type { Coordinator } from "./coordinator.ts";
import {
  parseMentionCommand,
  runMentionCommand,
  seekStep,
  typoDistance,
  volumeStep,
} from "./mention-commands.ts";

test("fixed phrases are commands, whatever the case and punctuation", () => {
  expect(parseMentionCommand("end session")).toEqual({ type: "end" });
  expect(parseMentionCommand("End the session!")).toEqual({ type: "end" });
  expect(parseMentionCommand("please skip")).toEqual({ type: "skip" });
  expect(parseMentionCommand("Volume up")).toEqual({
    type: "volume",
    change: volumeStep,
  });
  expect(parseMentionCommand("turn it down please")).toEqual({
    type: "volume",
    change: -volumeStep,
  });
  expect(parseMentionCommand("what’s playing?")).toEqual({
    type: "now-playing",
  });
  expect(parseMentionCommand("back")).toEqual({ type: "previous" });
  expect(parseMentionCommand("loop off")).toEqual({
    type: "loop",
    mode: "off",
  });
});

test("anything else goes to the agent", () => {
  expect(
    parseMentionCommand("Can you please end the session?"),
  ).toBeUndefined();
  expect(parseMentionCommand("add 3 songs by Radiohead")).toBeUndefined();
  expect(parseMentionCommand("play something chill")).toBeUndefined();
  expect(parseMentionCommand("skip the next two songs")).toBeUndefined();
  expect(parseMentionCommand("volume 150")).toBeUndefined();
  expect(parseMentionCommand("")).toBeUndefined();
});

test("volume and seek take a number", () => {
  expect(parseMentionCommand("volume 40")).toEqual({
    type: "volume",
    percent: 40,
  });
  expect(parseMentionCommand("set volume to 25%")).toEqual({
    type: "volume",
    percent: 25,
  });
  expect(parseMentionCommand("forward")).toEqual({
    type: "seek",
    seconds: seekStep,
  });
  expect(parseMentionCommand("rewind 30s")).toEqual({
    type: "seek",
    seconds: -30,
  });
  expect(parseMentionCommand("back 15")).toEqual({
    type: "seek",
    seconds: -15,
  });
});

test("only a link on its own is added; anything around it is the agent's", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  expect(parseMentionCommand(`<${url}>`)).toEqual({ type: "add", url });
  expect(parseMentionCommand(`<${url}|youtube.com/watch>`)).toEqual({
    type: "add",
    url,
  });
  expect(parseMentionCommand(url)).toEqual({ type: "add", url });
  expect(parseMentionCommand(`add <${url}>`)).toBeUndefined();
  expect(parseMentionCommand(`play ${url}`)).toBeUndefined();
  expect(parseMentionCommand(`add <${url}> and Creep`)).toBeUndefined();
});

test("typoDistance counts edits, with a swap as one", () => {
  expect(typoDistance("skip", "skip", 2)).toBe(0);
  expect(typoDistance("skpi", "skip", 2)).toBe(1);
  expect(typoDistance("volme up", "volume up", 2)).toBe(1);
  expect(typoDistance("shufle", "shuffle", 2)).toBe(1);
  expect(typoDistance("abc", "xyz", 1)).toBe(2);
  expect(typoDistance("a", "abcdef", 2)).toBe(3);
});

test("small typos in safe commands are read as the command", () => {
  expect(parseMentionCommand("shufle")).toEqual({
    type: "shuffle",
    readAs: "shuffle",
  });
  expect(parseMentionCommand("volme up")).toEqual({
    type: "volume",
    change: volumeStep,
    readAs: "volume up",
  });
  expect(parseMentionCommand("puase")).toEqual({
    type: "pause",
    readAs: "pause",
  });
  expect(parseMentionCommand("now plaing")).toEqual({
    type: "now-playing",
    readAs: "now playing",
  });
  // two typos only in longer phrases
  expect(parseMentionCommand("turn teh volum up")).toMatchObject({
    type: "volume",
    change: volumeStep,
  });
  expect(parseMentionCommand("shfle")).toBeUndefined();
});

test("typos the agent should handle instead", () => {
  // short phrases are too close to words and each other
  expect(parseMentionCommand("nest")).toBeUndefined();
  expect(parseMentionCommand("skpi")).toBeUndefined();
  // what can't be undone has to be typed exactly
  expect(parseMentionCommand("edn session")).toBeUndefined();
  expect(parseMentionCommand("clear queu")).toBeUndefined();
  expect(parseMentionCommand("take hots")).toBeUndefined();
  expect(parseMentionCommand("leaev")).toBeUndefined();
  // as close to two different commands
  expect(parseMentionCommand("autoplay of")).toBeUndefined();
  expect(parseMentionCommand("captions of")).toBeUndefined();
});

test("commands run through the coordinator and say what happened", async () => {
  const calls: unknown[][] = [];
  const coordinator = {
    agentEnd: async (...args: unknown[]) => {
      calls.push(["end", ...args]);
      return { ok: true, ended: true };
    },
    agentChangeVolume: async (...args: unknown[]) => {
      calls.push(["volume", ...args]);
      return { ok: true, volumePercent: 45 };
    },
    agentSkip: async () => ({
      ok: false,
      error: "You do not have permission for that.",
    }),
    agentStatus: () => ({
      ok: true,
      state: "paused",
      playbackSeconds: 65,
      nowPlaying: {
        title: "Song",
        artist: "Artist",
        durationSeconds: 200,
      },
      queue: [],
    }),
  } as unknown as Coordinator;

  expect(await runMentionCommand(coordinator, "U1", { type: "end" })).toEqual({
    ok: true,
    text: "Ended the session.",
  });
  expect(
    await runMentionCommand(coordinator, "U1", { type: "volume", change: 10 }),
  ).toEqual({ ok: true, text: "Volume 45%." });
  expect(await runMentionCommand(coordinator, "U1", { type: "skip" })).toEqual({
    ok: false,
    text: "You do not have permission for that.",
  });
  expect(
    await runMentionCommand(coordinator, "U1", { type: "now-playing" }),
  ).toEqual({
    ok: true,
    text: "Now playing *Song* by Artist (1:05 / 3:20). Paused.",
  });
  expect(await runMentionCommand(coordinator, "U1", { type: "queue" })).toEqual(
    { ok: true, text: "The queue is empty." },
  );
  expect(
    await runMentionCommand(coordinator, "U1", {
      type: "volume",
      change: 10,
      readAs: "volume up",
    }),
  ).toEqual({ ok: true, text: "Volume 45%. (Read as `volume up`.)" });
  expect(calls).toEqual([
    ["end", "U1"],
    ["volume", "U1", 10],
    ["volume", "U1", 10],
  ]);
});
