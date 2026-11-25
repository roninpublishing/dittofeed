import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/common";
import { createHash, randomUUID } from "crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { PoolClient } from "pg";

import { ClickHouseQueryBuilder, query as chQuery } from "./clickhouse";
import { db, pool } from "./db";
import {
  newsletter,
  newsletterErasure,
  publicationAutomation as rules,
  publicationAutomationAction as actions,
  publicationAutomationEvent as outbox,
  publicationAutomationIdentity as identities,
  publisherSuppression,
} from "./db/publisherSchema";
import { journey, segment, subscriptionGroup, userProperty } from "./db/schema";
import {
  getKeyedUserJourneyWorkflowId,
  userJourneyWorkflow,
  UserJourneyWorkflowVersion,
} from "./journeys/userWorkflow";
import { newsletterMailboxHash } from "./newsletterDelivery";
import { requireNewsletterSecretKey } from "./newsletterSecrets";
import {
  automationDedupeKey,
  automationLineage,
  automationMappedTraits,
  automationMatches,
  automationNativeId,
  automationValue,
  PublicationAutomationDefinition,
  PublicationAutomationError,
} from "./publicationAutomationDefinition";
import { decrypt, encrypt } from "./secrets";
import { insertSegmentAssignments } from "./segments";
import {
  buildSubscriptionChangeEvent,
  getSubscriptionGroupDetails,
  getSubscriptionGroupSegmentName,
  getSubscriptionGroupUnsubscribedSegmentName,
  getSubscriptionGroupWithAssignment,
} from "./subscriptionGroups";
import connectWorkflowClient from "./temporal/connectWorkflowClient";
import {
  EventType,
  InternalEventType,
  JourneyDefinition,
  JourneyNodeType,
  JourneyResourceStatusEnum,
  SubscriptionChange,
} from "./types";
import { InsertUserEvent, insertUserEvents } from "./userEvents";
import {
  findAllUserPropertyAssignments,
  findUserIdsByUserPropertyValue,
} from "./userProperties";

export {
  PublicationAutomationDefinition,
  PublicationAutomationError,
} from "./publicationAutomationDefinition";

type Rule = typeof rules.$inferSelect;
type Action = typeof actions.$inferSelect;
type SourceEvent = typeof outbox.$inferSelect;
type NativeEvent = Record<string, unknown> & { userId: string };

function serializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function definitionOf(value: unknown): PublicationAutomationDefinition {
  const result = schemaValidate(value, PublicationAutomationDefinition);
  if (result.isErr())
    throw new PublicationAutomationError(
      "Invalid publication automation definition",
    );
  const definition = result.value;
  if (
    !definition.destination.subscribe &&
    !definition.destination.welcomeJourneyId &&
    !definition.destination.createIfMissing &&
    !definition.destination.fieldMappings?.length
  )
    throw new PublicationAutomationError(
      "Configure at least one explicit destination action",
    );
  if (
    definition.source.conditions?.some(
      (condition) =>
        condition.operator === "equals" &&
        !Object.prototype.hasOwnProperty.call(condition, "value"),
    )
  )
    throw new PublicationAutomationError(
      "Equality conditions require an explicit value",
    );
  const destinations = new Set<string>();
  for (const mapping of definition.destination.fieldMappings ?? []) {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(mapping.destination) ||
      [
        "id",
        "userId",
        "anonymousId",
        "email",
        "last_clicked",
        "last_opened",
        "__proto__",
        "constructor",
        "prototype",
      ].includes(mapping.destination) ||
      destinations.has(mapping.destination)
    )
      throw new PublicationAutomationError(
        "Mappings must have distinct, unprotected destination trait names",
      );
    destinations.add(mapping.destination);
  }
  return definition;
}

async function ownedNewsletter(publisherId: string, workspaceId: string) {
  const [row] = await db()
    .select()
    .from(newsletter)
    .where(
      and(
        eq(newsletter.publisherId, publisherId),
        eq(newsletter.workspaceId, workspaceId),
      ),
    );
  if (!row)
    throw new PublicationAutomationError(
      "Newsletter does not belong to publisher",
      404,
    );
  return row;
}

async function welcomeJourney(workspaceId: string, id: string) {
  const [row] = await db()
    .select()
    .from(journey)
    .where(and(eq(journey.id, id), eq(journey.workspaceId, workspaceId)));
  const result = schemaValidate(row?.definition, JourneyDefinition);
  if (
    !row ||
    row.status !== JourneyResourceStatusEnum.Running ||
    result.isErr() ||
    result.value.entryNode.type !== JourneyNodeType.EventEntryNode
  )
    throw new PublicationAutomationError(
      "Welcome journey must be a running native event-entry journey in the destination newsletter",
    );
  // A dedicated, unkeyed entry event provides one deterministic native workflow per action.
  if (result.value.entryNode.key || /[*?]/.test(result.value.entryNode.event))
    throw new PublicationAutomationError(
      "Welcome journey requires an exact event name and no custom entry key",
    );
  return { row, definition: result.value };
}

export async function listPublicationAutomationOptions(publisherId: string) {
  const candidates = await db()
    .select({
      id: journey.id,
      name: journey.name,
      newsletterId: journey.workspaceId,
      definition: journey.definition,
    })
    .from(journey)
    .innerJoin(newsletter, eq(newsletter.workspaceId, journey.workspaceId))
    .where(
      and(
        eq(newsletter.publisherId, publisherId),
        eq(journey.status, JourneyResourceStatusEnum.Running),
      ),
    )
    .orderBy(journey.name, journey.id);
  const welcomeJourneys = [];
  for (const candidate of candidates) {
    const definition = schemaValidate(candidate.definition, JourneyDefinition);
    if (
      definition.isErr() ||
      definition.value.entryNode.type !== JourneyNodeType.EventEntryNode ||
      definition.value.entryNode.key ||
      /[*?]/.test(definition.value.entryNode.event)
    )
      continue;
    welcomeJourneys.push({
      id: candidate.id,
      name: candidate.name,
      newsletterId: candidate.newsletterId,
    });
  }
  return { welcomeJourneys };
}

export async function listPublicationAutomations(publisherId: string) {
  return serializable(
    await db()
      .select()
      .from(rules)
      .where(and(eq(rules.publisherId, publisherId), isNull(rules.deletedAt)))
      .orderBy(desc(rules.createdAt)),
  );
}

export async function upsertPublicationAutomation(input: {
  publisherId: string;
  id?: string;
  name: string;
  sourceNewsletterId: string;
  destinationNewsletterId: string;
  enabled: boolean;
  definition: PublicationAutomationDefinition;
}) {
  const definition = definitionOf(input.definition);
  if (
    !input.name.trim() ||
    input.sourceNewsletterId === input.destinationNewsletterId
  )
    throw new PublicationAutomationError(
      "Name and two distinct newsletters are required",
    );
  const [, destination] = await Promise.all([
    ownedNewsletter(input.publisherId, input.sourceNewsletterId),
    ownedNewsletter(input.publisherId, input.destinationNewsletterId),
  ]);
  if (
    (definition.destination.subscribe ||
      definition.destination.welcomeJourneyId) &&
    !destination.subscriptionGroupId
  )
    throw new PublicationAutomationError(
      "Destination newsletter requires a native subscription group",
    );
  if (definition.destination.welcomeJourneyId)
    await welcomeJourney(
      input.destinationNewsletterId,
      definition.destination.welcomeJourneyId,
    );
  const values = {
    name: input.name.trim(),
    publisherId: input.publisherId,
    sourceNewsletterId: input.sourceNewsletterId,
    destinationNewsletterId: input.destinationNewsletterId,
    enabled: input.enabled,
    definition,
    updatedAt: new Date(),
  };
  if (input.id) {
    const [updated] = await db()
      .update(rules)
      .set(values)
      .where(
        and(
          eq(rules.id, input.id),
          eq(rules.publisherId, input.publisherId),
          isNull(rules.deletedAt),
        ),
      )
      .returning();
    if (!updated)
      throw new PublicationAutomationError("Automation not found", 404);
    return serializable(updated);
  }
  const [created] = await db().insert(rules).values(values).returning();
  return serializable(created);
}

export async function deletePublicationAutomation(input: {
  publisherId: string;
  id: string;
}) {
  const [deleted] = await db()
    .update(rules)
    .set({ deletedAt: new Date(), enabled: false })
    .where(
      and(
        eq(rules.publisherId, input.publisherId),
        eq(rules.id, input.id),
        isNull(rules.deletedAt),
      ),
    )
    .returning({ id: rules.id });
  if (!deleted)
    throw new PublicationAutomationError("Automation not found", 404);
  return deleted;
}

export async function listPublicationAutomationActions(input: {
  publisherId: string;
  ruleId?: string;
  limit?: number;
  offset?: number;
}) {
  const rows = await db()
    .select({ action: actions })
    .from(actions)
    .innerJoin(rules, eq(actions.ruleId, rules.id))
    .where(
      and(
        eq(rules.publisherId, input.publisherId),
        input.ruleId ? eq(rules.id, input.ruleId) : undefined,
      ),
    )
    .orderBy(desc(actions.createdAt))
    .limit(Math.max(1, Math.min(200, input.limit ?? 50)))
    .offset(Math.max(0, input.offset ?? 0));
  // Audit metadata and per-step results are public, captured source/profile values remain encrypted.
  return serializable(
    rows.map(({ action }) => {
      const { encryptedPlan, ...state } = action.state;
      return { ...action, state };
    }),
  );
}

/** Persist BEFORE native write. Workers require the exact source payload to exist in ClickHouse. */
export async function enqueuePublicationAutomationEvents({
  workspaceId,
  userEvents,
  workspaceLockHeld = false,
}: {
  workspaceId: string;
  userEvents: InsertUserEvent[];
  workspaceLockHeld?: boolean;
}): Promise<void> {
  if (!userEvents.length) return;
  const [source] = await db()
    .select({ id: newsletter.workspaceId })
    .from(newsletter)
    .where(eq(newsletter.workspaceId, workspaceId));
  if (!source) return;
  requireNewsletterSecretKey();
  // Capture even with no active rules: native events emitted by in-flight steps must retain lineage.
  for (let offset = 0; offset < userEvents.length; offset += 200) {
    const batch = userEvents.slice(offset, offset + 200).map((event) => {
      const raw =
        typeof event.messageRaw === "string"
          ? event.messageRaw
          : JSON.stringify(event.messageRaw);
      const payload = JSON.parse(raw) as { userId?: unknown } | null;
      return {
        sourceNewsletterId: workspaceId,
        eventId: event.messageId,
        sourceUserId:
          typeof payload?.userId === "string" ? payload.userId : null,
        encryptedEvent: encrypt(raw),
      };
    });
    await db().transaction(async (tx) => {
      // A worker already holding the shared session lock must not acquire it on
      // another connection behind a queued exclusive erasure lock.
      if (!workspaceLockHeld)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}, 0))`,
        );
      const hashes = batch.flatMap((event) =>
        event.sourceUserId
          ? [
              createHash("sha256")
                .update(JSON.stringify([workspaceId, event.sourceUserId]))
                .digest("hex"),
            ]
          : [],
      );
      const erased = hashes.length
        ? await tx
            .select({ userHash: newsletterErasure.userHash })
            .from(newsletterErasure)
            .where(
              and(
                eq(newsletterErasure.workspaceId, workspaceId),
                inArray(newsletterErasure.userHash, hashes),
              ),
            )
        : [];
      const blocked = new Set(erased.map((row) => row.userHash));
      const values = batch.filter(
        (event) =>
          !event.sourceUserId ||
          !blocked.has(
            createHash("sha256")
              .update(JSON.stringify([workspaceId, event.sourceUserId]))
              .digest("hex"),
          ),
      );
      if (values.length)
        await tx
          .insert(outbox)
          .values(values)
          .onConflictDoNothing({
            target: [outbox.sourceNewsletterId, outbox.eventId],
          });
    });
  }
}

async function insertAutomationNativeEvent(
  workspaceId: string,
  event: InsertUserEvent,
): Promise<void> {
  const qb = new ClickHouseQueryBuilder();
  const existing = await nativeRows<{ present: number }>(
    `SELECT 1 AS present FROM user_events_v2 WHERE workspace_id = ${qb.addQueryValue(workspaceId, "String")} AND message_id = ${qb.addQueryValue(event.messageId, "String")} LIMIT 1`,
    qb,
  );
  // user_events_v2 is MergeTree, not a unique-key store. The action lock plus
  // this durable existence check prevents crash replay from adding another row.
  if (existing.length) return;
  await insertUserEvents(
    { workspaceId, userEvents: [event] },
    { writeModeOverride: "ch-sync", publicationAutomationLockHeld: true },
  );
}

async function nativeRows<T>(
  query: string,
  qb: ClickHouseQueryBuilder,
): Promise<T[]> {
  return (
    await chQuery({
      query,
      query_params: qb.getQueries(),
      format: "JSONEachRow",
    })
  ).json<T>();
}

async function persistedSource(
  source: SourceEvent,
): Promise<NativeEvent | null> {
  const raw = decrypt(source.encryptedEvent);
  if (!raw) throw new Error("Unable to decrypt automation source");
  const qb = new ClickHouseQueryBuilder();
  const rows = await nativeRows<{ message_raw: string }>(
    `SELECT message_raw FROM user_events_v2 WHERE workspace_id = ${qb.addQueryValue(source.sourceNewsletterId, "String")} AND message_id = ${qb.addQueryValue(source.eventId, "String")} AND message_raw = ${qb.addQueryValue(raw, "String")} LIMIT 1`,
    qb,
  );
  if (!rows.length) return null;
  const event: unknown = JSON.parse(raw);
  if (!event || typeof event !== "object") return {} as NativeEvent;
  return event as NativeEvent;
}

async function nativeTraits(
  workspaceId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const registered = await findAllUserPropertyAssignments({
    workspaceId,
    userId,
  });
  const qb = new ClickHouseQueryBuilder();
  const rows = await nativeRows<{ key: string; value: string }>(
    `SELECT tupleElement(trait, 1) AS key, argMax(tupleElement(trait, 2), tuple(event_time, processing_time, message_id)) AS value FROM user_events_v2 ARRAY JOIN JSONExtractKeysAndValuesRaw(message_raw, 'traits') AS trait WHERE workspace_id = ${qb.addQueryValue(workspaceId, "String")} AND user_id = ${qb.addQueryValue(userId, "String")} AND event_type = 'identify' GROUP BY key`,
    qb,
  );
  const traits: Record<string, unknown> = { ...registered };
  for (const row of rows)
    if (!["__proto__", "constructor", "prototype"].includes(row.key))
      traits[row.key] = JSON.parse(row.value);
  return traits;
}

async function existingMailboxUsers(
  workspaceId: string,
  mailbox: string,
): Promise<string[]> {
  const registered = await findUserIdsByUserPropertyValue({
    workspaceId,
    userPropertyName: "email",
    value: mailbox,
  });
  const qb = new ClickHouseQueryBuilder();
  const rows = await nativeRows<{ user_id: string }>(
    `SELECT user_id, argMax(JSONExtractString(message_raw, 'traits', 'email'), tuple(event_time, processing_time, message_id)) AS email FROM user_events_v2 WHERE workspace_id = ${qb.addQueryValue(workspaceId, "String")} AND event_type = 'identify' AND user_id != '' AND JSONHas(message_raw, 'traits', 'email') GROUP BY user_id HAVING lowerUTF8(trimBoth(email)) = ${qb.addQueryValue(mailbox, "String")}`,
    qb,
  );
  return [
    ...new Set([...(registered ?? []), ...rows.map((row) => row.user_id)]),
  ];
}

async function nativeSubscription(
  workspaceId: string,
  userId: string,
  groupId: string,
): Promise<SubscriptionChange | null> {
  const qb = new ClickHouseQueryBuilder();
  const rows = await nativeRows<{ action: SubscriptionChange }>(
    `SELECT JSONExtractString(message_raw, 'properties', 'action') AS action FROM user_events_v2 WHERE workspace_id = ${qb.addQueryValue(workspaceId, "String")} AND user_id = ${qb.addQueryValue(userId, "String")} AND event = ${qb.addQueryValue(InternalEventType.SubscriptionChange, "String")} AND JSONExtractString(message_raw, 'properties', 'subscriptionId') = ${qb.addQueryValue(groupId, "String")} ORDER BY event_time DESC, processing_time DESC, message_id DESC LIMIT 1`,
    qb,
  );
  const assignment = await getSubscriptionGroupWithAssignment({
    workspaceId,
    userId,
    subscriptionGroupId: groupId,
  });
  const assigned = assignment
    ? getSubscriptionGroupDetails(assignment).action
    : null;
  // Conservatively retain either explicit opt-out until a deliberate consent rule authorizes resubscription.
  return rows[0]?.action === SubscriptionChange.Unsubscribe ||
    assigned === SubscriptionChange.Unsubscribe
    ? SubscriptionChange.Unsubscribe
    : rows[0]?.action ?? assigned;
}

async function tryLock(client: PoolClient, key: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
    [key],
  );
  return result.rows[0]?.locked === true;
}

async function unlock(client: PoolClient, key: string) {
  await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
    key,
  ]);
}

async function saveAction(
  action: Action,
  state: Record<string, unknown>,
  disposition: Action["disposition"] = "pending",
  error: string | null = null,
) {
  await db()
    .update(actions)
    .set({
      state,
      disposition,
      error,
      destinationUserId:
        typeof state.destinationUserId === "string"
          ? state.destinationUserId
          : null,
      updatedAt: new Date(),
    })
    .where(eq(actions.id, action.id));
}

async function subscribeNative(input: {
  workspaceId: string;
  userId: string;
  groupId: string;
  actionId: string;
  timestamp: Date;
  lineage: string[];
}) {
  const groups = await db()
    .select()
    .from(subscriptionGroup)
    .where(
      and(
        eq(subscriptionGroup.id, input.groupId),
        eq(subscriptionGroup.workspaceId, input.workspaceId),
      ),
    );
  if (!groups.length)
    throw new Error("Destination subscription group unavailable");
  const segments = await db()
    .select()
    .from(segment)
    .where(
      and(
        eq(segment.workspaceId, input.workspaceId),
        eq(segment.subscriptionGroupId, input.groupId),
      ),
    );
  const main = segments.find(
    (value) => value.name === getSubscriptionGroupSegmentName(input.groupId),
  );
  const unsubscribed = segments.find(
    (value) =>
      value.name === getSubscriptionGroupUnsubscribedSegmentName(input.groupId),
  );
  if (!main || !unsubscribed)
    throw new Error("Destination subscription segments unavailable");
  const event = buildSubscriptionChangeEvent({
    messageId: automationNativeId(input.actionId, "subscribe"),
    userId: input.userId,
    action: SubscriptionChange.Subscribe,
    subscriptionGroupId: input.groupId,
    currentTime: input.timestamp,
  });
  const raw = JSON.parse(event.messageRaw as string) as Record<string, unknown>;
  raw.context = { publicationAutomation: { lineage: input.lineage } };
  await insertAutomationNativeEvent(input.workspaceId, {
    ...event,
    messageRaw: raw,
  });
  await insertSegmentAssignments([
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      segmentId: main.id,
      inSegment: true,
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      segmentId: unsubscribed.id,
      inSegment: false,
    },
  ]);
}

async function executeAction(
  client: PoolClient,
  rule: Rule,
  source: SourceEvent,
  event: NativeEvent,
  traits: Record<string, unknown>,
  budget: { remaining: number },
): Promise<void> {
  const definition = definitionOf(rule.definition);
  const dedupeKey = automationDedupeKey(
    definition,
    event.userId,
    source.eventId,
  );
  await db()
    .insert(actions)
    .values({
      ruleId: rule.id,
      sourceEventId: source.eventId,
      sourceUserId: event.userId,
      dedupeKey,
      state: {
        sourceOutboxId: source.id,
        ruleDefinition: definition,
        authorization: {
          type: "publisher_rule",
          ruleId: rule.id,
          ruleName: rule.name,
          ruleUpdatedAt: rule.updatedAt.toISOString(),
          sourceEventId: source.eventId,
          sourceLink: definition.source.link ?? null,
        },
        sourceNewsletterId: rule.sourceNewsletterId,
        destinationNewsletterId: rule.destinationNewsletterId,
        lineage: [...automationLineage(event), rule.id],
      },
    })
    .onConflictDoNothing({ target: [actions.ruleId, actions.dedupeKey] });
  const [action] = await db()
    .select()
    .from(actions)
    .where(and(eq(actions.ruleId, rule.id), eq(actions.dedupeKey, dedupeKey)));
  if (
    !action ||
    action.disposition === "completed" ||
    action.disposition === "blocked"
  )
    return;
  // A repeated click must not substitute new values/consent for the original action.
  if (action.sourceEventId !== source.eventId) return;
  if (budget.remaining <= 0) throw new Error("Automation action limit reached");
  budget.remaining -= 1;
  const state = { ...action.state };
  const actionLock = `publication-action:${action.id}`;
  if (!(await tryLock(client, actionLock)))
    throw new Error("Automation action busy");
  let mailboxLock: string | undefined;
  const workspaceLocks: string[] = [];
  try {
    const pinned = definitionOf(state.ruleDefinition);
    rule = {
      ...rule,
      sourceNewsletterId: String(state.sourceNewsletterId),
      destinationNewsletterId: String(state.destinationNewsletterId),
    };
    for (const workspaceId of [
      rule.sourceNewsletterId,
      rule.destinationNewsletterId,
    ].sort()) {
      await client.query(
        "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))",
        [workspaceId],
      );
      workspaceLocks.push(workspaceId);
    }
    const sourceHash = createHash("sha256")
      .update(JSON.stringify([rule.sourceNewsletterId, event.userId]))
      .digest("hex");
    const [erasedSource] = await db()
      .select({ userHash: newsletterErasure.userHash })
      .from(newsletterErasure)
      .where(
        and(
          eq(newsletterErasure.workspaceId, rule.sourceNewsletterId),
          eq(newsletterErasure.userHash, sourceHash),
        ),
      );
    if (erasedSource) {
      await db()
        .update(actions)
        .set({
          sourceUserId: `erased:${sourceHash}`,
          sourceEventId: createHash("sha256")
            .update(action.sourceEventId)
            .digest("hex"),
          destinationUserId: null,
          state: { erased: true },
          disposition: "blocked",
          error: "Source subscriber has been erased",
        })
        .where(eq(actions.id, action.id));
      return;
    }
    const lineage = Array.isArray(state.lineage)
      ? (state.lineage as string[])
      : [rule.id];
    const destination = await ownedNewsletter(
      rule.publisherId,
      rule.destinationNewsletterId,
    );
    await ownedNewsletter(rule.publisherId, rule.sourceNewsletterId);
    let plan: {
      mailbox: string;
      mapped: Record<string, unknown>;
      authorized: boolean;
    };
    if (state.encryptedPlan) {
      const plaintext = decrypt(
        state.encryptedPlan as Parameters<typeof decrypt>[0],
      );
      if (!plaintext) throw new Error("Unable to decrypt automation plan");
      plan = JSON.parse(plaintext) as typeof plan;
    } else {
      const value = automationValue(
        pinned.destination.match.source === "traits" ? traits : event,
        pinned.destination.match.path,
      );
      if (
        typeof value !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
      ) {
        await saveAction(
          action,
          state,
          "blocked",
          "Destination email is missing or invalid",
        );
        return;
      }
      const mailbox = value.trim().toLowerCase();
      plan = {
        mailbox,
        mapped: {},
        authorized: Boolean(
          pinned.consent &&
            automationValue(event, pinned.consent.path) === true,
        ),
      };
    }
    const mailboxHash = newsletterMailboxHash(plan.mailbox);
    mailboxLock = `publication-identity:${rule.destinationNewsletterId}:${mailboxHash}`;
    if (!(await tryLock(client, mailboxLock))) {
      mailboxLock = undefined;
      throw new Error("Destination identity busy");
    }
    const [blocked] = await db()
      .select({ id: publisherSuppression.id })
      .from(publisherSuppression)
      .where(
        and(
          eq(publisherSuppression.publisherId, rule.publisherId),
          eq(publisherSuppression.mailboxHash, mailboxHash),
          eq(publisherSuppression.active, true),
        ),
      )
      .limit(1);
    if (blocked) {
      await saveAction(
        action,
        state,
        "blocked",
        "Publisher suppression is active",
      );
      return;
    }
    const [identity] = await db()
      .select()
      .from(identities)
      .where(
        and(
          eq(identities.newsletterId, rule.destinationNewsletterId),
          eq(identities.mailboxHash, mailboxHash),
        ),
      );
    let destinationUserId = identity?.userId;
    let created = false;
    if (!destinationUserId) {
      const matches = await existingMailboxUsers(
        rule.destinationNewsletterId,
        plan.mailbox,
      );
      if (matches.length > 1) {
        await saveAction(
          action,
          state,
          "blocked",
          "Destination email matches multiple local subscribers",
        );
        return;
      }
      destinationUserId = matches[0];
      if (!destinationUserId && !pinned.destination.createIfMissing) {
        await saveAction(
          action,
          state,
          "blocked",
          "Destination subscriber not found",
        );
        return;
      }
      created = !destinationUserId;
      destinationUserId = destinationUserId ?? randomUUID();
      await db().insert(identities).values({
        newsletterId: rule.destinationNewsletterId,
        mailboxHash,
        userId: destinationUserId,
      });
    }
    if (destinationUserId.startsWith("erased:")) {
      await saveAction(
        action,
        { erased: true },
        "blocked",
        "Destination subscriber has been erased",
      );
      return;
    }
    const destinationHash = createHash("sha256")
      .update(JSON.stringify([rule.destinationNewsletterId, destinationUserId]))
      .digest("hex");
    const [erasedDestination] = await db()
      .select({ userHash: newsletterErasure.userHash })
      .from(newsletterErasure)
      .where(
        and(
          eq(newsletterErasure.workspaceId, rule.destinationNewsletterId),
          eq(newsletterErasure.userHash, destinationHash),
        ),
      );
    if (erasedDestination) {
      await saveAction(
        action,
        state,
        "blocked",
        "Destination subscriber has been erased",
      );
      return;
    }
    const existing = await nativeTraits(
      rule.destinationNewsletterId,
      destinationUserId,
    );
    if (
      typeof existing.email === "string" &&
      existing.email.trim().toLowerCase() !== plan.mailbox
    ) {
      await saveAction(
        action,
        state,
        "blocked",
        "Destination identity mailbox has changed",
      );
      return;
    }
    if (!state.encryptedPlan) {
      plan.mapped = automationMappedTraits(pinned, event, traits, existing);
      state.encryptedPlan = encrypt(JSON.stringify(plan));
      state.consent =
        pinned.consent && plan.authorized
          ? {
              authorization: pinned.consent.authorization,
              sourceEventId: source.eventId,
              allowResubscribe: pinned.consent.allowResubscribe,
            }
          : null;
    }
    state.destinationUserId = destinationUserId;
    state.created = state.created ?? created;
    await saveAction(action, state);
    const subscription = destination.subscriptionGroupId
      ? await nativeSubscription(
          rule.destinationNewsletterId,
          destinationUserId,
          destination.subscriptionGroupId,
        )
      : null;
    if (
      subscription === SubscriptionChange.Unsubscribe &&
      !(
        plan.authorized &&
        pinned.consent?.allowResubscribe &&
        pinned.destination.subscribe
      )
    ) {
      await saveAction(
        action,
        state,
        "blocked",
        "Destination newsletter unsubscribe is active",
      );
      return;
    }
    const emit = async (step: string, payload: Record<string, unknown>) => {
      const messageId = automationNativeId(action.id, step);
      await insertAutomationNativeEvent(rule.destinationNewsletterId, {
        messageId,
        messageRaw: {
          ...payload,
          userId: destinationUserId,
          messageId,
          timestamp: action.createdAt.toISOString(),
          context: {
            publicationAutomation: {
              lineage,
              sourceEventId: source.eventId,
              ruleId: rule.id,
            },
          },
        },
      });
    };
    if (!state.profileCompleted) {
      if (!existing.email || Object.keys(plan.mapped).length)
        await emit("identify", {
          type: EventType.Identify,
          traits: {
            ...plan.mapped,
            ...(!existing.email ? { email: plan.mailbox } : {}),
          },
        });
      state.profileCompleted = true;
      await saveAction(action, state);
    }
    if (pinned.destination.subscribe && !state.subscriptionCompleted) {
      if (!destination.subscriptionGroupId)
        throw new Error("Destination subscription group missing");
      if (
        subscription !== SubscriptionChange.Subscribe ||
        state.subscriptionStarted
      ) {
        state.subscriptionStarted = true;
        await saveAction(action, state);
        await subscribeNative({
          workspaceId: rule.destinationNewsletterId,
          userId: destinationUserId,
          groupId: destination.subscriptionGroupId,
          actionId: action.id,
          timestamp: action.createdAt,
          lineage,
        });
      }
      state.subscriptionCompleted = true;
      state.subscriptionEventId = automationNativeId(action.id, "subscribe");
      await saveAction(action, state);
    }
    if (pinned.destination.welcomeJourneyId && !state.journeyCompleted) {
      if (
        !pinned.destination.subscribe &&
        subscription !== SubscriptionChange.Subscribe
      ) {
        await saveAction(
          action,
          state,
          "blocked",
          "Welcome journey requires an explicit destination subscription",
        );
        return;
      }
      const welcome = await welcomeJourney(
        rule.destinationNewsletterId,
        pinned.destination.welcomeJourneyId,
      );
      if (welcome.definition.entryNode.type !== JourneyNodeType.EventEntryNode)
        throw new Error("Welcome entry unavailable");
      const messageId = automationNativeId(action.id, "welcome");
      const welcomeEvent = {
        event: welcome.definition.entryNode.event,
        messageId,
        properties: { publicationAutomationActionId: action.id },
        timestamp: action.createdAt.toISOString(),
      };
      await emit("welcome", { type: EventType.Track, ...welcomeEvent });
      const workflowId = getKeyedUserJourneyWorkflowId({
        workspaceId: rule.destinationNewsletterId,
        userId: destinationUserId,
        journeyId: welcome.row.id,
        entryNode: welcome.definition.entryNode,
        event: welcomeEvent,
      });
      if (!workflowId)
        throw new Error("Native welcome workflow ID unavailable");
      state.workflowId = workflowId;
      await saveAction(action, state);
      const workflowClient = await connectWorkflowClient();
      try {
        await workflowClient.start(userJourneyWorkflow, {
          taskQueue: "default",
          workflowId,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          args: [
            {
              version: UserJourneyWorkflowVersion.V2,
              workspaceId: rule.destinationNewsletterId,
              userId: destinationUserId,
              journeyId: welcome.row.id,
              definition: welcome.definition,
              event: welcomeEvent,
            },
          ],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
      }
      state.journeyCompleted = true;
      state.journeyEventId = messageId;
      await saveAction(action, state);
    }
    await saveAction(action, state, "completed");
  } catch (error) {
    await saveAction(
      action,
      state,
      "error",
      error instanceof PublicationAutomationError
        ? error.message
        : "Automation step failed; retry scheduled",
    );
    throw error;
  } finally {
    try {
      if (mailboxLock) await unlock(client, mailboxLock);
    } finally {
      try {
        for (const workspaceId of workspaceLocks.reverse())
          await client.query(
            "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))",
            [workspaceId],
          );
      } finally {
        await unlock(client, actionLock);
      }
    }
  }
}

/** Bounded recoverable worker; no send/provisioning work occurs in this activity. */
export async function drainPublicationAutomations(): Promise<{
  processed: number;
  retried: number;
}> {
  const pending = await db()
    .select()
    .from(outbox)
    .where(
      and(
        isNull(outbox.processedAt),
        sql`${outbox.nextAttemptAt} <= clock_timestamp()`,
      ),
    )
    .orderBy(outbox.nextAttemptAt)
    .limit(50);
  let processed = 0;
  let retried = 0;
  const budget = { remaining: 50 };
  for (const source of pending) {
    const client = await pool().connect();
    const lock = `publication-event:${source.id}`;
    let locked = false;
    try {
      locked = await tryLock(client, lock);
      if (!locked) continue;
      const [current] = await db()
        .select()
        .from(outbox)
        .where(eq(outbox.id, source.id));
      if (!current || current.processedAt) continue;
      const event = await persistedSource(current);
      if (!event) throw new Error("Source native event not yet persisted");
      const lineage = automationLineage(event);
      if (
        typeof event.userId === "string" &&
        event.userId &&
        lineage.length < 32
      ) {
        const candidates = await db()
          .select()
          .from(rules)
          .where(
            and(
              eq(rules.sourceNewsletterId, source.sourceNewsletterId),
              eq(rules.enabled, true),
              isNull(rules.deletedAt),
            ),
          );
        const traits = candidates.length
          ? await nativeTraits(source.sourceNewsletterId, event.userId)
          : {};
        for (const rule of candidates) {
          if (
            lineage.includes(rule.id) ||
            !automationMatches(definitionOf(rule.definition), event, traits)
          )
            continue;
          await executeAction(client, rule, current, event, traits, budget);
        }
      }
      await db()
        .update(outbox)
        .set({ processedAt: sql`clock_timestamp()` })
        .where(eq(outbox.id, source.id));
      processed += 1;
    } catch {
      await db()
        .update(outbox)
        .set({
          attempts: source.attempts + 1,
          nextAttemptAt: sql`clock_timestamp() + (${Math.min(3600000, 1000 * 2 ** Math.min(source.attempts, 12))} * interval '1 millisecond')`,
        })
        .where(eq(outbox.id, source.id));
      retried += 1;
    } finally {
      try {
        if (locked) await unlock(client, lock);
      } finally {
        client.release();
      }
    }
  }
  return { processed, retried };
}

/** Called after newsletterErasure barriers are installed and before native history is removed. */
export async function deletePublicationAutomationData({
  workspaceId,
  userIds,
}: {
  workspaceId: string;
  userIds?: string[];
}): Promise<void> {
  if (userIds && !userIds.length) return;
  await db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`,
    );
    const [publication] = await tx
      .select({ id: newsletter.workspaceId })
      .from(newsletter)
      .where(eq(newsletter.workspaceId, workspaceId));
    if (!publication) return;
    const qb = new ClickHouseQueryBuilder();
    const userFilter = userIds
      ? ` AND user_id IN ${qb.addQueryValue(userIds, "Array(String)")}`
      : "";
    const mailboxes = await nativeRows<{ user_id: string; mailbox: string }>(
      `SELECT user_id, argMax(JSONExtractString(message_raw, 'traits', 'email'), tuple(event_time, processing_time, message_id)) AS mailbox FROM user_events_v2 WHERE workspace_id = ${qb.addQueryValue(workspaceId, "String")} AND event_type = 'identify' AND user_id != '' AND JSONHas(message_raw, 'traits', 'email')${userFilter} GROUP BY user_id`,
      qb,
    );
    const [emailProperty] = await tx
      .select({ id: userProperty.id })
      .from(userProperty)
      .where(
        and(
          eq(userProperty.workspaceId, workspaceId),
          eq(userProperty.name, "email"),
        ),
      );
    if (emailProperty) {
      const assignments = new ClickHouseQueryBuilder();
      const assignmentFilter = userIds
        ? ` AND user_id IN ${assignments.addQueryValue(userIds, "Array(String)")}`
        : "";
      mailboxes.push(
        ...(await nativeRows<{ user_id: string; mailbox: string }>(
          `SELECT user_id, argMax(user_property_value, assigned_at) AS mailbox FROM computed_property_assignments_v2 WHERE workspace_id = ${assignments.addQueryValue(workspaceId, "String")} AND type = 'user_property' AND computed_property_id = ${assignments.addQueryValue(emailProperty.id, "String")}${assignmentFilter} GROUP BY user_id`,
          assignments,
        )),
      );
    }
    for (const row of mailboxes) {
      if (!row.mailbox) continue;
      const userHash = createHash("sha256")
        .update(JSON.stringify([workspaceId, row.user_id]))
        .digest("hex");
      await tx
        .insert(identities)
        .values({
          newsletterId: workspaceId,
          mailboxHash: newsletterMailboxHash(row.mailbox),
          userId: `erased:${userHash}`,
        })
        .onConflictDoUpdate({
          target: [identities.newsletterId, identities.mailboxHash],
          set: { userId: `erased:${userHash}` },
        });
    }
    await tx
      .delete(outbox)
      .where(
        and(
          eq(outbox.sourceNewsletterId, workspaceId),
          userIds ? inArray(outbox.sourceUserId, userIds) : undefined,
        ),
      );
    // Actions retain their original route even when the current rule is retargeted.
    const sourceNewsletterId = sql<string>`${actions.state}->>'sourceNewsletterId'`;
    const destinationNewsletterId = sql<string>`${actions.state}->>'destinationNewsletterId'`;
    const matched = await tx
      .select({
        id: actions.id,
        sourceUserId: actions.sourceUserId,
        sourceEventId: actions.sourceEventId,
        destinationUserId: actions.destinationUserId,
        sourceNewsletterId,
        destinationNewsletterId,
      })
      .from(actions)
      .where(
        or(
          and(
            eq(sourceNewsletterId, workspaceId),
            userIds ? inArray(actions.sourceUserId, userIds) : undefined,
          ),
          and(
            eq(destinationNewsletterId, workspaceId),
            userIds ? inArray(actions.destinationUserId, userIds) : undefined,
          ),
        ),
      );
    for (const action of matched) {
      const sourceUserId = `erased:${createHash("sha256")
        .update(
          JSON.stringify([action.sourceNewsletterId, action.sourceUserId]),
        )
        .digest("hex")}`;
      const destinationUserId = action.destinationUserId
        ? `erased:${createHash("sha256")
            .update(
              JSON.stringify([
                action.destinationNewsletterId,
                action.destinationUserId,
              ]),
            )
            .digest("hex")}`
        : null;
      await tx
        .update(actions)
        .set({
          sourceUserId,
          destinationUserId,
          sourceEventId: createHash("sha256")
            .update(action.sourceEventId)
            .digest("hex"),
          state: { erased: true },
          disposition: "blocked",
          error: "Subscriber data erased",
        })
        .where(eq(actions.id, action.id));
    }
    const reserved = await tx
      .select()
      .from(identities)
      .where(
        and(
          eq(identities.newsletterId, workspaceId),
          userIds ? inArray(identities.userId, userIds) : undefined,
        ),
      );
    for (const identity of reserved) {
      if (identity.userId.startsWith("erased:")) continue;
      const userHash = createHash("sha256")
        .update(JSON.stringify([workspaceId, identity.userId]))
        .digest("hex");
      await tx
        .update(identities)
        .set({ userId: `erased:${userHash}` })
        .where(
          and(
            eq(identities.newsletterId, workspaceId),
            eq(identities.mailboxHash, identity.mailboxHash),
          ),
        );
    }
  });
}
