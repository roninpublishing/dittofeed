import { createHash } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db, Db } from "./db";
import { subscriptionGroup } from "./db/schema";
import {
  newsletter,
  newsletterErasure,
  newsletterSend,
  newsletterSuppression,
} from "./db/publisherSchema";
import {
  ChannelType,
  EventType,
  InternalEventType,
  SubscriptionChange,
} from "./types";
import type { InsertUserEvent } from "./userEvents";

export function newsletterContactHash(
  workspaceId: string,
  userId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([workspaceId, userId]))
    .digest("hex");
}

type ConsentTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Caller owns the newsletter-optout exclusive lock through transaction commit. */
export async function upsertNewsletterConsent(
  tx: ConsentTransaction,
  input: {
    newsletterId: string;
    kind: "contact" | "mailbox";
    identityHash: string;
    sourceEventId: string;
    occurredAt: Date;
    active: boolean;
  },
): Promise<void> {
  await tx
    .insert(newsletterSuppression)
    .values(input)
    .onConflictDoUpdate({
      target: [
        newsletterSuppression.newsletterId,
        newsletterSuppression.kind,
        newsletterSuppression.identityHash,
      ],
      set: {
        sourceEventId: input.sourceEventId,
        occurredAt: input.occurredAt,
        active: input.active,
        updatedAt: new Date(),
      },
      setWhere: sql`${newsletterSuppression.occurredAt} < ${input.occurredAt} or (${newsletterSuppression.occurredAt} = ${input.occurredAt} and ((${input.active} and not ${newsletterSuppression.active}) or (${newsletterSuppression.active} = ${input.active} and ${newsletterSuppression.sourceEventId} < ${input.sourceEventId})))`,
    });
}

/**
 * Native subscription history is authoritative. Retain inactive hash-only rows
 * as event-time barriers too: an older provider callback must not undo a newer
 * explicit resubscribe. At equal timestamps unsubscribe wins, then source IDs
 * break equal-action ties deterministically. Publisher blocks are never touched.
 */
export async function synchronizeNewsletterSubscriptionEvents(input: {
  workspaceId: string;
  userEvents: InsertUserEvent[];
  workspaceLockHeld?: boolean;
}): Promise<void> {
  const changes: {
    userId: string;
    groupId: string;
    active: boolean;
    eventId: string;
    occurredAt: Date;
  }[] = [];
  for (const event of input.userEvents) {
    let raw: Record<string, unknown>;
    try {
      raw = (
        typeof event.messageRaw === "string"
          ? JSON.parse(event.messageRaw)
          : event.messageRaw
      ) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      !raw ||
      raw.type !== EventType.Track ||
      raw.event !== InternalEventType.SubscriptionChange ||
      typeof raw.userId !== "string"
    )
      continue;
    const properties = raw.properties;
    if (
      !properties ||
      typeof properties !== "object" ||
      Array.isArray(properties)
    )
      continue;
    const details = properties as Record<string, unknown>;
    if (
      typeof details.subscriptionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        details.subscriptionId,
      ) ||
      (details.action !== SubscriptionChange.Subscribe &&
        details.action !== SubscriptionChange.Unsubscribe)
    )
      continue;
    const occurredAt = new Date(
      typeof raw.timestamp === "string"
        ? raw.timestamp
        : event.serverTime ?? event.processingTime ?? Date.now(),
    );
    if (!Number.isFinite(occurredAt.getTime())) continue;
    changes.push({
      userId: raw.userId,
      groupId: details.subscriptionId,
      active: details.action === SubscriptionChange.Unsubscribe,
      eventId: event.messageId,
      occurredAt,
    });
  }
  if (!changes.length) return;
  await db().transaction(async (tx) => {
    // Automation already owns a session shared workspace lock through its native
    // writes. Avoid recursive acquisition behind a waiting erasure's exclusive
    // lock, while preserving the same barrier for ordinary ingestion.
    if (!input.workspaceLockHeld)
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${input.workspaceId}, 0))`,
      );
    const [publication] = await tx
      .select()
      .from(newsletter)
      .where(eq(newsletter.workspaceId, input.workspaceId))
      .limit(1);
    if (!publication) return;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`newsletter-optout:${input.workspaceId}`}, 0))`,
    );
    for (const change of changes) {
      if (
        publication.subscriptionGroupId &&
        publication.subscriptionGroupId !== change.groupId
      )
        continue;
      const [group] = await tx
        .select({ id: subscriptionGroup.id })
        .from(subscriptionGroup)
        .where(
          and(
            eq(subscriptionGroup.id, change.groupId),
            eq(subscriptionGroup.workspaceId, input.workspaceId),
            eq(subscriptionGroup.channel, ChannelType.Email),
          ),
        )
        .limit(1);
      if (!group) continue;
      const userHash = newsletterContactHash(input.workspaceId, change.userId);
      const [erased] = await tx
        .select()
        .from(newsletterErasure)
        .where(
          and(
            eq(newsletterErasure.workspaceId, input.workspaceId),
            eq(newsletterErasure.userHash, userHash),
          ),
        )
        .limit(1);
      if (erased) continue;
      const sends = await tx
        .selectDistinct({ mailboxHash: newsletterSend.mailboxHash })
        .from(newsletterSend)
        .where(
          and(
            eq(newsletterSend.workspaceId, input.workspaceId),
            eq(newsletterSend.userId, change.userId),
            isNull(newsletterSend.erasedAt),
          ),
        );
      const identities = [
        { kind: "contact" as const, identityHash: userHash },
        ...sends.map((send) => ({
          kind: "mailbox" as const,
          identityHash: send.mailboxHash,
        })),
      ];
      for (const identity of identities) {
        await upsertNewsletterConsent(tx, {
          newsletterId: input.workspaceId,
          ...identity,
          sourceEventId: change.eventId,
          occurredAt: change.occurredAt,
          active: change.active,
        });
      }
    }
  });
}
