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
        200: {
          type: "string",
          format: "binary",
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
