import { expect, test } from "bun:test";
import { ScrobbleDispatcher } from "./scrobbling.ts";
import { Store } from "./store.ts";

test("links Last.fm once as a global Slack user setting", async () => {
  const calls: URLSearchParams[] = [];
  const request = (async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    if (body.get("method") === "auth.getToken")
      return Response.json({ token: "request-token" });
    return Response.json({
      session: { name: "last-user", key: "session-key" },
    });
  }) as typeof fetch;
  const store = new Store(":memory:");
  const dispatcher = new ScrobbleDispatcher(
    store,
    { lastFmApiKey: "api-key", lastFmSharedSecret: "secret" },
    request,
  );
  expect(await dispatcher.beginLastFm("slack-user")).toContain(
    "token=request-token",
  );
  expect(await dispatcher.finishLastFm("slack-user")).toBe("last-user");
  expect(store.getUserScrobbling("slack-user")).toEqual(
    expect.objectContaining({
      lastFmUsername: "last-user",
      lastFmSessionKey: "session-key",
      lastFmEnabled: true,
    }),
  );
  expect(calls.map((call) => call.get("method"))).toEqual([
    "auth.getToken",
    "auth.getSession",
  ]);
  expect(
    calls.every((call) => call.get("api_sig")?.match(/^[a-f0-9]{32}$/)),
  ).toBeTrue();
  expect(calls.every((call) => !String(call).includes("secret"))).toBeTrue();
  store.close();
});

test("sends now playing immediately and queues scrobbles at the listening threshold", async () => {
  const calls: { url: string; body: string }[] = [];
  const request = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    if (String(input).includes("audioscrobbler")) {
      const method = new URLSearchParams(String(init?.body)).get("method");
      return Response.json(
        method === "track.scrobble"
          ? { scrobbles: { "@attr": { accepted: "1", ignored: "0" } } }
          : { nowplaying: { ignoredMessage: { code: "0" } } },
      );
    }
    return Response.json({ status: "ok" });
  }) as typeof fetch;
  const store = new Store(":memory:");
  store.connectLastFm("user", "last-user", "session-key");
  store.setListenBrainzToken("user", "lb-token", "lb-user");
  store.setListenBrainzEnabled("user", true);
  const dispatcher = new ScrobbleDispatcher(
    store,
    { lastFmApiKey: "api-key", lastFmSharedSecret: "secret" },
    request,
  );
  const playback = dispatcher.playback("huddle-session", "bot");
  playback.start(
    {
      id: "track",
      requesterId: "user",
      title: "Title",
      artist: "Artist",
      album: "Album",
      duration: 40,
    },
    ["user", "bot"],
  );
  await until(() => calls.length === 2);
  for (const seconds of [5, 10, 15, 20]) playback.position(seconds);
  await until(
    () =>
      (
        store.db
          .query(
            "SELECT count(*) AS count FROM scrobbles WHERE status = 'sent'",
          )
          .get() as { count: number }
      ).count === 2,
  );

  const lastFmMethods = calls
    .filter((call) => call.url.includes("audioscrobbler"))
    .map((call) => new URLSearchParams(call.body).get("method"));
  const listenBrainzTypes = calls
    .filter((call) => call.url.includes("listenbrainz"))
    .map((call) => JSON.parse(call.body).listen_type);
  expect(lastFmMethods).toEqual(["track.updateNowPlaying", "track.scrobble"]);
  expect(listenBrainzTypes).toEqual(["playing_now", "single"]);
  store.close();
});

test("does not count seeks as listening time", async () => {
  const store = new Store(":memory:");
  store.setListenBrainzToken("user", "token", "user");
  store.setListenBrainzEnabled("user", true);
  const dispatcher = new ScrobbleDispatcher(store, {}, (async () =>
    Response.json({ status: "ok" })) as unknown as typeof fetch);
  const playback = dispatcher.playback("session", "bot");
  playback.start(
    {
      id: "track",
      requesterId: "user",
      title: "Title",
      artist: "Artist",
      duration: 60,
    },
    ["user"],
  );
  playback.position(5);
  playback.position(50);
  playback.position(55);
  await Bun.sleep(0);
  expect(
    store.db.query("SELECT count(*) AS count FROM scrobbles").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("one user connection applies to every Huddle playback", async () => {
  let playingNow = 0;
  const store = new Store(":memory:");
  store.setListenBrainzToken("user", "token", "user");
  store.setListenBrainzEnabled("user", true);
  const dispatcher = new ScrobbleDispatcher(store, {}, (async (
    _input,
    init,
  ) => {
    if (JSON.parse(String(init?.body)).listen_type === "playing_now")
      playingNow++;
    return Response.json({ status: "ok" });
  }) as typeof fetch);
  const track = {
    id: "track",
    requesterId: "user",
    title: "Title",
    artist: "Artist",
    duration: 120,
  };
  dispatcher.playback("huddle-one", "bot").start(track, ["user"]);
  dispatcher.playback("huddle-two", "bot").start(track, ["user"]);
  await until(() => playingNow === 2);
  store.close();
});

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await Bun.sleep(1);
  expect(predicate()).toBeTrue();
}
