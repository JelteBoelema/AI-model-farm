// AES-256-GCM envelope for sensitive values that must be stored by us (e.g. in the local
// secrets driver). Format: v1.<iv>.<tag>.<ciphertext>, all base64url.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const VERSION = "v1";

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return key;
}

export function encrypt(plaintext: string, base64Key: string, associatedData = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(envelope: string, base64Key: string, associatedData = ""): string {
  const [version, iv, tag, ciphertext] = envelope.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
