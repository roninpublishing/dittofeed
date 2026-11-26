import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  buildDeliveriesFile,
  getDeliveryClicks,
  getDeliveryOpens,
  InvalidDeliveryClicksCursorError,
  InvalidDeliveryOpensCursorError,
  searchDeliveries,
  searchDeliveriesCount,
} from "backend-lib/src/deliveries";
import logger from "backend-lib/src/logger";
import {
  DevelopmentOpenTrackingError,
  findDevelopmentPixelEvents,
} from "backend-lib/src/messaging/developmentOpenTracking";
import { getEmailOpenEvidence } from "backend-lib/src/messaging/openTracking";
import {
  DownloadDeliveriesRequest,
  GetDeliveryClicksRequest,
  GetDeliveryClicksResponse,
  GetDeliveryOpenEvidenceRequest,
  GetDeliveryOpenEvidenceResponse,
  GetDeliveryOpensRequest,
  GetDeliveryOpensResponse,
  SearchDeliveriesRequest,
  SearchDeliveriesResponse,
} from "backend-lib/src/types";
import { FastifyInstance } from "fastify";
import { DevelopmentPixelEvidenceSchema } from "isomorphic-lib/src/tracking/development";

const DevelopmentOpenRequest = Type.Object({
  workspaceId: Type.String({ format: "uuid" }),
  eventId: Type.Optional(Type.String({ format: "uuid" })),
  userId: Type.Optional(Type.String({ minLength: 1 })),
  messageId: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  before: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
}, { additionalProperties: false });

const DevelopmentOpenResponse = Type.Object({
  events: Type.Array(Type.Object({
    eventId: Type.String(),
    workspaceId: Type.String(),
    hostname: Type.String(),
    sendId: Type.Union([Type.String(), Type.Null()]),
    userId: Type.Union([Type.String(), Type.Null()]),
    messageId: Type.Union([Type.String(), Type.Null()]),
    status: Type.Union([
      Type.Literal("matched"), Type.Literal("unmatched"), Type.Literal("invalid"),
    ]),
    method: Type.String(),
    occurredAt: Type.String(),
    receivedAt: Type.String(),
    rawExpiresAt: Type.String(),
    ip: Type.Union([Type.String(), Type.Null()]),
    userAgent: Type.Union([Type.String(), Type.Null()]),
    requestHash: Type.String(),
    evidence: Type.Union([DevelopmentPixelEvidenceSchema, Type.Null()]),
  }, { additionalProperties: false })),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: false });

// eslint-disable-next-line @typescript-eslint/require-await
export default async function deliveriesController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/clicks",
    {
      schema: {
        description:
          "Observed, unqualified click history for one contact and send.",
        tags: ["Deliveries"],
        body: GetDeliveryClicksRequest,
        response: {
          200: GetDeliveryClicksResponse,
          400: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.status(200).send(await getDeliveryClicks(request.body));
      } catch (error) {
        if (error instanceof InvalidDeliveryClicksCursorError) {
          return reply.status(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/opens",
    {
      schema: {
        description:
          "Observed, unqualified open history for one contact and send.",
        tags: ["Deliveries"],
        body: GetDeliveryOpensRequest,
        response: {
          200: GetDeliveryOpensResponse,
          400: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.status(200).send(await getDeliveryOpens(request.body));
      } catch (error) {
        if (error instanceof InvalidDeliveryOpensCursorError) {
          return reply.status(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/opens/evidence",
    {
      schema: {
        description:
          "Explicit scoped retrieval of retained raw open request evidence.",
        tags: ["Deliveries"],
        body: GetDeliveryOpenEvidenceRequest,
        response: {
          200: GetDeliveryOpenEvidenceResponse,
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const evidence = await getEmailOpenEvidence(request.body);
      if (!evidence)
        return reply.status(404).send({ message: "Open evidence not found" });
      return reply.status(200).send({ ...request.body, evidence });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/development-opens",
    {
      logLevel: "silent",
      onRequest(_request, reply, done) {
        void reply.header("Cache-Control", "private, no-store");
        done();
      },
      schema: {
        description:
          "Scoped retained development pixel evidence; never native open engagement.",
        tags: ["Deliveries"],
        body: DevelopmentOpenRequest,
        response: {
          200: DevelopmentOpenResponse,
          400: Type.Object({ message: Type.String() }),
          503: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.status(200).send(await findDevelopmentPixelEvents(request.body));
      } catch (error) {
        if (error instanceof DevelopmentOpenTrackingError && error.status === 400)
          return reply.status(400).send({ message: "Invalid development evidence query" });
        logger().error("Unable to read development open evidence");
        return reply.status(503).send({ message: "Development evidence unavailable" });
      }
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/",
    {
      schema: {
        description: "Search through deliveries.",
        tags: ["Deliveries"],
        querystring: SearchDeliveriesRequest,
        response: {
          200: SearchDeliveriesResponse,
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      request.raw.on("close", () => {
        if (request.raw.destroyed) {
          logger().info(
            {
              workspaceId: request.query.workspaceId,
            },
            "delivery search aborted",
          );
          controller.abort();
        }
      });

      const deliveries = await searchDeliveries({
        ...request.query,
        abortSignal: controller.signal,
      });
      return reply.status(200).send(deliveries);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/count",
    {
      schema: {
        description: "Fetch count of deliveries for the given filters.",
        tags: ["Deliveries"],
        querystring: SearchDeliveriesRequest,
        response: {
          200: Type.Object({
            count: Type.Number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      request.raw.on("close", () => {
        if (request.raw.destroyed) {
          logger().info(
            {
              workspaceId: request.query.workspaceId,
            },
            "delivery count search aborted",
          );
          controller.abort();
        }
      });

      const count = await searchDeliveriesCount({
        ...request.query,
        abortSignal: controller.signal,
      });

      return reply.status(200).send({ count });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/download",
    {
      schema: {
        description: "Download a csv containing deliveries.",
        tags: ["Deliveries"],
        querystring: DownloadDeliveriesRequest,
        produces: ["text/csv"],
        response: {
          200: Type.String({ format: "binary" }),
        },
      },
    },
    async (request, reply) => {
      const { fileName, fileContent } = await buildDeliveriesFile(
        request.query,
      );
      return reply
        .header("Content-Disposition", `attachment; filename=${fileName}`)
        .type("text/csv")
        .send(fileContent);
    },
  );
}
