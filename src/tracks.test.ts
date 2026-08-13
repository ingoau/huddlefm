import { expect, test } from "bun:test";
import { assertPublicUrl } from "./tracks.ts";

test("rejects credentials and private destinations", async () => {
  await expect(assertPublicUrl(new URL("https://user:pass@example.com"))).rejects.toThrow(
    "Credentials",
  );
  await expect(assertPublicUrl(new URL("http://127.0.0.1/test"))).rejects.toThrow(
    "Private",
  );
});
