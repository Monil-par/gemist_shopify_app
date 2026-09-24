import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getEncryptionKey() {
  const dedicated = (process.env.CREDENTIALS_ENCRYPTION_KEY || "").trim();
  const secret = dedicated || process.env.SHOPIFY_API_SECRET || "";
  if (!secret) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY or SHOPIFY_API_SECRET is required to encrypt merchant credentials.",
    );
  }

  return scryptSync(secret, "gemist-merchant-credentials", 32);
}

export function encrypt(value: string) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(payload: string) {
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, IV_LENGTH);
  const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}
