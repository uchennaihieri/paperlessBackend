import crypto from "crypto";

// Derive a stable 32-char AES-256 key from the JWT secret
function getKey(): string {
  const secret = process.env.JWT_SECRET ?? "default_local_secret_key_needs_32B";
  return crypto.createHash("sha256").update(secret).digest("base64").substring(0, 32);
}

const IV_LENGTH = 16;

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(getKey()), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text: string): string {
  if (!text) return "";
  const parts = text.split(":");
  const iv = Buffer.from(parts.shift()!, "hex");
  const encryptedText = Buffer.from(parts.join(":"), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(getKey()), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
