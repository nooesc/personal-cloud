import { fail } from "./core";
const encoder = new TextEncoder();
export async function sha256(value: string | Uint8Array): Promise<string> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function token(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function equal(a: string, b: string): boolean {
  const aa = encoder.encode(a),
    bb = encoder.encode(b);
  return aa.length === bb.length && crypto.subtle.timingSafeEqual(aa, bb);
}
async function key(secret: string) {
  if (!secret || secret.length < 32) fail(503, "Encryption is not configured");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
export async function seal(
  secret: string,
  context: string,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await key(secret),
    encoder.encode(value),
  );
  return base64(iv) + "." + base64(new Uint8Array(ciphertext));
}
export async function open(
  secret: string,
  context: string,
  value: string,
): Promise<string> {
  const [iv, data] = value.split(".");
  if (!iv || !data) fail(500, "Invalid encrypted value");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)),
        additionalData: encoder.encode(context),
      },
      await key(secret),
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    ),
  );
}
