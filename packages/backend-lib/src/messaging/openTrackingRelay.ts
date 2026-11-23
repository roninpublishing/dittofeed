import { createHmac, timingSafeEqual } from "crypto";

/** Authenticity of an edge observation, never identity or human-open proof. */
export function verifyOpenTrackingRelay({ rawBody, timestamp, signature, secret, now = Date.now() }: {
  rawBody: Buffer;
  timestamp: unknown;
  signature: unknown;
  secret: string | undefined;
  now?: number;
}): boolean {
  if (!secret || typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp) ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
      rawBody.byteLength > 16_384) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32 || key.toString("base64") !== secret) return false;
  const expected = createHmac("sha256", new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
    .update(timestamp).update(".")
    .update(new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)).digest();
  const supplied = Buffer.from(signature, "hex");
  return timingSafeEqual(
    new Uint8Array(supplied.buffer, supplied.byteOffset, supplied.byteLength),
    new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
  );
}
