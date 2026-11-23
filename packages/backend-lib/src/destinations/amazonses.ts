import Https from "node:https";

import {
  MessageTag,
  SendEmailCommand,
  SendEmailCommandOutput,
  SendEmailRequest,
  SESv2Client,
  SESv2ServiceException,
} from "@aws-sdk/client-sesv2";
import { SpanStatusCode } from "@opentelemetry/api";
import { SourceType } from "isomorphic-lib/src/constants";
import {
  jsonParseSafe,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import { err, ok, Result, ResultAsync } from "neverthrow";
import MailComposer from "nodemailer/lib/mail-composer";
import Mail from "nodemailer/lib/mailer";
import * as R from "remeda";
import SnsPayloadValidator from "sns-payload-validator";
import { Overwrite } from "utility-types";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "../apps/batch";
import { canWorkspaceReceiveEventsById } from "../auth";
import { MESSAGE_METADATA_FIELDS } from "../constants";
import logger from "../logger";
import { withSpan } from "../openTelemetry";
import {
  AmazonSesConfig,
  AmazonSesEventPayload,
  AmazonSesMailFields,
  AmazonSesNotificationType,
  AmazonSNSEvent,
  AmazonSNSNotificationEvent,
  AmazonSNSSubscriptionEvent,
  AmazonSNSUnsubscribeEvent,
  BatchTrackData,
  EmailProviderType,
  EventType,
  InternalEventType,
} from "../types";

export type SesMailData = Overwrite<
  AmazonSesMailFields,
  {
    tags?: Record<string, string>;
  }
> & {
  attachments?: Mail.Attachment[];
};

export async function sendMail({
  config,
  mailData,
}: {
  config: AmazonSesConfig;
  mailData: SesMailData;
}): Promise<Result<SendEmailCommandOutput, SESv2ServiceException | unknown>> {
  const { accessKeyId, secretAccessKey, region, endpoint } = config;
  const client = new SESv2Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    ...(endpoint && { endpoint }),
  });

  const tags: MessageTag[] | undefined = mailData.tags
    ? Object.entries(mailData.tags).map(([Name, Value]) => ({
        Name,
        Value,
      }))
    : undefined;

  // Process attachments if they exist
  const attachments = Array.isArray(mailData.attachments)
    ? mailData.attachments
    : [];

  // Create mail options for MailComposer
  // Note: Bcc is excluded from MIME headers for privacy - SES v2 uses Destination.BccAddresses instead
  const mailOptions: Mail.Options = {
    from: mailData.from,
    to: mailData.to,
    subject: mailData.subject,
    cc: mailData.cc,
    html: mailData.html,
    attachments,
    headers: mailData.headers,
    replyTo: mailData.replyTo,
  };

  if (mailData.replyTo) {
    mailOptions.replyTo = mailData.replyTo;
  }

  // Use MailComposer to create raw email content
  const mailComposer = new MailComposer(mailOptions);

  let rawEmailContent: Buffer;
  try {
    // Build the message
    rawEmailContent = await mailComposer.compile().build();
  } catch (error) {
    logger().info(
      {
        templateId: mailData.tags?.templateId,
        workspaceId: mailData.tags?.workspaceId,
      },
      "Error sending ses email",
    );
    return err(error);
  }

  // Always use the Raw content interface with explicit destination parameters
  const input: SendEmailRequest = {
    FromEmailAddress: mailData.from,
    Destination: {
      ToAddresses: Array.isArray(mailData.to) ? mailData.to : [mailData.to],
      CcAddresses: mailData.cc,
      BccAddresses: mailData.bcc,
    },
    Content: {
      Raw: {
        Data: Uint8Array.from(rawEmailContent),
      },
    },
    EmailTags: tags,
  };

  // Add ReplyToAddresses if specified
  if (mailData.replyTo) {
    input.ReplyToAddresses = Array.isArray(mailData.replyTo)
      ? mailData.replyTo
      : [mailData.replyTo];
  }

  const command = new SendEmailCommand(input);

  try {
    const result = await client.send(command);
    return ok(result);
  } catch (error) {
    if (error instanceof SESv2ServiceException && !error.$retryable) {
      logger().info(
        {
          workspaceId: mailData.tags?.workspaceId,
          templateId: mailData.tags?.templateId,
        },
        "Non-retryable error sending ses email",
      );
      return err(error);
    }
    logger().error(
      {
        workspaceId: mailData.tags?.workspaceId,
        templateId: mailData.tags?.templateId,
      },
      "Retryable error sending ses email",
    );
    throw error;
  }
}

export async function submitAmazonSesEvents(
  event: AmazonSesEventPayload,
  notificationId: string,
): Promise<ResultAsync<void, Error>> {
  return withSpan({ name: "submit-amazon-ses-events" }, async () => {
    // TODO: Amazon may batch requests (if we send with multiple To: addresses? or with the BatchTemplated endpoint).  We should map over the receipients.
    let tags: Record<string, string>;
    if (event.mail.tags) {
      const mappedTags: Record<string, string> = {};
      for (const [key, values] of Object.entries(event.mail.tags)) {
        const [value] = values;
        if (value) {
          mappedTags[key] = value;
        }
      }
      tags = mappedTags;
    } else {
      tags = {};
    }

    const workspaceId = tags.workspaceId ?? null;
    const userId = tags.userId ?? null;

    if (!workspaceId) {
      return err(new Error("Workspace id not found"));
    }

    if (!(await canWorkspaceReceiveEventsById({ workspaceId }))) {
      return err(new Error("Workspace not eligible"));
    }

    let timestamp: string;
    let eventName: InternalEventType;
    switch (event.eventType) {
      case AmazonSesNotificationType.Bounce:
        eventName = InternalEventType.EmailBounced;
        timestamp = event.bounce.timestamp;
        break;
      case AmazonSesNotificationType.Complaint:
        eventName = InternalEventType.EmailMarkedSpam;
        timestamp = event.complaint.timestamp;
        break;
      case AmazonSesNotificationType.Delivery:
        eventName = InternalEventType.EmailDelivered;
        timestamp = event.delivery.timestamp;
        break;
      case AmazonSesNotificationType.Open:
        eventName = InternalEventType.EmailOpened;
        timestamp = event.open.timestamp;
        break;
      case AmazonSesNotificationType.Click:
        eventName = InternalEventType.EmailClicked;
        timestamp = event.click.timestamp;
        break;
      default:
        return err(
          new Error(`Unhandled Amazon SES event type: ${event.eventType}`),
        );
    }

    // SNS MessageId identifies this notification. mail.messageId identifies the
    // outbound provider send and is shared by all of its click notifications.
    const messageId = uuidv5(`${event.eventType}:${notificationId}`, workspaceId);
    const metadataTags = R.pick(tags, MESSAGE_METADATA_FIELDS);
    const properties: Record<string, unknown> = {
      email: event.mail.destination?.[0],
      ...metadataTags,
      provider: EmailProviderType.AmazonSes,
      providerMessageId: event.mail.messageId,
      providerEventId: notificationId,
      evidenceSource: "amazonses_webhook",
    };
    if (event.eventType === AmazonSesNotificationType.Click) {
      properties.clickedAt = new Date(timestamp).toISOString();
      properties.engagementClassification = "observed_unqualified";
      if (event.click.link) properties.url = event.click.link;
      if (event.click.ipAddress) properties.ip = event.click.ipAddress;
      if (event.click.userAgent) properties.user_agent = event.click.userAgent;
      if (event.click.linkTags) properties.linkTags = event.click.linkTags;
    }
    if (event.eventType === AmazonSesNotificationType.Open) {
      properties.openedAt = new Date(timestamp).toISOString();
      properties.engagementClassification = "observed_unqualified";
      if (event.open.ipAddress) properties.ip = event.open.ipAddress;
      if (event.open.userAgent) properties.user_agent = event.open.userAgent;
    }

    const items: BatchTrackData[] = [];
    if (userId) {
      items.push({
        type: EventType.Track,
        event: eventName,
        userId,
        messageId,
        timestamp,
        properties,
      });
    }
    return ResultAsync.fromPromise(
      submitBatch({
        workspaceId,
        data: {
          context: {
            source: SourceType.Webhook,
            provider: EmailProviderType.AmazonSes,
          },
          batch: items,
          ...metadataTags,
        },
      }),
      (e) => (e instanceof Error ? e : Error(e as string)),
    );
  });
}

export async function validSNSSignature(payload: AmazonSNSEvent) {
  const validator = new SnsPayloadValidator();

  return ResultAsync.fromPromise(validator.validate(payload), (error) => error);
}

export async function confirmSubscription(
  payload: AmazonSNSSubscriptionEvent | AmazonSNSUnsubscribeEvent,
) {
  return ResultAsync.fromPromise(
    new Promise((res) => {
      Https.get(payload.SubscribeURL, res);
    }),
    (error) => error,
  );
}

export async function handleSesNotification(
  payload: AmazonSNSNotificationEvent,
): Promise<Result<void, Error>> {
  return withSpan({ name: "handle-ses-notification" }, async (span) => {
    const validated = jsonParseSafe(payload.Message).andThen((parsed) =>
      schemaValidateWithErr(parsed, AmazonSesEventPayload),
    );
    if (validated.isErr()) {
      logger().error("Invalid AmazonSes event payload.");

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "Invalid AmazonSes event payload.",
      });
      return err(validated.error);
    }
    const result = await submitAmazonSesEvents(validated.value, payload.MessageId);
    if (result.isErr()) {
      logger().error("Error submitting AmazonSes events.");

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "Error submitting AmazonSes events.",
      });
      return err(result.error);
    }
    return ok(undefined);
  });
}
