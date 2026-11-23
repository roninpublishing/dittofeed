import { Client } from "@sendgrid/client";
import sendgridMail from "@sendgrid/mail";
import { randomUUID } from "crypto";
import { SourceType } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import { EmailProviderType, EventType, InternalEventType, SendgridEvent, SendgridEventType } from "../types";
import { sendgridEventToDF, sendMail } from "./sendgrid";

const { MailService } = sendgridMail as typeof sendgridMail & {
  MailService: new () => typeof sendgridMail;
};

function fixture(): SendgridEvent {
  return {
    email: "recipient@example.com",
    event: SendgridEventType.Click,
    timestamp: 1795176000,
    sg_event_id: "click-one",
    sg_message_id: "provider-send",
    workspaceId: randomUUID(),
    userId: "contact",
    messageId: "internal-send",
    url: "https://example.com/article?edition=1#chapter",
    useragent: "privacy proxy",
    ip: "192.0.2.1",
  };
}

describe("SendGrid click evidence", () => {
  it("preserves distinct clicks, retry identity, send correlation and observed provenance", () => {
    const event = fixture();
    const first = unwrap(sendgridEventToDF({ sendgridEvent: event }));
    const retry = unwrap(sendgridEventToDF({ sendgridEvent: { ...event } }));
    const repeated = unwrap(sendgridEventToDF({ sendgridEvent: { ...event, sg_event_id: "click-two" } }));
    expect(first).toEqual(retry);
    expect(repeated.messageId).not.toBe(first.messageId);
    expect(first).toMatchObject({
      type: EventType.Track,
      event: InternalEventType.EmailClicked,
      timestamp: new Date(event.timestamp * 1000).toISOString(),
      context: { source: SourceType.Webhook, provider: EmailProviderType.SendGrid },
      properties: {
        messageId: "internal-send", providerMessageId: "provider-send", providerEventId: "click-one",
        clickedAt: new Date(event.timestamp * 1000).toISOString(), url: event.url,
        user_agent: event.useragent, ip: event.ip, provider: EmailProviderType.SendGrid,
        evidenceSource: "sendgrid_webhook", engagementClassification: "observed_unqualified",
      },
    });
  });

  it("distinguishes repeat opens while preserving retry identity and raw provider observations", () => {
    const event = { ...fixture(), event: SendgridEventType.Open, sg_event_id: "open-one" };
    const first = unwrap(sendgridEventToDF({ sendgridEvent: event }));
    const next = unwrap(sendgridEventToDF({ sendgridEvent: { ...event, sg_event_id: "open-two" } }));
    expect(unwrap(sendgridEventToDF({ sendgridEvent: { ...event } }))).toEqual(first);
    expect(next.messageId).not.toBe(first.messageId);
    expect(first).toMatchObject({
      event: InternalEventType.EmailOpened,
      properties: {
        messageId: "internal-send", providerEventId: "open-one",
        openedAt: new Date(event.timestamp * 1000).toISOString(),
        user_agent: event.useragent, ip: event.ip,
        evidenceSource: "sendgrid_webhook", engagementClassification: "observed_unqualified",
      },
    });
    const legacy = { ...event, sg_event_id: undefined };
    const legacyFirst = unwrap(sendgridEventToDF({ sendgridEvent: legacy }));
    expect(unwrap(sendgridEventToDF({ sendgridEvent: { ...legacy, timestamp: legacy.timestamp + 1 } })).messageId)
      .not.toBe(legacyFirst.messageId);
  });

  it("scopes notification identity to the workspace", () => {
    const event = fixture();
    const first = unwrap(sendgridEventToDF({ sendgridEvent: event }));
    const other = unwrap(sendgridEventToDF({ sendgridEvent: { ...event, workspaceId: randomUUID() } }));
    expect(other.messageId).not.toBe(first.messageId);
  });

  it("uses deterministic timestamp/link fallback without inventing a provider event ID", () => {
    const event = { ...fixture(), sg_event_id: undefined };
    const first = unwrap(sendgridEventToDF({ sendgridEvent: event }));
    expect(unwrap(sendgridEventToDF({ sendgridEvent: { ...event } }))).toEqual(first);
    const later = unwrap(sendgridEventToDF({ sendgridEvent: { ...event, timestamp: event.timestamp + 1 } }));
    const otherLink = unwrap(sendgridEventToDF({ sendgridEvent: { ...event, url: "https://example.com/other" } }));
    expect(later.messageId).not.toBe(first.messageId);
    expect(otherLink.messageId).not.toBe(first.messageId);
    if (first.type !== EventType.Track) throw new Error("Expected track event");
    expect(first.properties).not.toHaveProperty("providerEventId");
  });

  it.each([
    [SendgridEventType.Processed, "processed"],
    [SendgridEventType.Bounce, "bounce"],
    [SendgridEventType.SpamReport, "spamreport"],
  ])("preserves smtp correlation for %s", (eventType, prefix) => {
    const event = { ...fixture(), event: eventType, "smtp-id": "<smtp-send@example.com>", sg_message_id: undefined };
    const first = unwrap(sendgridEventToDF({ sendgridEvent: event }));
    expect(first.messageId).toBe(`${prefix}:<smtp-send@example.com>`);
    expect(first).toMatchObject({ properties: { messageId: "internal-send", smtpId: "<smtp-send@example.com>" } });
    expect(unwrap(sendgridEventToDF({ sendgridEvent: { ...event, sg_event_id: "another-provider-id" } })).messageId).toBe(first.messageId);
  });
});

describe("SendGrid credential isolation", () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it("uses independent SDK clients for concurrent tenants, never the global key", async () => {
    const globalKey = jest.spyOn(sendgridMail, "setApiKey");
    const keys = jest.spyOn(MailService.prototype, "setApiKey");
    const sends = jest.spyOn(MailService.prototype, "send").mockResolvedValue([
      { statusCode: 202, headers: {}, body: {} }, {},
    ]);
    const data = { to: "subscriber@example.com", from: "editor@example.com", subject: "Isolated", html: "Body" };
    await Promise.all([
      sendMail({ apiKey: "restricted-first", mailData: data }),
      sendMail({ apiKey: "restricted-second", mailData: data }),
    ]);
    expect(globalKey).not.toHaveBeenCalled();
    expect(keys.mock.calls).toEqual([["restricted-first"], ["restricted-second"]]);
    expect(sends.mock.contexts[0]).not.toBe(sends.mock.contexts[1]);
  });

  it("configures the EU endpoint on an isolated client without changing global requests", async () => {
    const request = jest.spyOn(Client.prototype, "setDefaultRequest");
    jest.spyOn(MailService.prototype, "send").mockResolvedValue([
      { statusCode: 202, headers: {}, body: {} }, {},
    ]);
    await sendMail({
      apiKey: "restricted-eu", region: "eu",
      mailData: { to: "subscriber@example.com", from: "editor@example.com", subject: "EU", html: "Body" },
    });
    expect(request).toHaveBeenCalledWith("baseUrl", "https://api.eu.sendgrid.com/");
  });
});
