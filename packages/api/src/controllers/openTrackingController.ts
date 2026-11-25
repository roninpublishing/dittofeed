import { Static, Type } from "@sinclair/typebox";
import config from "backend-lib/src/config";
import logger from "backend-lib/src/logger";
import {
  captureEmailOpenRequest,
  OPEN_TRACKING_PIXEL_PATH,
} from "backend-lib/src/messaging/openTracking";
import { verifyOpenTrackingRelay } from "backend-lib/src/messaging/openTrackingRelay";
import { getTrackingHostnameNewsletter } from "backend-lib/src/newsletterTracking";
import { FastifyInstance } from "fastify";
import { fastifyRawBody } from "fastify-raw-body";

const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const RelayBody = Type.Object(
  {
    v: Type.Literal(1),
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
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const BatchEvent = Type.Object(
  {
    ...RelayBody.properties,
    v: Type.Literal(2),
    eventId: Type.String({ format: "uuid" }),
    edge: Type.Object(
      {
        ...RelayBody.properties.edge.properties,
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
  fastify.post<{ Body: Static<typeof RelayBody> }>(
    "/email/open/relay",
    {
      config: { rawBody: true },
      logLevel: "silent",
      bodyLimit: 16_384,
      schema: { hide: true, body: RelayBody },
      errorHandler(error, _request, reply) {
        // This callback completes the response synchronously, without returning its thenable.
        void reply.status(error.statusCode === 413 ? 413 : 400).send();
      },
    },
    async (request, reply) => {
      const settings = config();
      if (!settings.enableOpenTracking || !settings.openTrackingRelaySecret)
        return reply.status(503).send();
      if (
        !Buffer.isBuffer(request.rawBody) ||
        !verifyOpenTrackingRelay({
          rawBody: request.rawBody,
          timestamp: request.headers["x-df-tracking-timestamp"],
          signature: request.headers["x-df-tracking-signature"],
          secret: settings.openTrackingRelaySecret,
        })
      )
        return reply.status(403).send();
      try {
        const workspaceId = await getTrackingHostnameNewsletter(
          request.body.hostname,
        );
        if (!workspaceId) return reply.status(403).send();
        await captureEmailOpenRequest({
          token: request.body.token,
          expectedHostname: request.body.hostname,
          expectedWorkspaceId: workspaceId,
          request: {
            receivedAt: new Date().toISOString(),
            method: request.body.method,
            headers: request.body.headers,
            query: request.body.query,
            remoteAddress: request.raw.socket.remoteAddress,
            httpVersion: request.raw.httpVersion,
            encrypted:
              "encrypted" in request.raw.socket &&
              request.raw.socket.encrypted === true,
            edgeObserved: {
              ...request.body.edge,
              source: "cloudflare_worker",
              hostname: request.body.hostname,
            },
          },
        });
        return reply.status(204).send();
      } catch {
        logger().error("Unable to persist relayed open request evidence");
        return reply.status(503).send();
      }
    },
  );
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
      if (!settings.enableOpenTracking || !settings.openTrackingRelaySecret)
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
        for (const event of request.body.events) {
          if (hosts.has(event.hostname)) continue;
          // eslint-disable-next-line no-await-in-loop -- Bound lookups and reject all hosts before writing.
          const workspaceId = await getTrackingHostnameNewsletter(
            event.hostname,
          );
          if (!workspaceId) return reply.status(403).send();
          hosts.set(event.hostname, workspaceId);
        }
        for (const event of request.body.events) {
          // eslint-disable-next-line no-await-in-loop -- Preserve bounded partial-retry persistence without flooding the pool.
          await captureEmailOpenRequest({
            token: event.token,
            eventId: event.eventId,
            expectedHostname: event.hostname,
            expectedWorkspaceId: hosts.get(event.hostname),
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
        return reply.status(204).send();
      } catch {
        // Partially stored batches may retry; stable receipt IDs deduplicate.
        logger().error("Unable to persist queued open request evidence");
        return reply.status(503).send();
      }
    },
  );
  fastify.route<{
    Params: { token: string };
    Querystring: Record<string, unknown>;
  }>({
    method: ["GET", "HEAD"],
    url: OPEN_TRACKING_PIXEL_PATH.slice("/api/public".length),
    // The URL is an opaque capability; never send it to ordinary request logs.
    logLevel: "silent",
    exposeHeadRoute: false,
    bodyLimit: 1024,
    schema: {
      hide: true,
      params: Type.Object({ token: Type.String({ maxLength: 256 }) }),
    },
    async handler(request, reply) {
      try {
        await captureEmailOpenRequest({
          token: request.params.token,
          request: {
            receivedAt: new Date().toISOString(),
            method: request.method,
            headers: request.headers,
            query: request.query,
            remoteAddress: request.raw.socket.remoteAddress,
            httpVersion: request.raw.httpVersion,
            encrypted:
              "encrypted" in request.raw.socket &&
              request.raw.socket.encrypted === true,
          },
        });
      } catch {
        // Neither the URL/token nor exception/request data belongs in logs.
        logger().error("Unable to persist open request evidence");
        return reply.status(503).send();
      }
      const imageReply = reply.type("image/gif");
      return request.method === "HEAD"
        ? imageReply.header("Content-Length", PIXEL.length).send()
        : imageReply.send(PIXEL);
    },
  });
}
