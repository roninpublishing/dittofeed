import { Static, Type } from "@sinclair/typebox";

/** Leave headroom below Cloudflare Queue's 128 KiB message limit. */
export const DEVELOPMENT_PIXEL_EVENT_BYTES = 120 * 1024;
export const DEVELOPMENT_PIXEL_BATCH_BYTES = 1024 * 1024;
export const DEVELOPMENT_PIXEL_BATCH_EVENTS = 50;
export const DEVELOPMENT_PIXEL_BATCH_PATH = "/api/public/email/open/development-batch";
export const DEVELOPMENT_PIXEL_TABLE = "developmentOpenPixelEvent";

/** Known credential fields, not a claim to recognize secrets embedded in arbitrary values. */
export function isDevelopmentPixelSecret(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return /(?:^|[-_.])(?:authorization|cookie|cookies|password|passwd|secret|token|credential|credentials|signature|sig|session|sessionid)(?:$|[-_.])/.test(normalized) ||
    /(?:api[-_]?key|access[-_]?key|csrf|xsrf|cf-access-jwt)/.test(normalized);
}

const StringMap = Type.Record(Type.String(), Type.String());
const Metadata = Type.Record(Type.String(), Type.Unknown());
export const DevelopmentPixelEvidenceSchema = Type.Object({
  request: Type.Object({
    url: Type.String(),
    method: Type.String({ minLength: 1, maxLength: 32 }),
    headers: StringMap,
    properties: Metadata,
    body: Type.Object({
      encoding: Type.Literal("base64"), data: Type.String(),
      capturedBytes: Type.Integer({ minimum: 0 }),
      declaredBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      truncated: Type.Boolean(), unavailable: Type.Union([Type.String(), Type.Null()]),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  cloudflare: Metadata,
  response: Type.Object({ status: Type.Integer({ minimum: 100, maximum: 599 }), headers: StringMap }, { additionalProperties: false }),
  network: Type.Object({
    setVersion: Type.Union([Type.String(), Type.Null()]),
    match: Type.Union([Type.Object({ id: Type.String(), version: Type.String() }, { additionalProperties: false }), Type.Null()]),
  }, { additionalProperties: false }),
  redactions: Type.Array(Type.String()),
  truncations: Type.Array(Type.String()),
  unavailable: Type.Array(Type.String()),
}, { additionalProperties: false });

export const DevelopmentPixelEventSchema = Type.Object({
  v: Type.Literal(3),
  eventId: Type.String({ format: "uuid" }),
  hostname: Type.String({ minLength: 6, maxLength: 253,
    pattern: "^dt[.](?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z0-9-]{2,63}$" }),
  token: Type.Union([Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }), Type.Null()]),
  occurredAt: Type.String({ format: "date-time", maxLength: 40 }),
  evidence: DevelopmentPixelEvidenceSchema,
}, { additionalProperties: false });

export const DevelopmentPixelBatchSchema = Type.Object({
  v: Type.Literal(3),
  events: Type.Array(DevelopmentPixelEventSchema, { minItems: 1, maxItems: DEVELOPMENT_PIXEL_BATCH_EVENTS }),
}, { additionalProperties: false });

export type DevelopmentPixelEvidence = Static<typeof DevelopmentPixelEvidenceSchema>;
export type DevelopmentPixelEvent = Static<typeof DevelopmentPixelEventSchema>;
