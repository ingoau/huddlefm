import { expect, test } from "bun:test";
import {
  LyricsCatalog,
  type LyricsPayload,
  songwritersFrom,
} from "./lyrics.ts";
import type { TrackMetadata } from "./tracks.ts";

test("reads Apple's songwriters, decoding entities and dropping repeats", () => {
  const ttml = `<tt><head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters><songwriter>Amy Allen</songwriter><songwriter>Christopher &quot;Brody&quot; Brown</songwriter><songwriter>Rog&#233;t Chahayed</songwriter><songwriter>Amy Allen</songwriter></songwriters></iTunesMetadata></metadata></head></tt>`;
  expect(songwritersFrom(ttml)).toEqual([
    "Amy Allen",
    'Christopher "Brody" Brown',
    "Rogét Chahayed",
  ]);
});

test("reads AMLL's songwriter meta tags in either attribute order", () => {
  const ttml = `<tt><head><metadata><amll:meta key="songwriters" value="A &amp; B"/><amll:meta value="C" key="songwriters"/><amll:meta key='songwriters' data-value="no" value='D'/><amll:meta key="musicName" value="Song"/></metadata></head></tt>`;
  expect(songwritersFrom(ttml)).toEqual(["A & B", "C", "D"]);
});

test("credits nobody when the TTML names nobody", () => {
  expect(songwritersFrom("<tt><body/></tt>")).toEqual([]);
});

const track: TrackMetadata = {
  sourceInput: "https://www.youtube.com/watch?v=abcdefghijk",
  canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  sourceId: "abcdefghijk",
  title: "Song",
  artist: "Artist",
};

// The providers in their tie-break order, with every priority each gives.
const providers = [
  ["betterLyrics", [0]],
  ["binimum", [2]],
  ["unison", [1, 7, 13]],
  ["amll", [5]],
  ["lrclib", [9, 14]],
] as const;

type Outcome = LyricsPayload | undefined | Error;

/**
 * A catalog whose providers answer only when told to, and say whether they
 * were stopped.
 */
function controlledCatalog() {
  const catalog = new LyricsCatalog();
  const answers = new Map<string, (outcome: Outcome) => void>();
  const stopped = new Set<string>();
  for (const [name] of providers)
    Reflect.set(
      catalog,
      name,
      (_track: TrackMetadata, signal: AbortSignal) =>
        new Promise<LyricsPayload | undefined>((resolve, reject) => {
          let answered = false;
          signal.addEventListener("abort", () => {
            if (answered) return;
            stopped.add(name);
            reject(signal.reason);
          });
          answers.set(name, (outcome) => {
            answered = true;
            if (outcome instanceof Error) reject(outcome);
            else resolve(outcome);
          });
        }),
    );
  return { catalog, answers, stopped };
}

const found = (source: string, priority: number): LyricsPayload => ({
  lines: [],
  source,
  priority,
});

const settledSoon = async (promise: Promise<unknown>) => {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Bun.sleep(5);
  return settled;
};

test("takes the best lyrics as soon as no provider still asked could beat them", async () => {
  const { catalog, answers } = controlledCatalog();
  const request = catalog.get(track);
  answers.get("lrclib")!(found("LRCLIB", 9));
  answers.get("unison")!(found("Unison", 7));
  answers.get("amll")!(undefined);
  answers.get("binimum")!(undefined);
  // Better Lyrics could still give a 0.
  expect(await settledSoon(request)).toBeFalse();
  answers.get("betterLyrics")!(undefined);
  expect((await request)?.source).toBe("Unison");

  const quick = controlledCatalog();
  const best = quick.catalog.get({ ...track, sourceId: "zyxwvutsrqp" });
  // Nothing can beat a 0, so the rest are not waited for, and are stopped.
  quick.answers.get("betterLyrics")!(found("Better Lyrics", 0));
  expect((await best)?.source).toBe("Better Lyrics");
  expect([...quick.stopped].sort()).toEqual([
    "amll",
    "binimum",
    "lrclib",
    "unison",
  ]);
});

test("picks exactly what waiting for every provider picked", async () => {
  // Random answers in a random order, against the old choice: the lowest
  // priority found, the earlier provider on a tie.
  let seed = 7;
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let trial = 0; trial < 300; trial++) {
    const { catalog, answers } = controlledCatalog();
    const outcomes = providers.map(([name, priorities]): Outcome => {
      const pick = random();
      if (pick < 0.15) return new Error(`${name} failed`);
      if (pick < 0.4) return undefined;
      return found(name, priorities[Math.floor(random() * priorities.length)]!);
    });
    const expected = outcomes
      .flatMap((outcome) =>
        outcome && !(outcome instanceof Error) ? [outcome] : [],
      )
      .sort((a, b) => a.priority - b.priority)[0];
    const request = catalog.get({ ...track, sourceId: `trial-${trial}` });
    const order = providers.map((_, index) => index).sort(() => random() - 0.5);
    for (const index of order) {
      answers.get(providers[index]![0])!(outcomes[index]);
      await Bun.sleep(0);
    }
    expect((await request)?.source).toBe(expected?.source);
  }
});

test("tries a title's variants at once, keeping the first that finds", async () => {
  const catalog = new LyricsCatalog();
  const asked: string[] = [];
  const replies = new Map<string, () => void>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname !== "lyrics-api.boidu.dev")
      return new Response(null, { status: 404 });
    const title = url.searchParams.get("s")!;
    asked.push(title);
    await new Promise<void>((resolve) => replies.set(title, resolve));
    return Response.json({
      ttml: `<tt><body><div><p begin="0s" end="1s"><span begin="0s" end="1s">${title}</span></p></div></body></tt>`,
    });
  }) as typeof fetch;
  try {
    const request = Reflect.apply(
      Reflect.get(catalog, "betterLyrics"),
      catalog,
      [{ ...track, title: "Song (feat. Guest)" }, new AbortController().signal],
    ) as Promise<LyricsPayload | undefined>;
    await Bun.sleep(5);
    // Both asked at once.
    expect(asked).toEqual(["Song (feat. Guest)", "Song"]);
    // The second answering first still waits for the first.
    replies.get("Song")!();
    expect(await settledSoon(request)).toBeFalse();
    replies.get("Song (feat. Guest)")!();
    const lyrics = await request;
    expect(lyrics?.source).toBe("Better Lyrics");
    expect(JSON.stringify(lyrics?.lines)).toContain("Song (feat. Guest)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("keeps a bounded number of lyrics, and none that failed", async () => {
  const catalog = new LyricsCatalog();
  let fetched = 0;
  let outcome: () => Promise<{
    selected: LyricsPayload | undefined;
    failed: boolean;
  }> = async () => ({ selected: found("Kept", 0), failed: false });
  Reflect.set(catalog, "fetch", () => (fetched++, outcome()));
  const get = (sourceId: string) => catalog.get({ ...track, sourceId });
  await get("first");
  for (let index = 0; index < 299; index++) await get(`song-${index}`);
  // Played again, the first is the most recently used.
  await get("first");
  expect(fetched).toBe(300);
  await get("one-more");
  await get("first");
  expect(fetched).toBe(301);
  // The least recently used made way.
  await get("song-0");
  expect(fetched).toBe(302);

  // A failure is asked again next time.
  outcome = async () => {
    throw new Error("offline");
  };
  await expect(get("failing")).rejects.toThrow("offline");
  await expect(get("failing")).rejects.toThrow("offline");
  expect(fetched).toBe(304);
  // As is nothing found while a provider failed; nothing found otherwise is
  // kept.
  outcome = async () => ({ selected: undefined, failed: true });
  await get("unsure");
  await get("unsure");
  expect(fetched).toBe(306);
  outcome = async () => ({ selected: undefined, failed: false });
  await get("none");
  await get("none");
  expect(fetched).toBe(307);
});
