import { MailDataRequired } from "@sendgrid/mail";
import { createHash, randomUUID } from "crypto";
import { isIP } from "net";
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
import addressparser from "nodemailer/lib/addressparser";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "./apps/batch";
import config from "./config";
import { db, Db } from "./db";
import { broadcast, journey, workspace } from "./db/schema";
import {
  publisher,
  newsletter,
  publisherSendgridAccount,
  sendingConnection,
  sendingIp,
  publisherSuppression,
  newsletterSend,
  sendingIpBudget,
  newsletterSuppression,
  newsletterWebhookReceipt,
  newsletterErasure,
} from "./db/publisherSchema";
import { verifyTimestampedSignature } from "./crypto";
import { sendMail, sendgridEventToDF } from "./destinations/sendgrid";
import {
  NewsletterInfrastructureError,
  resolveNewsletterSelection,
  requireAccount,
  verifyPinnedNewsletterSelection,
} from "./newsletterInfrastructure";
import { decrypt, encrypt } from "./secrets";
import { OPEN_TRACKING_PIXEL_PATH, prepareEmailOpenTracking } from "./messaging/openTracking";
import { DEVELOPMENT_PIXEL_ERASURE_LOCK, eraseDevelopmentPixelEvents } from "./messaging/developmentOpenTracking";
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
  EspSelection,
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
  providerPoolName?: string;
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
function singleMailbox(value: MailDataRequired["to"]): string {
  const recipient = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const text = typeof recipient === "string"
    ? recipient
    : recipient && !Array.isArray(recipient) ? recipient.email : undefined;
  if (!text || /[\r\n\0]/.test(text)) throw new NewsletterDeliveryError("Email requires a valid single To recipient");
  const addresses = addressparser(text, { flatten: true });
  const mailbox = addresses.length === 1 ? addresses[0]?.address : undefined;
  if (!mailbox || mailbox.length > 254 || !/^[^\s@<>;,]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(mailbox))
    throw new NewsletterDeliveryError("Email requires a valid single To recipient");
  return mailbox;
}
function requireSingleRecipient(mailData: MailDataRequired, recipients: readonly string[]): void {
  if ((Array.isArray(mailData.cc) ? mailData.cc.length > 0 : !!mailData.cc) ||
      (Array.isArray(mailData.bcc) ? mailData.bcc.length > 0 : !!mailData.bcc) ||
      mailData.personalizations !== undefined || mailData.isMultiple ||
      mailData.templateId !== undefined || mailData.dynamicTemplateData !== undefined ||
      mailData.content !== undefined || mailData.mailSettings?.bcc?.enable ||
      Object.keys(mailData.headers ?? {}).some((key) => /^(to|cc|bcc)$/i.test(key)) ||
      recipients.length !== 1 ||
      singleMailbox(mailData.to).toLowerCase() !== singleMailbox(recipients[0]).toLowerCase())
    throw new NewsletterDeliveryError("Email requires one recipient without CC, BCC or provider personalizations");
  if (typeof mailData.html !== "string")
    throw new NewsletterDeliveryError("Email requires an HTML body for open tracking");
}
function openTrackingReady(row: Send, envelope: Envelope): boolean {
  const settings = config();
  if (!settings.enableOpenTracking || !settings.secretKey ||
      Buffer.from(settings.secretKey, "base64").length !== 32 ||
      !row.openTrackingTokenHash || !row.encryptedOpenTrackingToken || !row.openTrackingOrigin)
    return false;
  try {
    requireSingleRecipient(envelope.mailData, envelope.recipients);
    const plaintext = decrypt(row.encryptedOpenTrackingToken);
    if (!plaintext) return false;
    const token = JSON.parse(plaintext) as { id?: unknown; token?: unknown };
    return token.id === row.id && typeof token.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(token.token) &&
      createHash("sha256").update(token.token).digest("hex") === row.openTrackingTokenHash &&
      envelope.mailData.html?.includes(
        `${row.openTrackingOrigin}${OPEN_TRACKING_PIXEL_PATH.replace(":token", token.token)}`,
      ) === true;
  } catch {
    return false;
  }
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

/** Only registered newsletters can queue tracked recipient sends. */
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

/**
 * A provider may choose any candidate. Charge the entire message to every
 * physical budget, never a divided/summed approximation of pool capacity.
 */
async function reserveCapacity(tx: Tx, row: Send, now: Date): Promise<boolean> {
  if (!row.candidateIpIds.length || row.recipientCount <= 0) return false;
  const candidates = await tx
    .select()
    .from(sendingIp)
    .where(
      and(
        inArray(sendingIp.id, row.candidateIpIds),
        eq(sendingIp.accountId, row.accountId),
        eq(sendingIp.publisherId, row.publisherId),
      ),
    );
  if (candidates.length !== new Set(row.candidateIpIds).size) return false;
  const canonicalIds = [...new Set(candidates.map((ip) => ip.canonicalIpId))].sort();
  // All accounts/publishers lock the same roots in the same order.
  for (const id of canonicalIds) {
    const [root] = await tx
      .select()
      .from(sendingIp)
      .where(eq(sendingIp.id, id))
      .for("update");
    if (!root || root.canonicalIpId !== id) return false;
  }
  const verified = await tx
    .select({ ip: sendingIp })
    .from(sendingIp)
    .innerJoin(
      publisherSendgridAccount,
      and(
        eq(publisherSendgridAccount.id, sendingIp.accountId),
        eq(publisherSendgridAccount.publisherId, sendingIp.publisherId),
        eq(publisherSendgridAccount.revision, sendingIp.verifiedAccountRevision),
      ),
    )
    .where(and(
      inArray(sendingIp.canonicalIpId, canonicalIds),
      isNotNull(sendingIp.providerVerifiedAt),
    ));
  const peers = verified.map(({ ip }) => ip);
  // A local claim of an address is not evidence of provider ownership. Draft
  // aliases cannot constrain other accounts, nor authorize their own sends.
  if (candidates.some((ip) => !peers.some((peer) => peer.id === ip.id))) return false;
  const reservations: { ipId: string; start: Date; seconds: number }[] = [];
  for (const ipId of canonicalIds) {
    const physical = peers.filter((ip) => ip.canonicalIpId === ipId);
    if (!physical.length || physical.some((ip) => ip.status !== "active"))
      return false;
    const limits = physical.map((ip) => newsletterCapacityLimits(ip, now));
    const windows = [
      { seconds: 3600, limit: Math.min(...limits.map((limit) => limit.hourly)) },
      { seconds: 86400, limit: Math.min(...limits.map((limit) => limit.daily)) },
    ];
    for (const w of windows) {
      const start = windowStart(now, w.seconds);
      // A non-accepting retry retains every existing same-window reservation.
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
            eq(sendingIpBudget.ipId, ipId),
            eq(sendingIpBudget.windowStart, start),
            eq(sendingIpBudget.windowSeconds, w.seconds),
          ),
        )
        .limit(1);
      if ((budget?.reserved ?? 0) + row.recipientCount > w.limit) return false;
      reservations.push({ ipId, start, seconds: w.seconds });
    }
  }
  // Write only after ALL candidates/windows pass: deferral consumes nothing.
  for (const reservation of reservations)
    await tx
      .insert(sendingIpBudget)
      .values({
        ipId: reservation.ipId,
        windowStart: reservation.start,
        windowSeconds: reservation.seconds,
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

export interface NewsletterEmailInput {
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
  espSelection?: EspSelection | null;
}

export async function sendNewsletterEmail(input: NewsletterEmailInput): Promise<BackendMessageSendResult> {
  try {
    requireSingleRecipient(input.mailData, input.recipients);
    const mailbox = singleMailbox(input.mailData.to);
    const id = await db().transaction(async (tx) => {
      await barrier(tx, input.workspaceId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["newsletter-send", input.workspaceId, input.logicalMessageId])}, 0))`,
      );
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
          prior.publisherId !== input.publisherId ||
          prior.userId !== input.userId ||
          prior.mailboxHash !== newsletterMailboxHash(mailbox)
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
      if (input.espSelection === null)
        throw new NewsletterDeliveryError("esp_selection_required");
      const resolved = await resolveNewsletterSelection({
        publisherId: input.publisherId,
        newsletterId: input.workspaceId,
        selection: input.espSelection,
      });
      const { account, connection, selection, ips, pool, providerPoolName } = resolved;
      if (!connection.encryptedApiKey)
        throw new NewsletterDeliveryError("ESP credential unavailable");
      const from = (typeof input.mailData.from === "string"
        ? input.mailData.from
        : input.mailData.from.email).trim().toLowerCase();
      const senderDomain = from.slice(from.lastIndexOf("@") + 1).replace(/\.$/, "");
      if (
        !connection.senderEmails.some((e) => e.toLowerCase() === from) &&
        !connection.senderDomains.some(
          (d) => d.toLowerCase() === from.split("@")[1],
        )
      )
        throw new NewsletterDeliveryError(
          "Sender is not authorized for this connection",
        );
      const sendId = randomUUID();
      const tracking = await prepareEmailOpenTracking({
        sendId,
        workspaceId: input.workspaceId,
        html: input.mailData.html as string,
      }, tx);
      // The caller cannot smuggle an IP pool into automatic selection.
      const { ipPoolName: _callerPool, ...renderedMailData } = input.mailData;
      const mailData: MailDataRequired = {
        ...renderedMailData,
        html: tracking.html,
        ...(providerPoolName ? { ipPoolName: providerPoolName } : {}),
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
        recipients: [mailbox],
        subscriptionGroupId:
          input.subscriptionGroupId ??
          publication.subscriptionGroupId ??
          undefined,
        providerPoolName,
        region: account.region,
      };
      const payload = JSON.stringify(envelope);
      const [created] = await tx
        .insert(newsletterSend)
        .values({
          id: sendId,
          publisherId: input.publisherId,
          workspaceId: input.workspaceId,
          accountId: account.id,
          accountRevision: account.revision,
          selection,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          candidateIpIds: ips.map((ip) => ip.id).sort(),
          ipId: selection.mode === "ip" ? selection.ipId : null,
          poolId: pool?.id ?? null,
          logicalMessageId: input.logicalMessageId,
          userId: input.userId,
          broadcastId: input.tags?.broadcastId,
          journeyId: input.tags?.journeyId,
          mailboxHash: newsletterMailboxHash(mailbox),
          senderDomain,
          encryptedRecipient: encrypt(JSON.stringify([mailbox])),
          encryptedPayload: encrypt(payload),
          encryptedCredential: connection.encryptedApiKey,
          openTrackingTokenHash: tracking.openTrackingTokenHash,
          encryptedOpenTrackingToken: tracking.encryptedOpenTrackingToken,
          openTrackingOrigin: tracking.openTrackingOrigin,
          payloadHash: createHash("sha256").update(payload).digest("hex"),
          state: "queued",
          recipientCount: 1,
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
        winner.publisherId !== input.publisherId ||
        winner.userId !== input.userId ||
        winner.mailboxHash !== newsletterMailboxHash(mailbox)
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
  } catch (cause) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured,
        message: cause instanceof NewsletterDeliveryError ||
          cause instanceof NewsletterInfrastructureError
          ? cause.message
          : "Newsletter delivery unavailable; check ESP selection, credentials and sender authorization",
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
    if (!openTrackingReady(row, envelope)) {
      await tx.update(newsletterSend).set({
        error: "Open tracking unavailable",
        nextAttemptAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      }).where(eq(newsletterSend.id, id));
      return false;
    }
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
      .where(and(
        eq(publisherSendgridAccount.id, row.accountId),
        eq(publisherSendgridAccount.publisherId, row.publisherId),
      ))
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
      connection?.status !== "ready" ||
      connection.accountId !== row.accountId ||
      connection.publisherId !== row.publisherId
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
      await verifyPinnedNewsletterSelection({
        publisherId: row.publisherId,
        accountId: row.accountId,
        accountRevision: row.accountRevision,
        connectionId: row.connectionId,
        connectionRevision: row.connectionRevision,
        selection: row.selection,
        candidateIpIds: row.candidateIpIds,
        providerPoolName: envelope.providerPoolName,
      });
    } catch {
      await tx
        .update(newsletterSend)
        .set({
          nextAttemptAt: new Date(now.getTime() + 60_000),
          error: "Pinned ESP selection not verified",
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
    if (!openTrackingReady(row, envelope)) {
      await tx.update(newsletterSend).set({
        state: "queued",
        error: "Open tracking unavailable",
        nextAttemptAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      }).where(eq(newsletterSend.id, id));
      return;
    }
    const [account] = await tx
      .select()
      .from(publisherSendgridAccount)
      .where(and(
        eq(publisherSendgridAccount.id, row.accountId),
        eq(publisherSendgridAccount.publisherId, row.publisherId),
      ))
      .limit(1);
    const [connection] = await tx
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.id, row.connectionId))
      .limit(1);
    if (
      !account?.allowRealSends ||
      !account.allTrafficControlled ||
      connection?.status !== "ready" ||
      connection.accountId !== row.accountId ||
      connection.publisherId !== row.publisherId
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
    // Recheck at the actual submission boundary; a queued retry never resolves
    // defaults or substitutes a changed provider inventory.
    try {
      await verifyPinnedNewsletterSelection({
        publisherId: row.publisherId,
        accountId: row.accountId,
        accountRevision: row.accountRevision,
        connectionId: row.connectionId,
        connectionRevision: row.connectionRevision,
        selection: row.selection,
        candidateIpIds: row.candidateIpIds,
        providerPoolName: envelope.providerPoolName,
      });
    } catch {
      await tx
        .update(newsletterSend)
        .set({
          state: "queued",
          error: "Pinned ESP selection not verified",
          nextAttemptAt: new Date(Date.now() + 60_000),
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
  accountId?: string;
  state?: Send["state"];
  limit?: number;
  offset?: number;
}) {
  if (input.accountId) await requireAccount(input.publisherId, input.accountId);
  return db()
    .select({
      id: newsletterSend.id,
      logicalMessageId: newsletterSend.logicalMessageId,
      publisherId: newsletterSend.publisherId,
      workspaceId: newsletterSend.workspaceId,
      accountId: newsletterSend.accountId,
      accountRevision: newsletterSend.accountRevision,
      selection: newsletterSend.selection,
      candidateIpIds: newsletterSend.candidateIpIds,
      actualIp: newsletterSend.actualIp,
      connectionId: newsletterSend.connectionId,
      connectionRevision: newsletterSend.connectionRevision,
      ipId: newsletterSend.ipId,
      poolId: newsletterSend.poolId,
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
        input.accountId ? eq(newsletterSend.accountId, input.accountId) : undefined,
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
export async function getNewsletterDeliveryHealth(publisherId: string, accountId?: string) {
  if (accountId) {
    const [account] = await db().select({ id: publisherSendgridAccount.id })
      .from(publisherSendgridAccount)
      .where(and(
        eq(publisherSendgridAccount.id, accountId),
        eq(publisherSendgridAccount.publisherId, publisherId),
      ))
      .limit(1);
    if (!account) throw new NewsletterDeliveryError("ESP account not found", 404);
  }
  const states = await db()
    .select({ state: newsletterSend.state, count: count() })
    .from(newsletterSend)
    .where(and(
      eq(newsletterSend.publisherId, publisherId),
      accountId ? eq(newsletterSend.accountId, accountId) : undefined,
    ))
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
        accountId ? eq(sendingConnection.accountId, accountId) : undefined,
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
                  sendingPoolId: row.poolId,
                  sendingAccountId: row.accountId,
                  senderDomain: row.senderDomain,
                  candidateIpIds: row.candidateIpIds,
                  actualIp: row.actualIp,
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
function observedSendingIp(event: CallbackEvent): string | undefined {
  // Engagement events carry the reader/proxy IP, not the outbound mail IP.
  return ["processed", "delivered", "deferred", "bounce", "dropped"].includes(event.event) &&
    typeof event.ip === "string" && isIP(event.ip)
    ? event.ip
    : undefined;
}
function providerIdentity(value: string): string {
  return value.split(".")[0] ?? value;
}
function callbackSendIdentity(event: CallbackEvent) {
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
  return or(
    sendId ? eq(newsletterSend.id, sendId) : undefined,
    smtp ? eq(newsletterSend.id, smtp) : undefined,
    smtpValue ? eq(newsletterSend.providerSmtpId, smtpValue) : undefined,
    event.sg_message_id
      ? eq(
          newsletterSend.providerMessageId,
          providerIdentity(event.sg_message_id),
        )
      : undefined,
  );
}

async function correlate(
  tx: Pick<Tx, "select">,
  connectionId: string,
  event: CallbackEvent,
): Promise<Send | undefined> {
  const identity = callbackSendIdentity(event);
  if (!identity) return undefined;
  const [match] = await tx
    .select({ send: newsletterSend })
    .from(newsletterSend)
    .innerJoin(sendingConnection, and(
      eq(sendingConnection.id, newsletterSend.connectionId),
      eq(sendingConnection.accountId, newsletterSend.accountId),
      eq(sendingConnection.publisherId, newsletterSend.publisherId),
    ))
    .where(
      and(eq(newsletterSend.connectionId, connectionId), identity),
    )
    .limit(1);
  const row = match?.send;
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
  for (const event of parsed as CallbackEvent[]) {
    const hint = await correlate(db(), connection.id, event);
    await db().transaction(async (tx) => {
      if (hint) await barrier(tx, hint.workspaceId);
      const matched = await correlate(tx, connection.id, event);
      // Newly correlated evidence is rechecked under its erasure lock by the
      // drainer. Callback metadata never assigns a tenant or contact.
      const row = matched?.workspaceId === hint?.workspaceId ? matched : undefined;
      const mailboxHash = newsletterMailboxHash(event.email);
      const identity = callbackSendIdentity(event);
      const [erased] = row || !identity
        ? []
        : await tx
            .select({ id: newsletterSend.id })
            .from(newsletterSend)
            .where(
              and(
                eq(newsletterSend.connectionId, connection.id),
                isNotNull(newsletterSend.erasedAt),
                // Identity matches only discard evidence; they never assign
                // callback metadata to an erased contact, including CC/BCC.
                identity,
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
    });
  }
}

export function newsletterSuppressionReason(event: {
  event: string;
  status?: unknown;
  type?: unknown;
  bounce_classification?: unknown;
}): SuppressionReason | null {
  if (event.event === "spamreport") return "complaint";
  // Provider unsubscribe is local to the newsletter of the immutable send.
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
      connectionId: newsletterWebhookReceipt.connectionId,
      encryptedPayload: newsletterWebhookReceipt.encryptedPayload,
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
    const hint = candidate.encryptedPayload
      ? await correlate(
          db(),
          candidate.connectionId,
          unpack<CallbackEvent>(candidate.encryptedPayload),
        )
      : undefined;
    await db().transaction(async (tx) => {
      if (hint) await barrier(tx, hint.workspaceId);
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
      const correlation = await correlate(tx, receipt.connectionId, event);
      if (correlation && correlation.workspaceId !== hint?.workspaceId) {
        // Correlation appeared since the hint query. Reacquire locks in
        // workspace -> publisher order on the next drain.
        await tx
          .update(newsletterWebhookReceipt)
          .set({ sendId: correlation.id })
          .where(eq(newsletterWebhookReceipt.id, receipt.id));
        return;
      }
      if (!correlation) {
        const identity = callbackSendIdentity(event);
        const [erased] = !identity ? [] : await tx
          .select({ id: newsletterSend.id })
          .from(newsletterSend)
          .where(
            and(
              eq(newsletterSend.connectionId, receipt.connectionId),
              isNotNull(newsletterSend.erasedAt),
              identity,
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
            eq(newsletterSend.connectionId, receipt.connectionId),
            eq(newsletterSend.publisherId, candidate.publisherId),
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
        const actualIp = observedSendingIp(event);
        if (actualIp) {
          await tx
            .update(newsletterSend)
            .set({ actualIp })
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
                          sendingPoolId: row.poolId,
                          actualIp: actualIp ?? row.actualIp,
                          accountId: row.accountId,
                          sendingAccountId: row.accountId,
                          senderDomain: row.senderDomain,
                          candidateIpIds: row.candidateIpIds,
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${DEVELOPMENT_PIXEL_ERASURE_LOCK}, 1))`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 0))`,
    );
    const [publication] = await tx
      .select({ id: newsletter.workspaceId })
      .from(newsletter)
      .where(eq(newsletter.workspaceId, input.workspaceId));
    if (!publication) return;
    await eraseDevelopmentPixelEvents(tx, input.workspaceId, input.userIds);
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
        const pending = await tx
          .select()
          .from(newsletterWebhookReceipt)
          .where(
            and(
              inArray(newsletterWebhookReceipt.connectionId, connectionIds),
              isNull(newsletterWebhookReceipt.sendId),
              isNotNull(newsletterWebhookReceipt.encryptedPayload),
              inArray(
                newsletterWebhookReceipt.mailboxHash,
                mailboxHashes.slice(offset, offset + 500),
              ),
            ),
          );
        for (const receipt of pending) {
          if (!receipt.encryptedPayload) continue;
          const identity = callbackSendIdentity(
            unpack<CallbackEvent>(receipt.encryptedPayload),
          );
          if (!identity) continue;
          const [owned] = await tx
            .select({ id: newsletterSend.id })
            .from(newsletterSend)
            .where(and(
              inArray(newsletterSend.id, ids),
              eq(newsletterSend.connectionId, receipt.connectionId),
              identity,
            ))
            .limit(1);
          if (owned)
            await tx.update(newsletterWebhookReceipt)
              .set({ encryptedPayload: null, processedAt: new Date() })
              .where(eq(newsletterWebhookReceipt.id, receipt.id));
        }
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
            openTrackingTokenHash: null,
            encryptedOpenTrackingToken: null,
            openTrackingOrigin: null,
            state: "suppressed",
            error: "Erased",
            erasedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(newsletterSend.id, row.id));
    }
  });
}
