/*
 * Sealing what the bot tells one user over the data channel, which everyone
 * in the huddle hears: their searches, saves, recent songs and the like. A
 * client sends a P-256 public key with its `sync`, which Chime stamps with
 * its sender, so no one else can stand in for it; the bot answers that user
 * with AES-GCM, under a key both derive by ECDH. clients/core/seal.ts is the
 * client's half.
 */

const curve = { name: "ECDH", namedCurve: "P-256" } as const;

function base64(bytes: ArrayBuffer | Uint8Array) {
  return Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString("base64");
}

/** The bot's key pair for a session, and its public half as clients take it. */
export async function sealingKeys() {
  const pair = (await crypto.subtle.generateKey(curve, false, [
    "deriveKey",
  ])) as CryptoKeyPair;
  const publicKey = base64(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKey };
}

/**
 * The key shared with the client whose public key this is, or undefined
 * for one that isn't a P-256 point.
 */
export async function sharedKey(privateKey: CryptoKey, peer: unknown) {
  // an uncompressed point, 65 bytes, is 88 characters of base64
  if (typeof peer !== "string" || peer.length !== 88) return;
  try {
    const point = await crypto.subtle.importKey(
      "raw",
      Buffer.from(peer, "base64"),
      curve,
      false,
      [],
    );
    return await crypto.subtle.deriveKey(
      { name: "ECDH", public: point },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
  } catch {
    return;
  }
}

/** A message sealed for one client, as `iv` and `data` in base64. */
export async function seal(key: CryptoKey, payload: Record<string, unknown>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { iv: base64(iv), data: base64(data) };
}
