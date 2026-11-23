import config, { DEFAULT_BACKEND_CONFIG } from "./config";
import { decrypt, encrypt } from "./secrets";

export interface NewsletterEncryptedSecret {
  iv: string;
  encryptedData: string;
  authTag: string;
}

/** Never accept the repository's public development key for durable credentials. */
export function requireNewsletterSecretKey(): string {
  const key = config().secretKey;
  if (
    !process.env.SECRET_KEY ||
    !key ||
    key === DEFAULT_BACKEND_CONFIG.secretKey ||
    key !== process.env.SECRET_KEY ||
    Buffer.from(key, "base64").length !== 32
  ) {
    throw new Error(
      "Newsletter credentials require an explicit stable 32-byte base64 SECRET_KEY.",
    );
  }
  return key;
}

export function encryptNewsletterSecret(
  value: string,
): NewsletterEncryptedSecret {
  return encrypt(value, requireNewsletterSecretKey());
}

export function decryptNewsletterSecret(
  value: NewsletterEncryptedSecret,
): string {
  const plaintext = decrypt({
    ...value,
    secretKey: requireNewsletterSecretKey(),
  });
  if (plaintext === null)
    throw new Error("Newsletter credential could not be decrypted.");
  return plaintext;
}
