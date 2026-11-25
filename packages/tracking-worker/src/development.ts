import type { DevelopmentPixelEvent } from "isomorphic-lib/src/tracking/development";
import { DEVELOPMENT_PIXEL_EVENT_BYTES, isDevelopmentPixelSecret } from "isomorphic-lib/src/tracking/development";

const encoder = new TextEncoder();
const REDACTED = "[REDACTED]";
const BODY_TIMEOUT_MS = 1_000;
const MAX_BODY_BYTES = DEVELOPMENT_PIXEL_EVENT_BYTES;
const MAX_DEPTH = 32;

type Evidence = DevelopmentPixelEvent["evidence"];
export type DevelopmentPixelSnapshot = { event: DevelopmentPixelEvent; finishBody: () => Promise<void> };

function mark(list: string[], value: string): void {
  const bounded = prefix(value, 256);
  if (list.length >= 128) {
    if (!list.includes("markers:count-limit")) list.push("markers:count-limit");
  } else if (!list.includes(bounded)) list.push(bounded);
}

/** UTF-8 byte bounds without cutting a Unicode code point. */
function prefix(value: string, bytes: number): string {
  let length = 0;
  let end = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (length + size > bytes) break;
    length += size;
    end += character.length;
  }
  return value.slice(0, end);
}

function base64(bytes: Uint8Array): string {
  let result = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    result += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(result);
}

export function snapshotDevelopmentPixel(request: Request, reply: Response, url: URL, token: string | null): DevelopmentPixelSnapshot {
  const evidence: Evidence = {
    request: {
      url: "", method: request.method.slice(0, 32), headers: Object.create(null) as Record<string, string>, properties: Object.create(null) as Record<string, unknown>,
      body: { encoding: "base64", data: "", capturedBytes: 0, declaredBytes: null, truncated: false, unavailable: null },
    },
    cloudflare: {}, response: { status: reply.status, headers: Object.fromEntries(reply.headers) },
    network: { setVersion: null, match: null }, redactions: [], truncations: [], unavailable: [],
  };
  if (request.method.length > 32) {
    evidence.request.properties.originalMethod = request.method;
    mark(evidence.truncations, "request.method:schema-limit");
  }
  const pathToken = url.pathname.slice("/api/public/email/open/".length).replace(/\.gif$/, "");
  const secrets = new Set([token, pathToken, (() => { try { return decodeURIComponent(pathToken); } catch { return null; } })()]
    .filter((value): value is string => Boolean(value)));
  function text(value: string, path: string): string {
    let result = value;
    for (const secret of secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED);
        mark(evidence.redactions, path);
      }
    }
    return result;
  }
  function redactOpaque(bytes: Uint8Array): Uint8Array {
    for (const secret of secrets) {
      const needle = encoder.encode(secret);
      for (let index = 0; index <= bytes.length - needle.length; index += 1) {
        if (needle.every((byte, part) => bytes[index + part] === byte)) {
          bytes.fill(42, index, index + needle.length);
          mark(evidence.redactions, "request.body:pixel-token");
          index += needle.length - 1;
        }
      }
    }
    return bytes;
  }
  let nodes = 0;
  function sanitize(value: unknown, path: string, depth = 0, seen = new Set<object>()): unknown {
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > DEVELOPMENT_PIXEL_EVENT_BYTES) {
      mark(evidence.truncations, `${path}:structure-limit`);
      return "[TRUNCATED]";
    }
    if (typeof value === "string") {
      const clean = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? safeUrl(value, path) : text(value, path);
      if (encoder.encode(clean).byteLength > DEVELOPMENT_PIXEL_EVENT_BYTES) {
        mark(evidence.truncations, `${path}:byte-limit`);
        return prefix(clean, DEVELOPMENT_PIXEL_EVENT_BYTES);
      }
      return clean;
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value !== "object") {
      mark(evidence.unavailable, `${path}:not-json`);
      return null;
    }
    if (seen.has(value)) {
      mark(evidence.unavailable, `${path}:circular`);
      return null;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (nodes > DEVELOPMENT_PIXEL_EVENT_BYTES) {
          mark(evidence.truncations, `${path}:structure-limit`);
          break;
        }
        result.push(sanitize(value[index], `${path}[${index}]`, depth + 1, seen));
      }
      seen.delete(value);
      return result;
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of Object.keys(value)) {
      if (nodes > DEVELOPMENT_PIXEL_EVENT_BYTES) {
        mark(evidence.truncations, `${path}:structure-limit`);
        break;
      }
      const key = text(name, `${path}.[key]`);
      if (isDevelopmentPixelSecret(name)) {
        result[key] = REDACTED;
        mark(evidence.redactions, `${path}.${key}`);
      } else {
        try { result[key] = sanitize((value as Record<string, unknown>)[name], `${path}.${key}`, depth + 1, seen); }
        catch { mark(evidence.unavailable, `${path}.${key}:getter-failed`); }
      }
    }
    seen.delete(value);
    return result;
  }
  function safeUrl(value: string, path: string): string {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) {
        parsed.username = REDACTED;
        parsed.password = REDACTED;
        mark(evidence.redactions, `${path}.credentials`);
      }
      const query = new URLSearchParams();
      for (const [name, entry] of parsed.searchParams) {
        if (isDevelopmentPixelSecret(name)) {
          query.append(text(name, path), REDACTED);
          mark(evidence.redactions, `${path}.query.${text(name, path)}`);
        } else query.append(text(name, path), text(entry, path));
      }
      // Keep the original encoding when no query value required redaction.
      if (query.toString() !== parsed.searchParams.toString()) parsed.search = query.toString();
      return text(parsed.href, path);
    } catch { return text(value, path); }
  }
  evidence.request.url = safeUrl(url.href, "request.url");
  for (const [name, value] of request.headers) {
    if (isDevelopmentPixelSecret(name)) {
      evidence.request.headers[name] = REDACTED;
      mark(evidence.redactions, `request.headers.${name}`);
    } else {
      const path = `request.headers.${name}`;
      evidence.request.headers[name] = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
        ? safeUrl(value, path)
        : text(value.replace(/https?:\/\/[^\s<>"',]+/gi, (entry) => safeUrl(entry, path)), path);
    }
  }
  // Enumerate both runtime own properties and WebIDL prototype accessors. Functions,
  // live streams and headers/cf (captured separately) are not serializable properties.
  const names = new Set<string>();
  for (let object: object | null = request; object && object !== Object.prototype; object = Object.getPrototypeOf(object) as object | null) {
    for (const name of Object.getOwnPropertyNames(object)) names.add(name);
  }
  for (const name of names) {
    if (["constructor", "headers", "cf", "body", "url", "method"].includes(name)) continue;
    try {
      const value = (request as unknown as Record<string, unknown>)[name];
      if (typeof value === "function") continue;
      if (name === "signal") {
        evidence.request.properties.signal = { aborted: request.signal.aborted, reason: sanitize(request.signal.reason, "request.properties.signal.reason") };
      } else if (isDevelopmentPixelSecret(name) && name !== "credentials") {
        evidence.request.properties[name] = REDACTED;
        mark(evidence.redactions, `request.properties.${name}`);
      } else evidence.request.properties[name] = name === "referrer" && typeof value === "string"
        ? safeUrl(value, "request.properties.referrer") : sanitize(value, `request.properties.${name}`);
    } catch { mark(evidence.unavailable, `request.properties.${name}:getter-failed`); }
  }
  for (const name of ["cache", "credentials", "destination", "integrity", "keepalive", "mode", "redirect", "referrer", "referrerPolicy", "bodyUsed", "signal", "isHistoryNavigation", "duplex", "priority"]) {
    if (!(name in evidence.request.properties)) mark(evidence.unavailable, `request.properties.${name}:not-exposed`);
  }
  if (request.cf) evidence.cloudflare = sanitize(request.cf, "cloudflare") as Record<string, unknown>;
  else mark(evidence.unavailable, "cloudflare:not-exposed");
  for (const name of ["asn", "asOrganization", "country", "city", "continent", "latitude", "longitude", "postalCode", "region", "regionCode", "timezone", "colo", "httpProtocol", "tlsVersion", "tlsCipher", "tlsClientAuth", "botManagement", "clientTcpRtt", "requestPriority", "verifiedBotCategory", "tlsClientExtensionsSha1", "tlsClientExtensionsSha1Le", "tlsExportedAuthenticator", "tlsClientHelloLength", "tlsClientRandom", "tlsClientCiphersSha1", "edgeRequestKeepAliveStatus", "clientAcceptEncoding", "isEUCountry", "metroCode", "hostMetadata"]) {
    if (!(name in evidence.cloudflare)) mark(evidence.unavailable, `cloudflare.${name}:not-exposed`);
  }
  for (const [section, names] of [
    ["tlsClientAuth", ["certPresented", "certVerified", "certRevoked", "certIssuerDN", "certSubjectDN", "certIssuerDNRFC2253", "certSubjectDNRFC2253", "certSerial", "certFingerprintSHA1", "certFingerprintSHA256", "certNotBefore", "certNotAfter", "certSKI", "certIssuerSKI"]],
    ["botManagement", ["score", "verifiedBot", "staticResource", "ja3Hash", "ja4", "detectionIds"]],
  ] as const) {
    const value = evidence.cloudflare[section];
    if (value && typeof value === "object") {
      for (const name of names) {
        if (!(name in value)) mark(evidence.unavailable, `cloudflare.${section}.${name}:not-exposed`);
      }
    }
  }
  if (!request.headers.has("cf-connecting-ip")) mark(evidence.unavailable, "request.headers.cf-connecting-ip:not-exposed");
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number.isSafeInteger(Number(declared))) evidence.request.body.declaredBytes = Number(declared);
  else mark(evidence.unavailable, `request.body.declaredBytes:${declared === null ? "not-exposed" : "invalid"}`);
  // The response handler keeps rejected-method response streams open until this
  // bounded capture finishes; reading after a response is fully sent is not
  // supported by workerd, even from waitUntil or a cloned Request.
  const bodyStream = request.body;
  const event: DevelopmentPixelEvent = {
    v: 3, eventId: crypto.randomUUID(), hostname: url.hostname.toLowerCase(), token,
    occurredAt: new Date().toISOString(), evidence,
  };
  return { event, async finishBody() {
    const body = evidence.request.body;
    if (!bodyStream) {
      return;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = bodyStream.getReader(); }
    catch {
      body.unavailable = "stream-unavailable";
      mark(evidence.unavailable, "request.body:stream-unavailable");
      return;
    }
    let timedOut = false;
    const { promise: deadline, reject } = Promise.withResolvers<never>();
    const timeout = setTimeout(() => { timedOut = true; reject(new Error("body deadline")); }, BODY_TIMEOUT_MS);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      try {
        while (true) {
          // eslint-disable-next-line no-await-in-loop -- Bound stream consumption before the next read.
          const { value, done } = await Promise.race([reader.read(), deadline]);
          if (done) break;
          const available = MAX_BODY_BYTES - size;
          if (value.byteLength > available) {
            chunks.push(value.subarray(0, available));
            size += available;
            body.truncated = true;
            mark(evidence.truncations, "request.body:read-byte-limit");
            break;
          }
          chunks.push(value);
          size += value.byteLength;
        }
      } catch {
        body.unavailable = timedOut ? "read-timeout" : "read-failed";
        body.truncated = true;
        mark(evidence.unavailable, `request.body:${body.unavailable}`);
        mark(evidence.truncations, "request.body:incomplete-read");
      }
      let bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType === "application/json" || contentType.endsWith("+json")) {
        evidence.request.properties.developmentBodyRepresentation = "redacted-json";
        // Partial/invalid structured bodies cannot be safely credential-redacted.
        try { bytes = encoder.encode(JSON.stringify(sanitize(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)), "request.body.json"))); }
        catch { body.unavailable = body.truncated ? "truncated-json-redaction-unsafe" : "invalid-json-redaction-unsafe"; bytes = new Uint8Array(); }
      } else if (contentType === "application/x-www-form-urlencoded") {
        evidence.request.properties.developmentBodyRepresentation = "redacted-form-urlencoded";
        const form = new URLSearchParams(new TextDecoder().decode(bytes));
        const clean = new URLSearchParams();
        for (const [name, value] of form) {
          clean.append(text(name, "request.body.form.key"), isDevelopmentPixelSecret(name) ? REDACTED : text(value, "request.body.form"));
          if (isDevelopmentPixelSecret(name)) mark(evidence.redactions, `request.body.form.${text(name, "request.body.form.key")}`);
        }
        bytes = encoder.encode(clean.toString());
      } else if (contentType.startsWith("multipart/")) {
        evidence.request.properties.developmentBodyRepresentation = "multipart-parts-json";
        try {
          if (body.truncated) throw new Error("partial multipart");
          const form = await Promise.race([
            new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData(),
            deadline,
          ]);
          const parts: unknown[] = [];
          for (const [name, value] of form) {
            const cleanName = text(name, "request.body.multipart.key");
            if (isDevelopmentPixelSecret(name)) {
              parts.push({ name: cleanName, value: REDACTED });
              mark(evidence.redactions, `request.body.multipart.${cleanName}`);
            } else if (typeof value === "string") {
              parts.push({ name: cleanName, value: text(value, "request.body.multipart.value") });
            } else {
              // eslint-disable-next-line no-await-in-loop -- Keep bounded file parts in their observed order.
              const data = new Uint8Array(await Promise.race([value.arrayBuffer(), deadline]));
              parts.push({ name: cleanName, file: { name: text(value.name, "request.body.multipart.file.name"),
                type: text(value.type, "request.body.multipart.file.type"), base64: base64(redactOpaque(data)) } });
            }
          }
          bytes = encoder.encode(JSON.stringify(parts));
        } catch {
          body.unavailable = timedOut ? "multipart-parse-timeout" : body.truncated ? "truncated-multipart-redaction-unsafe" : "invalid-multipart-redaction-unsafe";
          bytes = new Uint8Array();
        }
      } else {
        // Opaque bodies have no credential field names to recognize.
        bytes = redactOpaque(bytes);
      }
      body.data = base64(bytes);
      body.capturedBytes = bytes.byteLength;
    } catch {
      body.unavailable = timedOut ? "read-timeout" : "read-failed";
      body.truncated = size > 0;
      if (body.truncated) mark(evidence.truncations, "request.body:incomplete-read");
    } finally {
      clearTimeout(timeout);
      // Cancellation must not let an uncooperative source delay Queue delivery.
      void reader.cancel().catch(() => undefined);
      if (body.unavailable) mark(evidence.unavailable, `request.body:${body.unavailable}`);
    }
  } };
}

/** Enforce the actual serialized Queue limit, including UTF-8, keys and flags. */
export function boundDevelopmentPixel(event: DevelopmentPixelEvent): void {
  const { evidence } = event;
  let size = encoder.encode(JSON.stringify(event)).byteLength;
  while (size > DEVELOPMENT_PIXEL_EVENT_BYTES) {
    let largest: { parent: Record<string, unknown>; key: string; path: string; bytes: number } | undefined;
    function visit(value: Record<string, unknown>, path: string): void {
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        const bytes = encoder.encode(JSON.stringify(child)).byteLength;
        if (typeof child === "string" && (!largest || bytes > largest.bytes)) largest = { parent: value, key, path: childPath, bytes };
        else if (child && typeof child === "object") visit(child as Record<string, unknown>, childPath);
      }
    }
    visit(evidence.request.headers, "request.headers");
    visit(evidence.request.properties, "request.properties");
    visit(evidence.cloudflare, "cloudflare");
    const candidates = { url: evidence.request.url, data: evidence.request.body.data };
    visit(candidates, "request");
    if (!largest || largest.bytes < 512) {
      // Huge key counts/keys or marker lists: whole section removal is explicit.
      const sections = ["headers", "properties"] as const;
      let removed = false;
      for (const section of sections) {
        if (Object.keys(evidence.request[section]).length) {
          evidence.request[section] = {};
          mark(evidence.truncations, `request.${section}:event-byte-limit`);
          removed = true;
          break;
        }
      }
      if (!removed && Object.keys(evidence.cloudflare).length) {
        evidence.cloudflare = {};
        mark(evidence.truncations, "cloudflare:event-byte-limit");
        removed = true;
      }
      if (!removed) {
        evidence.redactions = evidence.redactions.length ? ["redactions:event-byte-limit"] : [];
        evidence.unavailable = ["unavailable:event-byte-limit"];
        evidence.truncations = ["evidence:event-byte-limit"];
      }
    } else {
      const excess = size - DEVELOPMENT_PIXEL_EVENT_BYTES + 512;
      const original = largest.parent[largest.key] as string;
      if (largest.parent === candidates && largest.key === "data") {
        const bytes = Math.max(0, Math.floor((original.length - excess) / 4) * 4);
        evidence.request.body.data = original.slice(0, bytes);
        evidence.request.body.capturedBytes = atob(evidence.request.body.data).length;
        evidence.request.body.truncated = true;
        mark(evidence.truncations, "request.body:event-byte-limit");
      } else if (largest.parent === candidates) {
        evidence.request.url = prefix(original, Math.max(0, encoder.encode(original).byteLength - excess));
        mark(evidence.truncations, "request.url:event-byte-limit");
      } else {
        largest.parent[largest.key] = prefix(original, Math.max(0, encoder.encode(original).byteLength - excess));
        mark(evidence.truncations, `${largest.path}:event-byte-limit`);
      }
    }
    size = encoder.encode(JSON.stringify(event)).byteLength;
  }
}
