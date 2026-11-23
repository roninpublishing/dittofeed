import { randomBytes } from "crypto";

import config, { DEFAULT_BACKEND_CONFIG } from "./config";
import {
  decryptNewsletterSecret,
  encryptNewsletterSecret,
} from "./newsletterSecrets";

describe("newsletter durable secret encryption", () => {
  const initialKey = config().secretKey;
  const initialEnvironmentKey = process.env.SECRET_KEY;
  afterEach(() => {
    config().secretKey = initialKey;
    if (initialEnvironmentKey === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = initialEnvironmentKey;
  });

  it("rejects missing, inherited public development and mismatched keys", () => {
    delete process.env.SECRET_KEY;
    expect(() => encryptNewsletterSecret("fixture-private-key")).toThrow(
      "explicit stable",
    );
    process.env.SECRET_KEY = DEFAULT_BACKEND_CONFIG.secretKey;
    config().secretKey = DEFAULT_BACKEND_CONFIG.secretKey;
    expect(() => encryptNewsletterSecret("fixture-private-key")).toThrow(
      "explicit stable",
    );
    process.env.SECRET_KEY = randomBytes(32).toString("base64");
    config().secretKey = randomBytes(32).toString("base64");
    expect(() => encryptNewsletterSecret("fixture-private-key")).toThrow(
      "explicit stable",
    );
  });

  it("stores randomized authenticated ciphertext and rejects modified data", () => {
    const key = randomBytes(32).toString("base64");
    process.env.SECRET_KEY = key;
    config().secretKey = key;
    const encrypted = encryptNewsletterSecret("fixture-private-key");
    expect(JSON.stringify(encrypted)).not.toContain("fixture-private-key");
    expect(encryptNewsletterSecret("fixture-private-key")).not.toEqual(
      encrypted,
    );
    expect(decryptNewsletterSecret(encrypted)).toBe("fixture-private-key");
    expect(() =>
      decryptNewsletterSecret({ ...encrypted, authTag: "00".repeat(16) }),
    ).toThrow("could not be decrypted");
  });
});
