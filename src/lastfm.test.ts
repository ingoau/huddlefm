import { expect, test } from "bun:test";
import {
  lastFmCollectionTracks,
  LastFmError,
  lastFmLink,
  lastFmName,
} from "./lastfm.ts";

function link(href: string) {
  return lastFmLink(new URL(href));
}

function stubRequest(body: unknown, status = 200) {
  const calls: URL[] = [];
  const request = (async (input: string) => {
    calls.push(new URL(input));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, request };
}

test("reads the collection behind each kind of Last.fm page", () => {
  expect(link("https://www.last.fm/user/rj/loved")).toMatchObject({
    type: "collection",
    collection: { kind: "loved", user: "rj" },
    label: "Add Last.fm loved tracks: rj",
  });
  expect(link("https://www.last.fm/user/rj")).toMatchObject({
    collection: { kind: "user-top", user: "rj", period: "overall" },
    label: "Add Last.fm top tracks: rj",
  });
  expect(
    link("https://www.last.fm/user/rj/library/tracks?date_preset=LAST_7_DAYS"),
  ).toMatchObject({
    collection: { kind: "user-top", user: "rj", period: "7day" },
    label: "Add Last.fm top tracks (last 7 days): rj",
  });
  expect(link("https://www.last.fm/user/rj/library")).toMatchObject({
    collection: { kind: "user-top", user: "rj", period: "overall" },
  });
  expect(link("https://last.fm/music/Cheap+Trick")).toMatchObject({
    collection: { kind: "artist-top", artist: "Cheap Trick" },
    label: "Add Last.fm top tracks: Cheap Trick",
  });
  expect(link("https://www.last.fm/music/Cheap+Trick/+tracks")).toMatchObject({
    collection: { kind: "artist-top", artist: "Cheap Trick" },
  });
  expect(
    link("https://www.last.fm/music/Cheap+Trick/Dream+Police"),
  ).toMatchObject({
    collection: {
      kind: "album",
      artist: "Cheap Trick",
      album: "Dream Police",
    },
    label: "Add Last.fm album: Dream Police — Cheap Trick",
  });
  expect(link("https://www.last.fm/tag/shoegaze")).toMatchObject({
    collection: { kind: "tag-top", tag: "shoegaze" },
    label: "Add Last.fm tag: shoegaze",
  });
  expect(link("https://www.last.fm/charts")).toMatchObject({
    collection: { kind: "chart-top" },
    label: "Add Last.fm charts",
  });
});

test("reads single tracks from Last.fm song pages", () => {
  expect(
    link("https://www.last.fm/music/Sparks/_/The+Number+One+Song"),
  ).toEqual({
    type: "track",
    track: { title: "The Number One Song", artist: "Sparks" },
  });
  expect(
    link("https://www.last.fm/music/Sparks/Kimono+My+House/Amateur+Hour"),
  ).toEqual({
    type: "track",
    track: {
      title: "Amateur Hour",
      artist: "Sparks",
      album: "Kimono My House",
    },
  });
});

test("keeps escaped pluses out of Last.fm names", () => {
  expect(
    link("https://www.last.fm/music/Godspeed+You%21+Black+Emperor"),
  ).toMatchObject({
    collection: { kind: "artist-top", artist: "Godspeed You! Black Emperor" },
  });
  expect(link("https://www.last.fm/music/C%2BC+Music+Factory")).toMatchObject({
    collection: { kind: "artist-top", artist: "C+C Music Factory" },
  });
});

test("explains Last.fm pages that have no API behind them", () => {
  expect(link("https://www.last.fm/user/rj/playlists/12345678")).toEqual({
    type: "unsupported",
    reason:
      "Last.fm playlists are not in its API — try loved, library, or album links",
  });
  for (const href of [
    "https://www.last.fm/user/rj/library/artists",
    "https://www.last.fm/music/Sparks/+wiki",
    "https://www.last.fm/settings",
  ])
    expect(link(href)).toEqual({
      type: "unsupported",
      reason: "That Last.fm link is not supported",
    });
});

test("leaves every other host to the normal link handling", () => {
  expect(link("https://example.com/user/rj/loved")).toBeUndefined();
  expect(link("https://lastfm.example.com/user/rj/loved")).toBeUndefined();
  expect(link("https://notlast.fm/user/rj/loved")).toBeUndefined();
});

test("asks Last.fm for the tracks a page lists, in order", async () => {
  const { calls, request } = stubRequest({
    lovedtracks: {
      track: [
        { name: "Song A", artist: { name: "Artist" }, duration: "215" },
        { name: "Song B", artist: { "#text": "Other" } },
        // Last.fm repeats tracks across its paged endpoints.
        { name: "song a", artist: { name: "artist" } },
        { name: "", artist: { name: "Nameless" } },
      ],
    },
  });
  expect(
    await lastFmCollectionTracks(
      { kind: "loved", user: "rj" },
      { apiKey: "key", limit: 10, request },
    ),
  ).toEqual([
    { title: "Song A", artist: "Artist", duration: 215 },
    { title: "Song B", artist: "Other" },
  ]);
  const [url] = calls;
  expect(url?.searchParams.get("method")).toBe("user.getLovedTracks");
  expect(url?.searchParams.get("user")).toBe("rj");
  expect(url?.searchParams.get("api_key")).toBe("key");
  expect(url?.searchParams.get("format")).toBe("json");
  expect(url?.searchParams.get("limit")).toBe("10");
});

test("fills album tracks in from the album that was asked for", async () => {
  const { calls, request } = stubRequest({
    album: {
      name: "Dream Police",
      tracks: { track: [{ name: "Voices", duration: 265 }] },
    },
  });
  expect(
    await lastFmCollectionTracks(
      { kind: "album", artist: "Cheap Trick", album: "Dream Police" },
      { apiKey: "key", request },
    ),
  ).toEqual([
    {
      title: "Voices",
      artist: "Cheap Trick",
      album: "Dream Police",
      duration: 265,
    },
  ]);
  expect(calls[0]?.searchParams.get("method")).toBe("album.getInfo");
});

test("keeps a single-track response usable", async () => {
  const { request } = stubRequest({
    toptracks: { track: { name: "Solo", artist: { name: "Artist" } } },
  });
  expect(
    await lastFmCollectionTracks(
      { kind: "user-top", user: "rj", period: "12month" },
      { apiKey: "key", request },
    ),
  ).toEqual([{ title: "Solo", artist: "Artist" }]);
});

test("surfaces the Last.fm error code", async () => {
  const { request } = stubRequest({ error: 6, message: "User not found" }, 404);
  const failure = await lastFmCollectionTracks(
    { kind: "loved", user: "nobody" },
    { apiKey: "key", request },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LastFmError);
  expect((failure as LastFmError).code).toBe(6);
  expect((failure as LastFmError).message).toBe("User not found");
});

test("reports a failed request that carries no Last.fm error", async () => {
  const { request } = stubRequest("nope", 503);
  expect(
    lastFmCollectionTracks({ kind: "chart-top" }, { apiKey: "key", request }),
  ).rejects.toThrow("Last.fm returned HTTP 503");
});

test("reads names from every shape Last.fm returns them in", () => {
  expect(lastFmName("Artist")).toBe("Artist");
  expect(lastFmName({ name: "Artist" })).toBe("Artist");
  expect(lastFmName({ "#text": "Artist" })).toBe("Artist");
  expect(lastFmName(undefined)).toBe("");
});
