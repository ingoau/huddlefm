import { expect, test } from "bun:test";
import { publicIp } from "./public-proxy.ts";

test("rejects private and reserved addresses", () => {
  for (const address of [
    "127.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "fc00::1",
  ])
    expect(publicIp(address)).toBeFalse();
  expect(publicIp("1.1.1.1")).toBeTrue();
  expect(publicIp("2606:4700:4700::1111")).toBeTrue();
});
