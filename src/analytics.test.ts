import { expect, test } from "bun:test";
import { Analytics } from "./analytics.ts";

function fakeClient() {
  const events: unknown[] = [];
  const exceptions: {
    error: unknown;
    distinctId?: string;
    properties?: Record<string | number, unknown>;
  }[] = [];
  const people: unknown[] = [];
  const client: NonNullable<ConstructorParameters<typeof Analytics>[0]> = {
    capture(event) {
      events.push(event);
    },
    captureException(error, distinctId, properties) {
      exceptions.push({ error, distinctId, properties });
    },
    setPersonProperties(message) {
      people.push(message);
    },
    async shutdown() {},
  };
  return {
    events,
    exceptions,
    people,
    client,
  };
}

test("maps audit actors and sessions without names or secrets", () => {
  const fake = fakeClient();
  const analytics = new Analytics(fake.client, "installation");
  analytics.audit("track.started", undefined, {
    sessionId: "session",
    requesterId: "U123",
    origin: "manual",
    title: "Track",
    actorName: "Sam",
    token: "secret",
  });

  expect(fake.events).toEqual([
    {
      distinctId: "U123",
      event: "track.started",
      properties: {
        origin: "manual",
        title: "Track",
        token: "[redacted]",
        $session_id: "session",
      },
    },
  ]);
});

test("attributes autoplay to the installation", () => {
  const fake = fakeClient();
  const analytics = new Analytics(fake.client, "installation");
  analytics.audit("track.autoplay_added", undefined, {
    requesterId: "BOT",
    origin: "autoplay",
  });

  expect(fake.events).toEqual([
    {
      distinctId: "installation",
      event: "track.autoplay_added",
      properties: { origin: "autoplay" },
    },
  ]);
});

test("sets current person state without user names", () => {
  const fake = fakeClient();
  const analytics = new Analytics(fake.client, "installation");
  analytics.setPersonProperties("U123", {
    lastfm_connected: true,
    lastfm_username: "sam",
    listenbrainz_connected: false,
  });

  expect(fake.people).toEqual([
    {
      distinctId: "U123",
      properties: {
        lastfm_connected: true,
        listenbrainz_connected: false,
      },
    },
  ]);
});

test("sanitizes and deduplicates exceptions", () => {
  const fake = fakeClient();
  const analytics = new Analytics(fake.client, "installation");
  const error = new Error("request failed token=secret");
  analytics.exception(error, {
    distinctId: "U123",
    sessionId: "session",
    properties: { component: "test" },
  });
  analytics.exception(error);

  expect(fake.exceptions).toHaveLength(1);
  expect(fake.exceptions[0]).toMatchObject({
    distinctId: "U123",
    properties: { component: "test", $session_id: "session" },
    error: { message: "request failed token=[redacted]" },
  });
});
