// AES-256-GCM for provider credentials (T24). 32-byte key = sha256(secret);
// fresh 12-byte IV per write; stored as versioned base64url of iv||tag||ct.
// Decrypt throws a clear error on wrong key, tampering, or bad encoding.
//
// The empty secret is a valid dev-only key: zero-setup runs use an in-memory
// credential store, so the value only needs the contract that rows never hold
// plaintext. DATABASE_URL deployments require CRED_ENC_KEY (enforced in
// src/infrastructure/config.ts).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const CRED_ENC_VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CRED_ENC_VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
  }

  decrypt(blob: string): string {
    const sep = blob.indexOf(":");
    if (sep < 0 || blob.slice(0, sep) !== CRED_ENC_VERSION) {
      throw new Error(`credential decrypt failed: unsupported encoding (expected "${CRED_ENC_VERSION}:<base64url>")`);
    }
    const raw = Buffer.from(blob.slice(sep + 1), "base64url");
    if (raw.length < IV_LENGTH + TAG_LENGTH) {
      throw new Error("credential decrypt failed: malformed payload");
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // GCM authentication failure — wrong key or tampered data.
      throw new Error("credential decrypt failed: wrong key or tampered data");
    }
  }
}
