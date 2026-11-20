import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { SpanStatusCode } from "@opentelemetry/api";
import { Type } from "@sinclair/typebox";
import { canWorkspaceReceiveEvents } from "backend-lib/src/auth";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  confirmSubscription,
  handleSesNotification,
  validSNSSignature,
} from "backend-lib/src/destinations/amazonses";
import { submitResendEvents } from "backend-lib/src/destinations/resend";
import { handleSendgridEvents } from "backend-lib/src/destinations/sendgrid";
import logger from "backend-lib/src/logger";
import { withSpan } from "backend-lib/src/openTelemetry";
import {
  AmazonSNSEvent,
  AmazonSNSEventTypes,
  ResendEvent,
  SendgridEvent,
} from "backend-lib/src/types";
import { and, eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { fastifyRawBody } from "fastify-raw-body";
import { SecretNames } from "isomorphic-lib/src/constants";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { ResendSecret } from "isomorphic-lib/src/types";
import { Webhook } from "svix";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function webhookController(fastify: FastifyInstance) {
  await fastify.register(fastifyRawBody);

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode !== 400) {
      return payload;
    }
    logger().error(
      {
        payload,
      },
      "Failed to validate webhook payload.",
    );
    return payload;
  });

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/sendgrid",
    {
      schema: {
        description: "Used to consume sendgrid webhook payloads.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "x-twilio-email-event-webhook-signature": Type.String(),
          "x-twilio-email-event-webhook-timestamp": Type.String(),
        }),
        body: Type.Array(SendgridEvent),
      },
    },
    async (request, reply) => {
      logger().debug({ body: request.body }, "Received sendgrid events.");
      const result = await handleSendgridEvents({
        sendgridEvents: request.body,
        webhookSignature:
          request.headers["x-twilio-email-event-webhook-signature"],
        webhookTimestamp:
          request.headers["x-twilio-email-event-webhook-timestamp"],
        rawBody: request.rawBody,
      });
      if (result.isErr()) {
        logger().info(
          {
            err: result.error,
          },
          "Error handling sendgrid webhook.",
        );
        return reply.status(400).send({
          message: result.error.message,
        });
      }
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/amazon-ses",
    {
      schema: {
        description: "Used to consume amazonses notification events.",
        tags: ["Webhooks"],
        body: AmazonSNSEvent,
      },
      // Force JSON parsing the request body as SNS send requests with text/plain content-type.
      onRequest: (req, _, done) => {
        // eslint-disable-next-line no-param-reassign
        req.headers["content-type"] = "application/json";
        done();
      },
    },
    async (request, reply) => {
      return withSpan({ name: "amazon-ses-webhook" }, async (span) => {
        logger().debug({ body: request.body }, "Received AmazonSES event.");

        const { body } = request;
        // Validate the signature
        const valid = await validSNSSignature(body);

        if (valid.isErr()) {
          logger().error(
            "Invalid signature for AmazonSES webhook.",
            valid.error,
          );
          return reply.status(401).send({ message: "Invalid signature" });
        }

        span.setAttribute("type", body.Type);
        switch (body.Type) {
          // Amazon will send a confirmation Type event we must use to enable (subscribe to) the webhook.
          // UnsubscribeConfirmation type events occur when our application requests disabling
          // the webhook. Since we never do this, we respond by re-confirming the subscription.
          case AmazonSNSEventTypes.SubscriptionConfirmation:
          case AmazonSNSEventTypes.UnsubscribeConfirmation:
            /* eslint-disable-next-line no-case-declarations */
            const confirmed = await confirmSubscription(body);
            if (confirmed.isErr()) {
              logger().error("Unable to confirm AmazonSNS subscription.", {
                error: confirmed.error,
              });
              return reply.status(401).send({});
            }
            logger().debug("AmazonSES Subscription confirmed");
            break;
          case AmazonSNSEventTypes.Notification: {
            const result = await handleSesNotification(body);
            if (result.isErr()) {
              logger().error("Error handling AmazonSES notification.", {
                error: result.error,
              });
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: result.error.message,
              });
              return reply.status(500).send();
            }
            break;
          }
        }

        return reply.status(200).send();
      });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/resend",
    {
      schema: {
        description: "Used to consume resend webhook payloads.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "svix-id": Type.String(),
          "svix-timestamp": Type.String(),
          "svix-signature": Type.String(),
        }),
        body: ResendEvent,
      },
    },
    async (request, reply) => {
      logger().debug({ body: request.body }, "Received resend events.");

      const { workspaceId } = request.body.data.tags;
      if (!workspaceId) {
        logger().info(
          {
            tags: request.body.data.tags,
          },
          "Missing workspaceId on resend tags",
        );
        return reply.status(200).send();
      }

      if (!workspaceId) {
        logger().error("Missing workspaceId on resend events.");
        return reply.status(400).send({
          error: "Missing workspaceId custom arg.",
        });
      }

      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Resend),
        ),
        with: {
          workspace: true,
        },
      });

      const webhookKey = schemaValidateWithErr(
        secret?.configValue,
        ResendSecret,
      )
        .map((val) => val.webhookKey)
        .unwrapOr(null);

      if (!webhookKey) {
        logger().error(
          {
            workspaceId,
          },
          "Missing resend webhook secret.",
        );
        return reply.status(400).send({
          error: "Missing secret.",
        });
      }

      if (!request.rawBody || typeof request.rawBody !== "string") {
        logger().error({ workspaceId }, "Missing rawBody on resend webhook.");
        return reply.status(500).send();
      }

      const wh = new Webhook(webhookKey);
      const verified = wh.verify(request.rawBody, request.headers);

      if (!verified) {
        logger().error(
          {
            workspaceId,
          },
          "Invalid signature for resend webhook.",
        );
        return reply.status(401).send({
          message: "Invalid signature.",
        });
      }

      if (
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({
          message: "Workspace not eligible.",
        });
      }

      await submitResendEvents({
        workspaceId,
        events: [request.body],
      });
      return reply.status(200).send();
    },
  );
}
