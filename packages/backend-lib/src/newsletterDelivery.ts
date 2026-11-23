import { MailDataRequired } from "@sendgrid/mail";
import { createHash, randomUUID } from "crypto";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { SourceType } from "isomorphic-lib/src/constants";
import { err, ok } from "neverthrow";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "./apps/batch";
import { db, Db } from "./db";
import { broadcast, journey, workspace } from "./db/schema";
import {
  publisher,
  newsletter,
  publisherSendgridAccount,
  sendingConnection,
  sendingIp,
  sendingPoolBinding,
  sendingPoolIp,
  newsletterRoute,
  publisherSuppression,
  newsletterSend,
  sendingIpBudget,
  newsletterSuppression,
  newsletterWebhookReceipt,
  newsletterErasure,
} from "./db/publisherSchema";
import { verifyTimestampedSignature } from "./crypto";
import { sendMail, sendgridEventToDF } from "./destinations/sendgrid";
import { verifyPinnedNewsletterRouting } from "./newsletterInfrastructure";
import { decrypt, encrypt } from "./secrets";
import {
  newsletterContactHash,
  upsertNewsletterConsent,
} from "./newsletterSubscriptions";
import {
  buildSubscriptionChangeEventInner,
  getSubscriptionGroupsWithAssignments,
  getSubscriptionGroupDetails,
  inSubscriptionGroup,
} from "./subscriptionGroups";
import {
  BackendMessageSendResult,
  BadWorkspaceConfigurationType,
  ChannelType,
  EmailProviderType,
  EventType,
  InternalEventType,
  MessageTags,
  MessageSuccess,
  SendgridEvent,
  SubscriptionChange,
} from "./types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Send = typeof newsletterSend.$inferSelect;
type AcceptedMessage = Extract<
  MessageSuccess,
  { type: InternalEventType.MessageSent }
>;
type Envelope = {
  mailData: MailDataRequired;
  success: AcceptedMessage;
  tags: Record<string, string>;
  recipients: string[];
  subscriptionGroupId?: string;
  providerPoolName: string;
  region: "global" | "eu";
};
type SuppressionReason =
  | "complaint"
  | "publisher_optout"
  | "manual"
  | "invalid_mailbox";

export class NewsletterDeliveryError extends Error {
  readonly statusCode: number;
  constructor(message = "Newsletter delivery unavailable", statusCode = 409) {
    super(message);
    this.name = "NewsletterDeliveryError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, NewsletterDeliveryError.prototype);
  }
}
export interface NewsletterEmailContext {
  publisherId: string;
}

export function newsletterMailboxHash(mailbox: string): string {
  return createHash("sha256")
    .update(mailbox.trim().toLowerCase())
    .digest("hex");
}
function unpack<T>(value: NonNullable<Send["encryptedPayload"]>): T {
  const text = decrypt(value);
  if (!text) throw new NewsletterDeliveryError();
  return JSON.parse(text) as T;
}
async function barrier(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}, 0))`,
  );
}
async function publisherBarrier(
  tx: Tx,
  publisherId: string,
  shared = false,
): Promise<void> {
  const key = `newsletter-suppression:${publisherId}`;
  await tx.execute(
    shared
      ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
      : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/** null means legacy, not an invitation to fall back after an opted-in error. */
export async function getNewsletterEmailContext(
  workspaceId: string,
): Promise<NewsletterEmailContext | null> {
  const [parent] = await db()
    .select()
    .from(publisher)
    .where(eq(publisher.workspaceId, workspaceId))
    .limit(1);
  if (parent)
    throw new NewsletterDeliveryError("Publisher workspaces cannot send email");
  const [child] = await db()
    .select()
    .from(newsletter)
    .where(eq(newsletter.workspaceId, workspaceId))
    .limit(1);
  return child ? { publisherId: child.publisherId } : null;
}

export async function listPublisherSuppressions(
  publisherId: string,
  options: { email?: string; limit?: number; offset?: number } = {},
) {
  const rows = await db()
    .select()
    .from(publisherSuppression)
    .where(
      and(
        eq(publisherSuppression.publisherId, publisherId),
        options.email === undefined
          ? undefined
          : eq(
              publisherSuppression.mailboxHash,
              newsletterMailboxHash(options.email),
            ),
      ),
    )
    .orderBy(publisherSuppression.createdAt, publisherSuppression.id)
    .limit(Math.max(1, Math.min(options.limit ?? 100, 500)))
    .offset(Math.max(0, options.offset ?? 0));
  return rows.map(({ encryptedMailbox, ...row }) => ({
    ...row,
    email: decrypt(encryptedMailbox),
  }));
}
export async function upsertPublisherSuppression(input: {
  publisherId: string;
  email: string;
  reason: SuppressionReason;
  sourceNewsletterId?: string;
  sourceEventId?: string;
}) {
  if (
    !input.email.trim() ||
    !["complaint", "publisher_optout", "manual", "invalid_mailbox"].includes(
      input.reason,
    )
  ) {
    throw new NewsletterDeliveryError("Invalid suppression", 400);
  }
  return db().transaction(async (tx) => {
    await publisherBarrier(tx, input.publisherId);
    if (input.sourceNewsletterId) {
      const [source] = await tx
        .select()
        .from(newsletter)
        .where(
          and(
            eq(newsletter.workspaceId, input.sourceNewsletterId),
            eq(newsletter.publisherId, input.publisherId),
          ),
        )
        .limit(1);
      if (!source)
        throw new NewsletterDeliveryError("Newsletter not found", 404);
    }
    const [row] = await tx
      .insert(publisherSuppression)
      .values({
        publisherId: input.publisherId,
        mailboxHash: newsletterMailboxHash(input.email),
        encryptedMailbox: encrypt(input.email.trim()),
        reason: input.reason,
        sourceNewsletterId: input.sourceNewsletterId,
        sourceEventId: input.sourceEventId,
      })
      .onConflictDoUpdate({
        target: [
          publisherSuppression.publisherId,
          publisherSuppression.mailboxHash,
          publisherSuppression.reason,
        ],
        set: {
          active: true,
          updatedAt: new Date(),
          encryptedMailbox: encrypt(input.email.trim()),
          sourceNewsletterId: input.sourceNewsletterId,
          sourceEventId: input.sourceEventId,
        },
      })
      .returning();
    if (!row) throw new NewsletterDeliveryError();
    const { encryptedMailbox, ...result } = row;
    return result;
  });
}
export async function deactivatePublisherSuppression(input: {
  publisherId: string;
  suppressionId: string;
}) {
  return db().transaction(async (tx) => {
    await publisherBarrier(tx, input.publisherId);
    const rows = await tx
      .update(publisherSuppression)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(publisherSuppression.publisherId, input.publisherId),
          eq(publisherSuppression.id, input.suppressionId),
        ),
      )
      .returning({ id: publisherSuppression.id });
    if (!rows.length)
      throw new NewsletterDeliveryError("Suppression not found", 404);
    return { id: input.suppressionId, active: false };
  });
}

export function newsletterCapacityLimits(
  ip: Pick<
    typeof sendingIp.$inferSelect,
    "hourlyLimit" | "dailyLimit" | "warmupStartedAt" | "warmupSchedule"
  >,
  now: Date,
) {
  let hourly = ip.hourlyLimit;
  let daily = ip.dailyLimit;
  if (ip.warmupStartedAt) {
    const days = Math.floor(
      (now.getTime() - ip.warmupStartedAt.getTime()) / 86_400_000,
    );
    let current: (typeof ip.warmupSchedule)[number] | undefined;
    for (const step of ip.warmupSchedule) {
      if (
        step.afterDays <= days &&
        (!current || step.afterDays >= current.afterDays)
      )
        current = step;
    }
    if (!current) return { hourly: 0, daily: 0 };
    hourly = Math.min(hourly, current.hourlyLimit);
    daily = Math.min(daily, current.dailyLimit);
  }
  return { hourly: Math.max(0, hourly), daily: Math.max(0, daily) };
}
function windowStart(now: Date, seconds: number) {
  return new Date(
    Math.floor(now.getTime() / (seconds * 1000)) * seconds * 1000,
  );
}

/** The physical IP row is the common lock across every subuser and connection. */
async function reserveCapacity(tx: Tx, row: Send, now: Date): Promise<boolean> {
  const [ip] = await tx
    .select()
    .from(sendingIp)
    .where(eq(sendingIp.id, row.ipId))
    .for("update");
  if (!ip || ip.status !== "active") return false;
  const limits = newsletterCapacityLimits(ip, now);
  const windows = [
    { seconds: 3600, limit: limits.hourly },
    { seconds: 86400, limit: limits.daily },
  ];
  for (const w of windows) {
    const start = windowStart(now, w.seconds);
    // A retry in the same window already owns this reservation. A retry in a
    // later hour still owns its daily reservation, but needs a fresh hour slot.
    if (
      row.reservedAt &&
      windowStart(row.reservedAt, w.seconds).getTime() === start.getTime()
    )
      continue;
    const [budget] = await tx
      .select()
      .from(sendingIpBudget)
      .where(
        and(
          eq(sendingIpBudget.ipId, ip.id),
          eq(sendingIpBudget.windowStart, start),
          eq(sendingIpBudget.windowSeconds, w.seconds),
        ),
      )
      .limit(1);
    if ((budget?.reserved ?? 0) + row.recipientCount > w.limit) return false;
  }
  for (const w of windows) {
    const start = windowStart(now, w.seconds);
    if (
      row.reservedAt &&
      windowStart(row.reservedAt, w.seconds).getTime() === start.getTime()
    )
      continue;
    await tx
      .insert(sendingIpBudget)
      .values({
        ipId: ip.id,
        windowStart: start,
        windowSeconds: w.seconds,
        reserved: row.recipientCount,
      })
      .onConflictDoUpdate({
        target: [
          sendingIpBudget.ipId,
          sendingIpBudget.windowStart,
          sendingIpBudget.windowSeconds,
        ],
        set: {
          reserved: sql`${sendingIpBudget.reserved} + ${row.recipientCount}`,
        },
      });
  }
  return true;
}

async function isSuppressed(
  tx: Tx,
  row: Send,
  envelope: Envelope,
): Promise<boolean> {
  const [deleted] = await tx
    .select()
    .from(newsletterErasure)
    .where(
      and(
        eq(newsletterErasure.workspaceId, row.workspaceId),
        eq(
          newsletterErasure.userHash,
          newsletterContactHash(row.workspaceId, row.userId),
        ),
      ),
    )
    .limit(1);
  if (deleted || row.erasedAt) return true;
  const [block] = await tx
    .select()
    .from(publisherSuppression)
    .where(
      and(
        eq(publisherSuppression.publisherId, row.publisherId),
        eq(publisherSuppression.active, true),
        inArray(
          publisherSuppression.mailboxHash,
          envelope.recipients.map(newsletterMailboxHash),
        ),
      ),
    )
    .limit(1);
  if (block) return true;
  const [localBlock] = await tx
    .select()
    .from(newsletterSuppression)
    .where(
      and(
        eq(newsletterSuppression.newsletterId, row.workspaceId),
        eq(newsletterSuppression.active, true),
        or(
          and(
            eq(newsletterSuppression.kind, "contact"),
            eq(
              newsletterSuppression.identityHash,
              newsletterContactHash(row.workspaceId, row.userId),
            ),
          ),
          and(
            eq(newsletterSuppression.kind, "mailbox"),
            inArray(
              newsletterSuppression.identityHash,
              envelope.recipients.map(newsletterMailboxHash),
            ),
          ),
        ),
      ),
    )
    .limit(1);
  return !!localBlock;
}
async function eligible(
  row: Send,
  envelope: Envelope,
): Promise<"ready" | "paused" | "cancelled"> {
  const [child] = await db()
    .select({ newsletter, workspace })
    .from(newsletter)
    .innerJoin(workspace, eq(workspace.id, newsletter.workspaceId))
    .where(eq(newsletter.workspaceId, row.workspaceId))
    .limit(1);
  if (!child || child.workspace.status !== "Active") return "cancelled";
  if (child.newsletter.status !== "active") return "paused";
  if (envelope.tags.broadcastId) {
    const [campaign] = await db()
      .select()
      .from(broadcast)
      .where(
        and(
          eq(broadcast.id, envelope.tags.broadcastId),
          eq(broadcast.workspaceId, row.workspaceId),
        ),
      )
      .limit(1);
    if (
      !campaign ||
      campaign.archived ||
      campaign.statusV2 === "Cancelled" ||
      campaign.statusV2 === "Failed"
    )
      return "cancelled";
    if (campaign.statusV2 === "Paused") return "paused";
  }
  if (envelope.tags.journeyId) {
    const [flow] = await db()
      .select()
      .from(journey)
      .where(
        and(
          eq(journey.id, envelope.tags.journeyId),
          eq(journey.workspaceId, row.workspaceId),
        ),
      )
      .limit(1);
    if (!flow || flow.status === "NotStarted") return "cancelled";
    if (flow.status === "Paused") return "paused";
  }
  if (envelope.subscriptionGroupId) {
    const groups = await getSubscriptionGroupsWithAssignments({
      workspaceId: row.workspaceId,
      userIds: [row.userId],
      subscriptionGroupIds: [envelope.subscriptionGroupId],
    });
    if (
      !groups[0] ||
      !inSubscriptionGroup(getSubscriptionGroupDetails(groups[0]))
    )
      return "cancelled";
  }
  return "ready";
}

export async function sendNewsletterEmail(input: {
  workspaceId: string;
  publisherId: string;
  userId: string;
  logicalMessageId: string;
  mailData: MailDataRequired;
  recipients: string[];
  from: string;
  success: AcceptedMessage;
  tags?: MessageTags;
  subscriptionGroupId?: string;
}): Promise<BackendMessageSendResult> {
  try {
    const id = await db().transaction(async (tx) => {
      await barrier(tx, input.workspaceId);
      const [deleted] = await tx
        .select()
        .from(newsletterErasure)
        .where(
          and(
            eq(newsletterErasure.workspaceId, input.workspaceId),
            eq(
              newsletterErasure.userHash,
              newsletterContactHash(input.workspaceId, input.userId),
            ),
          ),
        )
        .limit(1);
      if (deleted) throw new NewsletterDeliveryError("Contact erased");
      const [prior] = await tx
        .select()
        .from(newsletterSend)
        .where(
          and(
            eq(newsletterSend.workspaceId, input.workspaceId),
            eq(newsletterSend.logicalMessageId, input.logicalMessageId),
          ),
        )
        .limit(1);
      if (prior) {
        if (
          prior.userId !== input.userId ||
          prior.mailboxHash !== newsletterMailboxHash(input.recipients[0] ?? "")
        )
          throw new NewsletterDeliveryError("Send identity conflict");
        return prior.id;
      }
      const [publication] = await tx
        .select()
        .from(newsletter)
        .where(
          and(
            eq(newsletter.workspaceId, input.workspaceId),
            eq(newsletter.publisherId, input.publisherId),
          ),
        )
        .limit(1);
      if (!publication)
        throw new NewsletterDeliveryError("Newsletter not found", 404);
      const [account] = await tx
        .select()
        .from(publisherSendgridAccount)
        .where(eq(publisherSendgridAccount.publisherId, input.publisherId))
        .limit(1);
      if (!account)
        throw new NewsletterDeliveryError(
          "Publisher sending account is not configured",
        );
      const [route] = await tx
        .select({
          route: newsletterRoute,
          connection: sendingConnection,
          binding: sendingPoolBinding,
        })
        .from(newsletterRoute)
        .innerJoin(
          sendingConnection,
          eq(sendingConnection.id, newsletterRoute.connectionId),
        )
        .innerJoin(
          sendingPoolBinding,
          and(
            eq(sendingPoolBinding.connectionId, newsletterRoute.connectionId),
            eq(sendingPoolBinding.poolId, newsletterRoute.poolId),
          ),
        )
        .where(
          and(
            eq(newsletterRoute.newsletterId, input.workspaceId),
            eq(sendingConnection.newsletterId, input.workspaceId),
            eq(sendingConnection.publisherId, input.publisherId),
          ),
        )
        .limit(1);
      if (
        !route ||
        route.connection.status !== "ready" ||
        !route.connection.encryptedApiKey
      )
        throw new NewsletterDeliveryError(
          "Newsletter has no ready sending connection",
        );
      const ips = await tx
        .select({ ip: sendingIp })
        .from(sendingPoolIp)
        .innerJoin(sendingIp, eq(sendingIp.id, sendingPoolIp.ipId))
        .where(
          and(
            eq(sendingPoolIp.poolId, route.route.poolId),
            eq(sendingIp.publisherId, input.publisherId),
          ),
        );
      if (ips.length !== 1 || !ips[0])
        throw new NewsletterDeliveryError(
          "A concrete single-IP route is required",
        );
      const from = input.from.trim().toLowerCase();
      if (
        !route.connection.senderEmails.some((e) => e.toLowerCase() === from) &&
        !route.connection.senderDomains.some(
          (d) => d.toLowerCase() === from.split("@")[1],
        )
      )
        throw new NewsletterDeliveryError(
          "Sender is not authorized for this connection",
        );
      const sendId = randomUUID();
      const mailData: MailDataRequired = {
        ...input.mailData,
        ipPoolName: route.binding.providerPoolName,
        customArgs: { ...input.mailData.customArgs, newsletterSendId: sendId },
        headers: { ...input.mailData.headers, "X-Message-ID": sendId },
      };
      const envelope: Envelope = {
        mailData,
        success: input.success,
        tags: {
          ...input.mailData.customArgs,
          ...input.tags,
          workspaceId: input.workspaceId,
          userId: input.userId,
          messageId: input.logicalMessageId,
        },
        recipients: input.recipients,
        subscriptionGroupId:
          input.subscriptionGroupId ??
          publication.subscriptionGroupId ??
          undefined,
        providerPoolName: route.binding.providerPoolName,
        region: account.region,
      };
      const payload = JSON.stringify(envelope);
      const [created] = await tx
        .insert(newsletterSend)
        .values({
          id: sendId,
          publisherId: input.publisherId,
          workspaceId: input.workspaceId,
          connectionId: route.connection.id,
          connectionRevision: route.connection.revision,
          ipId: ips[0].ip.id,
          poolId: route.route.poolId,
          routeVersion: route.route.version,
          logicalMessageId: input.logicalMessageId,
          userId: input.userId,
          broadcastId: input.tags?.broadcastId,
          journeyId: input.tags?.journeyId,
          mailboxHash: newsletterMailboxHash(input.recipients[0] ?? ""),
          encryptedRecipient: encrypt(JSON.stringify(input.recipients)),
          encryptedPayload: encrypt(payload),
          encryptedCredential: route.connection.encryptedApiKey,
          payloadHash: createHash("sha256").update(payload).digest("hex"),
          state: "queued",
          recipientCount: input.recipients.length,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .onConflictDoNothing({
          target: [newsletterSend.workspaceId, newsletterSend.logicalMessageId],
        })
        .returning();
      if (created) return created.id;
      const [winner] = await tx
        .select()
        .from(newsletterSend)
        .where(
          and(
            eq(newsletterSend.workspaceId, input.workspaceId),
            eq(newsletterSend.logicalMessageId, input.logicalMessageId),
          ),
        )
        .limit(1);
      if (
        !winner ||
        winner.userId !== input.userId ||
        winner.mailboxHash !== newsletterMailboxHash(input.recipients[0] ?? "")
      )
        throw new NewsletterDeliveryError("Send identity conflict");
      return winner.id;
    });
    const [row] = await db()
      .select()
      .from(newsletterSend)
      .where(eq(newsletterSend.id, id))
      .limit(1);
    if (!row) throw new NewsletterDeliveryError();
    if (["queued", "submitting", "unknown", "accepted"].includes(row.state))
      return ok({
        type: InternalEventType.MessageQueued,
        sendId: row.id,
        state: row.state === "unknown" ? "unknown" : "queued",
        nextAttemptAt: row.nextAttemptAt.toISOString(),
      });
    return err({
      type: InternalEventType.MessageFailure,
      variant: {
        type: ChannelType.Email,
        provider: {
          type: EmailProviderType.SendGrid,
          status: 409,
          body: row.error ?? "Newsletter send suppressed",
        },
      },
    });
  } catch {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured,
        message:
          "Newsletter delivery unavailable; check routing, credentials and sender authorization",
      },
    });
  }
}

/** Durable claim commits BEFORE the network request. Abandoned claims are unknown. */
async function attemptNewsletterSend(id: string): Promise<void> {
  const [candidate] = await db()
    .select()
    .from(newsletterSend)
    .where(eq(newsletterSend.id, id))
    .limit(1);
  if (!candidate || candidate.state !== "queued") return;
  const claimed = await db().transaction(async (tx) => {
    await barrier(tx, candidate.workspaceId);
    await publisherBarrier(tx, candidate.publisherId, true);
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`newsletter-optout:${candidate.workspaceId}`}, 0))`,
    );
    const [row] = await tx
      .select()
      .from(newsletterSend)
      .where(
        and(
          eq(newsletterSend.id, id),
          eq(newsletterSend.state, "queued"),
          sql`${newsletterSend.nextAttemptAt} <= now()`,
        ),
      )
      .for("update", { skipLocked: true });
    if (!row || !row.encryptedPayload || !row.encryptedCredential) return false;
    const envelope = unpack<Envelope>(row.encryptedPayload);
    const now = new Date();
    const status = await eligible(row, envelope);
    if (
      row.expiresAt <= now ||
      status === "cancelled" ||
      (await isSuppressed(tx, row, envelope))
    ) {
      await tx
        .update(newsletterSend)
        .set({
          state: "suppressed",
          error: row.expiresAt <= now ? "Expired" : "Ineligible or suppressed",
          updatedAt: now,
        })
        .where(eq(newsletterSend.id, id));
      return false;
    }
    const [account] = await tx
      .select()
      .from(publisherSendgridAccount)
      .where(eq(publisherSendgridAccount.publisherId, row.publisherId))
      .limit(1);
    const [connection] = await tx
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.id, row.connectionId))
      .limit(1);
    if (
      status !== "ready" ||
      !account?.allowRealSends ||
      !account.allTrafficControlled ||
      connection?.status !== "ready"
    ) {
      await tx
        .update(newsletterSend)
        .set({
          nextAttemptAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
          error: "Release gate closed or paused",
        })
        .where(eq(newsletterSend.id, id));
      return false;
    }
    try {
      await verifyPinnedNewsletterRouting({
        publisherId: row.publisherId,
        newsletterId: row.workspaceId,
        connectionId: row.connectionId,
        connectionRevision: row.connectionRevision,
        poolId: row.poolId,
        ipId: row.ipId,
        providerPoolName: envelope.providerPoolName,
      });
    } catch {
      await tx
        .update(newsletterSend)
        .set({
          nextAttemptAt: new Date(now.getTime() + 60_000),
          error: "Pinned route not verified",
          updatedAt: now,
        })
        .where(eq(newsletterSend.id, id));
      return false;
    }
    if (!(await reserveCapacity(tx, row, now))) {
      await tx
        .update(newsletterSend)
        .set({
          nextAttemptAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
          error: "Capacity deferred",
        })
        .where(eq(newsletterSend.id, id));
      return false;
    }
    await tx
      .update(newsletterSend)
      .set({
        state: "submitting",
        reservedAt: now,
        attempts: row.attempts + 1,
        error: null,
        updatedAt: now,
      })
      .where(eq(newsletterSend.id, id));
    return true;
  });
  if (!claimed) return;
  await db().transaction(async (tx) => {
    await barrier(tx, candidate.workspaceId);
    await publisherBarrier(tx, candidate.publisherId, true);
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`newsletter-optout:${candidate.workspaceId}`}, 0))`,
    );
    const [row] = await tx
      .select()
      .from(newsletterSend)
      .where(
        and(eq(newsletterSend.id, id), eq(newsletterSend.state, "submitting")),
      )
      .for("update");
    if (!row || !row.encryptedPayload || !row.encryptedCredential) return;
    const envelope = unpack<Envelope>(row.encryptedPayload);
    const [account] = await tx
      .select()
      .from(publisherSendgridAccount)
      .where(eq(publisherSendgridAccount.publisherId, row.publisherId))
      .limit(1);
    const [connection] = await tx
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.id, row.connectionId))
      .limit(1);
    if (
      !account?.allowRealSends ||
      !account.allTrafficControlled ||
      connection?.status !== "ready"
    ) {
      await tx
        .update(newsletterSend)
        .set({
          state: "queued",
          error: "Release gate closed or paused",
          nextAttemptAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(),
        })
        .where(eq(newsletterSend.id, id));
      return;
    }
    if (
      (await isSuppressed(tx, row, envelope)) ||
      (await eligible(row, envelope)) !== "ready"
    ) {
      await tx
        .update(newsletterSend)
        .set({
          state: "suppressed",
          error: "Ineligible or suppressed",
          updatedAt: new Date(),
        })
        .where(eq(newsletterSend.id, id));
      return;
    }
    try {
      const key = decrypt(row.encryptedCredential);
      if (!key) throw new NewsletterDeliveryError();
      const response = await sendMail({
        apiKey: key,
        mailData: envelope.mailData,
        region: envelope.region,
      });
      if (response.isOk()) {
        const accepted = response.value?.statusCode === 202;
        const providerId = response.value?.headers["x-message-id"];
        await tx
          .update(newsletterSend)
          .set({
            state: accepted ? "accepted" : "unknown",
            providerMessageId:
              typeof providerId === "string"
                ? providerIdentity(providerId)
                : null,
            error: accepted ? null : "Unexpected provider response",
            updatedAt: new Date(),
          })
          .where(eq(newsletterSend.id, id));
      } else {
        const code = response.error.code;
        // Only explicit, non-accepting rate-limit responses can be retried.
        await tx
          .update(newsletterSend)
          .set({
            state:
              code === 429
                ? "queued"
                : code >= 400 && code < 500 && code !== 408
                  ? "rejected"
                  : "unknown",
            nextAttemptAt: new Date(Date.now() + 60_000),
            error: `Provider status ${code}`,
            updatedAt: new Date(),
          })
          .where(eq(newsletterSend.id, id));
      }
    } catch {
      await tx
        .update(newsletterSend)
        .set({
          state: "unknown",
          error: "Acceptance uncertain; automatic retry disabled",
          updatedAt: new Date(),
        })
        .where(eq(newsletterSend.id, id));
    }
  });
}

export async function getNewsletterSendStatus(input: {
  workspaceId: string;
  sendId: string;
}) {
  const [row] = await db()
    .select()
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.workspaceId, input.workspaceId),
        eq(newsletterSend.id, input.sendId),
      ),
    )
    .limit(1);
  if (!row) throw new NewsletterDeliveryError("Send not found", 404);
  return {
    sendId: row.id,
    state: row.state,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    error: row.error,
    accepted: row.state === "accepted",
    terminal: ["accepted", "unknown", "rejected", "suppressed"].includes(
      row.state,
    ),
  };
}
export async function getNewsletterSendStatusByMessageId(input: {
  workspaceId: string;
  messageId: string;
}) {
  const [row] = await db()
    .select({ id: newsletterSend.id })
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.workspaceId, input.workspaceId),
        eq(newsletterSend.logicalMessageId, input.messageId),
      ),
    )
    .limit(1);
  return row
    ? getNewsletterSendStatus({
        workspaceId: input.workspaceId,
        sendId: row.id,
      })
    : null;
}
export async function getNewsletterBroadcastQueueStatus(input: {
  workspaceId: string;
  broadcastId: string;
}) {
  const rows = await db()
    .select({ state: newsletterSend.state, count: count() })
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.workspaceId, input.workspaceId),
        eq(newsletterSend.broadcastId, input.broadcastId),
      ),
    )
    .groupBy(newsletterSend.state);
  const total = (states: string[]) =>
    rows
      .filter((row) => states.includes(row.state))
      .reduce((n, row) => n + row.count, 0);
  return {
    pending: total(["queued", "submitting"]),
    unknown: total(["unknown"]),
    rejected: total(["rejected"]),
    suppressed: total(["suppressed"]),
  };
}
export async function listNewsletterSends(input: {
  publisherId: string;
  newsletterId?: string;
  state?: Send["state"];
  limit?: number;
  offset?: number;
}) {
  return db()
    .select({
      id: newsletterSend.id,
      logicalMessageId: newsletterSend.logicalMessageId,
      publisherId: newsletterSend.publisherId,
      workspaceId: newsletterSend.workspaceId,
      connectionId: newsletterSend.connectionId,
      connectionRevision: newsletterSend.connectionRevision,
      ipId: newsletterSend.ipId,
      poolId: newsletterSend.poolId,
      routeVersion: newsletterSend.routeVersion,
      state: newsletterSend.state,
      error: newsletterSend.error,
      attempts: newsletterSend.attempts,
      recipientCount: newsletterSend.recipientCount,
      createdAt: newsletterSend.createdAt,
      updatedAt: newsletterSend.updatedAt,
      nextAttemptAt: newsletterSend.nextAttemptAt,
      expiresAt: newsletterSend.expiresAt,
    })
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.publisherId, input.publisherId),
        input.newsletterId
          ? eq(newsletterSend.workspaceId, input.newsletterId)
          : undefined,
        input.state ? eq(newsletterSend.state, input.state) : undefined,
      ),
    )
    .orderBy(newsletterSend.createdAt, newsletterSend.id)
    .limit(Math.min(input.limit ?? 100, 500))
    .offset(input.offset ?? 0);
}
export async function getNewsletterDeliveryHealth(publisherId: string) {
  const states = await db()
    .select({ state: newsletterSend.state, count: count() })
    .from(newsletterSend)
    .where(eq(newsletterSend.publisherId, publisherId))
    .groupBy(newsletterSend.state);
  const receipts = await db()
    .select({ count: count() })
    .from(newsletterWebhookReceipt)
    .innerJoin(
      sendingConnection,
      eq(sendingConnection.id, newsletterWebhookReceipt.connectionId),
    )
    .where(
      and(
        eq(sendingConnection.publisherId, publisherId),
        isNull(newsletterWebhookReceipt.processedAt),
      ),
    );
  return { states, pendingReceipts: receipts[0]?.count ?? 0 };
}

export async function drainNewsletterSends(): Promise<void> {
  // A crash between a committed claim and recorded response cannot authorize a
  // resend. Keep its consumed budget and expose it for operator reconciliation.
  await db()
    .update(newsletterSend)
    .set({
      state: "unknown",
      error: "Abandoned submission; acceptance uncertain",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(newsletterSend.state, "submitting"),
        sql`${newsletterSend.updatedAt} < now() - interval '10 minutes'`,
      ),
    );
  const rows = await db()
    .select({ id: newsletterSend.id })
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.state, "queued"),
        sql`${newsletterSend.nextAttemptAt} <= now()`,
      ),
    )
    .orderBy(newsletterSend.nextAttemptAt)
    .limit(50);
  for (const row of rows) await attemptNewsletterSend(row.id);
  await projectNewsletterAcceptedSends();
}
async function projectNewsletterAcceptedSends(): Promise<void> {
  const rows = await db()
    .select({ id: newsletterSend.id, workspaceId: newsletterSend.workspaceId })
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.state, "accepted"),
        isNull(newsletterSend.acceptedEventAt),
        isNull(newsletterSend.erasedAt),
      ),
    )
    .limit(50);
  for (const candidate of rows) {
    await db().transaction(async (tx) => {
      await barrier(tx, candidate.workspaceId);
      const [row] = await tx
        .select()
        .from(newsletterSend)
        .where(
          and(
            eq(newsletterSend.id, candidate.id),
            isNull(newsletterSend.acceptedEventAt),
            isNull(newsletterSend.erasedAt),
          ),
        )
        .for("update", { skipLocked: true });
      if (!row?.encryptedPayload) return;
      const envelope = unpack<Envelope>(row.encryptedPayload);
      await submitBatch(
        {
          workspaceId: row.workspaceId,
          data: {
            batch: [
              {
                type: EventType.Track,
                event: InternalEventType.MessageSent,
                userId: row.userId,
                messageId: uuidv5(
                  `newsletter-accepted:${row.id}`,
                  row.workspaceId,
                ),
                timestamp: row.updatedAt.toISOString(),
                properties: {
                  ...envelope.tags,
                  variant: envelope.success.variant,
                  newsletterSendId: row.id,
                  sendingIpId: row.ipId,
                  connectionId: row.connectionId,
                  providerMessageId: row.providerMessageId,
                },
              },
            ],
          },
        },
        { writeModeOverride: "ch-sync", workspaceLockHeld: true },
      );
      await tx
        .update(newsletterSend)
        .set({ acceptedEventAt: new Date() })
        .where(eq(newsletterSend.id, row.id));
    });
  }
}

export function verifyNewsletterWebhookSignature(input: {
  rawBody: Buffer;
  signature: string;
  timestamp: string;
  keys: { key: string; validUntil?: string }[];
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  if (
    !/^\d+$/.test(input.timestamp) ||
    Math.abs(now - Number(input.timestamp) * 1000) > 300_000
  )
    return false;
  return input.keys.some((entry) => {
    if (
      entry.validUntil &&
      (!Number.isFinite(Date.parse(entry.validUntil)) ||
        Date.parse(entry.validUntil) < now)
    )
      return false;
    const publicKey = entry.key.includes("BEGIN PUBLIC KEY")
      ? entry.key
      : `-----BEGIN PUBLIC KEY-----\n${entry.key}\n-----END PUBLIC KEY-----`;
    try {
      return verifyTimestampedSignature({
        signature: input.signature,
        timestamp: input.timestamp,
        payload: input.rawBody,
        publicKey,
      });
    } catch {
      return false;
    }
  });
}

type CallbackEvent = Record<string, unknown> & {
  email: string;
  event: string;
  timestamp: number;
  sg_event_id?: string;
  sg_message_id?: string;
};
function eventIdentity(event: CallbackEvent): string {
  return (
    event.sg_event_id ||
    createHash("sha256")
      .update(
        JSON.stringify([
          event.event,
          event.sg_message_id ?? null,
          event["smtp-id"] ?? null,
          event.email.toLowerCase(),
          event.timestamp,
          event.url ?? null,
        ]),
      )
      .digest("hex")
  );
}
function providerIdentity(value: string): string {
  return value.split(".")[0] ?? value;
}
async function correlate(
  tx: Tx,
  connectionId: string,
  event: CallbackEvent,
): Promise<Send | undefined> {
  const sendId =
    typeof event.newsletterSendId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      event.newsletterSendId,
    )
      ? event.newsletterSendId
      : null;
  const smtpValue =
    typeof event["smtp-id"] === "string"
      ? event["smtp-id"].replace(/[<>]/g, "")
      : "";
  const smtp =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      smtpValue,
    )
      ? smtpValue
      : null;
  if (!sendId && !smtpValue && !event.sg_message_id) return undefined;
  const [row] = await tx
    .select()
    .from(newsletterSend)
    .where(
      and(
        eq(newsletterSend.connectionId, connectionId),
        or(
          sendId ? eq(newsletterSend.id, sendId) : undefined,
          smtp ? eq(newsletterSend.id, smtp) : undefined,
          smtpValue ? eq(newsletterSend.providerSmtpId, smtpValue) : undefined,
          event.sg_message_id
            ? eq(
                newsletterSend.providerMessageId,
                providerIdentity(event.sg_message_id),
              )
            : undefined,
        ),
      ),
    )
    .limit(1);
  if (!row || row.erasedAt || !row.encryptedRecipient || row.attempts === 0)
    return undefined;
  if (
    row.providerMessageId &&
    event.sg_message_id &&
    providerIdentity(row.providerMessageId) !==
      providerIdentity(event.sg_message_id)
  )
    return undefined;
  const recipients = unpack<string[]>(row.encryptedRecipient);
  return recipients.some(
    (email) =>
      newsletterMailboxHash(email) === newsletterMailboxHash(event.email),
  )
    ? row
    : undefined;
}

/** Signed raw receipt is durable before acknowledging the provider. */
export async function receiveNewsletterWebhook(input: {
  connectionId: string;
  rawBody: Buffer;
  signature: string;
  timestamp: string;
}): Promise<void> {
  const [connection] = await db()
    .select()
    .from(sendingConnection)
    .where(eq(sendingConnection.id, input.connectionId))
    .limit(1);
  if (
    !connection ||
    !verifyNewsletterWebhookSignature({
      ...input,
      keys: connection.webhookKeys,
    })
  )
    throw new NewsletterDeliveryError("Invalid callback signature", 401);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw new NewsletterDeliveryError("Invalid callback", 400);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 1000 ||
    input.rawBody.length > 2_000_000
  )
    throw new NewsletterDeliveryError("Invalid callback", 400);
  for (const value of parsed) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.email !== "string" ||
      typeof value.event !== "string" ||
      !Number.isFinite(value.timestamp) ||
      Math.abs(value.timestamp) > 8_640_000_000_000
    )
      throw new NewsletterDeliveryError("Invalid callback", 400);
    for (const field of [
      "newsletterSendId",
      "sg_message_id",
      "sg_event_id",
      "smtp-id",
    ]) {
      if (
        value[field] !== undefined &&
        (typeof value[field] !== "string" || value[field].length > 1024)
      )
        throw new NewsletterDeliveryError("Invalid callback", 400);
    }
  }
  await db().transaction(async (tx) => {
    await barrier(tx, connection.newsletterId);
    for (const event of parsed as CallbackEvent[]) {
      const row = await correlate(tx, connection.id, event);
      const mailboxHash = newsletterMailboxHash(event.email);
      const [erased] = row
        ? []
        : await tx
            .select({ id: newsletterSend.id })
            .from(newsletterSend)
            .where(
              and(
                eq(newsletterSend.connectionId, connection.id),
                isNotNull(newsletterSend.erasedAt),
                eq(newsletterSend.mailboxHash, mailboxHash),
              ),
            )
            .limit(1);
      // Unmatched signed evidence stays encrypted until correlation arrives.
      // Erased identities retain only opaque dedupe/hash tombstones.
      await tx
        .insert(newsletterWebhookReceipt)
        .values({
          connectionId: connection.id,
          eventId: eventIdentity(event),
          sendId: row?.id,
          mailboxHash,
          encryptedPayload: erased ? null : encrypt(JSON.stringify(event)),
          processedAt: erased ? new Date() : null,
        })
        .onConflictDoNothing({
          target: [
            newsletterWebhookReceipt.connectionId,
            newsletterWebhookReceipt.eventId,
          ],
        });
    }
  });
}

export function newsletterSuppressionReason(event: {
  event: string;
  status?: unknown;
  type?: unknown;
  bounce_classification?: unknown;
}): SuppressionReason | null {
  if (event.event === "spamreport") return "complaint";
  // Each subuser belongs to one newsletter. Provider unsubscribe (including
  // its account-level unsubscribe) is local, never publisher-wide consent.
  // Explicit publisher opt-outs enter through the authenticated suppression API.
  if (
    event.event === "bounce" &&
    (event.bounce_classification === "Invalid Address" ||
      event.status === "5.1.1")
  )
    return "invalid_mailbox";
  return null;
}
export async function drainNewsletterWebhookReceipts(): Promise<void> {
  const candidates = await db()
    .select({
      id: newsletterWebhookReceipt.id,
      workspaceId: sendingConnection.newsletterId,
      publisherId: sendingConnection.publisherId,
    })
    .from(newsletterWebhookReceipt)
    .innerJoin(
      sendingConnection,
      eq(sendingConnection.id, newsletterWebhookReceipt.connectionId),
    )
    .where(
      and(
        isNull(newsletterWebhookReceipt.processedAt),
        sql`${newsletterWebhookReceipt.nextAttemptAt} <= now()`,
      ),
    )
    .orderBy(newsletterWebhookReceipt.nextAttemptAt)
    .limit(100);
  for (const candidate of candidates) {
    await db().transaction(async (tx) => {
      await barrier(tx, candidate.workspaceId);
      await publisherBarrier(tx, candidate.publisherId);
      const [receipt] = await tx
        .select()
        .from(newsletterWebhookReceipt)
        .where(
          and(
            eq(newsletterWebhookReceipt.id, candidate.id),
            isNull(newsletterWebhookReceipt.processedAt),
          ),
        )
        .for("update", { skipLocked: true });
      if (!receipt?.encryptedPayload) return;
      const event = unpack<CallbackEvent>(receipt.encryptedPayload);
      const correlation = receipt.sendId
        ? { id: receipt.sendId }
        : await correlate(tx, receipt.connectionId, event);
      if (!correlation) {
        const [erased] = await tx
          .select({ id: newsletterSend.id })
          .from(newsletterSend)
          .where(
            and(
              eq(newsletterSend.connectionId, receipt.connectionId),
              isNotNull(newsletterSend.erasedAt),
              eq(
                newsletterSend.mailboxHash,
                newsletterMailboxHash(event.email),
              ),
            ),
          )
          .limit(1);
        const expired =
          receipt.receivedAt.getTime() < Date.now() - 7 * 86_400_000;
        await tx
          .update(newsletterWebhookReceipt)
          .set(
            erased || expired
              ? { encryptedPayload: null, processedAt: new Date() }
              : {
                  attempts: receipt.attempts + 1,
                  nextAttemptAt: new Date(Date.now() + 30_000),
                },
          )
          .where(eq(newsletterWebhookReceipt.id, receipt.id));
        return;
      }
      const [row] = await tx
        .select()
        .from(newsletterSend)
        .where(
          and(
            eq(newsletterSend.id, correlation.id),
            isNull(newsletterSend.erasedAt),
          ),
        )
        .for("update");
      if (!row?.encryptedPayload || !row.encryptedRecipient) {
        await tx
          .update(newsletterWebhookReceipt)
          .set({ encryptedPayload: null, processedAt: new Date() })
          .where(eq(newsletterWebhookReceipt.id, receipt.id));
        return;
      }
      await tx
        .update(newsletterWebhookReceipt)
        .set({ sendId: row.id })
        .where(eq(newsletterWebhookReceipt.id, receipt.id));
      try {
        if (
          row.providerMessageId &&
          event.sg_message_id &&
          providerIdentity(row.providerMessageId) !==
            providerIdentity(event.sg_message_id)
        ) {
          await tx
            .update(newsletterWebhookReceipt)
            .set({ processedAt: new Date() })
            .where(eq(newsletterWebhookReceipt.id, receipt.id));
          return;
        }
        if (
          event.event === "processed" &&
          typeof event["smtp-id"] === "string"
        ) {
          await tx
            .update(newsletterSend)
            .set({ providerSmtpId: event["smtp-id"].replace(/[<>]/g, "") })
            .where(eq(newsletterSend.id, row.id));
        }
        const envelope = unpack<Envelope>(row.encryptedPayload);
        const reason = newsletterSuppressionReason(event);
        if (reason)
          await tx
            .insert(publisherSuppression)
            .values({
              publisherId: row.publisherId,
              mailboxHash: newsletterMailboxHash(event.email),
              encryptedMailbox: encrypt(event.email),
              reason,
              sourceNewsletterId: row.workspaceId,
              sourceEventId: receipt.eventId,
            })
            .onConflictDoUpdate({
              target: [
                publisherSuppression.publisherId,
                publisherSuppression.mailboxHash,
                publisherSuppression.reason,
              ],
              set: { active: true, updatedAt: new Date() },
            });
        const messageId = uuidv5(
          `newsletter-webhook:${receipt.connectionId}:${receipt.eventId}`,
          row.workspaceId,
        );
        const isPrimary =
          row.mailboxHash === newsletterMailboxHash(event.email);
        if (isPrimary) {
          const timestamp = new Date(event.timestamp * 1000).toISOString();
          if (
            ["unsubscribe", "group_unsubscribe", "group_resubscribe"].includes(
              event.event,
            ) &&
            envelope.subscriptionGroupId
          ) {
            await submitBatch(
              {
                workspaceId: row.workspaceId,
                data: {
                  batch: [
                    buildSubscriptionChangeEventInner({
                      messageId,
                      userId: row.userId,
                      timestamp,
                      subscriptionGroupId: envelope.subscriptionGroupId,
                      action:
                        event.event === "group_resubscribe"
                          ? SubscriptionChange.Subscribe
                          : SubscriptionChange.Unsubscribe,
                    }),
                  ],
                },
              },
              { writeModeOverride: "ch-sync", workspaceLockHeld: true },
            );
          } else {
            // Build identity ONLY from the stored send. All callback metadata,
            // including workspaceId/userId/messageId, is discarded.
            const normalized = sendgridEventToDF({
              sendgridEvent: {
                ...event,
                ...envelope.tags,
                event: event.event,
                timestamp: event.timestamp,
                email: event.email,
                workspaceId: row.workspaceId,
                userId: row.userId,
                messageId: row.logicalMessageId,
                "smtp-id": `<${row.id}>`,
                sg_message_id:
                  event.sg_message_id ?? row.providerMessageId ?? row.id,
                sg_event_id: receipt.eventId,
              } as SendgridEvent,
            });
            if (normalized.isOk() && normalized.value.type === EventType.Track)
              await submitBatch(
                {
                  workspaceId: row.workspaceId,
                  data: {
                    context: {
                      source: SourceType.Webhook,
                      provider: EmailProviderType.SendGrid,
                    },
                    batch: [
                      {
                        ...normalized.value,
                        messageId,
                        timestamp,
                        properties: {
                          ...normalized.value.properties,
                          newsletterSendId: row.id,
                          sendingIpId: row.ipId,
                          connectionId: row.connectionId,
                        },
                      },
                    ],
                  },
                },
                { writeModeOverride: "ch-sync", workspaceLockHeld: true },
              );
          }
        }
        if (
          ["unsubscribe", "group_unsubscribe", "group_resubscribe"].includes(
            event.event,
          )
        ) {
          // Native projection finishes before taking this lock: its ingestion
          // hook uses a separate transaction in the same lock domain.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`newsletter-optout:${row.workspaceId}`}, 0))`,
          );
          const consent = {
            newsletterId: row.workspaceId,
            sourceEventId: messageId,
            occurredAt: new Date(event.timestamp * 1000),
            active: event.event !== "group_resubscribe",
          };
          await upsertNewsletterConsent(tx, {
            ...consent,
            kind: "mailbox",
            identityHash: newsletterMailboxHash(event.email),
          });
          if (isPrimary)
            await upsertNewsletterConsent(tx, {
              ...consent,
              kind: "contact",
              identityHash: newsletterContactHash(row.workspaceId, row.userId),
            });
        }
        if (
          ["processed", "delivered", "open", "click"].includes(event.event) &&
          ["unknown", "submitting"].includes(row.state)
        )
          await tx
            .update(newsletterSend)
            .set({ state: "accepted", updatedAt: new Date() })
            .where(eq(newsletterSend.id, row.id));
        await tx
          .update(newsletterWebhookReceipt)
          .set({ processedAt: new Date(), attempts: receipt.attempts + 1 })
          .where(eq(newsletterWebhookReceipt.id, receipt.id));
      } catch {
        await tx
          .update(newsletterWebhookReceipt)
          .set({
            attempts: receipt.attempts + 1,
            nextAttemptAt: new Date(
              Date.now() +
                Math.min(
                  3_600_000,
                  30_000 * 2 ** Math.min(receipt.attempts, 7),
                ),
            ),
          })
          .where(eq(newsletterWebhookReceipt.id, receipt.id));
      }
    });
  }
}

export async function deleteNewsletterDeliveryData(input: {
  workspaceId: string;
  userIds?: string[];
}): Promise<void> {
  if (input.userIds && !input.userIds.length) return;
  await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 0))`,
    );
    if (input.userIds)
      for (let offset = 0; offset < input.userIds.length; offset += 500)
        await tx
          .insert(newsletterErasure)
          .values(
            input.userIds
              .slice(offset, offset + 500)
              .map((id) => ({
                workspaceId: input.workspaceId,
                userHash: newsletterContactHash(input.workspaceId, id),
              })),
          )
          .onConflictDoNothing();
    for (;;) {
      const rows = await tx
        .select()
        .from(newsletterSend)
        .where(
          and(
            eq(newsletterSend.workspaceId, input.workspaceId),
            isNull(newsletterSend.erasedAt),
            input.userIds
              ? inArray(newsletterSend.userId, input.userIds)
              : undefined,
          ),
        )
        .limit(500)
        .for("update");
      if (!rows.length) break;
      await tx
        .insert(newsletterErasure)
        .values(
          rows.map((row) => ({
            workspaceId: input.workspaceId,
            userHash: newsletterContactHash(input.workspaceId, row.userId),
          })),
        )
        .onConflictDoNothing();
      const ids = rows.map((row) => row.id);
      await tx
        .update(newsletterWebhookReceipt)
        .set({ encryptedPayload: null, processedAt: new Date() })
        .where(inArray(newsletterWebhookReceipt.sendId, ids));
      const mailboxHashes = [
        ...new Set(
          rows.flatMap((row) =>
            row.encryptedRecipient
              ? unpack<string[]>(row.encryptedRecipient).map(
                  newsletterMailboxHash,
                )
              : [row.mailboxHash],
          ),
        ),
      ];
      const connectionIds = [...new Set(rows.map((row) => row.connectionId))];
      for (let offset = 0; offset < mailboxHashes.length; offset += 500) {
        await tx
          .update(newsletterWebhookReceipt)
          .set({ encryptedPayload: null, processedAt: new Date() })
          .where(
            and(
              inArray(newsletterWebhookReceipt.connectionId, connectionIds),
              inArray(
                newsletterWebhookReceipt.mailboxHash,
                mailboxHashes.slice(offset, offset + 500),
              ),
            ),
          );
      }
      for (const row of rows)
        await tx
          .update(newsletterSend)
          .set({
            userId: newsletterContactHash(input.workspaceId, row.userId),
            logicalMessageId: createHash("sha256")
              .update(row.logicalMessageId)
              .digest("hex"),
            providerSmtpId: null,
            encryptedPayload: null,
            encryptedRecipient: null,
            encryptedCredential: null,
            state: "suppressed",
            error: "Erased",
            erasedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(newsletterSend.id, row.id));
    }
  });
}
