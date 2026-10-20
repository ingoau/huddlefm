import { expect, test } from "bun:test";
import {
  chaptersFrom,
  cleanVideoTitle,
  coreTitle,
  formatClock,
  formatLimit,
  isVideoLink,
  musicVideoMatch,
  parseClock,
  parseYouTubeSearch,
  pickSubtitles,
  shorten,
  validChapters,
  vttToSrt,
} from "./videos.ts";

test("shortens long titles at a word with an ellipsis", () => {
  expect(shorten("Short title", 20)).toBe("Short title");
  expect(shorten("The quick brown fox jumps over the lazy dog", 20)).toBe(
    "The quick brown fox…",
  );
  // No word boundary to use: cut where it must be.
  expect(shorten("Supercalifragilisticexpialidocious", 10)).toBe("Supercali…");
  expect([...shorten("😀".repeat(80), 75)]).toHaveLength(75);
});

test("tidies a video's title without losing what it is", () => {
  expect(cleanVideoTitle("My clip   of   cats #shorts #fyp", "Cats")).toBe(
    "My clip of cats",
  );
  expect(cleanVideoTitle("Big news | Daily Show", "Daily Show")).toBe(
    "Big news",
  );
  // A bar that is not the channel stays.
  expect(cleanVideoTitle("Part 1 | Part 2", "Someone")).toBe("Part 1 | Part 2");
  expect(cleanVideoTitle("🎉 Party (Official Video) 🎉", "Band")).toBe(
    "🎉 Party (Official Video) 🎉",
  );
  // A title that is only hashtags keeps them.
  expect(cleanVideoTitle("#shorts", "x")).toBe("#shorts");
});

test("reads and writes clock times", () => {
  expect(parseClock("90")).toBe(90);
  expect(parseClock("42:10")).toBe(2530);
  expect(parseClock("1:23:45")).toBe(5025);
  expect(parseClock("1:75")).toBeUndefined();
  expect(parseClock("soon")).toBeUndefined();
  expect(parseClock("1:2:3:4")).toBeUndefined();
  expect(formatClock(65)).toBe("1:05");
  expect(formatClock(3723)).toBe("1:02:03");
  expect(formatLimit(3600)).toBe("1 hour");
  expect(formatLimit(5400)).toBe("1 hour 30 minutes");
  expect(formatLimit(1200)).toBe("20 minutes");
});

test("tells YouTube video links from songs and everything else", () => {
  for (const link of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=10",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  ])
    expect(isVideoLink(link)).toBeTrue();
  for (const link of [
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=PL123",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://example.com/a.mp4",
    "not a link",
  ])
    expect(isVideoLink(link)).toBeFalse();
});

test("keeps chapters in order and drops one that is the whole video", () => {
  expect(
    chaptersFrom({
      chapters: [
        { start_time: 60, title: "Middle" },
        { start_time: 0, title: "Start" },
        { start_time: "x", title: "Broken" },
      ],
    }),
  ).toEqual([
    { start: 0, title: "Start" },
    { start: 60, title: "Middle" },
  ]);
  expect(chaptersFrom({ chapters: [{ start_time: 0, title: "All" }] })).toEqual(
    [],
  );
  expect(chaptersFrom({})).toEqual([]);
  expect(validChapters("nope")).toEqual([]);
});

const vtt = (url: string) => [{ ext: "vtt", url }];

test("prefers uploaded English captions, then automatic, then the video's own language", () => {
  expect(
    pickSubtitles({
      subtitles: { de: vtt("https://a/de"), "en-GB": vtt("https://a/en") },
      automatic_captions: { en: vtt("https://a/auto") },
    }),
  ).toEqual({ language: "en-gb", url: "https://a/en" });
  expect(
    pickSubtitles({
      language: "ja",
      subtitles: { ja: vtt("https://a/ja") },
      automatic_captions: {
        en: vtt("https://a/en-translated"),
        "ja-orig": vtt("https://a/ja-orig"),
      },
    }),
  ).toEqual({ language: "en", url: "https://a/en-translated" });
  expect(
    pickSubtitles({
      language: "ja",
      subtitles: { ja: vtt("https://a/ja"), live_chat: vtt("https://a/chat") },
    }),
  ).toEqual({ language: "ja", url: "https://a/ja" });
  // Only WebVTT is taken.
  expect(
    pickSubtitles({ subtitles: { en: [{ ext: "srv3", url: "https://a/x" }] } }),
  ).toBeUndefined();
  expect(pickSubtitles({})).toBeUndefined();
});

test("turns rolling automatic captions into plain two-line subtitles", () => {
  // YouTube keeps a cue's blank lines as a single space.
  const input = [
    "WEBVTT",
    "Kind: captions",
    "Language: en",
    "",
    "00:00:00.160 --> 00:00:02.869 align:start position:0%",
    " ",
    "hello<00:00:00.480><c> world</c>",
    "",
    "00:00:02.869 --> 00:00:02.879 align:start position:0%",
    "hello world",
    " ",
    "",
    "00:00:02.879 --> 00:00:05.230 align:start position:0%",
    "hello world",
    "next<00:00:03.000><c> words &amp; more</c>",
    "",
    "00:00:05.230 --> 00:00:08.000",
    "one",
    "two",
    "three",
    "",
  ].join("\n");
  expect(vttToSrt(input)).toBe(`1
00:00:00,160 --> 00:00:02,869
hello world

2
00:00:02,879 --> 00:00:05,230
next words & more

3
00:00:05,230 --> 00:00:08,000
two
three
`);
  expect(vttToSrt("WEBVTT\n\nnothing here")).toBe("");
});

test("takes a song's official video only when it surely is one", () => {
  const song = {
    sourceId: "songsongson",
    title: "Karma Police (Remastered)",
    artist: "Radiohead, Someone",
    duration: 260,
  };
  const video = (title: string, artist = "Radiohead", duration = 270) => ({
    videoId: crypto.randomUUID().slice(0, 11),
    title,
    artist,
    duration,
  });
  expect(coreTitle(song.title)).toBe("Karma Police");
  const official = video("Radiohead - Karma Police");
  expect(
    musicVideoMatch(song, [
      video("Karma Police (Lyrics)"),
      video("Karma Police Live at Glastonbury"),
      video("Karma Police", "Cover Band"),
      video("Karma Police", "Radiohead", 30),
      official,
    ]),
  ).toBe(official);
  expect(musicVideoMatch(song, [video("Karma Police (Lyric Video)")])).toBe(
    undefined,
  );
  // A word the song itself has is not held against the video.
  expect(
    musicVideoMatch({ ...song, title: "Live Forever" }, [
      video("Live Forever (Official Video)"),
    ]),
  ).toBeDefined();
  // The song's own upload is not its video.
  expect(
    musicVideoMatch(song, [{ ...official, videoId: "songsongson" }]),
  ).toBeUndefined();
});

test("reads videos from a YouTube search, leaving out live and members-only ones", () => {
  const renderer = (videoId: string, extra: Record<string, unknown> = {}) => ({
    videoRenderer: {
      videoId,
      title: { runs: [{ text: `Video ${videoId} #shorts` }] },
      ownerText: { runs: [{ text: "Channel" }] },
      lengthText: { simpleText: "1:02:03" },
      thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/a.jpg?x=1" }] },
      ...extra,
    },
  });
  const response = {
    contents: {
      sections: [
        renderer("aaaaaaaaaaa"),
        { shelf: [renderer("bbbbbbbbbbb", { lengthText: undefined })] },
        renderer("ccccccccccc", {
          badges: [
            {
              metadataBadgeRenderer: {
                style: "BADGE_STYLE_TYPE_MEMBERS_ONLY",
                label: "Members only",
              },
            },
          ],
        }),
        renderer("aaaaaaaaaaa"),
        { lockupViewModel: {} },
      ],
    },
  };
  expect(parseYouTubeSearch(response)).toEqual([
    {
      videoId: "aaaaaaaaaaa",
      title: "Video aaaaaaaaaaa",
      channel: "Channel",
      duration: 3723,
      thumbnail: "https://i.ytimg.com/a.jpg",
    },
  ]);
});
