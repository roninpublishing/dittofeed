// Adapted from yuriyward/mail-tracker scripts/refresh-networks.ts at
// 51ea4e7551564f6ddb55b60a34754863400e9133 (Ronin-owned reference).
// That revision contains no separate license notice; upstream attribution is retained.
import type { IpRange } from "isomorphic-lib/src/tracking/ip";
import { mergeRanges, parseCidr, rangeToCidrs, subtractRanges } from "isomorphic-lib/src/tracking/ip";
import type { NetworkRanges } from "isomorphic-lib/src/tracking/networks";
import { PUBLISHED_NETWORKS } from "isomorphic-lib/src/tracking/networks";

export const ACTIVE_NETWORK_KEY = "active";
export const NETWORK_SET_PREFIX = "sets:";
export interface NetworkSet {
  version: string;
  generatedAt: string;
  ranges: NetworkRanges;
}
let cachedNamespace: KVNamespace | undefined;
let cachedSet: NetworkSet | undefined;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 15_000;
const MAX_SPF_RECORDS = 20;
const PROOFPOINT_ESSENTIALS = [
  "67.231.144.0/22", "67.231.148.0/23", "67.231.152.0/22", "67.231.156.0/24",
  "148.163.128.0/19", "208.56.1.0/25", "91.207.212.0/23", "91.209.104.0/24",
  "185.132.180.0/22", "185.183.28.0/22",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toRanges(cidrs: readonly string[]): IpRange[] {
  return cidrs.map((cidr) => {
    const range = parseCidr(cidr);
    if (!range) throw new Error("invalid network range");
    return range;
  });
}

export async function loadActiveNetworkSet(kv: KVNamespace): Promise<NetworkSet | null> {
  const version = await kv.get(ACTIVE_NETWORK_KEY);
  if (version === null) return null;
  if (!version || version.length > 128) throw new Error("invalid active network version");
  if (cachedNamespace === kv && cachedSet?.version === version) return cachedSet;
  const value: unknown = await kv.get(`${NETWORK_SET_PREFIX}${version}`, "json");
  if (!record(value) || value.version !== version || typeof value.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.generatedAt)) || !record(value.ranges)) {
    throw new Error("active network set unavailable");
  }
  const ranges: Record<string, string[]> = {};
  for (const { id } of PUBLISHED_NETWORKS) {
    const blocks = value.ranges[id];
    if (!Array.isArray(blocks) || blocks.length === 0 ||
        !blocks.every((block): block is string => typeof block === "string")) {
      throw new Error("invalid active network source");
    }
    ranges[id] = mergeRanges(toRanges(blocks)).flatMap(rangeToCidrs);
  }
  cachedNamespace = kv;
  cachedSet = { version, generatedAt: value.generatedAt, ranges };
  return cachedSet;
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      redirect: "manual", signal: controller.signal, headers: { accept: "application/dns-json, application/json, text/plain" },
    });
    if (!response.ok || !response.body) throw new Error("source unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- Read one ordered stream chunk at a time and enforce the byte cap.
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SOURCE_BYTES) throw new Error("source too large");
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function googlePrefixes(url: string, fetcher: typeof fetch): Promise<IpRange[]> {
  const data: unknown = JSON.parse(await fetchText(url, fetcher));
  if (!record(data) || !Array.isArray(data.prefixes) || data.prefixes.length === 0) {
    throw new Error("invalid Google prefixes");
  }
  const cidrs = data.prefixes.map((prefix: unknown) => {
    if (!record(prefix)) throw new Error("invalid Google prefix");
    const cidr = prefix.ipv4Prefix ?? prefix.ipv6Prefix;
    if (typeof cidr !== "string") throw new Error("invalid Google prefix");
    return cidr;
  });
  return toRanges(cidrs);
}

// DNS JSON TXT answers encode one or more quoted chunks. Join chunks without
// inserting spaces: a DNS character-string boundary is not an SPF token boundary.
function txtData(data: string): string {
  let text = "";
  let rest = data.trim();
  while (rest) {
    const chunk = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (!chunk) throw new Error("invalid TXT answer");
    text += (chunk[1] ?? "").replace(/\\(\d{3}|.)/g, (_match, escaped: string) =>
      /^\d{3}$/.test(escaped) ? String.fromCharCode(Number(escaped)) : escaped);
    rest = rest.slice(chunk[0].length).trimStart();
  }
  return text;
}
async function spfCidrs(domain: string, seen: Set<string>, stack: Set<string>, fetcher: typeof fetch): Promise<string[]> {
  if (stack.has(domain)) throw new Error("cyclic SPF source");
  if (seen.has(domain)) return [];
  if (!/^(?:[a-z0-9_-]+\.)+[a-z0-9-]+$/i.test(domain) || seen.size >= MAX_SPF_RECORDS) {
    throw new Error("invalid SPF source traversal");
  }
  seen.add(domain);
  stack.add(domain);
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
    const data: unknown = JSON.parse(await fetchText(url, fetcher));
    if (!record(data) || data.Status !== 0 || !Array.isArray(data.Answer)) throw new Error("SPF lookup failed");
    const answers = data.Answer.filter((answer: unknown) => record(answer) && answer.type === 16);
    if (answers.length === 0) throw new Error("SPF answer missing");
    const cidrs: string[] = [];
    for (const answer of answers) {
      if (!record(answer) || typeof answer.data !== "string") throw new Error("invalid SPF answer");
      for (const token of txtData(answer.data).split(/\s+/)) {
        const mechanism = /^[+]?([a-z\d]+):(.+)$/i.exec(token);
        if (mechanism?.[1] === "ip4" || mechanism?.[1] === "ip6") {
          cidrs.push(mechanism[2] ?? "");
        } else if (mechanism?.[1] === "include") {
          // eslint-disable-next-line no-await-in-loop -- Traverse SPF includes serially so cycle and shared-record limits remain deterministic.
          cidrs.push(...await spfCidrs(mechanism[2] ?? "", seen, stack, fetcher));
        }
      }
    }
    if (cidrs.length === 0) throw new Error("empty SPF source");
    return cidrs;
  } finally {
    stack.delete(domain);
  }
}

function sourceLoaders(fetcher: typeof fetch): Record<string, () => Promise<IpRange[]> | IpRange[]> {
  return {
    "apple-private-relay": async () => toRanges((await fetchText(
      "https://mask-api.icloud.com/egress-ip-ranges.csv", fetcher,
    )).split("\n").map((line) => line.split(",")[0]?.trim() ?? "").filter(Boolean)),
    "google-services": async () => {
      const [all, cloud] = await Promise.all([
        googlePrefixes("https://www.gstatic.com/ipranges/goog.json", fetcher),
        googlePrefixes("https://www.gstatic.com/ipranges/cloud.json", fetcher),
      ]);
      return subtractRanges(all, cloud);
    },
    "microsoft-exchange-online": async () => {
      const data: unknown = JSON.parse(await fetchText(
        `https://endpoints.office.com/endpoints/worldwide?clientrequestid=${crypto.randomUUID()}`, fetcher,
      ));
      if (!Array.isArray(data)) throw new Error("invalid Microsoft endpoints");
      const cidrs: string[] = [];
      for (const endpoint of data) {
        if (!record(endpoint) || typeof endpoint.serviceArea !== "string") {
          throw new Error("invalid Microsoft endpoint");
        }
        const { ips } = endpoint;
        if (ips === undefined) continue;
        if (!Array.isArray(ips) || !ips.every((ip: unknown): ip is string => typeof ip === "string")) {
          throw new Error("invalid Microsoft endpoint IPs");
        }
        if (endpoint.serviceArea === "Exchange") cidrs.push(...ips);
      }
      return toRanges(cidrs);
    },
    mimecast: async () => toRanges(await spfCidrs("_netblocks.mimecast.com", new Set(), new Set(), fetcher)),
    // Reference source is a sign-in-only page, not a machine-readable endpoint.
    // These published US/EU ranges require operator review when upstream changes.
    "proofpoint-essentials": () => toRanges(PROOFPOINT_ESSENTIALS),
  };
}
function assertNotShrunk(previous: readonly string[], next: readonly string[]): void {
  if (next.length * 5 < previous.length * 4) throw new Error("network block count shrank by more than 20%");
  for (const version of [4, 6]) {
    const count = (cidrs: readonly string[]) => mergeRanges(toRanges(cidrs))
      .filter((range) => range.version === version)
      .reduce((sum, range) => sum + range.end - range.start + 1n, 0n);
    if (count(next) * 5n < count(previous) * 4n) throw new Error("network coverage shrank by more than 20%");
  }
}

/** Only publish the pointer after every source has passed. Never log request evidence. */
export async function refreshNetworks(kv: KVNamespace, fetcher: typeof fetch = fetch): Promise<NetworkSet> {
  const previous = await loadActiveNetworkSet(kv);
  const sources = sourceLoaders(fetcher);
  const entries = await Promise.all(PUBLISHED_NETWORKS.map(async ({ id }) => {
    try {
      const source = sources[id];
      if (!source) throw new Error("missing source");
      const cidrs = mergeRanges(await source()).flatMap(rangeToCidrs);
      if (cidrs.length === 0) throw new Error("empty source");
      if (previous) assertNotShrunk(previous.ranges[id] ?? [], cidrs);
      return [id, cidrs] as const;
    } catch {
      // Source id is a fixed public identifier. Never expose upstream error text.
      throw new Error(`network refresh failed: ${id}`);
    }
  }));
  const now = new Date().toISOString();
  const set: NetworkSet = { version: `${now}-${crypto.randomUUID()}`, generatedAt: now, ranges: Object.fromEntries(entries) };
  await kv.put(`${NETWORK_SET_PREFIX}${set.version}`, JSON.stringify(set));
  await kv.put(ACTIVE_NETWORK_KEY, set.version);
  return set;
}
