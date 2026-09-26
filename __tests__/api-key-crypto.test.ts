import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  EncryptionNotConfiguredError,
  decryptSecret,
  encryptSecret,
  keyHint,
} from "@/lib/apiKeyCrypto";
import { randomBytes } from "node:crypto";

// Task 51. The property that matters is not "it round-trips" -- it is
// that what lands in the database is not recoverable without the server
// secret. Several of these exist to prove that specifically.

const SECRET_A = randomBytes(32).toString("base64");
const SECRET_B = randomBytes(32).toString("base64");
const PLAINTEXT = "sk-ant-api03-EXAMPLE-not-a-real-key-0123456789abcdef";

let original: string | undefined;
beforeEach(() => {
  original = process.env.API_KEY_ENCRYPTION_SECRET;
  process.env.API_KEY_ENCRYPTION_SECRET = SECRET_A;
});
afterEach(() => {
  if (original === undefined) delete process.env.API_KEY_ENCRYPTION_SECRET;
  else process.env.API_KEY_ENCRYPTION_SECRET = original;
});

describe("apiKeyCrypto", () => {
  test("round-trips", () => {
    expect(decryptSecret(encryptSecret(PLAINTEXT))).toBe(PLAINTEXT);
  });

  test("the stored value is genuinely encrypted, not the key in disguise", () => {
    const stored = encryptSecret(PLAINTEXT);
    // Not the plaintext, and not merely encoded: decoding every base64
    // segment must not reveal it either. This is the check that would
    // fail if someone "encrypted" by base64-ing the value.
    expect(stored).not.toContain(PLAINTEXT);
    expect(stored).not.toContain("sk-ant");
    for (const part of stored.split(":").slice(1)) {
      const decoded = Buffer.from(part, "base64").toString("utf8");
      expect(decoded).not.toContain("sk-ant");
      expect(decoded).not.toContain(PLAINTEXT);
    }
  });

  test("a different secret cannot decrypt it", () => {
    const stored = encryptSecret(PLAINTEXT);
    process.env.API_KEY_ENCRYPTION_SECRET = SECRET_B;
    // GCM's auth tag makes this throw rather than return garbage that
    // would later be sent to Anthropic as if it were a key.
    expect(() => decryptSecret(stored)).toThrow();
  });

  test("tampering with the ciphertext is detected", () => {
    const [v, iv, tag, ct] = encryptSecret(PLAINTEXT).split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 0xff;
    expect(() =>
      decryptSecret([v, iv, tag, flipped.toString("base64")].join(":")),
    ).toThrow();
  });

  test("encrypting twice gives different ciphertext", () => {
    // A fresh IV each time: identical keys must not produce identical
    // rows, which would leak that two users share a key.
    expect(encryptSecret(PLAINTEXT)).not.toBe(encryptSecret(PLAINTEXT));
  });

  test("errors never quote the secret or the plaintext", () => {
    process.env.API_KEY_ENCRYPTION_SECRET = "not-32-bytes";
    let message = "";
    try {
      encryptSecret(PLAINTEXT);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("API_KEY_ENCRYPTION_SECRET");
    expect(message).not.toContain("not-32-bytes");
    expect(message).not.toContain(PLAINTEXT);
  });

  test("a missing secret is a clear, typed configuration error", () => {
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    expect(() => encryptSecret(PLAINTEXT)).toThrow(
      EncryptionNotConfiguredError,
    );
  });

  test("keyHint shows only the last four characters", () => {
    const hint = keyHint(PLAINTEXT);
    expect(hint).toBe("…cdef");
    expect(hint).not.toContain("sk-ant");
  });
});
