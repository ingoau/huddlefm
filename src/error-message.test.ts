import { expect, test } from "bun:test";
import { redactSecrets, safeError } from "./error-message.ts";

test("redacts credentials without mangling ordinary token messages", () => {
  const text = redactSecrets(
    'authorization: Bearer secret cookie=session token=abc "JoinToken":"join" xoxp-slack',
  );

  expect(text).not.toContain("secret");
  expect(text).not.toContain("session");
  expect(text).not.toContain("abc");
  expect(text).not.toContain("join");
  expect(text).not.toContain("xoxp-slack");
  expect(safeError(new Error("That user token is invalid"))).toBe(
    "That user token is invalid",
  );
});

test("redacts the key identifier from a provider console URL", () => {
  const text = redactSecrets(
    "You requested up to 65536 tokens. To increase, visit https://openrouter.ai/workspaces/default/keys/0123456789abcdef0123456789abcdef and adjust the key's monthly limit",
  );

  expect(text).not.toContain("0123456789abcdef");
  expect(text).toContain("https://openrouter.ai/workspaces/default/keys/");
  expect(text).toContain("You requested up to 65536 tokens");
});
