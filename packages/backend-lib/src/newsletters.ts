import { randomUUID } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import { bootstrapComputeProperties } from "./bootstrap";
import { provisionBuiltinUserProperties } from "./builtinUserProperties";
import { ClickHouseQueryBuilder, query as chQuery } from "./clickhouse";
import config from "./config";
import { Db, db } from "./db";
import { newsletter, newsletterSend, publisher } from "./db/publisherSchema";
import {
  broadcast,
  journey,
  segment,
  subscriptionGroup,
  userProperty,
  workspace,
  workspaceMemberRole,
} from "./db/schema";
import {
  getSubscriptionGroupSegmentName,
  updateUserSubscriptions,
  upsertSubscriptionGroup,
  upsertSubscriptionSecret,
} from "./subscriptionGroups";
import {
  ChannelType,
  SubscriptionGroupType,
  UserPropertyDefinitionType,
} from "./types";
import { insertUserEvents } from "./userEvents";
import { deleteUsers, getUsers, getUsersCount } from "./users";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class NewsletterError extends Error {
  readonly status: number;
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "NewsletterError";
    this.status = statusCode;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, NewsletterError.prototype);
  }
}

const countingNotice =
  "Contacts and subscriptions are newsletter-local records. Matched mailboxes compare normalized email addresses, not unique people. No profiles are merged or cross-updated.";

async function requireManager(
  tx: Transaction,
  workspaceId: string,
  memberId?: string,
) {
  if (!memberId) return; // Internal/bearer callers are authorized by the API's workspace scopes.
  const [membership] = await tx
    .select()
    .from(workspaceMemberRole)
    .where(
      and(
        eq(workspaceMemberRole.workspaceId, workspaceId),
        eq(workspaceMemberRole.workspaceMemberId, memberId),
      ),
    );
  if (!membership || !["Admin", "WorkspaceManager"].includes(membership.role)) {
    throw new NewsletterError("Publisher management membership required", 403);
  }
}

export async function requirePublisherAccess(
  contextWorkspaceId: string,
  publisherId: string,
): Promise<void> {
  if (contextWorkspaceId !== publisherId)
    throw new NewsletterError("Publisher workspace access required", 403);
  const [row] = await db()
    .select()
    .from(publisher)
    .where(eq(publisher.workspaceId, publisherId));
  if (!row) throw new NewsletterError("Publisher not found", 404);
}

export async function getPublisherForWorkspace(
  workspaceId: string,
): Promise<string | null> {
  const [parent] = await db()
    .select()
    .from(publisher)
    .where(eq(publisher.workspaceId, workspaceId));
  if (parent) return parent.workspaceId;
  const [child] = await db()
    .select()
    .from(newsletter)
    .where(eq(newsletter.workspaceId, workspaceId));
  return child?.publisherId ?? null;
}

export async function requireNewsletterAccess(
  contextWorkspaceId: string,
  newsletterId: string,
): Promise<void> {
  const [row] = await db()
    .select()
    .from(newsletter)
    .where(eq(newsletter.workspaceId, newsletterId));
  if (!row) throw new NewsletterError("Newsletter not found", 404);
  if (
    contextWorkspaceId !== row.workspaceId &&
    contextWorkspaceId !== row.publisherId
  ) {
    throw new NewsletterError("Newsletter workspace access required", 403);
  }
}

/** Apply to campaign creation/start and direct sends; legacy workspaces remain unchanged. */
export async function requireNewsletterCampaignWorkspace(
  workspaceId: string,
): Promise<void> {
  const [row] = await db()
    .select()
    .from(publisher)
    .where(eq(publisher.workspaceId, workspaceId));
  if (row)
    throw new NewsletterError(
      "Select a newsletter: publisher workspaces cannot own campaigns or send messages",
      409,
    );
}

export async function createPublisher({
  workspaceId,
  name,
  memberId,
}: {
  workspaceId?: string;
  name: string;
  memberId?: string;
}) {
  const normalizedName = name.trim();
  if (!normalizedName) throw new NewsletterError("Publisher name is required");
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId ?? normalizedName}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(workspace)
      .where(
        workspaceId
          ? eq(workspace.id, workspaceId)
          : and(
              eq(workspace.name, normalizedName),
              sql`${workspace.parentWorkspaceId} is null`,
            ),
      );
    if (workspaceId && !existing)
      throw new NewsletterError("Workspace not found", 404);
    let target = existing;
    if (target) {
      await requireManager(tx, target.id, memberId);
      const [optedIn] = await tx
        .select()
        .from(publisher)
        .where(eq(publisher.workspaceId, target.id));
      if (!workspaceId && !optedIn)
        throw new NewsletterError(
          "Explicit workspace adoption is required",
          409,
        );
      if (
        target.parentWorkspaceId ||
        target.type === "Child" ||
        target.status !== "Active"
      ) {
        throw new NewsletterError(
          "Only an active top-level workspace can become a publisher",
          409,
        );
      }
      const [hasNewsletter] = await tx
        .select()
        .from(newsletter)
        .where(eq(newsletter.workspaceId, target.id));
      const [hasBroadcast] = await tx
        .select({ id: broadcast.id })
        .from(broadcast)
        .where(eq(broadcast.workspaceId, target.id))
        .limit(1);
      const [hasJourney] = await tx
        .select({ id: journey.id })
        .from(journey)
        .where(eq(journey.workspaceId, target.id))
        .limit(1);
      if (hasNewsletter || hasBroadcast || hasJourney)
        throw new NewsletterError(
          "A campaign-owning workspace cannot become a publisher control plane",
          409,
        );
      await tx
        .update(workspace)
        .set({ type: "Parent" })
        .where(eq(workspace.id, target.id));
    } else {
      [target] = await tx
        .insert(workspace)
        .values({ name: normalizedName, type: "Parent" })
        .returning();
      if (!target) throw new Error("Publisher workspace was not created");
      if (memberId)
        await tx
          .insert(workspaceMemberRole)
          .values({
            workspaceId: target.id,
            workspaceMemberId: memberId,
            role: "Admin",
          });
    }
    await tx
      .insert(publisher)
      .values({ workspaceId: target.id })
      .onConflictDoNothing();
    const [record] = await tx
      .select()
      .from(publisher)
      .where(eq(publisher.workspaceId, target.id));
    if (!record) throw new Error("Publisher was not created");
    return {
      ...record,
      id: target.id,
      name: target.name,
      type: "Parent" as const,
    };
  });
}

export async function listNewsletters(publisherId: string) {
  await requirePublisherAccess(publisherId, publisherId);
  return db()
    .select({
      workspaceId: newsletter.workspaceId,
      publisherId: newsletter.publisherId,
      name: workspace.name,
      slug: newsletter.slug,
      status: newsletter.status,
      workspaceStatus: workspace.status,
      subscriptionGroupId: newsletter.subscriptionGroupId,
      createdAt: newsletter.createdAt,
      updatedAt: newsletter.updatedAt,
    })
    .from(newsletter)
    .innerJoin(workspace, eq(workspace.id, newsletter.workspaceId))
    .where(eq(newsletter.publisherId, publisherId))
    .orderBy(asc(newsletter.slug));
}

async function provisionNewsletter(
  workspaceId: string,
  explicitGroupId?: string,
) {
  await provisionBuiltinUserProperties(workspaceId);
  // Native resolved properties remain local; never replace an adopted workspace's definitions.
  await db()
    .insert(userProperty)
    .values([
      {
        workspaceId,
        name: "id",
        definition: { type: UserPropertyDefinitionType.Id },
      },
      {
        workspaceId,
        name: "email",
        definition: { type: UserPropertyDefinitionType.Trait, path: "email" },
      },
    ])
    .onConflictDoNothing({
      target: [userProperty.workspaceId, userProperty.name],
    });
  await upsertSubscriptionSecret({ workspaceId });
  const [row] = await db()
    .select()
    .from(newsletter)
    .where(eq(newsletter.workspaceId, workspaceId));
  if (!row) throw new NewsletterError("Newsletter not found", 404);
  const groupId =
    row.subscriptionGroupId ??
    explicitGroupId ??
    uuidv5("email-subscription-group", workspaceId);
  const [existingGroup] = await db()
    .select()
    .from(subscriptionGroup)
    .where(eq(subscriptionGroup.id, groupId));
  if (
    existingGroup &&
    (existingGroup.workspaceId !== workspaceId ||
      existingGroup.channel !== "Email")
  ) {
    throw new NewsletterError(
      "Subscription group must belong to the newsletter",
      403,
    );
  }
  const result = await upsertSubscriptionGroup({
    id: groupId,
    workspaceId,
    name: existingGroup?.name ?? "Newsletter - Email",
    type:
      existingGroup?.type === "OptOut"
        ? SubscriptionGroupType.OptOut
        : SubscriptionGroupType.OptIn,
    channel: ChannelType.Email,
  });
  if (result.isErr())
    throw new NewsletterError(
      "Could not provision the native newsletter subscription group",
      409,
    );
  await db()
    .update(newsletter)
    .set({ subscriptionGroupId: groupId })
    .where(eq(newsletter.workspaceId, workspaceId));
  if (config().bootstrapWorker)
    await bootstrapComputeProperties({ workspaceId });
}

export async function createNewsletter({
  publisherId,
  name,
  slug,
  memberId,
}: {
  publisherId: string;
  name: string;
  slug: string;
  memberId?: string;
}) {
  const normalizedName = name.trim();
  if (!normalizedName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new NewsletterError(
      "A name and lowercase hyphenated slug are required",
    );
  const workspaceId = await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${publisherId}, 0))`,
    );
    const [parent] = await tx
      .select({ publisher, workspace })
      .from(publisher)
      .innerJoin(workspace, eq(publisher.workspaceId, workspace.id))
      .where(eq(publisher.workspaceId, publisherId));
    if (!parent || parent.workspace.status !== "Active")
      throw new NewsletterError("Active publisher not found", 404);
    await requireManager(tx, publisherId, memberId);
    const [existing] = await tx
      .select({ newsletter, workspace })
      .from(newsletter)
      .innerJoin(workspace, eq(newsletter.workspaceId, workspace.id))
      .where(
        and(eq(newsletter.publisherId, publisherId), eq(newsletter.slug, slug)),
      );
    if (existing) {
      if (existing.workspace.name !== normalizedName)
        throw new NewsletterError(
          "Newsletter slug already exists with a different name",
          409,
        );
      return existing.newsletter.workspaceId;
    }
    const [conflict] = await tx
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.parentWorkspaceId, publisherId),
          eq(workspace.name, normalizedName),
        ),
      );
    if (conflict)
      throw new NewsletterError(
        "Existing child workspaces require explicit adoption",
        409,
      );
    const [child] = await tx
      .insert(workspace)
      .values({
        name: normalizedName,
        type: "Child",
        parentWorkspaceId: publisherId,
      })
      .returning();
    if (!child) throw new Error("Newsletter workspace was not created");
    const groupId = uuidv5("email-subscription-group", child.id);
    await tx
      .insert(subscriptionGroup)
      .values({
        id: groupId,
        workspaceId: child.id,
        name: "Newsletter - Email",
        type: "OptIn",
        channel: "Email",
      });
    await tx
      .insert(newsletter)
      .values({
        workspaceId: child.id,
        publisherId,
        slug,
        subscriptionGroupId: groupId,
      });
    return child.id;
  });
  await provisionNewsletter(workspaceId);
  return (await listNewsletters(publisherId)).find(
    (row) => row.workspaceId === workspaceId,
  )!;
}

export async function adoptNewsletter({
  publisherId,
  workspaceId,
  slug,
  memberId,
  subscriptionGroupId,
}: {
  publisherId: string;
  workspaceId: string;
  slug: string;
  memberId?: string;
  subscriptionGroupId?: string;
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new NewsletterError("A lowercase hyphenated slug is required");
  await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${publisherId}, 0))`,
    );
    const [parent] = await tx
      .select()
      .from(publisher)
      .where(eq(publisher.workspaceId, publisherId));
    if (!parent) throw new NewsletterError("Publisher not found", 404);
    await requireManager(tx, publisherId, memberId);
    const [target] = await tx
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .for("update");
    if (!target) throw new NewsletterError("Workspace not found", 404);
    const [existing] = await tx
      .select()
      .from(newsletter)
      .where(eq(newsletter.workspaceId, workspaceId));
    if (existing) {
      if (
        existing.publisherId !== publisherId ||
        existing.slug !== slug ||
        (subscriptionGroupId &&
          existing.subscriptionGroupId !== subscriptionGroupId)
      ) {
        throw new NewsletterError(
          "Newsletter belongs to another publisher or adoption configuration",
          409,
        );
      }
      return;
    }
    const [isPublisher] = await tx
      .select()
      .from(publisher)
      .where(eq(publisher.workspaceId, workspaceId));
    const [hasChildren] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.parentWorkspaceId, workspaceId))
      .limit(1);
    if (
      isPublisher ||
      hasChildren ||
      workspaceId === publisherId ||
      target.status !== "Active" ||
      target.parentWorkspaceId !== publisherId
    ) {
      throw new NewsletterError(
        "Workspace cannot be adopted into this publisher hierarchy",
        409,
      );
    }
    const [slugConflict] = await tx
      .select()
      .from(newsletter)
      .where(
        and(eq(newsletter.publisherId, publisherId), eq(newsletter.slug, slug)),
      );
    if (slugConflict)
      throw new NewsletterError("Newsletter slug already exists", 409);
    const groups = await tx
      .select()
      .from(subscriptionGroup)
      .where(
        and(
          eq(subscriptionGroup.workspaceId, workspaceId),
          eq(subscriptionGroup.channel, "Email"),
        ),
      );
    const deterministicId = uuidv5("email-subscription-group", workspaceId);
    const selected = subscriptionGroupId
      ? groups.find((group) => group.id === subscriptionGroupId)
      : groups.find((group) => group.id === deterministicId) ??
        (groups.length === 1 ? groups[0] : undefined);
    if (subscriptionGroupId && !selected)
      throw new NewsletterError(
        "Subscription group must belong to the adopted newsletter",
        403,
      );
    if (!selected && groups.length > 1)
      throw new NewsletterError(
        "Select the existing newsletter subscription group explicitly",
        409,
      );
    const [nameConflict] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        and(
          eq(workspace.parentWorkspaceId, publisherId),
          eq(workspace.name, target.name),
        ),
      );
    if (nameConflict && nameConflict.id !== workspaceId)
      throw new NewsletterError(
        "A sibling workspace already has this name",
        409,
      );
    await tx
      .update(workspace)
      .set({ type: "Child", parentWorkspaceId: publisherId })
      .where(eq(workspace.id, workspaceId));
    const groupId = selected?.id ?? deterministicId;
    if (!selected)
      await tx
        .insert(subscriptionGroup)
        .values({
          id: groupId,
          workspaceId,
          name: "Newsletter - Email",
          type: "OptIn",
          channel: "Email",
        });
    await tx
      .insert(newsletter)
      .values({ workspaceId, publisherId, slug, subscriptionGroupId: groupId });
  });
  await provisionNewsletter(workspaceId, subscriptionGroupId);
  return (await listNewsletters(publisherId)).find(
    (row) => row.workspaceId === workspaceId,
  )!;
}

export async function updateNewsletter({
  publisherId,
  newsletterId,
  name,
  status,
  memberId,
}: {
  publisherId: string;
  newsletterId: string;
  name?: string;
  status?: "draft" | "active" | "paused";
  memberId?: string;
}) {
  await requirePublisherAccess(publisherId, publisherId);
  await db().transaction(async (tx) => {
    await requireManager(tx, publisherId, memberId);
    const [row] = await tx
      .select()
      .from(newsletter)
      .where(
        and(
          eq(newsletter.workspaceId, newsletterId),
          eq(newsletter.publisherId, publisherId),
        ),
      );
    if (!row)
      throw new NewsletterError("Newsletter not found in publisher", 404);
    if (name !== undefined && !name.trim())
      throw new NewsletterError("Newsletter name is required");
    if (status !== undefined && !["draft", "active", "paused"].includes(status))
      throw new NewsletterError("Invalid newsletter status");
    if (name !== undefined || status !== undefined) {
      await tx
        .update(workspace)
        .set({
          name: name?.trim(),
          status:
            status === undefined
              ? undefined
              : status === "paused"
                ? "Paused"
                : "Active",
        })
        .where(eq(workspace.id, newsletterId));
    }
    if (status !== undefined)
      await tx
        .update(newsletter)
        .set({ status })
        .where(eq(newsletter.workspaceId, newsletterId));
  });
  return (await listNewsletters(publisherId)).find(
    (row) => row.workspaceId === newsletterId,
  )!;
}

async function selectedNewsletters(
  publisherId: string,
  newsletterIds?: string[],
) {
  const all = await listNewsletters(publisherId);
  if (newsletterIds === undefined) return all;
  const selected = new Set(newsletterIds);
  if (newsletterIds.some((id) => !all.some((row) => row.workspaceId === id)))
    throw new NewsletterError("Newsletter is outside this publisher", 403);
  return all.filter((row) => selected.has(row.workspaceId));
}

export interface PublicationContactIdentity {
  newsletterId: string;
  userId: string;
}

export async function searchPublicationContacts({
  publisherId,
  newsletterIds,
  searchTerm = "",
  limit = 50,
  offset = 0,
}: {
  publisherId: string;
  newsletterIds?: string[];
  searchTerm?: string;
  limit?: number;
  offset?: number;
}) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new NewsletterError("Invalid contact pagination");
  const publications = await selectedNewsletters(publisherId, newsletterIds);
  if (!publications.length)
    return {
      contacts: [],
      contactCount: 0,
      subscriptionCount: 0,
      matchedMailboxCount: 0,
      limit,
      offset,
      countingNotice,
    };
  const ids = publications.map((row) => row.workspaceId);
  const [properties, groups, segments] = await Promise.all([
    db()
      .select()
      .from(userProperty)
      .where(inArray(userProperty.workspaceId, ids)),
    db()
      .select()
      .from(subscriptionGroup)
      .where(inArray(subscriptionGroup.workspaceId, ids)),
    db().select().from(segment).where(inArray(segment.workspaceId, ids)),
  ]);
  const emailIds = properties
    .filter((property) => property.name === "email")
    .map((property) => property.id);
  const mainSegmentIds = segments
    .filter(
      (item) =>
        item.subscriptionGroupId &&
        item.name ===
          getSubscriptionGroupSegmentName(item.subscriptionGroupId) &&
        publications.some(
          (publication) =>
            publication.workspaceId === item.workspaceId &&
            publication.subscriptionGroupId === item.subscriptionGroupId,
        ),
    )
    .map((item) => item.id);
  const optOutWorkspaceIds = publications
    .filter((publication) =>
      groups.some(
        (group) =>
          group.id === publication.subscriptionGroupId &&
          group.type === "OptOut",
      ),
    )
    .map((publication) => publication.workspaceId);
  const qb = new ClickHouseQueryBuilder();
  const idsParam = qb.addQueryValue(ids, "Array(String)");
  const emailParam = qb.addQueryValue(emailIds, "Array(String)");
  const segmentParam = qb.addQueryValue(mainSegmentIds, "Array(String)");
  const optOutParam = qb.addQueryValue(optOutWorkspaceIds, "Array(String)");
  const searchParam = qb.addQueryValue(searchTerm.trim(), "String");
  // Resolve each native property within (workspace,user), never collapse same user IDs or mailboxes across newsletters.
  const cte = `WITH latest AS (
    SELECT workspace_id, user_id, computed_property_id,
      argMax(user_property_value, assigned_at) AS property_value,
      argMax(segment_value, assigned_at) AS subscription_value
    FROM computed_property_assignments_v2
    WHERE workspace_id IN ${idsParam}
    GROUP BY workspace_id, user_id, computed_property_id
  ), contacts AS (
    SELECT workspace_id, user_id,
      maxIf(JSONExtractString(property_value), computed_property_id IN ${emailParam}) AS email,
      groupArrayIf(tuple(computed_property_id, property_value), property_value != '') AS properties,
      if(countIf(computed_property_id IN ${segmentParam}) = 0,
        workspace_id IN ${optOutParam}, maxIf(subscription_value, computed_property_id IN ${segmentParam})) AS subscribed
    FROM latest GROUP BY workspace_id, user_id
  ), matched AS (SELECT * FROM contacts WHERE ${searchParam} = ''
    OR positionCaseInsensitiveUTF8(email, ${searchParam}) > 0 OR positionCaseInsensitiveUTF8(user_id, ${searchParam}) > 0)`;
  const [countResult, pageResult] = await Promise.all([
    chQuery({
      query: `${cte} SELECT count() AS contactCount, countIf(subscribed) AS subscriptionCount, uniqExactIf(lowerUTF8(trimBoth(email)), email != '') AS matchedMailboxCount FROM matched`,
      query_params: qb.getQueries(),
    }),
    chQuery({
      query: `${cte} SELECT * FROM matched ORDER BY workspace_id, user_id LIMIT ${qb.addQueryValue(limit, "UInt32")} OFFSET ${qb.addQueryValue(offset, "UInt64")}`,
      query_params: qb.getQueries(),
    }),
  ]);
  const [counts] = await countResult.json<{
    contactCount: string;
    subscriptionCount: string;
    matchedMailboxCount: string;
  }>();
  const rows = await pageResult.json<{
    workspace_id: string;
    user_id: string;
    email: string;
    properties: [string, string][];
    subscribed: boolean | number;
  }>();
  const propertyById = new Map(
    properties.map((property) => [property.id, property]),
  );
  const contacts = rows.map((row) => ({
    newsletterId: row.workspace_id,
    userId: row.user_id,
    compositeId: JSON.stringify([row.workspace_id, row.user_id]),
    email: row.email || null,
    subscribed: Boolean(row.subscribed),
    properties: Object.fromEntries(
      row.properties.flatMap(([id, value]) => {
        const property = propertyById.get(id);
        if (!property || property.workspaceId !== row.workspace_id) return [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = value;
        }
        return [[id, { name: property.name, value: parsed }]];
      }),
    ),
  }));
  return {
    contacts,
    contactCount: Number(counts?.contactCount ?? 0),
    subscriptionCount: Number(counts?.subscriptionCount ?? 0),
    matchedMailboxCount: Number(counts?.matchedMailboxCount ?? 0),
    limit,
    offset,
    countingNotice,
  };
}

export async function operatePublicationContacts({
  publisherId,
  newsletterIds,
  contacts,
  userIds,
  operation,
  consent,
}: {
  publisherId: string;
  newsletterIds: string[];
  contacts?: PublicationContactIdentity[];
  userIds?: string[];
  operation: "subscribe" | "unsubscribe" | "delete";
  consent?: string;
}) {
  const publications = await selectedNewsletters(publisherId, newsletterIds);
  if (!["subscribe", "unsubscribe", "delete"].includes(operation))
    throw new NewsletterError("Invalid publication contact operation");
  if (contacts && userIds)
    throw new NewsletterError(
      "Supply composite contacts or single-newsletter user IDs, not both",
    );
  if (userIds && publications.length !== 1)
    throw new NewsletterError(
      "Cross-newsletter operations require explicit newsletter/contact identities",
    );
  const first = publications[0];
  const targets =
    contacts ??
    (first
      ? userIds?.map((userId) => ({ newsletterId: first.workspaceId, userId }))
      : undefined) ??
    [];
  if (!targets.length || targets.length > 1000)
    throw new NewsletterError("Select between 1 and 1000 explicit contacts");
  const publicationById = new Map(
    publications.map((publication) => [publication.workspaceId, publication]),
  );
  const unique = new Map<string, PublicationContactIdentity>();
  for (const target of targets) {
    if (!target.userId || !publicationById.has(target.newsletterId))
      throw new NewsletterError(
        "Contact is outside the selected newsletters",
        403,
      );
    unique.set(JSON.stringify([target.newsletterId, target.userId]), target);
  }
  // Validate all scopes and groups before doing any native operation.
  if (
    operation !== "delete" &&
    publications.some((publication) => !publication.subscriptionGroupId)
  )
    throw new NewsletterError(
      "Newsletter subscription provisioning is incomplete",
      409,
    );
  await Promise.all(
    publications.map(async (publication) => {
      const localIds = [...unique.values()]
        .filter((target) => target.newsletterId === publication.workspaceId)
        .map((target) => target.userId);
      if (!localIds.length) return;
      const result = await getUsers({
        workspaceId: publication.workspaceId,
        userIds: localIds,
        limit: localIds.length,
      });
      if (result.isErr()) throw result.error;
      const existing = new Set(result.value.users.map((user) => user.id));
      if (localIds.some((id) => !existing.has(id)))
        throw new NewsletterError(
          "Contact not found in the specified newsletter",
          404,
        );
    }),
  );
  await Promise.all(
    publications.map(async (publication) => {
      const localIds = [...unique.values()]
        .filter((target) => target.newsletterId === publication.workspaceId)
        .map((target) => target.userId);
      if (!localIds.length) return;
      if (operation === "delete") {
        await deleteUsers({
          workspaceId: publication.workspaceId,
          userIds: localIds,
        });
      } else {
        if (operation === "subscribe" && consent?.trim()) {
          await insertUserEvents({
            workspaceId: publication.workspaceId,
            userEvents: localIds.map((userId) => ({
              messageId: randomUUID(),
              messageRaw: {
                type: "track",
                event: "RoninPublicationSubscriptionConsent",
                userId,
                properties: {
                  consent: consent.trim(),
                  subscriptionGroupId: publication.subscriptionGroupId,
                },
              },
            })),
          });
        }
        await updateUserSubscriptions({
          workspaceId: publication.workspaceId,
          userUpdates: localIds.map((userId) => ({
            userId,
            changes: {
              [publication.subscriptionGroupId!]: operation === "subscribe",
            },
          })),
        });
      }
    }),
  );
  return {
    operation,
    affectedContactCount: unique.size,
    contacts: [...unique.values()],
    publisherSuppressionsChanged: false as const,
  };
}

export async function getPublisherOverview(publisherId: string) {
  const publications = await listNewsletters(publisherId);
  const [matching, deliveryRows] = await Promise.all([
    searchPublicationContacts({ publisherId, limit: 1 }),
    db()
      .select({
        workspaceId: newsletterSend.workspaceId,
        state: newsletterSend.state,
        count: sql<number>`count(*)::int`,
      })
      .from(newsletterSend)
      .where(eq(newsletterSend.publisherId, publisherId))
      .groupBy(newsletterSend.workspaceId, newsletterSend.state),
  ]);
  const newsletters = await Promise.all(
    publications.map(async (publication) => {
      const [contactResult, subscriptionResult] = await Promise.all([
        getUsersCount({ workspaceId: publication.workspaceId }),
        publication.subscriptionGroupId
          ? getUsersCount({
              workspaceId: publication.workspaceId,
              subscriptionGroupFilter: [publication.subscriptionGroupId],
            })
          : undefined,
      ]);
      if (contactResult.isErr()) throw contactResult.error;
      if (subscriptionResult?.isErr()) throw subscriptionResult.error;
      return {
        ...publication,
        contactCount: contactResult.value.userCount,
        subscriptionCount: subscriptionResult?.isOk()
          ? subscriptionResult.value.userCount
          : 0,
        deliveryHealth: Object.fromEntries(
          deliveryRows
            .filter((row) => row.workspaceId === publication.workspaceId)
            .map((row) => [row.state, row.count]),
        ),
      };
    }),
  );
  return {
    publisherId,
    newsletters,
    totals: {
      contactCount: newsletters.reduce((sum, row) => sum + row.contactCount, 0),
      subscriptionCount: newsletters.reduce(
        (sum, row) => sum + row.subscriptionCount,
        0,
      ),
      matchedMailboxCount: matching.matchedMailboxCount,
    },
    countingNotice,
  };
}
