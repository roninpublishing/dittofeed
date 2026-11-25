/** Adapted from yuriyward/mail-tracker unit, labels, track and gmail-prefetch tests at 51ea4e7551564f6ddb55b60a34754863400e9133. */
import {
  BURST_WINDOW_MS,
  classify,
  DEDUPE_WINDOW_MS,
  EARLY_CLICK_MS,
  EARLY_OPEN_MS,
  EventClass,
  Hit,
  RULES_VERSION,
} from "./classify";
import { networkLookup } from "./networks";

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const GMAIL =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const hit = (overrides: Partial<Hit> = {}): Hit => ({
  ageMs: 3_600_000,
  asOrganization: "Example Broadband",
  ip: "198.51.100.7",
  kind: "open",
  method: "GET",
  otherLinksInBurst: 0,
  ownerVerified: false,
  selfIps: [],
  userAgent: BROWSER,
  ...overrides,
});
const FIXTURE = networkLookup({
  "apple-private-relay": ["172.224.226.0/27", "2a02:26f7:b3c0:4000::/64"],
  "google-services": ["66.249.80.0/20"],
  "microsoft-exchange-online": ["40.92.0.0/15", "40.107.0.0/16"],
  mimecast: ["205.139.110.0/24"],
  "proofpoint-essentials": ["148.163.128.0/19"],
});

describe("classification (reference rules with expanded classes)", () => {
  test.each<[string, Partial<Hit>, EventClass, boolean]>([
    ["browser open", {}, "human", true],
    ["browser click", { kind: "click" }, "human", true],
    ["own IP", { selfIps: ["198.51.100.7"] }, "self", false],
    ["verified owner", { ownerVerified: true }, "self", false],
    ["Mailspring", { userAgent: "Mozilla/5.0 (Macintosh) Mailspring/1.16" }, "human", true],
    ["Thunderbird", { userAgent: "Thunderbird/128.0" }, "human", true],
    ["Outlook", { userAgent: "Outlook/16.0" }, "human", true],
    ["Apple Mail", { userAgent: "Mail/16" }, "human", true],
    ["Gmail proxy", { userAgent: GMAIL }, "gmail_proxy", true],
    ["Apple MPP", { userAgent: "Mozilla/5.0" }, "apple_proxy", false],
    ["Apple ASN", { asOrganization: "Apple Inc." }, "apple_proxy", false],
    ["Google ASN without proxy evidence", { asOrganization: "Google LLC" }, "prefetch", false],
    ["early open", { ageMs: 4000 }, "prefetch", false],
    ["HEAD", { method: "HEAD" }, "scanner", false],
    ["unsupported method", { method: "POST" }, "scanner", false],
    ["bot UA", { userAgent: "python-requests/2.32" }, "scanner", false],
    ["isbot supplement", { userAgent: "APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)" }, "scanner", false],
    ["early click", { ageMs: 2000, kind: "click" }, "scanner", false],
    ["burst", { kind: "click", otherLinksInBurst: 2 }, "scanner", false],
    ["data-centre click", { asOrganization: "Microsoft Corporation", kind: "click" }, "scanner", false],
    ["no UA", { userAgent: "" }, "unknown", false],
    ["unrecognised UA", { userAgent: "SomethingElse/1.0 (Experimental; Desktop)" }, "unknown", false],
  ])("%s", (_name, overrides, eventClass, counted) => {
    expect(classify(hit(overrides), FIXTURE)).toMatchObject({
      class: eventClass,
      counted,
      rulesVersion: RULES_VERSION,
    });
    expect(classify(hit(overrides), FIXTURE).reason.length).toBeGreaterThan(0);
  });

  test("preserves reference reasons and a fixed rules version", () => {
    expect(classify(hit())).toEqual({
      class: "human",
      counted: true,
      reason: "browser or mail-client user agent",
      rulesVersion: "mail-tracker-51ea4e7-ronin-v1",
    });
    expect(classify(hit({ userAgent: GMAIL }))).toMatchObject({
      reason: "on-open image proxy (ggpht.com)",
    });
    expect([EARLY_CLICK_MS, BURST_WINDOW_MS, EARLY_OPEN_MS, DEDUPE_WINDOW_MS])
      .toEqual([10_000, 3000, 30_000, 30_000]);
  });

  test.each<[string, string]>([
    ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "Slack"],
    ["Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5", "Microsoft Teams"],
    ["LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient)", "LinkedIn"],
    ["TelegramBot (like TwitterBot)", "Telegram"],
    ["Mozilla/5.0 (compatible; Discordbot/2.0)", "Discord"],
    ["WhatsApp/2.23.20.0 A", "WhatsApp"],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit)", "Facebook"],
    ["Twitterbot/1.0", "Twitter"],
    [`${BROWSER} facebookexternalhit/1.1 Facebot Twitterbot/1.0`, "iMessage"],
    ["Mozilla/5.0 (Macintosh) Version/17.0 Safari/605 (Applebot/0.1)", "Apple"],
  ])("link preview %s", (userAgent, platform) => {
    for (const kind of ["open", "click"] as const) {
      expect(classify(hit({ kind, userAgent }))).toMatchObject({
        class: "scanner",
        counted: false,
        reason: `link preview by ${platform}`,
      });
    }
  });

  test.each([
    GMAIL,
    "Mozilla/5.0 (compatible; YahooMailProxy; https://help.yahoo.com)",
    "Mozilla/5.0 (Windows NT 10.0) Outlook-ImageProxy/1.0",
  ])("a click with image-proxy UA %s is automation", (userAgent) => {
    expect(classify(hit({ kind: "click", userAgent }))).toMatchObject({
      class: "scanner",
      counted: false,
      reason: "click with an image-proxy user agent (automated)",
    });
  });

  test.each([
    "Mozilla/5.0 (compatible; YahooMailProxy; https://help.yahoo.com)",
    "Mozilla/5.0 (Windows NT 10.0) Outlook-ImageProxy/1.0",
  ])("other on-open proxies retain reference counting: %s", (userAgent) => {
    expect(classify(hit({ userAgent, ageMs: 1000, ip: "40.107.22.5" }), FIXTURE))
      .toMatchObject({ class: "human", counted: true, reason: expect.stringContaining("on-open image proxy") });
  });

  test.each(["Proofpoint URL Defense", "Mimecast/1.0", "Microsoft SafeLinks", "curl/8.0", "HeadlessChrome/130.0"])(
    "security and automation UA %s",
    (userAgent) => {
      expect(classify(hit({ userAgent }))).toMatchObject({ class: "scanner", counted: false });
    },
  );

  test.each([-31_000, -30_000, 0, 30_000, 31_000, null])(
    "Apple proxy never counts regardless of delivery age %s",
    (ageMs) => {
      for (const overrides of [
        { userAgent: "Mozilla/5.0" },
        { ip: "172.224.226.5" },
        { asOrganization: "Apple Inc." },
      ]) {
        expect(classify(hit({ ...overrides, ageMs }), FIXTURE))
          .toMatchObject({ class: "apple_proxy", counted: false });
      }
    },
  );

  test("self wins over scanner, proxy, HEAD and timing evidence", () => {
    expect(classify(hit({ method: "HEAD", userAgent: GMAIL, ageMs: 0, ownerVerified: true })))
      .toMatchObject({ class: "self", counted: false });
    expect(classify(hit({ ip: "::ffff:198.51.100.7", selfIps: ["198.51.100.7"] })))
      .toMatchObject({ class: "self", counted: false });
    expect(classify(hit({ ip: "2001:db8::1", selfIps: ["2001:0DB8:0:0:0:0:0:1"] })))
      .toMatchObject({ class: "self", counted: false });
    expect(classify(hit({ ip: "", selfIps: [""] }))).toMatchObject({ class: "human", counted: true });
    expect(classify(hit({ ip: "garbage", selfIps: ["garbage"] })))
      .not.toMatchObject({ class: "self" });
  });

  test.each([null, Number.NaN, Number.POSITIVE_INFINITY])("missing/invalid delivery time %s is not early", (ageMs) => {
    for (const kind of ["open", "click"] as const) {
      expect(classify(hit({ kind, ageMs }))).toMatchObject({ class: "human", counted: true });
    }
  });

  test.each<[number, boolean]>([[9999, false], [10_000, true]])("click threshold %s", (ageMs, counted) => {
    expect(classify(hit({ kind: "click", ageMs })).counted).toBe(counted);
  });
  test.each<[number, boolean]>([[29_999, false], [30_000, true]])("open threshold %s", (ageMs, counted) => {
    expect(classify(hit({ ageMs })).counted).toBe(counted);
  });
});

describe("Gmail delivery prefetch (ported read-time rule)", () => {
  test.each<[number | null, EventClass, boolean]>([
    [-31_000, "gmail_proxy", true],
    [-30_001, "gmail_proxy", true],
    [-30_000, "prefetch", false],
    [-7000, "prefetch", false],
    [0, "prefetch", false],
    [6000, "prefetch", false],
    [30_000, "prefetch", false],
    [30_001, "gmail_proxy", true],
    [31_000, "gmail_proxy", true],
    [null, "gmail_proxy", true],
  ])("age %s", (ageMs, eventClass, counted) => {
    for (const overrides of [{ userAgent: GMAIL }, { ip: "66.249.84.10" }]) {
      expect(classify(hit({ ...overrides, ageMs }), FIXTURE))
        .toMatchObject({ class: eventClass, counted });
    }
  });

  test("a HEAD Gmail fetch is still a non-counted scanner", () => {
    expect(classify(hit({ userAgent: GMAIL, method: "HEAD" })))
      .toMatchObject({ class: "scanner", counted: false, reason: "HEAD request" });
  });
  test("security network takes precedence over Gmail UA", () => {
    expect(classify(hit({ userAgent: GMAIL, ip: "205.139.110.12" }), FIXTURE))
      .toMatchObject({ class: "scanner", counted: false });
  });
});

describe("duplicate actor window", () => {
  test.each<[number | null | undefined, boolean]>([
    [undefined, true], [null, true], [-1, true], [0, false], [29_999, false],
    [30_000, true], [30_001, true], [Number.NaN, true],
  ])("elapsed %s counts %s", (recentActorHitMs, counted) => {
    for (const userAgent of [BROWSER, GMAIL]) {
      const result = classify(hit({ userAgent, recentActorHitMs }));
      expect(result.counted).toBe(counted);
      expect(result.class).toBe(userAgent === GMAIL ? "gmail_proxy" : "human");
      expect(result.reason.includes("duplicate")).toBe(!counted);
    }
  });
  test("duplicate evidence does not relabel scanners or self as people", () => {
    expect(classify(hit({ method: "HEAD", recentActorHitMs: 1 })))
      .toMatchObject({ class: "scanner", counted: false });
    expect(classify(hit({ ownerVerified: true, recentActorHitMs: 1 })))
      .toMatchObject({ class: "self", counted: false });
  });
});
