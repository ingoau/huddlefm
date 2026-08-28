import { expect, test } from "bun:test";
import { Analytics } from "./analytics.ts";

function fakeClient() {
  const events: unknown[] = [];
  const exceptions: {
    error: unknown;
    distinctId?: string;
    properties?: Record<string | number, unknown>;
  }[] = [];
  let shutdownTimeout: number | undefined;
  const client: NonNullable<ConstructorParameters<typeof Analytics>[0]> = {
    capture(event) {
      events.push(event);
    },
    captureException(error, distinctId, properties) {
      exceptions.push({ error, distinctId, properties });
    },
    async shutdown(timeout) {
      shutdownTimeout = timeout;
    },
  };
  return {
    events,
    exceptions,
    get shutdownTimeout() {
      return shutdownTimeout;
    },
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

test("flushes with a bounded shutdown", async () => {
  const fake = fakeClient();
  await new Analytics(fake.client, "installation").shutdown();
  expect(fake.shutdownTimeout).toBe(5_000);
});
