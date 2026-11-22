package huddlefm.android;

import android.util.Base64;
import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens what the bot seals for this user, as clients/core/seal.ts does: everyone in the huddle
 * hears the data channel, so what's for one user comes under a key only this client and the bot
 * share, derived by ECDH on P-256 and used with AES-GCM.
 */
final class Seal {
  private final KeyPair pair;
  /** The AES key shared with each bot key heard, as each session has its own. */
  private final Map<String, byte[]> shared = new HashMap<>();

  Seal() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    pair = generator.generateKeyPair();
  }

  /** This client's public key, raw and in base64, as WebCrypto exports it. */
  String publicKey() {
    ECPoint w = ((ECPublicKey) pair.getPublic()).getW();
    byte[] raw = new byte[65];
    raw[0] = 4;
    put(w.getAffineX(), raw, 1);
    put(w.getAffineY(), raw, 33);
    return Base64.encodeToString(raw, Base64.NO_WRAP);
  }

  /** A sealed message's text, or null when it isn't for this client. */
  String open(String key, String iv, String data) {
    try {
      byte[] secret = shared.get(key);
      if (secret == null) {
        secret = derive(key);
        shared.put(key, secret);
      }
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(
          Cipher.DECRYPT_MODE,
          new SecretKeySpec(secret, "AES"),
          new GCMParameterSpec(128, Base64.decode(iv, Base64.DEFAULT)));
      return new String(cipher.doFinal(Base64.decode(data, Base64.DEFAULT)), "UTF-8");
    } catch (Exception e) {
      // another of this user's clients', or not the bot's
      return null;
    }
  }

  private byte[] derive(String peer) throws Exception {
    byte[] raw = Base64.decode(peer, Base64.DEFAULT);
    if (raw.length != 65 || raw[0] != 4) throw new IllegalArgumentException("Not a P-256 point");
    ECPoint point =
        new ECPoint(
            new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)),
            new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
    ECPublicKey ours = (ECPublicKey) pair.getPublic();
    java.security.PublicKey theirs =
        KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, ours.getParams()));
    KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
    agreement.init(pair.getPrivate());
    agreement.doPhase(theirs, true);
    // WebCrypto's ECDH deriveKey for AES-256 takes the shared x coordinate as the key
    return agreement.generateSecret();
  }

  private static void put(BigInteger value, byte[] into, int at) {
    byte[] bytes = value.toByteArray();
    int length = Math.min(bytes.length, 32);
    System.arraycopy(bytes, bytes.length - length, into, at + 32 - length, length);
  }
}
