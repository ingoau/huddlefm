import { expect, test } from "bun:test";
import { PoTokenServer } from "./pot-server.ts";

test("a server that cannot start is retried, not thrown", async () => {
  const server = new PoTokenServer("/nonexistent/bgutil/server");
  server.start();
  await Bun.sleep(100);
  expect(server.url).toStartWith("http://127.0.0.1:");
  await server.close();
});
