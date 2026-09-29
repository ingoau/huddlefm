import { expect, test } from "bun:test";
import { songwritersFrom } from "./lyrics.ts";

test("reads Apple's songwriters, decoding entities and dropping repeats", () => {
  const ttml = `<tt><head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters><songwriter>Amy Allen</songwriter><songwriter>Christopher &quot;Brody&quot; Brown</songwriter><songwriter>Rog&#233;t Chahayed</songwriter><songwriter>Amy Allen</songwriter></songwriters></iTunesMetadata></metadata></head></tt>`;
  expect(songwritersFrom(ttml)).toEqual([
    "Amy Allen",
    'Christopher "Brody" Brown',
    "Rogét Chahayed",
  ]);
});

test("reads AMLL's songwriter meta tags in either attribute order", () => {
  const ttml = `<tt><head><metadata><amll:meta key="songwriters" value="A &amp; B"/><amll:meta value="C" key="songwriters"/><amll:meta key="musicName" value="Song"/></metadata></head></tt>`;
  expect(songwritersFrom(ttml)).toEqual(["A & B", "C"]);
});

test("credits nobody when the TTML names nobody", () => {
  expect(songwritersFrom("<tt><body/></tt>")).toEqual([]);
});
