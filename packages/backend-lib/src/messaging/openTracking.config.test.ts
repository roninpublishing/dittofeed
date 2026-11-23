import type { Config } from "../config";

// Configuration validation must not depend on a developer's ignored .env file.
// Global database setup is performed separately by the existing test harness.
jest.mock("dotenv", () => ({
  __esModule: true,
  default: { config: () => ({}) },
  config: () => ({}),
}));

function isolatedConfig(overrides: Record<string, string> = {}): Config {
  const previous = process.env;
  process.env = { ...previous };
  delete process.env.ENABLE_OPEN_TRACKING;
  delete process.env.OPEN_TRACKING_BASE_URL;
  delete process.env.OPEN_TRACKING_RETENTION_DAYS;
  delete process.env.OPEN_TRACKING_RELAY_SECRET;
  Object.assign(process.env, overrides);
  process.env.SECRET_KEY = overrides.SECRET_KEY ?? Buffer.alloc(32, 7).toString("base64");
  let settings: Config | undefined;
  try {
    jest.isolateModules(() => {
      settings = jest.requireActual<{ default: () => Config }>("../config").default();
    });
    if (!settings) throw new Error("Configuration was not loaded");
    return settings;
  } finally {
    process.env = previous;
  }
}

describe("owned open tracking configuration", () => {
  it("defaults to disabled without inventing a public URL and retains evidence for 30 days", () => {
    expect(isolatedConfig()).toMatchObject({ enableOpenTracking: false, openTrackingRetentionDays: 30 });
    expect(isolatedConfig().openTrackingBaseUrl).toBeUndefined();
  });

  it("requires deliberate enablement as well as a configured public URL", () => {
    expect(isolatedConfig({ OPEN_TRACKING_BASE_URL: "https://pixels.example.com" }).enableOpenTracking).toBe(false);
    expect(() => isolatedConfig({ ENABLE_OPEN_TRACKING: "true" })).toThrow();
    expect(isolatedConfig({ ENABLE_OPEN_TRACKING: "true", OPEN_TRACKING_BASE_URL: "https://pixels.example.com/" }))
      .toMatchObject({ enableOpenTracking: true, openTrackingBaseUrl: "https://pixels.example.com" });
  });

  it("allows newsletter-only origins with an explicit relay key instead of a fabricated shared hostname", () => {
    const settings = isolatedConfig({
      ENABLE_OPEN_TRACKING: "true",
      OPEN_TRACKING_RELAY_SECRET: Buffer.alloc(32, 9).toString("base64"),
    });
    expect(settings.enableOpenTracking).toBe(true);
    expect(settings.openTrackingBaseUrl).toBeUndefined();
  });

  it.each(["malformed", Buffer.alloc(16, 9).toString("base64")])(
    "refuses an explicitly invalid relay key",
    (key) => {
      expect(() => isolatedConfig({ OPEN_TRACKING_RELAY_SECRET: key })).toThrow();
    },
  );

  it.each(["", "not-a-valid-key", Buffer.alloc(16, 7).toString("base64")])(
    "refuses capture with a missing or invalid encryption key",
    (key) => {
      expect(() => isolatedConfig({
        ENABLE_OPEN_TRACKING: "true", OPEN_TRACKING_BASE_URL: "https://pixels.example.com",
        SECRET_KEY: key,
      })).toThrow("Enabling open tracking requires an explicit 32-byte base64 SECRET_KEY.");
    },
  );

  it.each([
    "http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.2:3000", "http://[::1]:3000",
  ])("permits explicit HTTP only for loopback: %s", (url) => {
    expect(isolatedConfig({ ENABLE_OPEN_TRACKING: "true", OPEN_TRACKING_BASE_URL: url }).openTrackingBaseUrl).toBe(url);
  });

  it.each([
    "http://pixels.example.com", "https://user:credential-secret@pixels.example.com",
    "https://pixels.example.com?token=query-secret", "https://pixels.example.com/#fragment-secret",
    "https://pixels.example.com/prefix", "not-a-url", "file:///private/path",
    "http://localhost.example.com", "http://192.168.1.10:3000",
  ])("rejects unsafe/non-origin URLs without echoing supplied secrets: %s", (url) => {
    expect(() => isolatedConfig({ ENABLE_OPEN_TRACKING: "true", OPEN_TRACKING_BASE_URL: url }))
      .toThrow("OPEN_TRACKING_BASE_URL must be an HTTPS origin (HTTP is allowed only on loopback).");
  });

  it.each(["1", "2", "30", "365"])("accepts bounded whole-day retention: %s", (days) => {
    expect(isolatedConfig({ OPEN_TRACKING_RETENTION_DAYS: days }).openTrackingRetentionDays).toBe(Number(days));
  });

  it.each(["0", "-1", "1.5", "366", "Infinity", "999999"])("rejects unbounded or invalid retention: %s", (days) => {
    expect(() => isolatedConfig({ OPEN_TRACKING_RETENTION_DAYS: days })).toThrow();
  });
});
