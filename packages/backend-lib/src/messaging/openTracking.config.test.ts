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
  delete process.env.ENABLE_OPEN_TRACKING_DEV_LAKE;
  delete process.env.OPEN_TRACKING_RETENTION_DAYS;
  delete process.env.OPEN_TRACKING_RELAY_SECRET;
  delete process.env.OPEN_TRACKING_SELF_IPS;
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
  it("defaults to disabled and retains evidence for 30 days", () => {
    expect(isolatedConfig()).toMatchObject({ enableOpenTracking: false, enableOpenTrackingDevLake: false, openTrackingRetentionDays: 30 });
  });

  it("requires deliberate enablement and an authenticated relay key", () => {
    const relay = Buffer.alloc(32, 9).toString("base64");
    expect(isolatedConfig({ OPEN_TRACKING_RELAY_SECRET: relay }).enableOpenTracking).toBe(false);
    expect(() => isolatedConfig({ ENABLE_OPEN_TRACKING: "true" })).toThrow();
    expect(isolatedConfig({ ENABLE_OPEN_TRACKING: "true", OPEN_TRACKING_RELAY_SECRET: relay }).enableOpenTracking).toBe(true);
  });

  it("requires explicit capture enablement before the isolated development lake can collect", () => {
    const relay = Buffer.alloc(32, 9).toString("base64");
    expect(() => isolatedConfig({ ENABLE_OPEN_TRACKING_DEV_LAKE: "true" }))
      .toThrow("ENABLE_OPEN_TRACKING_DEV_LAKE requires ENABLE_OPEN_TRACKING.");
    const enabled = isolatedConfig({
      ENABLE_OPEN_TRACKING: "true", ENABLE_OPEN_TRACKING_DEV_LAKE: "true",
      OPEN_TRACKING_RELAY_SECRET: relay,
    });
    expect(enabled).toMatchObject({ enableOpenTracking: true, enableOpenTrackingDevLake: true });
    expect(isolatedConfig({
      ENABLE_OPEN_TRACKING: "true", ENABLE_OPEN_TRACKING_DEV_LAKE: "false",
      OPEN_TRACKING_RELAY_SECRET: relay,
    }).enableOpenTrackingDevLake).toBe(false);
    expect(() => isolatedConfig({
      ENABLE_OPEN_TRACKING: "true", ENABLE_OPEN_TRACKING_DEV_LAKE: "true",
    })).toThrow("Enabling open tracking requires OPEN_TRACKING_RELAY_SECRET.");
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
        ENABLE_OPEN_TRACKING: "true", OPEN_TRACKING_RELAY_SECRET: Buffer.alloc(32, 9).toString("base64"),
        SECRET_KEY: key,
      })).toThrow("Enabling open tracking requires an explicit 32-byte base64 SECRET_KEY.");
    },
  );


  it.each(["1", "2", "30", "365"])("accepts bounded whole-day retention: %s", (days) => {
    expect(isolatedConfig({ OPEN_TRACKING_RETENTION_DAYS: days }).openTrackingRetentionDays).toBe(Number(days));
  });

  it("accepts only explicit staff IPv4 and IPv6 addresses without guessing identities", () => {
    expect(isolatedConfig().openTrackingSelfIps).toEqual([]);
    expect(
      isolatedConfig({ OPEN_TRACKING_SELF_IPS: "192.0.2.8, 2001:db8::8" })
        .openTrackingSelfIps,
    ).toEqual(["192.0.2.8", "2001:db8::8"]);
    for (const value of [
      "private-host.invalid",
      "192.0.2.8/24",
      "192.0.2.8,",
      Array(257).fill("192.0.2.8").join(","),
    ]) {
      expect(() => isolatedConfig({ OPEN_TRACKING_SELF_IPS: value })).toThrow(
        "OPEN_TRACKING_SELF_IPS must contain at most 256 comma-separated IP addresses.",
      );
    }
  });

  it.each(["0", "-1", "1.5", "366", "Infinity", "999999"])("rejects unbounded or invalid retention: %s", (days) => {
    expect(() => isolatedConfig({ OPEN_TRACKING_RETENTION_DAYS: days })).toThrow();
  });
});
