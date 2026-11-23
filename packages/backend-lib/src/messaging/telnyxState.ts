import { createHash } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import { MESSAGE_METADATA_FIELDS } from "../constants";
import { db } from "../db";
import {
  telnyxEmailDeletedSend as deletedSend,
  telnyxEmailReceipt as receipt,
  telnyxEmailSend as send,
} from "../db/schema";

const METADATA_KEYS = new Set<string>([
  ...MESSAGE_METADATA_FIELDS, "channel", "triggeringMessageId", "subscriptionGroupId",
]);

export class TelnyxSendConflictError extends Error {
  constructor() {
    super("Telnyx send identity conflicts with durable state or was deleted.");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "TelnyxSendConflictError";
  }
}

export async function prepareTelnyxSend(input: {
  workspaceId: string;
  credentialWorkspaceId: string;
  messageId: string;
  userId: string;
  primaryEmail: string;
  metadata: Record<string, string>;
  requestHash: string;
}): Promise<{ id: string; providerMessageId: string | null; createdAt: Date }> {
  return db().transaction(async (tx) => {
    // Serialize preparation against contact erasure, including the absent-row case.
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${input.workspaceId}, 0))`);
    const [deleted] = await tx.select().from(deletedSend).where(and(
      eq(deletedSend.workspaceId, input.workspaceId),
      eq(deletedSend.messageIdHash, createHash("sha256").update(input.messageId).digest("hex")),
    )).limit(1);
    if (deleted) throw new TelnyxSendConflictError();
    const metadata = Object.fromEntries(Object.entries(input.metadata).filter(([key, value]) =>
      METADATA_KEYS.has(key) && typeof value === "string",
    ));
    metadata.workspaceId = input.workspaceId;
    metadata.userId = input.userId;
    metadata.messageId = input.messageId;
    await tx.insert(send).values({ ...input, metadata }).onConflictDoNothing({
      target: [send.workspaceId, send.messageId],
    });
    const [row] = await tx.select().from(send).where(and(
      eq(send.workspaceId, input.workspaceId), eq(send.messageId, input.messageId),
    )).limit(1);
    if (!row || row.requestHash !== input.requestHash ||
        row.credentialWorkspaceId !== input.credentialWorkspaceId ||
        row.userId !== input.userId || row.primaryEmail !== input.primaryEmail) {
      throw new TelnyxSendConflictError();
    }
    return { id: row.id, providerMessageId: row.providerMessageId, createdAt: row.createdAt };
  });
}

export async function completeTelnyxSend(input: { id: string; providerMessageId: string }): Promise<void> {
  const deleted = await db().transaction(async (tx) => {
    const [row] = await tx.select().from(send).where(eq(send.id, input.id)).for("update");
    if (!row) {
      const [tombstone] = await tx.select().from(deletedSend).where(eq(deletedSend.id, input.id)).for("update");
      if (!tombstone || (tombstone.providerMessageId && tombstone.providerMessageId !== input.providerMessageId)) {
        throw new TelnyxSendConflictError();
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tombstone.credentialWorkspaceId}:${input.providerMessageId}`}, 0))`);
      await tx.update(deletedSend).set({ providerMessageId: input.providerMessageId }).where(eq(deletedSend.id, input.id));
      await tx.delete(receipt).where(and(
        eq(receipt.credentialWorkspaceId, tombstone.credentialWorkspaceId),
        eq(receipt.providerMessageId, input.providerMessageId),
      ));
      return true;
    }
    if (row.providerMessageId && row.providerMessageId !== input.providerMessageId) {
      throw new TelnyxSendConflictError();
    }
    await tx.update(send).set({ providerMessageId: input.providerMessageId }).where(eq(send.id, input.id));
    return false;
  });
  // Commit erasure reconciliation even though this caller must fail closed.
  // Deleting a local contact cannot recall an email already accepted externally.
  if (deleted) throw new TelnyxSendConflictError();
}

export async function deleteTelnyxUserData({ workspaceId, userIds }: {
  workspaceId: string;
  userIds?: string[];
}): Promise<void> {
  if (userIds && !userIds.length) return;
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
    const rows = await tx.select().from(send).where(and(
      eq(send.workspaceId, workspaceId), userIds ? inArray(send.userId, userIds) : undefined,
    )).for("update");
    for (const row of rows) {
      await tx.insert(deletedSend).values({
        id: row.id, workspaceId: row.workspaceId,
        credentialWorkspaceId: row.credentialWorkspaceId,
        messageIdHash: createHash("sha256").update(row.messageId).digest("hex"), providerMessageId: row.providerMessageId,
      }).onConflictDoNothing();
      if (row.providerMessageId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${row.credentialWorkspaceId}:${row.providerMessageId}`}, 0))`);
        await tx.delete(receipt).where(and(
          eq(receipt.credentialWorkspaceId, row.credentialWorkspaceId),
          eq(receipt.providerMessageId, row.providerMessageId),
        ));
      }
      await tx.delete(send).where(eq(send.id, row.id));
    }
  });
}
