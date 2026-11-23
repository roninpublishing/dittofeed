import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { SpanStatusCode } from "@opentelemetry/api";
import { Type } from "@sinclair/typebox";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  confirmSubscription,
  handleSesNotification,
  validSNSSignature,
} from "backend-lib/src/destinations/amazonses";
import {
  InvalidTelnyxEventError,
  persistTelnyxEmailEvent,
  verifyTelnyxSignature,
} from "backend-lib/src/messaging/telnyxEvents";
import { handleSendgridEvents } from "backend-lib/src/destinations/sendgrid";
import logger from "backend-lib/src/logger";
import { NewsletterDeliveryError, receiveNewsletterWebhook } from "backend-lib/src/newsletterDelivery";
import { withSpan } from "backend-lib/src/openTelemetry";
import {
  AmazonSNSEvent,
  AmazonSNSEventTypes,
  SendgridEvent,
} from "backend-lib/src/types";
import { and, eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { fastifyRawBody } from "fastify-raw-body";
import { SecretNames } from "isomorphic-lib/src/constants";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { TelnyxSecret, WorkspaceStatusDbEnum } from "isomorphic-lib/src/types";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function webhookController(fastify: FastifyInstance) {
  await fastify.register(fastifyRawBody, { encoding: false, runFirst: true });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.addHook("onSend", async (request, reply, payload) => {
    if (request.routeOptions.url?.endsWith("/telnyx") || reply.statusCode !== 400) {
      return payload;
    }
    logger().error("Failed to validate webhook payload.");
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
      logger().debug({ eventCount: request.body.length }, "Received sendgrid events.");
      const result = await handleSendgridEvents({
        sendgridEvents: request.body,
        webhookSignature:
          request.headers["x-twilio-email-event-webhook-signature"],
        webhookTimestamp:
          request.headers["x-twilio-email-event-webhook-timestamp"],
        rawBody: request.rawBody,
      });
      if (result.isErr()) {
        logger().info("Error handling sendgrid webhook.");
        return reply.status(400).send({
          message: result.error.message,
        });
      }
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/sendgrid/connections/:connectionId",
    {
      config: { rawBody: true },
      bodyLimit: 2_000_000,
      schema: {
        operationId: "receiveNewsletterSendgridWebhook",
        description: "Durably receive a raw, signed callback for a newsletter sending connection.",
        tags: ["Webhooks"],
        params: Type.Object({ connectionId: Type.String({ format: "uuid" }) }),
        headers: Type.Object({
          "x-twilio-email-event-webhook-signature": Type.String(),
          "x-twilio-email-event-webhook-timestamp": Type.String(),
        }),
        body: Type.Array(Type.Record(Type.String(), Type.Unknown())),
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.rawBody)) return reply.status(400).send({ message: "Raw callback body required" });
      try {
        await receiveNewsletterWebhook({
          connectionId: request.params.connectionId,
          rawBody: request.rawBody,
          signature: request.headers["x-twilio-email-event-webhook-signature"],
          timestamp: request.headers["x-twilio-email-event-webhook-timestamp"],
        });
        return reply.status(202).send();
      } catch (error) {
        return reply.status(error instanceof NewsletterDeliveryError ? error.statusCode : 503)
          .send({ message: "Callback could not be received" });
      }
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
        logger().debug("Received AmazonSES event.");

        const { body } = request;
        // Validate the signature
        const valid = await validSNSSignature(body);

        if (valid.isErr()) {
          logger().error("Invalid signature for AmazonSES webhook.");
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
              logger().error("Unable to confirm AmazonSNS subscription.");
              return reply.status(401).send({});
            }
            logger().debug("AmazonSES Subscription confirmed");
            break;
          case AmazonSNSEventTypes.Notification: {
            const result = await handleSesNotification(body);
            if (result.isErr()) {
              logger().error("Error handling AmazonSES notification.");
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Error handling AmazonSES notification.",
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
    "/telnyx",
    {
      bodyLimit: 1024 * 1024,
      schema: {
        description: "Durably receive native Telnyx email events verified over the exact raw body.",
        tags: ["Webhooks"],
        querystring: Type.Object({ workspaceId: Type.String({ format: "uuid" }) }),
        headers: Type.Object({
          "telnyx-signature-ed25519": Type.String(),
          "telnyx-timestamp": Type.String(),
        }),
        // Validate the verified raw envelope inside the handler; never mutate it with AJV.
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.query;
      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Telnyx),
        ),
        with: { workspace: true },
      });
      const publicKey = schemaValidateWithErr(secret?.configValue, TelnyxSecret)
        .map((value) => value.publicKey).unwrapOr(undefined);
      if (!request.rawBody) {
        return reply.status(500).send({ message: "Raw request body unavailable." });
      }
      if (!secret?.workspace || secret.workspace.status !== WorkspaceStatusDbEnum.Active ||
          !verifyTelnyxSignature({
            rawBody: request.rawBody, publicKey,
            signature: request.headers["telnyx-signature-ed25519"],
            timestamp: request.headers["telnyx-timestamp"],
          })) {
        return reply.status(401).send({ message: "Invalid webhook authentication." });
      }
      try {
        await persistTelnyxEmailEvent({
          credentialWorkspaceId: workspaceId,
          rawBody: request.rawBody,
          headers: request.headers,
        });
      } catch (error) {
        if (error instanceof InvalidTelnyxEventError) {
          return reply.status(400).send({ message: "Invalid Telnyx event envelope." });
        }
        // Do not let framework error logging expose SQL parameters containing raw evidence.
        return reply.status(500).send({ message: "Unable to persist webhook receipt." });
      }
      return reply.status(202).send();
    },
  );
}
