import { expect, test } from "bun:test";
import { assertPublicUrl, TrackCatalog } from "./tracks.ts";

test("rejects credentials and private destinations", async () => {
  await expect(assertPublicUrl(new URL("https://user:pass@example.com"))).rejects.toThrow(
    "Credentials",
  );
  await expect(assertPublicUrl(new URL("http://127.0.0.1/test"))).rejects.toThrow(
    "Private",
  );
});

test("uses search metadata without extracting it again", async () => {
  const catalog = new TrackCatalog({ durationSeconds: 1_200, downloadBytes: 100_000_000 });
  const track = {
    sourceInput: "https://music.youtube.com/watch?v=test",
    canonicalUrl: "https://music.youtube.com/watch?v=test",
    sourceId: "test",
    title: "Test",
    artist: "Artist",
    duration: 60,
  };
  Reflect.get(catalog, "references").set("reference", track);
  catalog.resolveUrl = async () => { throw new Error("unexpected extraction"); };
  expect(await catalog.resolve("reference")).toBe(track);
});
