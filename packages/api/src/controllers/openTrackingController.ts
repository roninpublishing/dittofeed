import { Static, Type } from "@sinclair/typebox";
import config from "backend-lib/src/config";
import logger from "backend-lib/src/logger";
import {
  captureDevelopmentPixelEvents,
  CaptureDevelopmentPixelEventInput,
} from "backend-lib/src/messaging/developmentOpenTracking";
import {
  captureEmailOpenRequests,
  CaptureEmailOpenRequestInput,
} from "backend-lib/src/messaging/openTracking";
import { verifyOpenTrackingRelay } from "backend-lib/src/messaging/openTrackingRelay";
import { getTrackingHostnameNewsletter } from "backend-lib/src/newsletterTracking";
import { FastifyInstance } from "fastify";
import { fastifyRawBody } from "fastify-raw-body";
import {
  DEVELOPMENT_PIXEL_BATCH_BYTES,
  DEVELOPMENT_PIXEL_EVENT_BYTES,
  DevelopmentPixelBatchSchema,
} from "isomorphic-lib/src/tracking/development";

const BatchEvent = Type.Object(
  {
    v: Type.Literal(2),
    eventId: Type.String({ format: "uuid" }),
    hostname: Type.String({
      minLength: 6,
      maxLength: 253,
      pattern:
        "^dt[.](?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z0-9-]{2,63}$",
    }),
    token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    method: Type.Union([Type.Literal("GET"), Type.Literal("HEAD")]),
    query: Type.Object(
      {
        cb: Type.Optional(Type.String({ pattern: "^[0-9]{1,20}$" })),
        v: Type.Optional(Type.String({ pattern: "^[0-9]{1,20}$" })),
      },
      { additionalProperties: false },
    ),
    headers: Type.Record(
      Type.String({ maxLength: 64 }),
      Type.String({ maxLength: 512 }),
      { maxProperties: 64 },
    ),
    edge: Type.Object(
      {
        receivedAt: Type.String({ format: "date-time", maxLength: 40 }),
        remoteAddress: Type.Optional(Type.String({ maxLength: 64 })),
        httpVersion: Type.Optional(Type.String({ maxLength: 32 })),
        tlsVersion: Type.Optional(Type.String({ maxLength: 32 })),
        asOrganization: Type.Optional(Type.String({ maxLength: 256 })),
        asn: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
        ),
        country: Type.Optional(Type.String({ pattern: "^[A-Z]{2}$" })),
        network: Type.Optional(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: 64 }),
              version: Type.String({ minLength: 1, maxLength: 128 }),
            },
            { additionalProperties: false },
          ),
        ),
        networkSetVersion: Type.Optional(
          Type.Union([
            Type.String({ minLength: 1, maxLength: 128 }),
            Type.Null(),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type QueuedOpenEvent = Static<typeof BatchEvent>;
const BatchBody = Type.Object(
  {
    v: Type.Literal(2),
    events: Type.Array(BatchEvent, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);
const BATCH_BODY_BYTES = 1_048_576;

export default async function openTrackingController(fastify: FastifyInstance) {
  await fastify.register(fastifyRawBody, {
    encoding: false,
    runFirst: true,
    global: false,
  });
  fastify.addHook("onRequest", (_request, reply, done) => {
    // Header setters return the thenable reply; awaiting it here would stall the hook.
    void reply
      .header("Cache-Control", "no-store, no-cache, private, max-age=0")
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    done();
  });
  fastify.post<{ Body: Static<typeof BatchBody> }>(
    "/email/open/batch",
    {
      config: { rawBody: true },
      logLevel: "silent",
      bodyLimit: BATCH_BODY_BYTES,
      schema: { hide: true, body: BatchBody },
      errorHandler(error, _request, reply) {
        void reply.status(error.statusCode === 413 ? 413 : 400).send();
      },
    },
    async (request, reply) => {
      const settings = config();
      if (
        !settings.enableOpenTracking ||
        settings.enableOpenTrackingDevLake ||
        !settings.openTrackingRelaySecret
      )
        return reply.status(503).send();
      if (
        !Buffer.isBuffer(request.rawBody) ||
        !verifyOpenTrackingRelay({
          rawBody: request.rawBody,
          timestamp: request.headers["x-df-tracking-timestamp"],
          signature: request.headers["x-df-tracking-signature"],
          secret: settings.openTrackingRelaySecret,
          maxBodyBytes: BATCH_BODY_BYTES,
        })
      )
        return reply.status(403).send();
      try {
        // Resolve all hosts before writing. A signed batch cannot cross the
        // hostname -> newsletter -> original token-origin ownership boundary.
        const hosts = new Map<string, string>();
        const observations: CaptureEmailOpenRequestInput[] = [];
        for (const event of request.body.events) {
          let workspaceId = hosts.get(event.hostname);
          if (!workspaceId) {
            // eslint-disable-next-line no-await-in-loop -- Bound lookups and verify all hosts before writing.
            const verified = await getTrackingHostnameNewsletter(event.hostname);
            if (!verified) return reply.status(403).send();
            workspaceId = verified;
            hosts.set(event.hostname, workspaceId);
          }
          observations.push({
            token: event.token,
            eventId: event.eventId,
            expectedHostname: event.hostname,
            expectedWorkspaceId: workspaceId,
            request: {
              receivedAt: event.edge.receivedAt,
              method: event.method,
              headers: event.headers,
              query: event.query,
              remoteAddress: request.raw.socket.remoteAddress,
              httpVersion: request.raw.httpVersion,
              encrypted:
                "encrypted" in request.raw.socket &&
                request.raw.socket.encrypted === true,
              edgeObserved: {
                ...event.edge,
                source: "cloudflare_worker",
                hostname: event.hostname,
              },
            },
          });
        }
        await captureEmailOpenRequests(observations);
        return reply.status(204).send();
      } catch {
        // Partially stored batches may retry; stable receipt IDs deduplicate.
        logger().error("Unable to persist queued open request evidence");
        return reply.status(503).send();
      }
    },
  );
  fastify.post<{ Body: Static<typeof DevelopmentPixelBatchSchema> }>(
    "/email/open/development-batch",
    {
      config: { rawBody: true },
      logLevel: "silent",
      bodyLimit: DEVELOPMENT_PIXEL_BATCH_BYTES,
      schema: { hide: true, body: DevelopmentPixelBatchSchema },
      errorHandler(error, _request, reply) {
        void reply.status(error.statusCode === 413 ? 413 : 400).send();
      },
    },
    async (request, reply) => {
      const settings = config();
      if (
        !settings.enableOpenTracking ||
        !settings.enableOpenTrackingDevLake ||
        !settings.openTrackingRelaySecret
      )
        return reply.status(503).send();
      if (
        !Buffer.isBuffer(request.rawBody) ||
        !verifyOpenTrackingRelay({
          rawBody: request.rawBody,
          timestamp: request.headers["x-df-tracking-timestamp"],
          signature: request.headers["x-df-tracking-signature"],
          secret: settings.openTrackingRelaySecret,
          maxBodyBytes: DEVELOPMENT_PIXEL_BATCH_BYTES,
        })
      )
        return reply.status(403).send();
      if (
        request.body.events.some(
          (event) =>
            Buffer.byteLength(JSON.stringify(event)) >
            DEVELOPMENT_PIXEL_EVENT_BYTES,
        )
      )
        return reply.status(413).send();
      try {
        // Verify every hostname before the first durable write, including
        // observations whose original token was unknown or malformed.
        const hosts = new Map<string, string>();
        const observations: CaptureDevelopmentPixelEventInput[] = [];
        for (const event of request.body.events) {
          let workspaceId = hosts.get(event.hostname);
          if (!workspaceId) {
            // eslint-disable-next-line no-await-in-loop -- Resolve bounded, distinct hosts before writing.
            const verified = await getTrackingHostnameNewsletter(event.hostname);
            if (!verified) return reply.status(403).send();
            workspaceId = verified;
            hosts.set(event.hostname, workspaceId);
          }
          observations.push({ workspaceId, event });
        }
        await captureDevelopmentPixelEvents(observations);
        return reply.status(204).send();
      } catch {
        // A partial batch must retry with the same stable event IDs. Never log
        // raw request evidence, tokens, or private persistence exceptions.
        logger().error("Unable to persist queued development open evidence");
        return reply.status(503).send();
      }
    },
  );
}
