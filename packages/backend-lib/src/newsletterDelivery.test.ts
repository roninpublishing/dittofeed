import { CommandResult } from "@clickhouse/client";
import { MailDataRequired } from "@sendgrid/mail";
import { createSign, generateKeyPairSync, randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { err, ok } from "neverthrow";

import * as batch from "./apps/batch";
import * as clickhouse from "./clickhouse";
import config from "./config";
import * as openTracking from "./messaging/openTracking";
import { db } from "./db";
import {
  workspace,
  messageTemplate,
  subscriptionGroup,
  userProperty,
  userPropertyAssignment,
} from "./db/schema";
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
  getNewsletterDeliveryHealth,
  listNewsletterSends,
  newsletterCapacityLimits,
  newsletterSuppressionReason,
  receiveNewsletterWebhook,
  sendNewsletterEmail,
  upsertPublisherSuppression,
  verifyNewsletterWebhookSignature,
} from "./newsletterDelivery";
import { decrypt, encrypt } from "./secrets";
import {
  EspSelection,
  ChannelType,
  EmailContentsType,
  EmailProviderType,
  InternalEventType,
  SubscriptionChange,
} from "./types";
import { deleteUsers } from "./users";
import { createWorkspace } from "./workspaces";
import { installNewsletterSecretFixture } from "../test/newsletterSecretFixture";

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
  let accountIds: string[];
  let ipIds: string[];
  let poolIds: string[];
  let restoreSecret: () => void;
  let previousTracking: boolean;
  let poolId: string;
  let ipId: string;
  let provider: jest.SpyInstance;
  let projection: jest.SpyInstance;

  beforeEach(async () => {
    restoreSecret = installNewsletterSecretFixture();
    previousTracking = config().enableOpenTracking;
    config().enableOpenTracking = true;
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
    await db().insert(tables.newsletterTrackingDomain).values(
      newsletterIds.map((id, i) => ({
        newsletterId: id,
        domain: `${id}.example.com`,
        hostname: `dt.${id}.example.com`,
        status: "active" as const,
        cnameVerified: true,
        cloudflareStatus: "active",
        sslStatus: "active",
        verifiedAt: new Date(),
        customHostnameId: `fixture-${i}`,
      })),
    );
    accountIds = newsletterIds.map(() => randomUUID());
    await db()
      .insert(tables.publisherSendgridAccount)
      .values(accountIds.map((id, i) => ({
        id,
        publisherId,
        name: `ESP account ${i}`,
        allowRealSends: true,
        allTrafficControlled: true,
      })));
    connectionIds = newsletterIds.map(() => randomUUID());
    await db()
      .insert(tables.sendingConnection)
      .values(
        newsletterIds.map((id, i) => ({
          id: connectionIds[i],
          publisherId,
          accountId: accountIds[i]!,
          newsletterId: null,
          username: `subuser-${i}`,
          administrativeEmail: `admin-${i}@example.com`,
          encryptedApiKey: encrypt(`restricted-key-${i}`),
          senderDomains: ["example.com"],
          webhookKeys: [{ key: callbackKey }],
          status: "ready" as const,
        })),
      );
    ipIds = accountIds.map(() => randomUUID());
    poolIds = accountIds.map(() => randomUUID());
    ipId = ipIds[0]!;
    poolId = poolIds[0]!;
    for (let i = 0; i < accountIds.length; i++) {
      await db()
        .insert(tables.sendingIp)
        .values({
          id: ipIds[i]!,
          canonicalIpId: ipId,
          accountId: accountIds[i]!,
          publisherId,
          address: "192.0.2.10",
          status: "active",
          providerVerifiedAt: new Date(),
          verifiedAccountRevision: 1,
          hourlyLimit: 3,
          dailyLimit: 3,
        });
      await db()
        .insert(tables.sendingPool)
        .values({
          id: poolIds[i]!,
          accountId: accountIds[i]!,
          publisherId,
          name: "shared-single-ip",
          providerPoolName: "physical-ip-one",
        });
      await db().insert(tables.sendingPoolIp).values({
        poolId: poolIds[i]!,
        ipId: ipIds[i]!,
      });
      await db().insert(tables.sendingPoolBinding).values({
        connectionId: connectionIds[i]!,
        poolId: poolIds[i]!,
        providerPoolName: "physical-ip-one",
      });
      await db().insert(tables.newsletterDefault).values({
        newsletterId: newsletterIds[i]!,
        selection: { accountId: accountIds[i]!, mode: "ip", ipId: ipIds[i]! },
      });
    }
    // Keep provider inspection outside this durable-delivery fixture. The
    // infrastructure suite exercises that boundary with read-only HTTP fixtures.
    jest.spyOn(infrastructure, "resolveNewsletterSelection").mockImplementation(
      async ({ publisherId: ownerId, newsletterId, selection: explicit }) => {
        const [defaults] = await db().select().from(tables.newsletterDefault)
          .where(eq(tables.newsletterDefault.newsletterId, newsletterId));
        const selection = explicit === undefined ? defaults?.selection : explicit;
        if (!selection) throw new Error("esp_selection_required");
        const [account] = await db().select().from(tables.publisherSendgridAccount)
          .where(and(
            eq(tables.publisherSendgridAccount.id, selection.accountId),
            eq(tables.publisherSendgridAccount.publisherId, ownerId),
          ));
        const [connection] = await db().select().from(tables.sendingConnection)
          .where(eq(tables.sendingConnection.accountId, selection.accountId));
        if (!account || !connection) throw new Error("Account unavailable");
        const inventory = await db().select().from(tables.sendingIp)
          .where(eq(tables.sendingIp.accountId, account.id));
        const pools = await db().select().from(tables.sendingPool)
          .where(eq(tables.sendingPool.accountId, account.id));
        const pool = selection.mode === "automatic" ? undefined : pools.find(
          (value) => selection.mode === "pool" ? value.id === selection.poolId : true,
        );
        const members = pool ? await db().select().from(tables.sendingPoolIp)
          .where(eq(tables.sendingPoolIp.poolId, pool.id)) : [];
        const ips = selection.mode === "automatic" ? inventory : inventory.filter(
          (ip) => members.some((member) => member.ipId === ip.id) &&
            (selection.mode !== "ip" || selection.ipId === ip.id),
        );
        if (!ips.length) throw new Error("Inventory unavailable");
        return { selection, account, connection, ips, pool,
          providerPoolName: pool?.providerPoolName };
      },
    );
    jest
      .spyOn(infrastructure, "verifyPinnedNewsletterSelection")
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
    restoreSecret();
    config().enableOpenTracking = previousTracking;
    await db()
      .delete(tables.newsletterWebhookReceipt)
      .where(
        inArray(tables.newsletterWebhookReceipt.connectionId, connectionIds),
      );
    await db()
      .delete(tables.newsletterSend)
      .where(eq(tables.newsletterSend.publisherId, publisherId));
    await db().delete(tables.sendingPool)
      .where(inArray(tables.sendingPool.accountId, accountIds));
    await db().delete(tables.sendingConnection)
      .where(inArray(tables.sendingConnection.accountId, accountIds));
    // Remove aliases before their shared root, preserving the global FK.
    await db().delete(tables.sendingIp)
      .where(and(
        inArray(tables.sendingIp.accountId, accountIds),
        sql`${tables.sendingIp.id} <> ${tables.sendingIp.canonicalIpId}`,
      ));
    await db().delete(tables.sendingIp)
      .where(inArray(tables.sendingIp.accountId, accountIds));
    await db().delete(tables.publisherSendgridAccount)
      .where(inArray(tables.publisherSendgridAccount.id, accountIds));
    await db()
      .delete(workspace)
      .where(inArray(workspace.id, [...newsletterIds, publisherId]));
  });

  async function enqueue(
    index = 0,
    logicalMessageId: string = randomUUID(),
    espSelection?: EspSelection | null,
  ) {
    const workspaceId = newsletterIds[index]!;
    const userId = `contact-${index}`;
    const recipients = ["subscriber@example.com"];
    const html =
      'https://example.com/?subscriber_email=subscriber%40example.com';
    const result = await sendNewsletterEmail({
      workspaceId,
      publisherId,
      userId,
      logicalMessageId,
      recipients,
      from: "editor@example.com",
      tags: { messageId: logicalMessageId, userId },
      espSelection,
      mailData: {
        from: "editor@example.com",
        ipPoolName: "untrusted-caller-pool",
        to: recipients[0]!,
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

  it.each(["disabled", "unverified", "missing-key"] as const)(
    "refuses a new canonical send when open tracking is %s without leaving an orphan row",
    async (readiness) => {
      if (readiness === "disabled") config().enableOpenTracking = false;
      else if (readiness === "missing-key") config().secretKey = undefined;
      else await db().update(tables.newsletterTrackingDomain).set({ status: "pending" })
        .where(eq(tables.newsletterTrackingDomain.newsletterId, newsletterIds[0]!));
      const result = await sendNewsletterEmail({
        workspaceId: newsletterIds[0]!, publisherId, userId: "contact",
        logicalMessageId: randomUUID(), recipients: ["subscriber@example.com"],
        from: "editor@example.com",
        mailData: {
          from: "editor@example.com", to: "subscriber@example.com",
          html: "<p>New send</p>", subject: "No untracked send",
        },
        success: {
          type: InternalEventType.MessageSent,
          variant: {
            type: ChannelType.Email, from: "editor@example.com",
            to: "subscriber@example.com", body: "<p>New send</p>",
            subject: "No untracked send", provider: { type: EmailProviderType.SendGrid },
          },
        },
      });
      expect(result.isErr()).toBe(true);
      expect(provider).not.toHaveBeenCalled();
      expect(await db().select().from(tables.newsletterSend)
        .where(eq(tables.newsletterSend.publisherId, publisherId))).toHaveLength(0);
    },
  );

  it("persists one canonical pixel identity and reuses its encrypted transport without readiness resolution", async () => {
    const issuance = jest.spyOn(openTracking, "prepareEmailOpenTracking");
    const messageId = randomUUID();
    const [first, concurrent] = await Promise.all([
      enqueue(0, messageId),
      enqueue(0, messageId),
    ]);
    expect(first.sendId).toBe(concurrent.sendId);
    expect(issuance).toHaveBeenCalledTimes(1);
    const [saved] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, first.sendId));
    if (!saved?.encryptedOpenTrackingToken || !saved.encryptedPayload)
      throw new Error("Missing canonical tracked transport");
    const token = JSON.parse(decrypt(saved.encryptedOpenTrackingToken)!) as { id: string; token: string };
    expect(token.id).toBe(saved.id);
    const envelope = JSON.parse(decrypt(saved.encryptedPayload)!) as {
      mailData: { html: string }; success: { variant: { body: string } };
    };
    expect(envelope.mailData.html).toContain(`${saved.openTrackingOrigin}/api/public/email/open/${token.token}.gif`);
    expect(envelope.mailData.html.match(/data-df-open-tracking=/g)).toHaveLength(1);
    expect(envelope.success.variant.body).not.toContain("data-df-open-tracking");
    config().enableOpenTracking = false;
    await db().update(tables.newsletterTrackingDomain).set({ status: "pending" })
      .where(eq(tables.newsletterTrackingDomain.newsletterId, first.workspaceId));
    await db().delete(tables.newsletterDefault)
      .where(eq(tables.newsletterDefault.newsletterId, first.workspaceId));
    expect((await enqueue(0, messageId)).sendId).toBe(first.sendId);
    expect(issuance).toHaveBeenCalledTimes(1);
    const [retry] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, first.sendId));
    expect(retry?.encryptedPayload).toEqual(saved.encryptedPayload);
    expect(retry?.encryptedOpenTrackingToken).toEqual(saved.encryptedOpenTrackingToken);
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
  });

  it.each<Partial<MailDataRequired>>([
    { to: "invalid" },
    { to: "one@example.com,two@example.com" },
    { to: ["subscriber@example.com", "other@example.com"] },
    { to: "wrong@example.com" },
    { cc: "copy@example.com" },
    { bcc: "copy@example.com" },
    { personalizations: [{ to: [{ email: "other@example.com" }] }] },
    { isMultiple: true },
    { mailSettings: { bcc: { enable: true, email: "copy@example.com" } } },
    { headers: { Bcc: "copy@example.com" } },
    { templateId: "untracked-provider-template" },
  ])("rejects unsupported recipient payloads before issuance or queueing: %p", async (overrides) => {
    const issuance = jest.spyOn(openTracking, "prepareEmailOpenTracking");
    const result = await sendNewsletterEmail({
      workspaceId: newsletterIds[0]!, publisherId, userId: "contact",
      logicalMessageId: randomUUID(), recipients: ["subscriber@example.com"],
      from: "editor@example.com",
      mailData: {
        from: "editor@example.com", to: "subscriber@example.com",
        html: "<p>Untracked</p>", subject: "Invalid recipient", ...overrides,
      },
      success: {
        type: InternalEventType.MessageSent,
        variant: {
          type: ChannelType.Email, from: "editor@example.com",
          to: "subscriber@example.com", body: "<p>Untracked</p>",
          subject: "Invalid recipient", provider: { type: EmailProviderType.SendGrid },
        },
      },
    });
    expect(result.isErr()).toBe(true);
    expect(issuance).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.publisherId, publisherId))).toHaveLength(0);
  });

  it.each(["openTrackingTokenHash", "encryptedOpenTrackingToken", "openTrackingOrigin"] as const)(
    "blocks provider submission when canonical %s is missing",
    async (column) => {
      const queued = await enqueue();
      await db().update(tables.newsletterSend).set({ [column]: null })
        .where(eq(tables.newsletterSend.id, queued.sendId));
      await drainNewsletterSends();
      expect(provider).not.toHaveBeenCalled();
      const [row] = await db().select().from(tables.newsletterSend)
        .where(eq(tables.newsletterSend.id, queued.sendId));
      expect(row).toMatchObject({ state: "queued", error: "Open tracking unavailable", attempts: 0 });
    },
  );

  async function callback(connectionIndex: number, events: unknown[]) {
    await receiveNewsletterWebhook({
      connectionId: connectionIds[connectionIndex]!,
      ...signed(Buffer.from(JSON.stringify(events))),
    });
  }

  it("deletes legacy non-newsletter contacts without writing newsletter erasure barriers", async () => {
    const [property] = await db()
      .select()
      .from(userProperty)
      .where(eq(userProperty.workspaceId, publisherId))
      .limit(1);
    if (!property) throw new Error("Expected default workspace property");
    const deletedUserId = randomUUID();
    const retainedUserId = randomUUID();
    await db().insert(userPropertyAssignment).values(
      [deletedUserId, retainedUserId].map((userId) => ({
        workspaceId: publisherId,
        userPropertyId: property.id,
        userId,
        value: JSON.stringify("legacy contact"),
      })),
    );

    // This assertion concerns native PostgreSQL erasure, not analytics deletion.
    jest.spyOn(clickhouse, "command").mockImplementation(async (): Promise<Promise<CommandResult>> => ({
      query_id: "fixture-deletion", response_headers: {},
    }));
    await deleteUsers({
      workspaceId: publisherId,
      userIds: [deletedUserId],
    });

    const assignments = await db()
      .select()
      .from(userPropertyAssignment)
      .where(eq(userPropertyAssignment.workspaceId, publisherId));
    expect(assignments.map((assignment) => assignment.userId)).toEqual([
      retainedUserId,
    ]);
    expect(
      await db()
        .select()
        .from(tables.newsletterErasure)
        .where(eq(tables.newsletterErasure.workspaceId, publisherId)),
    ).toHaveLength(0);
  });

  it("queues selected SendGrid tests and personalized sends after rendering without fallback", async () => {
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
        },
      });
    const messageId = randomUUID();
    const result = await testTemplate({
      workspaceId,
      templateId,
      channel: ChannelType.Email,
      provider: EmailProviderType.SendGrid,
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
    expect(send?.recipientCount).toBe(1);
    await db()
      .delete(tables.newsletterDefault)
      .where(eq(tables.newsletterDefault.newsletterId, workspaceId));
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
      providerOverride: EmailProviderType.SendGrid,
    });
    expect(noFallback.isErr()).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it("blocks publisher sending and resolves registered newsletters", async () => {
    await expect(getNewsletterEmailContext(publisherId)).rejects.toThrow(
      "Publisher workspaces cannot send email",
    );
    expect(await getNewsletterEmailContext(newsletterIds[0]!)).toEqual({
      publisherId,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("serializes shared physical-IP budgets across concurrent single-recipient sends", async () => {
    await db().update(tables.sendingIp).set({ hourlyLimit: 1, dailyLimit: 1 })
      .where(inArray(tables.sendingIp.id, ipIds));
    const first = await enqueue(0);
    const second = await enqueue(1);
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
    expect(budgets.map((row) => row.reserved)).toEqual([1, 1]);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set([first.sendId, second.sendId]),
    );
  });

  it("pins account/credentials/rendered attribution/pool and ignores later default changes", async () => {
    const queued = await enqueue();
    await db()
      .update(tables.newsletterDefault)
      .set({ selection: { accountId: accountIds[1]!, mode: "ip", ipId: ipIds[1]! } })
      .where(eq(tables.newsletterDefault.newsletterId, queued.workspaceId));
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
      accountId: accountIds[0],
      accountRevision: 1,
      candidateIpIds: [ipId],
      selection: { accountId: accountIds[0], mode: "ip", ipId },
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

  it("uses an explicit account override and deduplicates without retargeting the confirmed attempt", async () => {
    const messageId = randomUUID();
    const selection: EspSelection = {
      accountId: accountIds[1]!, mode: "ip", ipId: ipIds[1]!,
    };
    const first = await enqueue(0, messageId, selection);
    const retry = await enqueue(0, messageId, {
      accountId: accountIds[0]!, mode: "ip", ipId,
    });
    expect(retry.sendId).toBe(first.sendId);
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "restricted-key-1",
    }));
    const [row] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, first.sendId));
    expect(row).toMatchObject({
      workspaceId: newsletterIds[0],
      accountId: accountIds[1],
      connectionId: connectionIds[1],
      selection,
      candidateIpIds: [ipIds[1]],
      actualIp: null,
    });
  });

  it("does not re-read a later default for a confirmed missing selection", async () => {
    const result = await sendNewsletterEmail({
      workspaceId: newsletterIds[0]!,
      publisherId,
      userId: "no-selection",
      logicalMessageId: randomUUID(),
      espSelection: null,
      recipients: ["subscriber@example.com"],
      from: "editor@example.com",
      mailData: {
        from: "editor@example.com", to: "subscriber@example.com",
        subject: "No selection", html: "Must not queue",
      },
      success: {
        type: InternalEventType.MessageSent,
        variant: {
          type: ChannelType.Email, from: "editor@example.com",
          to: "subscriber@example.com", subject: "No selection",
          body: "Must not queue", provider: { type: EmailProviderType.SendGrid },
        },
      },
    });
    expect(result.isErr()).toBe(true);
    expect(infrastructure.resolveNewsletterSelection).not.toHaveBeenCalled();
    expect(await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.publisherId, publisherId))).toHaveLength(0);
  });

  it.each(["pool", "automatic"] as const)(
    "reserves each recipient against every possible %s IP, not summed capacity",
    async (mode) => {
      await db().update(tables.sendingIp).set({ hourlyLimit: 1, dailyLimit: 1 })
        .where(inArray(tables.sendingIp.id, ipIds));
      const secondIp = randomUUID();
      await db().insert(tables.sendingIp).values({
        id: secondIp, canonicalIpId: secondIp, accountId: accountIds[0]!,
        publisherId, address: "192.0.2.11", status: "active",
        providerVerifiedAt: new Date(), verifiedAccountRevision: 1,
        hourlyLimit: 3, dailyLimit: 3,
      });
      await db().insert(tables.sendingPoolIp).values({ poolId, ipId: secondIp });
      const selection: EspSelection = mode === "pool"
        ? { accountId: accountIds[0]!, mode, poolId }
        : { accountId: accountIds[0]!, mode };
      const first = await enqueue(0, randomUUID(), selection);
      const second = await enqueue(0, randomUUID(), selection);
      await Promise.all([drainNewsletterSends(), drainNewsletterSends()]);
      expect(provider).toHaveBeenCalledTimes(1);
      const rows = await db().select().from(tables.newsletterSend)
        .where(inArray(tables.newsletterSend.id, [first.sendId, second.sendId]));
      expect(rows.map((row) => row.state).sort()).toEqual(["accepted", "queued"]);
      for (const row of rows) {
        expect(row.candidateIpIds).toEqual([ipId, secondIp].sort());
        expect(row.ipId).toBeNull();
        expect(row.actualIp).toBeNull();
      }
      const budgets = await db().select().from(tables.sendingIpBudget)
        .where(inArray(tables.sendingIpBudget.ipId, [ipId, secondIp]));
      expect(budgets).toHaveLength(4);
      expect(budgets.every((budget) => budget.reserved === 1)).toBe(true);
      const mail = provider.mock.calls[0]![0].mailData as Record<string, unknown>;
      if (mode === "automatic") expect(mail).not.toHaveProperty("ipPoolName");
      else expect(mail.ipPoolName).toBe("physical-ip-one");
    },
  );

  it("defers the entire candidate set without partial reservations when one IP lacks capacity", async () => {
    const constrained = randomUUID();
    await db().insert(tables.sendingIp).values({
      id: constrained, canonicalIpId: constrained, accountId: accountIds[0]!,
      publisherId, address: "192.0.2.12", status: "active",
      providerVerifiedAt: new Date(), verifiedAccountRevision: 1,
      hourlyLimit: 0, dailyLimit: 0,
    });
    await db().insert(tables.sendingPoolIp).values({ poolId, ipId: constrained });
    await enqueue(0, randomUUID(), {
      accountId: accountIds[0]!, mode: "pool", poolId,
    });
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(await db().select().from(tables.sendingIpBudget)
      .where(inArray(tables.sendingIpBudget.ipId, [ipId, constrained]))).toHaveLength(0);
  });

  it("uses the strictest physical alias limits and pause across different accounts", async () => {
    await db().update(tables.sendingIp).set({ hourlyLimit: 0 })
      .where(eq(tables.sendingIp.id, ipIds[1]!));
    const queued = await enqueue(0);
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    await db().update(tables.sendingIp).set({ hourlyLimit: 3, status: "paused" })
      .where(eq(tables.sendingIp.id, ipIds[1]!));
    await db().update(tables.newsletterSend).set({ nextAttemptAt: new Date(0) })
      .where(eq(tables.newsletterSend.id, queued.sendId));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(await db().select().from(tables.sendingIpBudget)
      .where(eq(tables.sendingIpBudget.ipId, ipId))).toHaveLength(0);
  });

  it("ignores an unverified paused zero-limit alias until provider ownership is verified", async () => {
    await db().update(tables.sendingIp).set({
      status: "paused", hourlyLimit: 0, dailyLimit: 0,
      providerVerifiedAt: null, verifiedAccountRevision: null,
    }).where(eq(tables.sendingIp.id, ipIds[1]!));
    await enqueue(0);
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    await db().update(tables.sendingIp).set({
      providerVerifiedAt: new Date(), verifiedAccountRevision: 1,
    }).where(eq(tables.sendingIp.id, ipIds[1]!));
    const blocked = await enqueue(0);
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await getNewsletterSendStatusByMessageId({
      workspaceId: blocked.workspaceId, messageId: blocked.logicalMessageId,
    })).toMatchObject({ state: "queued", error: "Capacity deferred" });
  });

  it("does not admit an unverified candidate or stale account ownership verification", async () => {
    const queued = await enqueue(0);
    await db().update(tables.sendingIp).set({
      providerVerifiedAt: null, verifiedAccountRevision: null,
    }).where(eq(tables.sendingIp.id, ipId));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    await db().update(tables.sendingIp).set({
      providerVerifiedAt: new Date(), verifiedAccountRevision: 0,
    }).where(eq(tables.sendingIp.id, ipId));
    await db().update(tables.newsletterSend).set({ nextAttemptAt: new Date(0) })
      .where(eq(tables.newsletterSend.id, queued.sendId));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(await db().select().from(tables.sendingIpBudget)
      .where(eq(tables.sendingIpBudget.ipId, ipId))).toHaveLength(0);
  });

  it("uses the selected account's release gate, not another account in the publisher", async () => {
    await db().update(tables.publisherSendgridAccount).set({ allowRealSends: false })
      .where(eq(tables.publisherSendgridAccount.id, accountIds[1]!));
    const queued = await enqueue(0, randomUUID(), {
      accountId: accountIds[1]!, mode: "ip", ipId: ipIds[1]!,
    });
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(await getNewsletterSendStatusByMessageId({
      workspaceId: queued.workspaceId, messageId: queued.logicalMessageId,
    })).toMatchObject({ state: "queued", error: "Release gate closed or paused" });
  });

  it("rejects inventory drift at submission without fallback or changing the pinned attempt", async () => {
    const queued = await enqueue();
    jest.mocked(infrastructure.verifyPinnedNewsletterSelection)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("Provider pool membership changed"));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(infrastructure.verifyPinnedNewsletterSelection).toHaveBeenCalledTimes(2);
    const [row] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(row).toMatchObject({
      state: "queued", accountId: accountIds[0], candidateIpIds: [ipId],
      error: "Pinned ESP selection not verified",
    });
    expect(infrastructure.resolveNewsletterSelection).toHaveBeenCalledTimes(1);
  });

  it("never broadens or resubmits a reserved singleton retry after pool membership changes", async () => {
    provider.mockResolvedValueOnce(err({ code: 429 }));
    const queued = await enqueue(0, randomUUID(), {
      accountId: accountIds[0]!, mode: "pool", poolId,
    });
    await drainNewsletterSends();
    const [before] = await db().select().from(tables.newsletterSend).where(eq(tables.newsletterSend.id, queued.sendId));
    expect(before).toMatchObject({ state: "queued", attempts: 1, candidateIpIds: [ipId] });
    expect(before!.reservedAt).not.toBeNull();
    const budgets = await db().select().from(tables.sendingIpBudget).where(eq(tables.sendingIpBudget.ipId, ipId));
    const addedIp = randomUUID();
    await db().insert(tables.sendingIp).values({
      id: addedIp, canonicalIpId: addedIp, accountId: accountIds[0]!, publisherId,
      address: "192.0.2.15", status: "active", providerVerifiedAt: new Date(), verifiedAccountRevision: 1,
      hourlyLimit: 100, dailyLimit: 1000,
    });
    await db().insert(tables.sendingPoolIp).values({ poolId, ipId: addedIp });
    jest.mocked(infrastructure.verifyPinnedNewsletterSelection).mockRejectedValue(new Error("pinned_selection_changed"));
    provider.mockClear();
    await db().update(tables.newsletterSend).set({ nextAttemptAt: new Date(0) }).where(eq(tables.newsletterSend.id, queued.sendId));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    const [after] = await db().select().from(tables.newsletterSend).where(eq(tables.newsletterSend.id, queued.sendId));
    expect(after).toMatchObject({
      state: "queued", attempts: 1, candidateIpIds: [ipId], reservedAt: before!.reservedAt,
      error: "Pinned ESP selection not verified",
    });
    expect(await db().select().from(tables.sendingIpBudget).where(eq(tables.sendingIpBudget.ipId, ipId))).toEqual(budgets);
    expect(await db().select().from(tables.sendingIpBudget).where(eq(tables.sendingIpBudget.ipId, addedIp))).toEqual([]);
  });

  it("records only provider-observed actual IP without changing the selected candidates", async () => {
    const queued = await enqueue(0, randomUUID(), {
      accountId: accountIds[1]!, mode: "automatic",
    });
    await drainNewsletterSends();
    projection.mockClear();
    await callback(1, [{
      event: "open", email: "subscriber@example.com",
      newsletterSendId: queued.sendId, sg_event_id: "reader-ip",
      timestamp: Math.floor(Date.now() / 1000), ip: "198.51.100.55",
    }]);
    await drainNewsletterWebhookReceipts();
    const [opened] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(opened?.actualIp).toBeNull();
    await callback(1, [{
      event: "delivered", email: "subscriber@example.com",
      newsletterSendId: queued.sendId, sg_event_id: "observed-ip",
      timestamp: Math.floor(Date.now() / 1000), ip: "192.0.2.10",
      workspaceId: newsletterIds[1], userId: "forged",
    }]);
    await drainNewsletterWebhookReceipts();
    const [row] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(row).toMatchObject({
      workspaceId: newsletterIds[0], accountId: accountIds[1],
      candidateIpIds: [ipIds[1]], actualIp: "192.0.2.10", ipId: null,
    });
    expect(projection).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: newsletterIds[0],
    }), expect.anything());
  });

  it("reuses every same-window reservation on explicit non-accepting retries", async () => {
    const secondIp = randomUUID();
    await db().insert(tables.sendingIp).values({
      id: secondIp, canonicalIpId: secondIp, accountId: accountIds[0]!,
      publisherId, address: "192.0.2.13", status: "active",
      providerVerifiedAt: new Date(), verifiedAccountRevision: 1,
      hourlyLimit: 3, dailyLimit: 3,
    });
    provider.mockResolvedValueOnce(err({ code: 429 }));
    const queued = await enqueue(0, randomUUID(), {
      accountId: accountIds[0]!, mode: "automatic",
    });
    await drainNewsletterSends();
    await db().update(tables.newsletterSend).set({ nextAttemptAt: new Date(0) })
      .where(eq(tables.newsletterSend.id, queued.sendId));
    await drainNewsletterSends();
    expect(provider).toHaveBeenCalledTimes(2);
    const budgets = await db().select().from(tables.sendingIpBudget)
      .where(inArray(tables.sendingIpBudget.ipId, [ipId, secondIp]));
    expect(budgets).toHaveLength(4);
    expect(budgets.every((budget) => budget.reserved === 1)).toBe(true);
    const [row] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(row).toMatchObject({ state: "accepted", attempts: 2 });
  });

  it("cannot multiply a physical budget by registering the same IP in another publisher", async () => {
    const otherPublisher = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    const otherAccount = randomUUID();
    const aliasId = randomUUID();
    try {
      await db().insert(tables.publisher).values({ workspaceId: otherPublisher });
      await db().insert(tables.publisherSendgridAccount).values({
        id: otherAccount, publisherId: otherPublisher, name: "Other publisher ESP",
      });
      await db().insert(tables.sendingIp).values({
        id: aliasId, canonicalIpId: ipId, accountId: otherAccount,
        publisherId: otherPublisher, address: "192.0.2.10", status: "active",
        providerVerifiedAt: new Date(), verifiedAccountRevision: 1,
        hourlyLimit: 0, dailyLimit: 0,
      });
      await enqueue();
      await drainNewsletterSends();
      expect(provider).not.toHaveBeenCalled();
      expect(await db().select().from(tables.sendingIpBudget)
        .where(eq(tables.sendingIpBudget.ipId, ipId))).toHaveLength(0);
      const [alias] = await db().select().from(tables.sendingIp)
        .where(eq(tables.sendingIp.id, aliasId));
      expect(alias?.canonicalIpId).toBe(ipId);
    } finally {
      await db().delete(tables.sendingIp).where(eq(tables.sendingIp.id, aliasId));
      await db().delete(tables.publisherSendgridAccount)
        .where(eq(tables.publisherSendgridAccount.id, otherAccount));
      await db().delete(workspace).where(eq(workspace.id, otherPublisher));
    }
  });

  it("reports account-scoped history and rejects a foreign account health query", async () => {
    await enqueue(0);
    await enqueue(1);
    const health = await getNewsletterDeliveryHealth(publisherId, accountIds[0]);
    expect(health.states).toEqual([{ state: "queued", count: 1 }]);
    const rows = await listNewsletterSends({ publisherId, accountId: accountIds[1] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: accountIds[1], candidateIpIds: [ipIds[1]], actualIp: null,
    });
    await expect(getNewsletterDeliveryHealth(publisherId, randomUUID()))
      .rejects.toThrow("ESP account not found");
  });

  it("defers changed credential revisions without rewriting the immutable credential snapshot", async () => {
    const queued = await enqueue();
    await db().update(tables.sendingConnection)
      .set({ encryptedApiKey: encrypt("rotated-key"), revision: 2 })
      .where(eq(tables.sendingConnection.id, connectionIds[0]!));
    jest.mocked(infrastructure.verifyPinnedNewsletterSelection)
      .mockRejectedValue(new Error("pinned_credential_revision_changed"));
    await drainNewsletterSends();
    expect(provider).not.toHaveBeenCalled();
    expect(infrastructure.verifyPinnedNewsletterSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: accountIds[0], accountRevision: 1,
        connectionId: connectionIds[0], connectionRevision: 1,
      }),
    );
    const [row] = await db().select().from(tables.newsletterSend)
      .where(eq(tables.newsletterSend.id, queued.sendId));
    expect(row?.state).toBe("queued");
    expect(decrypt(row!.encryptedCredential!)).toBe("restricted-key-0");
  });

  it("erases one newsletter without discarding sibling receipts on the same account connection", async () => {
    const first = await enqueue(0);
    const sibling = await enqueue(1, randomUUID(), {
      accountId: accountIds[0]!, mode: "ip", ipId,
    });
    await drainNewsletterSends();
    projection.mockClear();
    const events = [first, sibling].map((send, i) => ({
      event: "open", email: "subscriber@example.com",
      timestamp: Math.floor(Date.now() / 1000),
      newsletterSendId: send.sendId, sg_event_id: `shared-account-open-${i}`,
    }));
    await callback(0, events);
    await deleteNewsletterDeliveryData({
      workspaceId: first.workspaceId, userIds: [first.userId],
    });
    const receipts = await db().select().from(tables.newsletterWebhookReceipt)
      .where(eq(tables.newsletterWebhookReceipt.connectionId, connectionIds[0]!));
    expect(receipts.find((receipt) => receipt.sendId === first.sendId)?.encryptedPayload)
      .toBeNull();
    expect(receipts.find((receipt) => receipt.sendId === sibling.sendId)?.encryptedPayload)
      .not.toBeNull();
    await drainNewsletterWebhookReceipts();
    expect(projection).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: sibling.workspaceId,
    }), expect.anything());
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

  it("publisher suppressions block newsletter sends before submission without promoting policy failures", async () => {
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
      openTrackingTokenHash: null,
      encryptedOpenTrackingToken: null,
      openTrackingOrigin: null,
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

  it(
    "discards late signed receipts for erased immutable sends without assigning callback metadata",
    async () => {
      const queued = await enqueue();
      await drainNewsletterSends();
      const [sent] = await db()
        .select()
        .from(tables.newsletterSend)
        .where(eq(tables.newsletterSend.id, queued.sendId));
      if (!sent?.providerMessageId) throw new Error("Expected accepted send");
      await deleteNewsletterDeliveryData({
        workspaceId: queued.workspaceId,
        userIds: [queued.userId],
      });
      projection.mockClear();
      const events = [
        { sg_message_id: `${sent.providerMessageId}.filter` },
        { "smtp-id": `<${queued.sendId}>` },
        { newsletterSendId: queued.sendId },
      ].map((identity, index) => ({
        ...identity,
        event: "open",
        email: "subscriber@example.com",
        timestamp: Math.floor(Date.now() / 1000),
        sg_event_id: `late-copy-${index}`,
        workspaceId: newsletterIds[1],
        userId: "forged-contact",
        messageId: "forged-message",
      }));
      await callback(0, events);
      const receipts = await db()
        .select()
        .from(tables.newsletterWebhookReceipt)
        .where(
          eq(tables.newsletterWebhookReceipt.connectionId, connectionIds[0]!),
        );
      expect(receipts).toHaveLength(events.length);
      for (const receipt of receipts) {
        expect(receipt.encryptedPayload).toBeNull();
        expect(receipt.processedAt).toBeInstanceOf(Date);
        expect(receipt.sendId).toBeNull();
      }

      // The other signed connection cannot use these identities to assign a send.
      await callback(1, events);
      await drainNewsletterWebhookReceipts();
      expect(projection).not.toHaveBeenCalled();
      const unrelated = await db()
        .select()
        .from(tables.newsletterWebhookReceipt)
        .where(
          eq(tables.newsletterWebhookReceipt.connectionId, connectionIds[1]!),
        );
      expect(unrelated).toHaveLength(events.length);
      expect(
        unrelated.every(
          (receipt) =>
            receipt.sendId === null &&
            receipt.encryptedPayload !== null &&
            receipt.processedAt === null,
        ),
      ).toBe(true);
    },
  );
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
