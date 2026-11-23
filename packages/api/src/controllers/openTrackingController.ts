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
