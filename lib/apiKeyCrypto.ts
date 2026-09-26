import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Task 51. Application-level encryption for stored third-party API keys.
//
// This sits ON TOP of whatever Supabase provides at rest. The point is
// that the database alone is not enough to recover a key: the secret
// lives only in the server environment, so a leaked backup, a dump, or
// read access to the table yields ciphertext and nothing else.
//
// AES-256-GCM, chosen because it is authenticated -- decryption fails
// loudly if the ciphertext was altered, rather than returning plausible
// garbage that would then be sent to Anthropic as a key. A fresh random
// 96-bit IV per encryption (the size GCM is specified for), so encrypting
// the same key twice never produces the same ciphertext.
//
// SERVER ONLY. This module reads a server-only environment variable and
// must never be imported into a client component. Nothing here logs or
// returns plaintext on any path, including errors -- an error message
// that quoted the value it failed on would defeat the whole exercise.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
// Versioned so the format can change later without having to guess how
// an existing row was written.
const FORMAT_VERSION = "v1";

export class EncryptionNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`API_KEY_ENCRYPTION_SECRET ${detail}`);
    this.name = "EncryptionNotConfiguredError";
  }
}

function getKey(): Buffer {
  const raw = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!raw) {
    throw new EncryptionNotConfiguredError("is not set");
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new EncryptionNotConfiguredError("is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    // Says the length it got, never the value.
    throw new EncryptionNotConfiguredError(
      `must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

// Returns "v1:<iv>:<authTag>:<ciphertext>", all base64. Safe to store in
// a text column and safe to hand back to its owner -- it is useless
// without the server secret.
export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error("Nothing to encrypt");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Stored value is not in the expected encrypted format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  // Throws on a bad tag (wrong secret, or tampered ciphertext). Left to
  // throw rather than caught and defaulted: a silently wrong key would
  // surface later as a confusing 401 from Anthropic.
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// For display next to a masked field: "sk-ant-…4f2a". Never the whole
// value, and deliberately not enough to use.
export function keyHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `…${tail}`;
}

// Constant-time compare, for anywhere a stored value is checked against
// a submitted one. Not used on the hot path today; here so a future
// caller does not reach for === on a secret.
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
