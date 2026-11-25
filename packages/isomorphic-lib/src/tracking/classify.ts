/** Adapted from yuriyward/mail-tracker, commit 51ea4e7551564f6ddb55b60a34754863400e9133. */
/* eslint-disable prefer-regex-literals -- Static constructors preserve Unicode semantics with this package's ES5 compile target. */
import { isbot } from "isbot";

import { gmailProxyReason } from "./gmail-proxy";
import { ipKey } from "./ip-key";
import { NetworkLookup, publishedNetworkLookup } from "./networks";

export const EVENT_CLASSES = [
  "human",
  "apple_proxy",
  "gmail_proxy",
  "prefetch",
  "scanner",
  "self",
  "unknown",
] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

/** Change this identifier whenever classification or counting policy changes. */
export const RULES_VERSION = "mail-tracker-51ea4e7-ronin-v1";
export const EARLY_CLICK_MS = 10_000;
export const EARLY_OPEN_MS = 30_000;
export const BURST_WINDOW_MS = 3_000;
export const DEDUPE_WINDOW_MS = 30_000;

export interface TrackingHit {
  kind: "open" | "click";
  method: string;
  userAgent: string;
  asOrganization: string;
  ip: string;
  /** Only an authenticated owner assertion, never a caller-supplied header. */
  ownerVerified: boolean;
  /** Hit time minus verified provider delivery time; null means unavailable. */
  ageMs: number | null;
  /** Other distinct links of this send/actor within the preceding BURST_WINDOW_MS. */
  otherLinksInBurst: number;
  selfIps: readonly string[];
  /**
   * Elapsed time from an earlier hit of this send/kind/IP/UA/HTTP method.
   * Excludes the current receipt and future hits; a HEAD must not suppress a GET.
   */
  recentActorHitMs?: number | null;
}
export type Hit = TrackingHit;

export interface Classification {
  class: EventClass;
  reason: string;
  /** A heuristic policy flag, not proof that a person read the message. */
  counted: boolean;
  rulesVersion: string;
}

const SCANNER_UA = new RegExp(
  String.raw`bot\b|crawler|spider|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|headlesschrome|phantomjs|barracuda|proofpoint|mimecast|symantec|forcepoint|trendmicro|safelinks|scanner|preview`,
  "iu",
);
const LINK_PREVIEW_UA: readonly [RegExp, string][] = [
  [new RegExp(String.raw`facebookexternalhit\/[\d.]+ Facebot Twitterbot`, "iu"), "iMessage"],
  [new RegExp(String.raw`applebot`, "iu"), "Apple"],
  [new RegExp(String.raw`telegrambot`, "iu"), "Telegram"],
  [new RegExp(String.raw`slackbot`, "iu"), "Slack"],
  [new RegExp(String.raw`skypeuripreview`, "iu"), "Microsoft Teams"],
  [new RegExp(String.raw`linkedinbot`, "iu"), "LinkedIn"],
  [new RegExp(String.raw`discordbot`, "iu"), "Discord"],
  [new RegExp(String.raw`whatsapp`, "iu"), "WhatsApp"],
  [new RegExp(String.raw`facebookexternalhit`, "iu"), "Facebook"],
  [new RegExp(String.raw`twitterbot`, "iu"), "Twitter"],
];
const ON_OPEN_PROXY_UA = new RegExp(
  String.raw`googleimageproxy|ggpht\.com|yahoomailproxy|outlook-imageproxy`,
  "iu",
);
const BARE_MOZILLA_UA = new RegExp(String.raw`^Mozilla\/5\.0$`, "u");
const HUMAN_UA = new RegExp(String.raw`^Mozilla\/5\.0 \(|thunderbird|outlook|mail\/\d`, "iu");
const MAIL_CLIENT_UA = new RegExp(String.raw`^(?:thunderbird|outlook|mail\/\d)`, "iu");
const IMAGE_PROXY_NETWORK = new RegExp(String.raw`\b(?:google|apple|microsoft|yahoo|oath)\b`, "iu");
const DATA_CENTRE_NETWORK = new RegExp(
  String.raw`\b(?:google|microsoft|amazon|digitalocean|ovh|hetzner|linode|akamai)\b`,
  "iu",
);
const APPLE_NETWORK = new RegExp(String.raw`\bapple\b`, "iu");
const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/**
 * Reference order: self, scanners, proxies, humans, unknown. Known mail proxies
 * are exempt from supplemental isbot matching, not from the original scanner rules.
 * Yahoo/Outlook on-open proxies retain reference counting in the human policy class;
 * their reason still explicitly identifies the image proxy, not a verified human.
 */
export const classify = (
  hit: TrackingHit,
  networks: NetworkLookup = publishedNetworkLookup,
): Classification => {
  const finish = (
    eventClass: EventClass,
    reason: string,
    counted = false,
  ): Classification => {
    const elapsed = hit.recentActorHitMs;
    const duplicate =
      counted &&
      elapsed !== undefined &&
      elapsed !== null &&
      elapsed >= 0 &&
      elapsed < DEDUPE_WINDOW_MS;
    return {
      class: eventClass,
      reason: duplicate ? `${reason}; duplicate actor hit within 30s` : reason,
      counted: counted && !duplicate,
      rulesVersion: RULES_VERSION,
    };
  };
  const key = hit.selfIps.length === 0 ? null : ipKey(hit.ip);
  if (
    key !== null &&
    hit.selfIps.some((ip) => {
      const self = ipKey(ip);
      return self?.version === key.version && self.key === key.key;
    })
  ) {
    return finish("self", "IP is listed in SELF_IPS");
  }
  if (hit.ownerVerified) {
    return finish("self", "verified Cloudflare Access token");
  }

  const network = hit.ip === "" ? null : networks(hit.ip);
  const preview = LINK_PREVIEW_UA.find(([pattern]) => pattern.test(hit.userAgent));
  if (preview) {
    return finish("scanner", `link preview by ${preview[1]}`);
  }
  const proxyUa = ON_OPEN_PROXY_UA.exec(hit.userAgent);
  if (hit.kind === "click" && proxyUa) {
    return finish("scanner", "click with an image-proxy user agent (automated)");
  }
  if (hit.method === "HEAD") {
    return finish("scanner", "HEAD request");
  }
  if (hit.method !== "GET") {
    return finish("scanner", "non-GET request");
  }
  const scanner = SCANNER_UA.exec(hit.userAgent);
  if (scanner) {
    return finish("scanner", `scanner user agent (${scanner[0]})`);
  }
  if (network?.[hit.kind] === "scanner") {
    return finish("scanner", `IP in the ${network.name}`);
  }
  const age = hit.ageMs !== null && Number.isFinite(hit.ageMs) ? hit.ageMs : null;
  if (hit.kind === "click") {
    if (age !== null && age < EARLY_CLICK_MS) {
      return finish("scanner", `clicked ${seconds(age)} after delivery`);
    }
    if (hit.otherLinksInBurst > 0) {
      return finish(
        "scanner",
        `burst: ${hit.otherLinksInBurst + 1} links clicked within ${seconds(BURST_WINDOW_MS)}`,
      );
    }
    if (DATA_CENTRE_NETWORK.test(hit.asOrganization)) {
      return finish("scanner", `click from a data-centre network (${hit.asOrganization})`);
    }
  }
  if (
    !proxyUa &&
    !BARE_MOZILLA_UA.test(hit.userAgent) &&
    !MAIL_CLIENT_UA.test(hit.userAgent) &&
    isbot(hit.userAgent)
  ) {
    return finish("scanner", "scanner user agent (isbot)");
  }

  let onOpenReason: string | null = null;
  if (hit.kind === "open" && proxyUa) {
    onOpenReason = `on-open image proxy (${proxyUa[0]})`;
  } else if (network?.[hit.kind] === "on-open") {
    onOpenReason = `on-open image proxy: IP in the ${network.name}`;
  }
  if (onOpenReason !== null) {
    if (gmailProxyReason.matches(onOpenReason)) {
      if (age !== null && Math.abs(age) <= EARLY_OPEN_MS) {
        return finish("prefetch", `Gmail delivery prefetch within ±30s of delivery; ${onOpenReason}`);
      }
      return finish("gmail_proxy", onOpenReason, true);
    }
    return finish("human", onOpenReason, true);
  }
  if (network?.[hit.kind] === "prefetch") {
    return finish(
      network.id === "apple-private-relay" ? "apple_proxy" : "prefetch",
      `prefetch: IP in the ${network.name}`,
    );
  }
  if (hit.kind === "open") {
    if (BARE_MOZILLA_UA.test(hit.userAgent)) {
      return finish("apple_proxy", "prefetch: bare Mozilla/5.0 user agent (Apple Mail Privacy Protection)");
    }
    if (IMAGE_PROXY_NETWORK.test(hit.asOrganization)) {
      return finish(
        APPLE_NETWORK.test(hit.asOrganization) ? "apple_proxy" : "prefetch",
        `prefetch: fetched from a mail provider network (${hit.asOrganization})`,
      );
    }
    if (age !== null && age < EARLY_OPEN_MS) {
      return finish("prefetch", `prefetch: opened ${seconds(age)} after delivery`);
    }
  }
  if (HUMAN_UA.test(hit.userAgent)) {
    return finish("human", "browser or mail-client user agent", true);
  }
  return finish("unknown", hit.userAgent === "" ? "no user agent" : "no recognised signal");
};
