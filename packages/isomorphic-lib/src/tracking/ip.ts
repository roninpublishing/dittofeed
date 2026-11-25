/** Adapted from yuriyward/mail-tracker, commit 51ea4e7551564f6ddb55b60a34754863400e9133. */
/* eslint-disable no-bitwise -- Integer IP parsing and CIDR range arithmetic require address masks and shifts. */
/* eslint-disable prefer-regex-literals -- Static constructors preserve Unicode semantics with this package's ES5 compile target. */
/**
 * IPv4 and IPv6 addresses as integers, and the range arithmetic scripts/refresh-networks.ts
 * needs. The Worker matches addresses with src/ip-key.ts instead.
 */

export type IpVersion = 4 | 6;

/** An inclusive range of addresses of one version. */
export interface IpRange {
  version: IpVersion;
  start: bigint;
  end: bigint;
}

const N_32 = BigInt(32);
const N_128 = BigInt(128);
const N_0 = BigInt(0);
const N_8 = BigInt(8);
const N_16 = BigInt(16);
const N_HEX_FFFF = BigInt(0xffff);
const N_1 = BigInt(1);
const N_24 = BigInt(24);
const N_HEX_FF = BigInt(0xff);

const BITS: Record<IpVersion, bigint> = { 4: N_32, 6: N_128 };
const V4_PART = new RegExp(String.raw`^\d{1,3}$`, "u");
const HEX_GROUP = new RegExp(String.raw`^[\da-f]{1,4}$`, "iu");

const parseV4 = (text: string): bigint | null => {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = N_0;
  for (const part of parts) {
    if (!V4_PART.test(part) || Number(part) > 255) {
      return null;
    }
    value = (value << N_8) | BigInt(part);
  }
  return value;
};

const parseGroups = (text: string): bigint[] | null => {
  if (text === "") {
    return [];
  }
  const groups: bigint[] = [];
  const parts = text.split(":");
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1 && part.includes(".")) {
      const v4 = parseV4(part);
      if (v4 === null) {
        return null;
      }
      groups.push(v4 >> N_16, v4 & N_HEX_FFFF);
    } else if (HEX_GROUP.test(part)) {
      groups.push(BigInt(`0x${part}`));
    } else {
      return null;
    }
  }
  return groups;
};

const parseV6 = (text: string): bigint | null => {
  const halves = text.split("::");
  if (halves.length > 2 || (halves.length === 2 && halves[0]?.includes("."))) {
    return null;
  }
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }
  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => N_0),
    ...tail,
  ];
  return groups.reduce((value, group) => (value << N_16) | group, N_0);
};

/** Parses `address/length` (a bare address is a single-address range); host bits are ignored. */
export const parseCidr = (text: string): IpRange | null => {
  const [address = "", length, ...rest] = text.trim().split("/");
  if (rest.length > 0 || (length !== undefined && !V4_PART.test(length))) {
    return null;
  }
  const ip = address.includes(":")
    ? { value: parseV6(address), version: 6 as const }
    : { value: parseV4(address), version: 4 as const };
  if (ip.value === null) {
    return null;
  }
  const bits = BITS[ip.version];
  const prefix = length === undefined ? bits : BigInt(length);
  if (prefix > bits) {
    return null;
  }
  const hostMask = (N_1 << (bits - prefix)) - N_1;
  const start = ip.value & ~hostMask;
  return { end: start | hostMask, start, version: ip.version };
};

const hex = (groups: number[]): string =>
  groups.map((group) => group.toString(16)).join(":");

const formatV6 = (value: bigint): string => {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & N_HEX_FFFF)
  );
  // Compress the longest run of two or more zero groups (RFC 5952).
  let best = { length: 0, start: -1 };
  let run = { length: 0, start: -1 };
  for (const [index, group] of groups.entries()) {
    run =
      group === 0
        ? {
            length: run.length + 1,
            start: run.length === 0 ? index : run.start,
          }
        : { length: 0, start: -1 };
    if (run.length > best.length) {
      best = run;
    }
  }
  if (best.length < 2) {
    return hex(groups);
  }
  const head = hex(groups.slice(0, best.start));
  const tail = hex(groups.slice(best.start + best.length));
  return `${head}::${tail}`;
};

export const formatIp = (version: IpVersion, value: bigint): string =>
  version === 6
    ? formatV6(value)
    : [N_24, N_16, N_8, N_0].map((shift) => (value >> shift) & N_HEX_FF).join(".");

/** Sorts ranges and merges overlapping or adjacent ones, per version. */
export const mergeRanges = (ranges: readonly IpRange[]): IpRange[] => {
  const sorted = ranges.toSorted((a, b) =>
    a.version === b.version
      ? Number(a.start > b.start) - Number(a.start < b.start)
      : a.version - b.version
  );
  const merged: IpRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last?.version === range.version && range.start <= last.end + N_1) {
      last.end = range.end > last.end ? range.end : last.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

/** The addresses of `ranges` that are not in `remove`. */
export const subtractRanges = (
  ranges: readonly IpRange[],
  remove: readonly IpRange[]
): IpRange[] => {
  const cuts = mergeRanges(remove);
  const result: IpRange[] = [];
  for (const range of mergeRanges(ranges)) {
    let { start } = range;
    for (const cut of cuts) {
      if (
        cut.version !== range.version ||
        cut.end < start ||
        cut.start > range.end
      ) {
        continue;
      }
      if (cut.start > start) {
        result.push({ end: cut.start - N_1, start, version: range.version });
      }
      start = cut.end + N_1;
    }
    if (start <= range.end) {
      result.push({ end: range.end, start, version: range.version });
    }
  }
  return result;
};

/** The smallest list of CIDR blocks that covers exactly one range. */
export const rangeToCidrs = ({ version, start, end }: IpRange): string[] => {
  const bits = BITS[version];
  const cidrs: string[] = [];
  let next = start;
  while (next <= end) {
    let size = N_0;
    // Grow the block while it stays aligned on `next` and inside the range.
    while (
      size < bits &&
      (next & ((N_1 << (size + N_1)) - N_1)) === N_0 &&
      next + (N_1 << (size + N_1)) - N_1 <= end
    ) {
      size += N_1;
    }
    cidrs.push(`${formatIp(version, next)}/${bits - size}`);
    next += N_1 << size;
  }
  return cidrs;
};
