import { createSign, generateKeyPairSync, randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { ok } from "neverthrow";

import * as batch from "./apps/batch";
import { db } from "./db";
import { workspace, messageTemplate, subscriptionGroup } from "./db/schema";
import * as tables from "./db/publisherSchema";
import * as sendgrid from "./destinations/sendgrid";
import * as infrastructure from "./newsletterInfrastructure";
import { sendEmail, testTemplate } from "./messaging";
import { synchronizeNewsletterSubscriptionEvents } from "./newsletterSubscriptions";
import { buildSubscriptionChangeEventInner } from "./subscriptionGroups";
import {
  deleteNewsletterDeliveryData,
  drainNewsletterSends,
  drainNewsletterWebhookReceipts,
  getNewsletterEmailContext,
  getNewsletterSendStatusByMessageId,
  newsletterCapacityLimits,
  newsletterSuppressionReason,
  receiveNewsletterWebhook,
  sendNewsletterEmail,
  upsertPublisherSuppression,
  verifyNewsletterWebhookSignature,
} from "./newsletterDelivery";
import { decrypt, encrypt } from "./secrets";
import {
  ChannelType,
  EmailContentsType,
  EmailProviderType,
  InternalEventType,
  SubscriptionChange,
} from "./types";
import { createWorkspace } from "./workspaces";

const signingKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const callbackKey = signingKeys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function signed(
  rawBody: Buffer,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  return {
    rawBody,
    timestamp,
    signature: createSign("sha256").update(timestamp)
      .update(new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength))
      .sign(signingKeys.privateKey, "base64"),
  };
}

describe("newsletter callback signature and suppression policies", () => {
  it("verifies exact raw bytes and bounded rotation keys, not expired keys or reserialized bodies", () => {
    const rawBody = Buffer.from('[ {"event":"processed"} ]');
    const signature = signed(rawBody);
    expect(
      verifyNewsletterWebhookSignature({
        ...signature,
        keys: [{ key: "bad" }, { key: callbackKey }],
      }),
    ).toBe(true);
    expect(
      verifyNewsletterWebhookSignature({
        ...signature,
        rawBody: Buffer.from('[{"event":"processed"}]'),
        keys: [{ key: callbackKey }],
      }),
    ).toBe(false);
    expect(
      verifyNewsletterWebhookSignature({
        ...signature,
        keys: [
          {
            key: callbackKey,
            validUntil: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      }),
    ).toBe(false);
    expect(
      verifyNewsletterWebhookSignature({
        ...signature,
        keys: [{ key: callbackKey, validUntil: "invalid" }],
      }),
    ).toBe(false);
    expect(
      verifyNewsletterWebhookSignature({
        ...signature,
        now: Date.now() + 600_000,
        keys: [{ key: callbackKey }],
      }),
    ).toBe(false);
  });

  it("keeps ordinary unsubscribe local and never classifies transient/policy bounces as invalid mailboxes", () => {
    expect(newsletterSuppressionReason({ event: "spamreport" })).toBe(
      "complaint",
    );
    expect(newsletterSuppressionReason({ event: "unsubscribe" })).toBeNull();
    expect(
      newsletterSuppressionReason({ event: "group_unsubscribe" }),
    ).toBeNull();
    expect(
      newsletterSuppressionReason({ event: "bounce", status: "5.1.1" }),
    ).toBe("invalid_mailbox");
    expect(
      newsletterSuppressionReason({ event: "bounce", status: "5.7.1" }),
    ).toBeNull();
    expect(
      newsletterSuppressionReason({ event: "bounce", status: "4.2.2" }),
    ).toBeNull();
  });

  it("caps warmup by physical limits and refuses a future/not-started warmup", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const ip = {
      hourlyLimit: 20,
      dailyLimit: 100,
      warmupStartedAt: new Date("2026-11-19T12:00:00Z"),
      warmupSchedule: [
        { afterDays: 0, hourlyLimit: 2, dailyLimit: 5 },
        { afterDays: 2, hourlyLimit: 200, dailyLimit: 1000 },
      ],
    };
    expect(newsletterCapacityLimits(ip, now)).toEqual({ hourly: 2, daily: 5 });
    expect(
      newsletterCapacityLimits(ip, new Date("2026-11-22T12:00:00Z")),
    ).toEqual({ hourly: 20, daily: 100 });
    expect(
      newsletterCapacityLimits(ip, new Date("2026-11-18T12:00:00Z")),
    ).toEqual({ hourly: 0, daily: 0 });
  });
});

describe("durable newsletter sends and signed inbox", () => {
  let publisherId: string;
  let newsletterIds: string[];
  let connectionIds: string[];
  let poolId: string;
  let ipId: string;
  let provider: jest.SpyInstance;
  let projection: jest.SpyInstance;

  beforeEach(async () => {
    publisherId = (await createWorkspace({ name: randomUUID() }).then(unwrap))
      .id;
    newsletterIds = await Promise.all(
      [0, 1].map(
        async () =>
          (await createWorkspace({ name: randomUUID() }).then(unwrap)).id,
      ),
    );
    await db().insert(tables.publisher).values({ workspaceId: publisherId });
    await db()
      .insert(tables.newsletter)
      .values(
        newsletterIds.map((id, i) => ({
          workspaceId: id,
          publisherId,
          slug: `publication-${i}`,
          status: "active" as const,
        })),
      );
    await db()
      .insert(tables.publisherSendgridAccount)
      .values({
        publisherId,
        allowRealSends: true,
        allTrafficControlled: true,
      });
    connectionIds = newsletterIds.map(() => randomUUID());
    await db()
      .insert(tables.sendingConnection)
      .values(
        newsletterIds.map((id, i) => ({
          id: connectionIds[i],
          publisherId,
          newsletterId: id,
          username: `subuser-${i}`,
          administrativeEmail: `admin-${i}@example.com`,
          encryptedApiKey: encrypt(`restricted-key-${i}`),
          senderDomains: ["example.com"],
          webhookKeys: [{ key: callbackKey }],
          status: "ready" as const,
        })),
      );
    ipId = randomUUID();
    poolId = randomUUID();
    await db()
      .insert(tables.sendingIp)
      .values({
        id: ipId,
        publisherId,
        address: "192.0.2.10",
        status: "active",
        hourlyLimit: 3,
        dailyLimit: 3,
      });
    await db()
      .insert(tables.sendingPool)
      .values({ id: poolId, publisherId, name: "shared-single-ip" });
    await db().insert(tables.sendingPoolIp).values({ poolId, ipId });
    await db()
      .insert(tables.sendingPoolBinding)
      .values(
        connectionIds.map((connectionId) => ({
          connectionId,
          poolId,
          providerPoolName: "physical-ip-one",
        })),
      );
    await db()
      .insert(tables.newsletterRoute)
      .values(
        newsletterIds.map((newsletterId, i) => ({
          newsletterId,
          connectionId: connectionIds[i]!,
          poolId,
        })),
      );
    jest
      .spyOn(infrastructure, "verifyPinnedNewsletterRouting")
      .mockResolvedValue(undefined);
    provider = jest
      .spyOn(sendgrid, "sendMail")
      .mockImplementation(async () =>
        ok({
          statusCode: 202,
          body: {},
          headers: { "x-message-id": randomUUID() },
        }),
      );
    projection = jest.spyOn(batch, "submitBatch").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db()
      .delete(tables.newsletterWebhookReceipt)
      .where(
        inArray(tables.newsletterWebhookReceipt.connectionId, connectionIds),
      );
    await db()
      .delete(tables.newsletterSend)
      .where(eq(tables.newsletterSend.publisherId, publisherId));
    await db()
      .delete(workspace)
      .where(inArray(workspace.id, [...newsletterIds, publisherId]));
  });

  async function enqueue(
    index = 0,
    copies = 1,
    logicalMessageId: string = randomUUID(),
  ) {
    const workspaceId = newsletterIds[index]!;
    const userId = `contact-${index}`;
    const recipients = Array.from({ length: copies }, (_, i) =>
      i === 0 ? "subscriber@example.com" : `copy-${i}@example.com`,
    );
    const html =
      'https://example.com/?subscriber_email=subscriber%40example.com<img src="owned-pixel">';
    const result = await sendNewsletterEmail({
      workspaceId,
      publisherId,
      userId,
      logicalMessageId,
      recipients,
      from: "editor@example.com",
      tags: { messageId: logicalMessageId, userId },
      mailData: {
        from: "editor@example.com",
        to: recipients[0]!,
        cc: recipients.slice(1),
        html,
        subject: "Original subject",
        customArgs: { templateId: "original-template" },
      },
      success: {
        type: InternalEventType.MessageSent,
        variant: {
          type: ChannelType.Email,
          from: "editor@example.com",
          to: recipients[0]!,
          body: html,
          subject: "Original subject",
          provider: { type: EmailProviderType.SendGrid },
        },
      },
    });
    expect(result.isOk()).toBe(true);
    const status = await getNewsletterSendStatusByMessageId({
      workspaceId,
      messageId: logicalMessageId,
    });
    if (!status) throw new Error("Missing durable send");
    return { ...status, workspaceId, userId, logicalMessageId };
  }

  async function callback(connectionIndex: number, events: unknown[]) {
    await receiveNewsletterWebhook({
      connectionId: connectionIds[connectionIndex]!,
      ...signed(Buffer.from(JSON.stringify(events))),
    });
  }

  it("routes actual tests and personalized sends centrally after rendering, ignoring legacy overrides without fallback", async () => {
    const workspaceId = newsletterIds[0]!;
    const templateId = randomUUID();
    await db()
      .insert(messageTemplate)
      .values({
        id: templateId,
        workspaceId,
        name: randomUUID(),
        definition: {
          type: ChannelType.Email,
          emailContentsType: EmailContentsType.Code,
          identifierKey: "destination",
          from: "{{user.sender}}",
          subject: "For {{user.edition}}",
          body: '<a href="https://example.com/?subscriber_email={{subscriber_email}}&edition={{user.edition | url_encode}}">Read</a>',
          cc: "copy@example.com",
        },
      });
    const messageId = randomUUID();
    const result = await testTemplate({
      workspaceId,
      templateId,
      channel: ChannelType.Email,
      provider: EmailProviderType.Test,
      tags: { messageId },
      userProperties: {
        id: "actual-test-contact",
        email: "wrong@example.com",
        destination: "real+reader@example.com",
        sender: "editor@example.com",
        edition: "one two",
      },
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      type: InternalEventType.MessageQueued,
    });
    expect(provider).not.toHaveBeenCalled();
    const [send] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.logicalMessageId, messageId));
    const envelope = JSON.parse(decrypt(send!.encryptedPayload!)!) as {
      mailData: Record<string, unknown>;
    };
    expect(envelope.mailData).toMatchObject({
      to: "real+reader@example.com",
      from: { email: "editor@example.com" },
      subject: "For one two",
    });
    const href = String(envelope.mailData.html).match(/href="([^"]+)"/)?.[1];
    if (!href) throw new Error("Queued email must retain its rendered destination");
    const destination = new URL(href);
    expect(destination.searchParams.get("subscriber_email")).toBe("real+reader@example.com");
    expect(destination.searchParams.get("edition")).toBe("one two");
    expect(send?.recipientCount).toBe(2);
    await db()
      .delete(tables.newsletterRoute)
      .where(eq(tables.newsletterRoute.newsletterId, workspaceId));
    const noFallback = await sendEmail({
      workspaceId,
      templateId,
      userId: "actual-test-contact",
      useDraft: false,
      userPropertyAssignments: {
        destination: "real+reader@example.com",
        sender: "editor@example.com",
        edition: "one two",
      },
      messageTags: { messageId: randomUUID() },
      providerOverride: EmailProviderType.Test,
    });
    expect(noFallback.isErr()).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it("blocks publisher sending and preserves legacy non-opted-in workspaces", async () => {
    await expect(getNewsletterEmailContext(publisherId)).rejects.toThrow(
      "Publisher workspaces cannot send email",
    );
    expect(await getNewsletterEmailContext(newsletterIds[0]!)).toEqual({
      publisherId,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("serializes shared physical-IP budgets across concurrent subusers and counts every recipient copy", async () => {
    const first = await enqueue(0, 2);
    const second = await enqueue(1, 2);
    expect(provider).not.toHaveBeenCalled();
    expect(projection).not.toHaveBeenCalled();
    await Promise.all([drainNewsletterSends(), drainNewsletterSends()]);
    const rows = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.publisherId, publisherId));
    expect(rows.filter((row) => row.state === "accepted")).toHaveLength(1);
    expect(rows.filter((row) => row.state === "queued")).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(1);
    const budgets = await db()
      .select()
      .from(tables.sendingIpBudget)
      .where(eq(tables.sendingIpBudget.ipId, ipId));
    expect(budgets.map((row) => row.reserved)).toEqual([2, 2]);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set([first.sendId, second.sendId]),
    );
  });

  it("pins credentials/rendered attribution/pool before attempts and ignores later route/key changes", async () => {
    const queued = await enqueue();
    await db()
      .update(tables.sendingConnection)
      .set({ encryptedApiKey: encrypt("rotated-key"), revision: 2 })
      .where(eq(tables.sendingConnection.id, connectionIds[0]!));
    await db()
      .update(tables.newsletterRoute)
      .set({ version: 2 })
      .where(eq(tables.newsletterRoute.newsletterId, queued.workspaceId));
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "restricted-key-0",
        mailData: expect.objectContaining({
          ipPoolName: "physical-ip-one",
          html: expect.stringContaining("subscriber%40example.com"),
        }),
      }),
    );
    const [row] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(row).toMatchObject({
      routeVersion: 1,
      connectionRevision: 1,
      state: "accepted",
    });
    expect(row?.acceptedEventAt).not.toBeNull();
    const raw = JSON.stringify(row);
    expect(raw).not.toContain("subscriber@example.com");
    expect(raw).not.toContain("Original subject");
    expect(raw).not.toContain("restricted-key");
    expect(projection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: queued.workspaceId,
        data: expect.objectContaining({
          batch: [
            expect.objectContaining({
              event: InternalEventType.MessageSent,
              properties: expect.objectContaining({
                messageId: queued.logicalMessageId,
                templateId: "original-template",
                sendingIpId: ipId,
                connectionId: connectionIds[0],
                variant: expect.objectContaining({
                  type: ChannelType.Email,
                  body: expect.stringContaining("subscriber%40example.com"),
                }),
              }),
            }),
          ],
        }),
      }),
      expect.anything(),
    );
    await drainNewsletterSends();
    expect(projection).toHaveBeenCalledTimes(1);
  });

  it("never resends after an ambiguous provider response or stale submitting claim", async () => {
    provider.mockRejectedValue(new Error("socket closed after request"));
    const queued = await enqueue();
    await drainNewsletterSends();
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId: queued.workspaceId,
        messageId: queued.logicalMessageId,
      }),
    ).toMatchObject({ state: "unknown", terminal: true });
    expect(projection).not.toHaveBeenCalled();
    const abandoned = await enqueue(1);
    await db()
      .update(tables.newsletterSend)
      .set({
        state: "submitting",
        attempts: 1,
        updatedAt: new Date(Date.now() - 700_000),
      })
      .where(eq(tables.newsletterSend.id, abandoned.sendId));
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId: abandoned.workspaceId,
        messageId: abandoned.logicalMessageId,
      }),
    ).toMatchObject({ state: "unknown" });
  });

  it("publisher suppressions block all newsletter copies before submission without promoting policy failures", async () => {
    await enqueue(0);
    await enqueue(1);
    await upsertPublisherSuppression({
      publisherId,
      email: " Subscriber@Example.com ",
      reason: "manual",
    });
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    const rows = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.publisherId, publisherId));
    expect(rows.map((row) => row.state)).toEqual(["suppressed", "suppressed"]);
  });

  it("deduplicates signed callbacks, ignores malicious metadata, learns SMTP correlation and preserves event time", async () => {
    const queued = await enqueue();
    await drainNewsletterSends();
    const [row] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    projection.mockClear();
    const timestamp = Math.floor(Date.now() / 1000) - 120;
    const event = {
      event: "processed",
      timestamp,
      email: "subscriber@example.com",
      sg_event_id: "processed-one",
      sg_message_id: `${row!.providerMessageId}.filter`,
      "smtp-id": "<actual-provider-smtp-id>",
      workspaceId: newsletterIds[1],
      userId: "attacker",
      messageId: "attacker-message",
      templateId: "attacker-template",
    };
    await Promise.all([callback(0, [event]), callback(0, [event])]);
    await drainNewsletterWebhookReceipts();
    expect(projection).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: queued.workspaceId,
        data: expect.objectContaining({
          batch: [
            expect.objectContaining({
              userId: queued.userId,
              timestamp: new Date(timestamp * 1000).toISOString(),
              properties: expect.objectContaining({
                messageId: queued.logicalMessageId,
                templateId: "original-template",
              }),
            }),
          ],
        }),
      }),
      expect.anything(),
    );
    await callback(0, [
      {
        event: "bounce",
        timestamp,
        email: "subscriber@example.com",
        sg_event_id: "bounce-one",
        "smtp-id": "<actual-provider-smtp-id>",
        status: "5.7.1",
      },
    ]);
    await drainNewsletterWebhookReceipts();
    expect(projection).toHaveBeenCalledTimes(2);
    expect(
      await db()
        .select()
        .from(tables.publisherSuppression)
        .where(eq(tables.publisherSuppression.publisherId, publisherId)),
    ).toHaveLength(0);
    await callback(1, [{ ...event, sg_event_id: "wrong-connection" }]);
    await drainNewsletterWebhookReceipts();
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("erases encrypted payloads/receipts and blocks late callbacks and stale logical retries", async () => {
    const queued = await enqueue();
    await drainNewsletterSends();
    const [row] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    const event = {
      event: "open",
      email: "subscriber@example.com",
      timestamp: Math.floor(Date.now() / 1000),
      sg_event_id: "open-before-erasure",
      sg_message_id: row!.providerMessageId,
    };
    await callback(0, [event]);
    await deleteNewsletterDeliveryData({
      workspaceId: queued.workspaceId,
      userIds: [queued.userId],
    });
    await callback(0, [{ ...event, sg_event_id: "open-after-erasure" }]);
    projection.mockClear();
    await drainNewsletterWebhookReceipts();
    await drainNewsletterSends();
    expect(projection).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    const [erased] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(erased).toMatchObject({
      state: "suppressed",
      encryptedPayload: null,
      encryptedRecipient: null,
      encryptedCredential: null,
    });
    expect(erased?.userId).not.toBe(queued.userId);
    const receipts = await db()
      .select()
      .from(tables.newsletterWebhookReceipt)
      .where(
        eq(tables.newsletterWebhookReceipt.connectionId, connectionIds[0]!),
      );
    expect(receipts.every((receipt) => receipt.encryptedPayload === null)).toBe(
      true,
    );
    const retry = await sendNewsletterEmail({
      workspaceId: queued.workspaceId,
      publisherId,
      userId: queued.userId,
      logicalMessageId: queued.logicalMessageId,
      recipients: ["subscriber@example.com"],
      from: "editor@example.com",
      mailData: {
        from: "editor@example.com",
        to: "subscriber@example.com",
        html: "must not resurrect",
        subject: "No",
      },
      success: {
        type: InternalEventType.MessageSent,
        variant: {
          type: ChannelType.Email,
          from: "editor@example.com",
          to: "subscriber@example.com",
          body: "No",
          subject: "No",
          provider: { type: EmailProviderType.SendGrid },
        },
      },
    });
    expect(retry.isErr()).toBe(true);
  });
  it("applies a signed complaint across newsletters while local unsubscribe never creates a publisher block", async () => {
    const queued = await enqueue(0);
    await drainNewsletterSends();
    const [row] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    await enqueue(1);
    await callback(0, [
      {
        event: "spamreport",
        timestamp: Math.floor(Date.now() / 1000),
        email: "subscriber@example.com",
        sg_event_id: "complaint-one",
        sg_message_id: row!.providerMessageId,
      },
    ]);
    await drainNewsletterWebhookReceipts();
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    const blocks = await db()
      .select()
      .from(tables.publisherSuppression)
      .where(eq(tables.publisherSuppression.publisherId, publisherId));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.reason).toBe("complaint");
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId: queued.workspaceId,
        messageId: queued.logicalMessageId,
      }),
    ).toMatchObject({ state: "accepted" });
  });

  it("expires gated queued sends without reserving capacity or manufacturing acceptance", async () => {
    const queued = await enqueue();
    await db()
      .update(tables.publisherSendgridAccount)
      .set({ allowRealSends: false })
      .where(eq(tables.publisherSendgridAccount.publisherId, publisherId));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    await db()
      .update(tables.newsletterSend)
      .set({
        expiresAt: new Date(Date.now() - 1),
        nextAttemptAt: new Date(Date.now() - 1),
      })
      .where(eq(tables.newsletterSend.id, queued.sendId));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(projection).not.toHaveBeenCalled();
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId: queued.workspaceId,
        messageId: queued.logicalMessageId,
      }),
    ).toMatchObject({ state: "suppressed", error: "Expired" });
    expect(
      await db()
        .select()
        .from(tables.sendingIpBudget)
        .where(eq(tables.sendingIpBudget.ipId, ipId)),
    ).toHaveLength(0);
  });
  it("synchronizes native unsubscribe before a first send and protects newer explicit resubscribe from late callbacks", async () => {
    const workspaceId = newsletterIds[0]!;
    const groupId = randomUUID();
    await db()
      .insert(subscriptionGroup)
      .values({
        id: groupId,
        workspaceId,
        name: "Newsletter",
        type: "OptOut",
        channel: "Email",
      });
    const change = async (
      action: SubscriptionChange,
      timestamp: string,
      eventId: string = randomUUID(),
    ) => {
      await synchronizeNewsletterSubscriptionEvents({
        workspaceId,
        userEvents: [
          {
            messageId: eventId,
            messageRaw: { ...buildSubscriptionChangeEventInner({
              messageId: eventId,
              userId: "contact-0",
              subscriptionGroupId: groupId,
              action,
              timestamp,
            }) },
          },
        ],
      });
    };
    await change(SubscriptionChange.Unsubscribe, "2026-11-20T10:00:00Z");
    const blocked = await enqueue(0);
    await enqueue(1);
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId,
        messageId: blocked.logicalMessageId,
      }),
    ).toMatchObject({ state: "suppressed" });
    await change(SubscriptionChange.Subscribe, "2026-11-20T12:00:00Z");
    await change(SubscriptionChange.Unsubscribe, "2026-11-20T11:00:00Z");
    const resubscribed = await enqueue(0);
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId,
        messageId: resubscribed.logicalMessageId,
      }),
    ).toMatchObject({ state: "accepted" });
    await change(
      SubscriptionChange.Unsubscribe,
      "2026-11-20T12:00:00Z",
      "earlier-source-id",
    );
    await change(
      SubscriptionChange.Subscribe,
      "2026-11-20T12:00:00Z",
      "zz-later-source-id",
    );
    const tied = await enqueue(0);
    await drainNewsletterSends();
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId,
        messageId: tied.logicalMessageId,
      }),
    ).toMatchObject({ state: "suppressed" });
    await upsertPublisherSuppression({
      publisherId,
      email: "subscriber@example.com",
      reason: "manual",
    });
    await change(SubscriptionChange.Subscribe, "2026-11-20T13:00:00Z");
    const publisherBlocked = await enqueue(0);
    await drainNewsletterSends();
    expect(
      await getNewsletterSendStatusByMessageId({
        workspaceId,
        messageId: publisherBlocked.logicalMessageId,
      }),
    ).toMatchObject({ state: "suppressed" });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("retains an early SMTP-only bounce until a processed callback supplies stored correlation", async () => {
    const queued = await enqueue();
    await drainNewsletterSends();
    const [send] = await db()
      .select()
      .from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    projection.mockClear();
    const timestamp = Math.floor(Date.now() / 1000) - 30;
    await callback(0, [
      {
        event: "bounce",
        email: "subscriber@example.com",
        timestamp,
        sg_event_id: "early-bounce",
        "smtp-id": "<delayed-smtp>",
        status: "5.1.1",
      },
      {
        event: "processed",
        email: "subscriber@example.com",
        timestamp,
        sg_event_id: "later-processed",
        "smtp-id": "<delayed-smtp>",
        sg_message_id: send!.providerMessageId,
      },
    ]);
    await drainNewsletterWebhookReceipts();
    await db()
      .update(tables.newsletterWebhookReceipt)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(tables.newsletterWebhookReceipt.eventId, "early-bounce"));
    await drainNewsletterWebhookReceipts();
    expect(projection).toHaveBeenCalledTimes(2);
    const blocks = await db()
      .select()
      .from(tables.publisherSuppression)
      .where(eq(tables.publisherSuppression.publisherId, publisherId));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.reason).toBe("invalid_mailbox");
    const receipts = await db()
      .select()
      .from(tables.newsletterWebhookReceipt)
      .where(
        eq(tables.newsletterWebhookReceipt.connectionId, connectionIds[0]!),
      );
    expect(
      receipts.every(
        (receipt) => receipt.sendId === queued.sendId && receipt.processedAt,
      ),
    ).toBe(true);
  });
});
