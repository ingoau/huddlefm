// Opening what the bot seals for this user, as src/plugin-seal.ts describes:
// everyone in the huddle hears the data channel, so what's for one user, like
// their searches, saves and recent songs, comes sealed with a key only this
// client and the bot share.

const curve = { name: "ECDH", namedCurve: "P-256" } as const;

function bytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export class Sealing {
  private pair = crypto.subtle.generateKey(curve, false, [
    "deriveKey",
  ]) as Promise<CryptoKeyPair>;
  /** the key shared with each bot key heard, as a session has its own */
  private shared = new Map<string, Promise<CryptoKey>>();

  /** This client's public key, sent with `sync`, in base64. */
  async publicKey() {
    const raw = await crypto.subtle.exportKey(
      "raw",
      (await this.pair).publicKey,
    );
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  }

  /** A sealed message's payload, or undefined when it isn't for this client. */
  async open(sealed: { key: string; iv: string; data: string }) {
    let key = this.shared.get(sealed.key);
    if (!key) {
      key = this.derive(sealed.key);
      this.shared.set(sealed.key, key);
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(sealed.iv) },
        await key,
        bytes(sealed.data),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as unknown;
    } catch {
      // another of this user's clients', or not the bot's
      return undefined;
    }
  }

  private async derive(peer: string) {
    const point = await crypto.subtle.importKey(
      "raw",
      bytes(peer),
      curve,
      false,
      [],
    );
    return crypto.subtle.deriveKey(
      { name: "ECDH", public: point },
      (await this.pair).privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  }
}
