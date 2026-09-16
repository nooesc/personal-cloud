import type { Env } from "../env";
import { fail } from "../core";
const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function unbase64(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function digest(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32)
    fail(503, "Hosted encryption is not configured");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(env.ENCRYPTION_KEY)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(
  env: Env,
  context: string,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await encryptionKey(env),
    encoder.encode(value),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function open(
  env: Env,
  context: string,
  value: string,
): Promise<string> {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted)
    fail(500, "Invalid encrypted credential");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64(iv),
        additionalData: encoder.encode(context),
      },
      await encryptionKey(env),
      unbase64(encrypted),
    ),
  );
}
async function hmacKey(
  secret: string,
  usage: ("sign" | "verify")[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}
export async function sign(secret: string, value: string): Promise<string> {
  if (!secret || secret.length < 32)
    fail(503, "Hosted session signing is not configured");
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret, ["sign"]),
        encoder.encode(value),
      ),
    ),
  );
}
export async function verify(
  secret: string,
  value: string,
  signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      unbase64(signature),
      encoder.encode(value),
    );
  } catch {
    return false;
  }
}
export async function verifyWebhook(
  secret: string,
  bytes: ArrayBuffer,
  signature: string,
): Promise<boolean> {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const sig = Uint8Array.from(signature.slice(7).match(/../g)!, (x) =>
    parseInt(x, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    sig,
    bytes,
  );
}
