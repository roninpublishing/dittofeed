import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";

import { db } from "./db";
import { newsletter, publisher } from "./db/publisherSchema";
import {
  defaultEmailProvider,
  segment,
  subscriptionGroup,
  userProperty,
  workspace,
  workspaceMember,
  workspaceMemberRole,
} from "./db/schema";
import {
  adoptNewsletter,
  createNewsletter,
  createPublisher,
  getPublisherForWorkspace,
  getPublisherOverview,
  listNewsletters,
  NewsletterError,
  operatePublicationContacts,
  requireNewsletterAccess,
  requireNewsletterCampaignWorkspace,
  requirePublisherAccess,
  searchPublicationContacts,
  updateNewsletter,
} from "./newsletters";
import { getSegmentAssignmentDb } from "./segments";
import {
  getSubscriptionGroupSegmentName,
  updateUserSubscriptions,
} from "./subscriptionGroups";
import { insertUserEvents } from "./userEvents";
import { insertUserPropertyAssignments } from "./userProperties";

jest.mock("./bootstrap", () => ({ bootstrapComputeProperties: jest.fn() }));

// Keep native subscription/registry storage real; replace only external worker/event side effects.
jest.mock("./userEvents", () => ({
  ...jest.requireActual("./userEvents"),
  insertUserEvents: jest.fn().mockResolvedValue(undefined),
}));

it("converges concurrent newsletter creation onto one native subscription group", async () => {
  const parent = await createPublisher({ name: randomUUID() });
  const [first, second] = await Promise.all([
    createNewsletter({
      publisherId: parent.workspaceId,
      name: "Concurrent",
      slug: "concurrent",
    }),
    createNewsletter({
      publisherId: parent.workspaceId,
      name: "Concurrent",
      slug: "concurrent",
    }),
  ]);
  expect(first.workspaceId).toBe(second.workspaceId);
  expect(first.subscriptionGroupId).toBe(second.subscriptionGroupId);
  expect(
    await db()
      .select()
      .from(subscriptionGroup)
      .where(eq(subscriptionGroup.workspaceId, first.workspaceId)),
  ).toHaveLength(1);
});

async function seedContact(
  newsletterId: string,
  userId: string,
  email: string,
) {
  const properties = await db()
    .select()
    .from(userProperty)
    .where(eq(userProperty.workspaceId, newsletterId));
  const idProperty = properties.find((property) => property.name === "id");
  const emailProperty = properties.find(
    (property) => property.name === "email",
  );
  if (!idProperty || !emailProperty)
    throw new Error("Missing native contact properties");
  await insertUserPropertyAssignments([
    {
      workspaceId: newsletterId,
      userId,
      userPropertyId: idProperty.id,
      value: JSON.stringify(userId),
    },
    {
      workspaceId: newsletterId,
      userId,
      userPropertyId: emailProperty.id,
      value: JSON.stringify(email),
    },
  ]);
}

async function mainSubscriptionSegment(newsletterId: string, groupId: string) {
  const [row] = await db()
    .select()
    .from(segment)
    .where(
      and(
        eq(segment.workspaceId, newsletterId),
        eq(segment.name, getSubscriptionGroupSegmentName(groupId)),
      ),
    );
  if (!row) throw new Error("Missing native subscription segment");
  return row.id;
}

describe("publisher newsletters", () => {
  it("opts in explicitly, creates idempotent independent children, and provisions native builtins without provider fallback", async () => {
    const name = randomUUID();
    const parent = await createPublisher({ name });
    const retry = await createPublisher({ name });
    expect(retry.workspaceId).toBe(parent.workspaceId);
    const [legacyChild] = await db()
      .insert(workspace)
      .values({
        name: "Not opted in",
        type: "Child",
        parentWorkspaceId: parent.workspaceId,
      })
      .returning();
    if (!legacyChild) throw new Error("Missing legacy child");
    const first = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "First",
      slug: "first",
    });
    const second = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "Second",
      slug: "second",
    });
    expect(
      (
        await createNewsletter({
          publisherId: parent.workspaceId,
          name: "First",
          slug: "first",
        })
      ).workspaceId,
    ).toBe(first.workspaceId);
    expect(first.subscriptionGroupId).not.toBe(second.subscriptionGroupId);
    expect(
      (await listNewsletters(parent.workspaceId)).map((row) => row.workspaceId),
    ).toEqual([first.workspaceId, second.workspaceId]);
    expect(await getPublisherForWorkspace(legacyChild.id)).toBeNull();
    expect(
      await db()
        .select()
        .from(defaultEmailProvider)
        .where(eq(defaultEmailProvider.workspaceId, first.workspaceId)),
    ).toHaveLength(0);
    const builtins = await db()
      .select()
      .from(userProperty)
      .where(eq(userProperty.workspaceId, first.workspaceId));
    expect(builtins.map((property) => property.name)).toEqual(
      expect.arrayContaining(["id", "email", "last_clicked", "last_opened"]),
    );
    await updateNewsletter({
      publisherId: parent.workspaceId,
      newsletterId: first.workspaceId,
      status: "paused",
    });
    expect(
      (await listNewsletters(parent.workspaceId)).find(
        (row) => row.workspaceId === first.workspaceId,
      ),
    ).toMatchObject({ status: "paused", workspaceStatus: "Paused" });
    expect(
      (await listNewsletters(parent.workspaceId)).find(
        (row) => row.workspaceId === second.workspaceId,
      ),
    ).toMatchObject({ status: "draft", workspaceStatus: "Active" });
    await expect(
      requireNewsletterCampaignWorkspace(parent.workspaceId),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      requireNewsletterCampaignWorkspace(first.workspaceId),
    ).resolves.toBeUndefined();
  });

  it("does not silently adopt an unrelated same-name workspace as a publisher", async () => {
    const name = randomUUID();
    const [root] = await db().insert(workspace).values({ name }).returning();
    if (!root) throw new Error("Missing root");
    await expect(createPublisher({ name })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(
      await db()
        .select()
        .from(publisher)
        .where(eq(publisher.workspaceId, root.id)),
    ).toHaveLength(0);
    expect(
      (await createPublisher({ workspaceId: root.id, name })).workspaceId,
    ).toBe(root.id);
  });

  it("enforces publisher member management permissions and restores typed errors", async () => {
    const [member] = await db()
      .insert(workspaceMember)
      .values({ email: `${randomUUID()}@example.test` })
      .returning();
    if (!member) throw new Error("Missing member");
    const parent = await createPublisher({
      name: randomUUID(),
      memberId: member.id,
    });
    await createNewsletter({
      publisherId: parent.workspaceId,
      name: "Managed",
      slug: "managed",
      memberId: member.id,
    });
    await db()
      .update(workspaceMemberRole)
      .set({ role: "Viewer" })
      .where(
        and(
          eq(workspaceMemberRole.workspaceId, parent.workspaceId),
          eq(workspaceMemberRole.workspaceMemberId, member.id),
        ),
      );
    await expect(
      createNewsletter({
        publisherId: parent.workspaceId,
        name: "Denied",
        slug: "denied",
        memberId: member.id,
      }),
    ).rejects.toBeInstanceOf(NewsletterError);
    await expect(
      createNewsletter({
        publisherId: parent.workspaceId,
        name: "Denied",
        slug: "denied",
        memberId: member.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("denies child-to-parent, sibling and foreign-publisher escalation", async () => {
    const parent = await createPublisher({ name: randomUUID() });
    const foreign = await createPublisher({ name: randomUUID() });
    const first = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "First",
      slug: "first",
    });
    const second = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "Second",
      slug: "second",
    });
    await expect(
      requirePublisherAccess(first.workspaceId, parent.workspaceId),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      requireNewsletterAccess(first.workspaceId, second.workspaceId),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      requireNewsletterAccess(foreign.workspaceId, first.workspaceId),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      requireNewsletterAccess(parent.workspaceId, first.workspaceId),
    ).resolves.toBeUndefined();
    await expect(
      searchPublicationContacts({
        publisherId: foreign.workspaceId,
        newsletterIds: [first.workspaceId],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      updateNewsletter({
        publisherId: foreign.workspaceId,
        newsletterId: first.workspaceId,
        status: "active",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("adopts only an existing child explicitly, preserving its native subscription identity", async () => {
    const parent = await createPublisher({ name: randomUUID() });
    const foreign = await createPublisher({ name: randomUUID() });
    const [child] = await db()
      .insert(workspace)
      .values({
        name: "Existing publication",
        type: "Child",
        parentWorkspaceId: parent.workspaceId,
      })
      .returning();
    const [root] = await db()
      .insert(workspace)
      .values({ name: randomUUID() })
      .returning();
    if (!child || !root) throw new Error("Missing adoption fixture");
    const [group] = await db()
      .insert(subscriptionGroup)
      .values({
        workspaceId: child.id,
        name: "Existing permission",
        channel: "Email",
        type: "OptOut",
      })
      .returning();
    if (!group) throw new Error("Missing native group");
    expect(await listNewsletters(parent.workspaceId)).toHaveLength(0);
    const adopted = await adoptNewsletter({
      publisherId: parent.workspaceId,
      workspaceId: child.id,
      slug: "existing",
    });
    expect(adopted.subscriptionGroupId).toBe(group.id);
    expect(
      (
        await adoptNewsletter({
          publisherId: parent.workspaceId,
          workspaceId: child.id,
          slug: "existing",
        })
      ).workspaceId,
    ).toBe(child.id);
    await expect(
      adoptNewsletter({
        publisherId: foreign.workspaceId,
        workspaceId: child.id,
        slug: "stolen",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      adoptNewsletter({
        publisherId: parent.workspaceId,
        workspaceId: root.id,
        slug: "foreign-root",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await db().select().from(workspace).where(eq(workspace.id, root.id)))[0]
        ?.parentWorkspaceId,
    ).toBeNull();
    expect(
      await db()
        .select()
        .from(newsletter)
        .where(eq(newsletter.workspaceId, root.id)),
    ).toHaveLength(0);
  });

  it("counts local subscriptions and matched mailboxes, never treats duplicate mailbox records as unique people", async () => {
    const parent = await createPublisher({ name: randomUUID() });
    const first = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "First",
      slug: "first",
    });
    const second = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "Second",
      slug: "second",
    });
    await seedContact(
      first.workspaceId,
      "same-local-id",
      "Reader@example.test",
    );
    await seedContact(
      second.workspaceId,
      "same-local-id",
      "reader@example.test",
    );
    await seedContact(
      second.workspaceId,
      "another-local-id",
      "reader@example.test",
    );
    await updateUserSubscriptions({
      workspaceId: first.workspaceId,
      userUpdates: [
        {
          userId: "same-local-id",
          changes: { [first.subscriptionGroupId!]: true },
        },
      ],
    });
    await updateUserSubscriptions({
      workspaceId: second.workspaceId,
      userUpdates: [
        {
          userId: "same-local-id",
          changes: { [second.subscriptionGroupId!]: true },
        },
      ],
    });
    const result = await searchPublicationContacts({
      publisherId: parent.workspaceId,
      searchTerm: "reader@",
    });
    expect(result).toMatchObject({
      contactCount: 3,
      subscriptionCount: 2,
      matchedMailboxCount: 1,
    });
    expect(
      new Set(result.contacts.map((contact) => contact.compositeId)).size,
    ).toBe(3);
    expect(
      result.contacts.filter((contact) => contact.userId === "same-local-id"),
    ).toHaveLength(2);
    const overview = await getPublisherOverview(parent.workspaceId);
    expect(overview.totals).toEqual({
      contactCount: 3,
      subscriptionCount: 2,
      matchedMailboxCount: 1,
    });
    expect(overview.countingNotice).toContain("not unique people");
  });

  it("changes only explicitly selected native subscriptions, even when sibling IDs and mailboxes match", async () => {
    const parent = await createPublisher({ name: randomUUID() });
    const first = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "First",
      slug: "first",
    });
    const second = await createNewsletter({
      publisherId: parent.workspaceId,
      name: "Second",
      slug: "second",
    });
    await seedContact(
      first.workspaceId,
      "same-local-id",
      "reader@example.test",
    );
    await seedContact(
      second.workspaceId,
      "same-local-id",
      "reader@example.test",
    );
    const firstSegment = await mainSubscriptionSegment(
      first.workspaceId,
      first.subscriptionGroupId!,
    );
    const secondSegment = await mainSubscriptionSegment(
      second.workspaceId,
      second.subscriptionGroupId!,
    );
    await operatePublicationContacts({
      publisherId: parent.workspaceId,
      newsletterIds: [first.workspaceId, second.workspaceId],
      contacts: [{ newsletterId: first.workspaceId, userId: "same-local-id" }],
      operation: "subscribe",
      consent: "Explicit operator request",
    });
    expect(
      await getSegmentAssignmentDb({
        workspaceId: first.workspaceId,
        segmentId: firstSegment,
        userId: "same-local-id",
      }),
    ).toBe(true);
    expect(
      await getSegmentAssignmentDb({
        workspaceId: second.workspaceId,
        segmentId: secondSegment,
        userId: "same-local-id",
      }),
    ).toBeNull();
    await operatePublicationContacts({
      publisherId: parent.workspaceId,
      newsletterIds: [second.workspaceId],
      userIds: ["same-local-id"],
      operation: "subscribe",
    });
    await operatePublicationContacts({
      publisherId: parent.workspaceId,
      newsletterIds: [first.workspaceId],
      userIds: ["same-local-id"],
      operation: "unsubscribe",
    });
    expect(
      await getSegmentAssignmentDb({
        workspaceId: first.workspaceId,
        segmentId: firstSegment,
        userId: "same-local-id",
      }),
    ).toBe(false);
    expect(
      await getSegmentAssignmentDb({
        workspaceId: second.workspaceId,
        segmentId: secondSegment,
        userId: "same-local-id",
      }),
    ).toBe(true);
    expect(insertUserEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: first.workspaceId,
        userEvents: expect.arrayContaining([
          expect.objectContaining({
            messageRaw: expect.objectContaining({
              event: "RoninPublicationSubscriptionConsent",
            }),
          }),
        ]),
      }),
    );
    await expect(
      operatePublicationContacts({
        publisherId: parent.workspaceId,
        newsletterIds: [first.workspaceId, second.workspaceId],
        userIds: ["same-local-id"],
        operation: "unsubscribe",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      operatePublicationContacts({
        publisherId: parent.workspaceId,
        newsletterIds: [first.workspaceId],
        contacts: [
          { newsletterId: second.workspaceId, userId: "same-local-id" },
        ],
        operation: "unsubscribe",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      operatePublicationContacts({
        publisherId: parent.workspaceId,
        newsletterIds: [first.workspaceId],
        userIds: ["does-not-exist"],
        operation: "subscribe",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
