/** Adapted from yuriyward/mail-tracker networks.test.ts at 51ea4e7551564f6ddb55b60a34754863400e9133. */
import { classify, Hit } from "./classify";
import {
  formatIp,
  mergeRanges,
  parseCidr,
  rangeToCidrs,
  subtractRanges,
} from "./ip";
import { cidrKeyRange, ipKey } from "./ip-key";
import { networkLookup, PUBLISHED_NETWORKS, publishedNetworkLookup } from "./networks";
import generated from "./networkSnapshot.json";

const FIXTURE = networkLookup({
  "apple-private-relay": ["172.224.226.0/27", "2a02:26f7:b3c0:4000::/64"],
  "google-services": ["66.249.80.0/20"],
  "microsoft-exchange-online": ["40.92.0.0/15", "40.107.0.0/16"],
  mimecast: ["205.139.110.0/24"],
  "proofpoint-essentials": ["148.163.128.0/19"],
});
const hit = (overrides: Partial<Hit> = {}): Hit => ({
  ageMs: 3_600_000,
  asOrganization: "Example Broadband",
  ip: "198.51.100.7",
  kind: "open",
  method: "GET",
  otherLinksInBurst: 0,
  ownerVerified: false,
  selfIps: [],
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  ...overrides,
});

describe("classification by published network", () => {
  test.each([
    ["172.224.226.5", "open", "apple_proxy", false],
    ["2a02:26f7:b3c0:4000::1", "open", "apple_proxy", false],
    ["172.224.226.5", "click", "human", true],
    ["66.249.84.10", "open", "gmail_proxy", true],
    ["66.249.84.10", "click", "scanner", false],
    ["40.107.22.5", "click", "scanner", false],
    ["40.107.22.5", "open", "prefetch", false],
    ["205.139.110.12", "open", "scanner", false],
    ["205.139.110.12", "click", "scanner", false],
    ["148.163.130.1", "open", "scanner", false],
    ["148.163.130.1", "click", "scanner", false],
    ["198.51.100.7", "open", "human", true],
    ["198.51.100.7", "click", "human", true],
  ] as const)("%s %s", (ip, kind, eventClass, counted) => {
    expect(classify(hit({ ip, kind }), FIXTURE)).toMatchObject({ class: eventClass, counted });
  });
  test("self takes precedence over a security network", () => {
    expect(classify(hit({ ip: "40.107.22.5", kind: "click", selfIps: ["40.107.22.5"] }), FIXTURE))
      .toMatchObject({ class: "self", counted: false });
  });
  test("the committed ranges hold a sample from each reference list", () => {
    expect([
      "172.224.226.5", "66.249.84.10", "40.107.22.5", "205.139.110.12",
      "148.163.130.1", "198.51.100.7",
    ].map((ip) => publishedNetworkLookup(ip)?.id ?? null)).toEqual([
      "apple-private-relay", "google-services", "microsoft-exchange-online", "mimecast",
      "proofpoint-essentials", null,
    ]);
  });
  test("missing networks and invalid addresses do not match", () => {
    const empty = networkLookup({});
    for (const ip of ["", "garbage", "172.224.226.5", "2001:db8::1"]) {
      expect(empty(ip)).toBeNull();
    }
    expect(FIXTURE("999.1.1.1")).toBeNull();
    expect(FIXTURE("2001:db8:::1")).toBeNull();
    expect(FIXTURE("::ffff:172.224.226.5")?.id).toBe("apple-private-relay");
  });
  test("first matching published list wins", () => {
    const lookup = networkLookup({
      "apple-private-relay": ["192.0.2.0/24"],
      "google-services": ["192.0.2.0/24"],
    });
    expect(lookup("192.0.2.1")?.id).toBe(PUBLISHED_NETWORKS[0]?.id);
  });
  test("malformed range fails closed without throwing", () => {
    expect(networkLookup({ mimecast: ["not-a-cidr"] })("192.0.2.1")).toBeNull();
    expect(networkLookup({ mimecast: ["192.0.2.0/33"] })("192.0.2.1")).toBeNull();
  });
  test("range boundaries are inclusive for IPv4 and IPv6", () => {
    for (const ip of ["172.224.226.0", "172.224.226.31", "2a02:26f7:b3c0:4000::", "2a02:26f7:b3c0:4000:ffff:ffff:ffff:ffff"]) {
      expect(FIXTURE(ip)?.id).toBe("apple-private-relay");
    }
    for (const ip of ["172.224.225.255", "172.224.226.32", "2a02:26f7:b3c0:3fff:ffff:ffff:ffff:ffff", "2a02:26f7:b3c0:4001::"]) {
      expect(FIXTURE(ip)).toBeNull();
    }
  });
});

const cidrs = (...blocks: string[]) => blocks.map(parseCidr).filter((range) => range !== null);

describe("IP keys and range arithmetic", () => {
  test.each<[string, string | null]>([
    ["192.0.2.1", "c0000201"],
    ["2001:db8::1", "20010db8000000000000000000000001"],
    ["2001:DB8:0:0:1:0:0:1", "20010db8000000000001000000000001"],
    ["::ffff:192.0.2.1", "c0000201"],
    ["::ffff:c000:201", "c0000201"],
    [" ::1 ", `${"0".repeat(31)}1`],
    ["::", "0".repeat(32)],
    ["192.0.2.256", null], ["1.2.3", null], ["1.2.3.4.5", null],
    ["2001:db8:::1", null], ["1:2:3:4:5:6:7:8:9", null],
    ["1:2:3:4:5:6:7::8", null], ["1.2.3.4::", null],
    ["1.2.3.4::1", null], ["fe80::1%en0", null], ["[::1]", null], ["", null],
  ])("key of %s", (text, expected) => {
    expect(ipKey(text)?.key ?? null).toBe(expected);
  });
  test.each<[string, string, string]>([
    ["192.0.2.77/24", "c0000200", "c00002ff"],
    ["192.0.2.77/26", "c0000240", "c000027f"],
    ["192.0.2.77", "c000024d", "c000024d"],
    ["2001:db8::/33", `20010db8${"0".repeat(24)}`, `20010db87${"f".repeat(23)}`],
    ["0.0.0.0/0", "00000000", "ffffffff"],
    ["::/0", "0".repeat(32), "f".repeat(32)],
  ])("range of %s", (cidr, start, end) => {
    expect(cidrKeyRange(cidr)).toMatchObject({ start, end });
  });
  test.each([
    "192.0.2.0/33", "2001:db8::/129", "2001:db8::/1x", "192.0.2.0/-1",
    "192.0.2.0/", "192.0.2.0/24/1", "192.0.2.0/1.5", "1.2.3.4::1/64",
    "invalid", "", "/24",
  ])("rejects malformed CIDR %s", (cidr) => {
    expect(cidrKeyRange(cidr)).toBeNull();
    expect(parseCidr(cidr)).toBeNull();
  });
  test("committed ranges are sorted IPv4 first, valid and nonoverlapping", () => {
    for (const [id, blocks] of Object.entries(generated.ranges)) {
      const ranges = blocks.map(cidrKeyRange);
      expect({ id, valid: ranges.every((range) => range !== null) }).toEqual({ id, valid: true });
      expect({ id, sorted: ranges.every((range, index) => {
        const previous = ranges[index - 1];
        return index === 0 || (range !== null && previous !== undefined && previous !== null &&
          (previous.version < range.version || (previous.version === range.version && previous.end < range.start)));
      }) }).toEqual({ id, sorted: true });
    }
  });
  test("integer and string key parsers agree on every committed block", () => {
    for (const block of ["0.0.0.0/0", "::/0", ...Object.values(generated.ranges).flat()]) {
      const range = parseCidr(block);
      expect(range).not.toBeNull();
      if (range !== null) {
        const width = range.version === 4 ? 8 : 32;
        expect(cidrKeyRange(block)).toEqual({
          version: range.version,
          start: range.start.toString(16).padStart(width, "0"),
          end: range.end.toString(16).padStart(width, "0"),
        });
      }
    }
  });
  test("host bits are ignored and IPv6 output uses canonical compression", () => {
    const range = parseCidr("192.0.2.77/24");
    expect(range && formatIp(4, range.start)).toBe("192.0.2.0");
    expect(range && formatIp(4, range.end)).toBe("192.0.2.255");
    expect(formatIp(6, BigInt("0x20010db8000000000000000000000001"))).toBe("2001:db8::1");
    expect(formatIp(6, BigInt(0))).toBe("::");
  });
  test("merging joins adjacent blocks into the fewest CIDRs without mutating input", () => {
    const input = cidrs("192.0.2.128/25", "192.0.2.0/25", "2001:db8::/33", "2001:db8:8000::/33");
    const before = input.map((range) => ({ ...range }));
    expect(mergeRanges(input).flatMap(rangeToCidrs)).toEqual(["192.0.2.0/24", "2001:db8::/32"]);
    expect(input).toEqual(before);
  });
  test("subtraction cuts holes", () => {
    expect(subtractRanges(cidrs("192.0.2.0/24"), cidrs("192.0.2.64/26")).flatMap(rangeToCidrs))
      .toEqual(["192.0.2.0/26", "192.0.2.128/25"]);
  });
});
