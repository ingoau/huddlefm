import { expect, test } from "bun:test";
import { controlDenied } from "./local-control.ts";

test("local controls are disabled or bearer authenticated", () => {
  const request = (authorization?: string) => new Request("http://127.0.0.1/leave", {
    headers: authorization ? { authorization } : {},
  });
  expect(controlDenied(request())?.status).toBe(404);
  expect(controlDenied(request(), "secret")?.status).toBe(401);
  expect(controlDenied(request("Bearer secret"), "secret")).toBeUndefined();
});
