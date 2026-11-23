import { randomUUID } from "crypto";
import { SourceType } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import { submitBatch } from "../apps/batch";
import { canWorkspaceReceiveEventsById } from "../auth";
import { AmazonSesEventPayload, AmazonSesNotificationType, AmazonSNSEventTypes, AmazonSNSNotificationEvent, EmailProviderType, InternalEventType } from "../types";
import { handleSesNotification } from "./amazonses";

jest.mock("../apps/batch", () => ({ submitBatch: jest.fn() }));
jest.mock("../auth", () => ({ canWorkspaceReceiveEventsById: jest.fn() }));

const submit = jest.mocked(submitBatch);
const eligible = jest.mocked(canWorkspaceReceiveEventsById);

function fixture(): AmazonSNSNotificationEvent {
  const event: AmazonSesEventPayload = {
    eventType: AmazonSesNotificationType.Click,
    mail: {
      timestamp: "2026-11-20T00:00:00.000Z", messageId: "ses-provider-send",
      destination: ["recipient@example.com"],
      tags: { workspaceId: [randomUUID()], userId: ["contact"], messageId: ["internal-send"] },
    },
    click: {
      timestamp: "2026-11-20T14:23:45.123+02:00",
      link: "https://example.com/article?edition=1#chapter",
      ipAddress: "192.0.2.2", userAgent: "privacy proxy", linkTags: { edition: ["one"] },
    },
  };
  return {
    Type: AmazonSNSEventTypes.Notification, Message: JSON.stringify(event), MessageId: randomUUID(),
    TopicArn: "arn:aws:sns:us-east-1:123456789012:email-events", Timestamp: "2026-11-20T12:30:00Z",
    SignatureVersion: "1", Signature: "verified-by-caller", SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    UnsubscribeURL: "https://sns.us-east-1.amazonaws.com/unsubscribe",
  };
}

describe("SES notification click evidence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    eligible.mockResolvedValue(true);
    submit.mockResolvedValue(undefined);
  });

  it("uses SNS notification identity rather than collapsing all clicks on a provider send", async () => {
    const notification = fixture();
    unwrap(await handleSesNotification(notification));
    unwrap(await handleSesNotification({ ...notification }));
    const repeated = { ...notification, MessageId: randomUUID() };
    unwrap(await handleSesNotification(repeated));
    const first = submit.mock.calls[0]?.[0];
    const retry = submit.mock.calls[1]?.[0];
    const another = submit.mock.calls[2]?.[0];
    expect(first).toEqual(retry);
    expect(another?.data.batch[0]?.messageId).not.toBe(first?.data.batch[0]?.messageId);
    expect(first?.data).toMatchObject({
      context: { source: SourceType.Webhook, provider: EmailProviderType.AmazonSes },
      batch: [{
        event: InternalEventType.EmailClicked, userId: "contact", timestamp: "2026-11-20T14:23:45.123+02:00",
        properties: {
          messageId: "internal-send", providerMessageId: "ses-provider-send", providerEventId: notification.MessageId,
          clickedAt: "2026-11-20T12:23:45.123Z", url: "https://example.com/article?edition=1#chapter",
          ip: "192.0.2.2", user_agent: "privacy proxy", linkTags: { edition: ["one"] },
          evidenceSource: "amazonses_webhook", engagementClassification: "observed_unqualified", provider: EmailProviderType.AmazonSes,
        },
      }],
    });
    expect(another?.data).toMatchObject({ batch: [{ properties: { providerEventId: repeated.MessageId, messageId: "internal-send" } }] });
  });

  it("preserves event time for a late click, not SNS receipt/send time", async () => {
    const notification = fixture();
    const event = JSON.parse(notification.Message) as AmazonSesEventPayload;
    if (event.eventType !== AmazonSesNotificationType.Click) throw new Error("Expected click fixture");
    event.click.timestamp = "2026-11-18T23:59:59.987-05:00";
    notification.Message = JSON.stringify(event);
    unwrap(await handleSesNotification(notification));
    expect(submit.mock.calls[0]?.[0].data.batch[0]).toMatchObject({
      timestamp: event.click.timestamp,
      properties: { clickedAt: "2026-11-19T04:59:59.987Z" },
    });
  });

  it("retains open occurrence, proxy evidence and distinct SNS notification identity", async () => {
    const notification = fixture();
    const clicked = JSON.parse(notification.Message) as AmazonSesEventPayload;
    const event: AmazonSesEventPayload = {
      eventType: AmazonSesNotificationType.Open,
      mail: clicked.mail,
      open: {
        timestamp: "2026-11-19T01:23:45.123+02:00",
        ipAddress: "192.0.2.8", userAgent: "Apple privacy proxy",
      },
    };
    notification.Message = JSON.stringify(event);
    unwrap(await handleSesNotification(notification));
    unwrap(await handleSesNotification({ ...notification }));
    unwrap(await handleSesNotification({ ...notification, MessageId: randomUUID() }));
    expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
    expect(submit.mock.calls[2]?.[0].data.batch[0]?.messageId)
      .not.toBe(submit.mock.calls[0]?.[0].data.batch[0]?.messageId);
    expect(submit.mock.calls[0]?.[0].data.batch[0]).toMatchObject({
      event: InternalEventType.EmailOpened,
      timestamp: event.open.timestamp,
      properties: {
        messageId: "internal-send", providerEventId: notification.MessageId,
        openedAt: "2026-11-18T23:23:45.123Z",
        ip: "192.0.2.8", user_agent: "Apple privacy proxy",
        evidenceSource: "amazonses_webhook", engagementClassification: "observed_unqualified",
      },
    });
  });

  it("keeps the workspace eligibility boundary and does not ingest malformed payloads", async () => {
    eligible.mockResolvedValue(false);
    expect((await handleSesNotification(fixture())).isErr()).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    eligible.mockResolvedValue(true);
    expect((await handleSesNotification({ ...fixture(), Message: "not-json" })).isErr()).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
