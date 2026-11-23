import { createHash, randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import config, { Config } from "./config";
import { db } from "./db";
import {
  newsletter,
  newsletterErasure,
  publicationAutomationAction,
  publicationAutomationEvent,
  publicationAutomationIdentity,
  publisher,
  publisherSuppression,
} from "./db/publisherSchema";
import { journey, workspace } from "./db/schema";
import { newsletterMailboxHash } from "./newsletterDelivery";
import {
  automationNativeId,
  PublicationAutomationDefinition,
} from "./publicationAutomationDefinition";
import {
  deletePublicationAutomationData,
  drainPublicationAutomations,
  enqueuePublicationAutomationEvents,
  listPublicationAutomationActions,
  upsertPublicationAutomation,
} from "./publicationAutomations";
import { encrypt } from "./secrets";
import {
  updateUserSubscriptions,
  upsertSubscriptionGroup,
} from "./subscriptionGroups";
import connectWorkflowClient from "./temporal/connectWorkflowClient";
import {
  ChannelType,
  EventType,
  InternalEventType,
  JourneyNodeType,
  SubscriptionGroupType,
} from "./types";
import { findUserEventsById, insertUserEvents } from "./userEvents";
import { createWorkspace } from "./workspaces";

jest.mock("./temporal/connectWorkflowClient", () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe("publication automation native actions", () => {
  let parentId: string;
  let sourceId: string;
  let destinationId: string;
  let groupId: string;
  let journeyId: string;
  let ruleId: string;
  let sourceUserId: string;
  let mailbox: string;
  let retargetedIds: string[];
  let previousWriteMode: Config["writeMode"];
  const startWorkflow = jest.fn().mockResolvedValue({});
  let definition: PublicationAutomationDefinition;

  beforeEach(async () => {
    previousWriteMode = config().writeMode;
    retargetedIds = [];
    config().writeMode = "ch-sync";
    startWorkflow.mockClear();
    jest
      .mocked(connectWorkflowClient)
      .mockResolvedValue({ start: startWorkflow } as never);
    parentId = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    sourceId = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    destinationId = (await createWorkspace({ name: randomUUID() }).then(unwrap))
      .id;
    await db().insert(publisher).values({ workspaceId: parentId });
    const group = await upsertSubscriptionGroup({
      workspaceId: destinationId,
      name: "Destination newsletter",
      channel: ChannelType.Email,
      type: SubscriptionGroupType.OptIn,
    }).then(unwrap);
    groupId = group.id;
    await db()
      .insert(newsletter)
      .values([
        {
          workspaceId: sourceId,
          publisherId: parentId,
          slug: "a",
          status: "active",
        },
        {
          workspaceId: destinationId,
          publisherId: parentId,
          slug: "b",
          subscriptionGroupId: groupId,
          status: "active",
        },
      ]);
    journeyId = randomUUID();
    await db()
      .insert(journey)
      .values({
        id: journeyId,
        workspaceId: destinationId,
        name: "Native welcome",
        status: "Running",
        definition: {
          entryNode: {
            type: JourneyNodeType.EventEntryNode,
            event: "BWelcome",
            child: JourneyNodeType.ExitNode,
          },
          nodes: [],
          exitNode: { type: JourneyNodeType.ExitNode },
        },
      });
    sourceUserId = `source-${randomUUID()}`;
    mailbox = `${randomUUID()}@example.com`;
    definition = {
      source: {
        eventType: "track",
        event: InternalEventType.EmailClicked,
        link: { path: "properties.url", equals: "https://b.example.com/join" },
      },
      destination: {
        match: { field: "email", source: "traits", path: "email" },
        createIfMissing: true,
        subscribe: true,
        welcomeJourneyId: journeyId,
        fieldMappings: [
          { source: "traits", path: "name", destination: "name" },
          {
            source: "event",
            path: "properties.offer",
            destination: "signup_offer",
          },
        ],
      },
    };
    const rule = await upsertPublicationAutomation({
      publisherId: parentId,
      name: "A click to B",
      sourceNewsletterId: sourceId,
      destinationNewsletterId: destinationId,
      enabled: true,
      definition,
    });
    if (!rule) throw new Error("Expected created rule");
    ruleId = rule.id;
    const identifyId = randomUUID();
    await insertUserEvents({
      workspaceId: sourceId,
      userEvents: [
        {
          messageId: identifyId,
          messageRaw: {
            type: EventType.Identify,
            userId: sourceUserId,
            messageId: identifyId,
            traits: {
              email: mailbox,
              name: "Source name",
              private_source_field: "not copied",
            },
          },
        },
      ],
    });
  });

  afterEach(async () => {
    config().writeMode = previousWriteMode;
    await db()
      .delete(workspace)
      .where(
        inArray(workspace.id, [
          sourceId,
          destinationId,
          ...retargetedIds,
          parentId,
        ]),
      );
  });

  async function click(extra: Record<string, unknown> = {}, id = randomUUID()) {
    const event = {
      messageId: id,
      messageRaw: {
        type: EventType.Track,
        userId: sourceUserId,
        messageId: id,
        event: InternalEventType.EmailClicked,
        properties: {
          url: "https://b.example.com/join",
          offer: "blue",
          ...extra,
        },
      },
    };
    await insertUserEvents({ workspaceId: sourceId, userEvents: [event] });
    return event;
  }

  async function actionRows() {
    return db()
      .select()
      .from(publicationAutomationAction)
      .where(eq(publicationAutomationAction.ruleId, ruleId));
  }

  it("creates a distinct B subscriber, maps isolated fields, subscribes and starts the native welcome once", async () => {
    const event = await click();
    await Promise.all([
      drainPublicationAutomations(),
      drainPublicationAutomations(),
    ]);
    const [action] = await actionRows();
    expect(action?.disposition).toBe("completed");
    expect(action?.destinationUserId).not.toBe(sourceUserId);
    expect(action?.destinationUserId).toBeTruthy();
    if (!action?.destinationUserId)
      throw new Error("Expected native destination subscriber");
    const native = await findUserEventsById({
      workspaceId: destinationId,
      messageIds: [
        automationNativeId(action.id, "identify"),
        automationNativeId(action.id, "subscribe"),
        automationNativeId(action.id, "welcome"),
      ],
    });
    expect(
      native.filter(
        (row) => row.event === InternalEventType.SubscriptionChange,
      ),
    ).toHaveLength(1);
    const identity = native.find(
      (row) => row.event_type === EventType.Identify,
    );
    expect(JSON.parse(identity?.traits ?? "{}")).toEqual({
      email: mailbox,
      name: "Source name",
      signup_offer: "blue",
    });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow.mock.calls[0]?.[1].workflowId).toBe(
      action.state.workflowId,
    );
    await insertUserEvents({ workspaceId: sourceId, userEvents: [event] });
    await click({ offer: "red" });
    await drainPublicationAutomations();
    expect(await actionRows()).toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(
      await db()
        .select()
        .from(publicationAutomationIdentity)
        .where(eq(publicationAutomationIdentity.newsletterId, destinationId)),
    ).toHaveLength(1);
    const history = await listPublicationAutomationActions({
      publisherId: parentId,
    });
    expect(history[0]?.state.encryptedPlan).toBeUndefined();
  });

  it("requires exact native source persistence even when durable source intent exists", async () => {
    const messageId = randomUUID();
    const event = {
      messageId,
      messageRaw: {
        type: EventType.Track,
        userId: sourceUserId,
        messageId,
        event: InternalEventType.EmailClicked,
        properties: { url: "https://b.example.com/join" },
      },
    };
    await enqueuePublicationAutomationEvents({
      workspaceId: sourceId,
      userEvents: [event],
    });
    await drainPublicationAutomations();
    expect(await actionRows()).toHaveLength(0);
    await insertUserEvents({ workspaceId: sourceId, userEvents: [event] });
    await db()
      .update(publicationAutomationEvent)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(publicationAutomationEvent.sourceNewsletterId, sourceId),
          eq(publicationAutomationEvent.eventId, messageId),
        ),
      );
    await drainPublicationAutomations();
    expect((await actionRows())[0]?.disposition).toBe("completed");
  });

  it("recovers welcome failure without creating a second contact or subscription event", async () => {
    startWorkflow.mockRejectedValueOnce(new Error("Temporal unavailable"));
    const event = await click();
    await drainPublicationAutomations();
    const [failed] = await actionRows();
    expect(failed?.disposition).toBe("error");
    if (!failed) throw new Error("Expected durable failed action");
    // Simulate a crash after native writes but before their completion flags commit.
    await db()
      .update(publicationAutomationAction)
      .set({
        state: {
          ...failed.state,
          profileCompleted: false,
          subscriptionCompleted: false,
          subscriptionStarted: true,
        },
      })
      .where(eq(publicationAutomationAction.id, failed.id));
    expect(failed?.state.subscriptionCompleted).toBe(true);
    await db()
      .update(publicationAutomationEvent)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(publicationAutomationEvent.sourceNewsletterId, sourceId),
          eq(publicationAutomationEvent.eventId, event.messageId),
        ),
      );
    await drainPublicationAutomations();
    const [completed] = await actionRows();
    expect(completed?.disposition).toBe("completed");
    expect(completed?.destinationUserId).toBe(failed?.destinationUserId);
    expect(startWorkflow).toHaveBeenCalledTimes(2);
    const subscriptions = await findUserEventsById({
      workspaceId: destinationId,
      messageIds: [automationNativeId(completed!.id, "subscribe")],
    });
    expect(subscriptions).toHaveLength(1);
  });

  it("preserves a destination profile and unsubscribe instead of silently opting it in", async () => {
    const destinationUserId = randomUUID();
    await insertUserEvents({
      workspaceId: destinationId,
      userEvents: [
        {
          messageId: randomUUID(),
          messageRaw: {
            type: EventType.Identify,
            userId: destinationUserId,
            traits: { email: mailbox, name: "Destination name" },
          },
        },
      ],
    });
    await updateUserSubscriptions({
      workspaceId: destinationId,
      userUpdates: [
        { userId: destinationUserId, changes: { [groupId]: false } },
      ],
    });
    await click();
    await drainPublicationAutomations();
    const [action] = await actionRows();
    expect(action?.destinationUserId).toBe(destinationUserId);
    expect(action?.disposition).toBe("blocked");
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(
      await findUserEventsById({
        workspaceId: destinationId,
        messageIds: [
          automationNativeId(action!.id, "identify"),
          automationNativeId(action!.id, "subscribe"),
        ],
      }),
    ).toHaveLength(0);
  });

  it("records explicit consent for legitimate local resubscription but never overrides publisher suppression", async () => {
    definition.consent = {
      type: "explicit",
      source: "event",
      path: "properties.subscribeB",
      equals: true,
      authorization: "User explicitly requested newsletter B",
      allowResubscribe: true,
    };
    await upsertPublicationAutomation({
      publisherId: parentId,
      id: ruleId,
      name: "Consented A to B",
      sourceNewsletterId: sourceId,
      destinationNewsletterId: destinationId,
      enabled: true,
      definition,
    });
    await db()
      .insert(publisherSuppression)
      .values({
        publisherId: parentId,
        mailboxHash: newsletterMailboxHash(mailbox),
        encryptedMailbox: encrypt(mailbox),
        reason: "manual",
        active: true,
      });
    await click({ subscribeB: true });
    await drainPublicationAutomations();
    expect((await actionRows())[0]?.disposition).toBe("blocked");
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(
      await db()
        .select()
        .from(publicationAutomationIdentity)
        .where(eq(publicationAutomationIdentity.newsletterId, destinationId)),
    ).toHaveLength(0);
  });

  it("allows explicitly authorized newsletter resubscription and records the source consent", async () => {
    const destinationUserId = randomUUID();
    await insertUserEvents({
      workspaceId: destinationId,
      userEvents: [
        {
          messageId: randomUUID(),
          messageRaw: {
            type: EventType.Identify,
            userId: destinationUserId,
            traits: { email: mailbox, name: "Local name" },
          },
        },
      ],
    });
    await updateUserSubscriptions({
      workspaceId: destinationId,
      userUpdates: [
        { userId: destinationUserId, changes: { [groupId]: false } },
      ],
    });
    definition.consent = {
      type: "explicit",
      source: "event",
      path: "properties.subscribeB",
      equals: true,
      authorization: "User explicitly requested newsletter B",
      allowResubscribe: true,
    };
    await upsertPublicationAutomation({
      publisherId: parentId,
      id: ruleId,
      name: "Consented A to B",
      sourceNewsletterId: sourceId,
      destinationNewsletterId: destinationId,
      enabled: true,
      definition,
    });
    const event = await click({ subscribeB: true });
    await drainPublicationAutomations();
    const [action] = await actionRows();
    expect(action?.disposition).toBe("completed");
    expect(action?.destinationUserId).toBe(destinationUserId);
    expect(action?.state.consent).toEqual({
      authorization: "User explicitly requested newsletter B",
      sourceEventId: event.messageId,
      allowResubscribe: true,
    });
    const identify = await findUserEventsById({
      workspaceId: destinationId,
      messageIds: [automationNativeId(action!.id, "identify")],
    });
    expect(JSON.parse(identify[0]?.traits ?? "{}")).toEqual({
      signup_offer: "blue",
    });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("erases automation snapshots and retains a mailbox tombstone against later recreation", async () => {
    await click();
    await drainPublicationAutomations();
    const [completed] = await actionRows();
    const destinationUserId = completed?.destinationUserId;
    if (!destinationUserId) throw new Error("Expected destination subscriber");
    const userHash = createHash("sha256")
      .update(JSON.stringify([destinationId, destinationUserId]))
      .digest("hex");
    await db()
      .insert(newsletterErasure)
      .values({ workspaceId: destinationId, userHash });
    await deletePublicationAutomationData({
      workspaceId: destinationId,
      userIds: [destinationUserId],
    });
    const [erased] = await actionRows();
    expect(erased?.state).toEqual({ erased: true });
    expect(erased?.destinationUserId).toBe(`erased:${userHash}`);
    expect(
      await db()
        .select()
        .from(publicationAutomationEvent)
        .where(
          eq(publicationAutomationEvent.sourceNewsletterId, destinationId),
        ),
    ).toHaveLength(0);
    sourceUserId = `another-source-${randomUUID()}`;
    const messageId = randomUUID();
    await insertUserEvents({
      workspaceId: sourceId,
      userEvents: [
        {
          messageId,
          messageRaw: {
            type: EventType.Identify,
            userId: sourceUserId,
            traits: { email: mailbox },
          },
        },
      ],
    });
    await click();
    await drainPublicationAutomations();
    const rows = await actionRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.disposition === "blocked")).toBe(true);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "destination"] as const)(
    "erases pinned %s identities and encrypted plans after a rule is retargeted",
    async (side) => {
      const event = await click();
      await drainPublicationAutomations();
      const [completed] = await actionRows();
      if (!completed?.destinationUserId)
        throw new Error("Expected destination subscriber");
      expect(completed.state.encryptedPlan).toBeTruthy();
      const originalDestinationUserId = completed.destinationUserId;
      retargetedIds = await Promise.all(
        ["c", "d"].map(async () =>
          (await createWorkspace({ name: randomUUID() }).then(unwrap)).id,
        ),
      );
      await db().insert(newsletter).values(
        retargetedIds.map((workspaceId, index) => ({
          workspaceId,
          publisherId: parentId,
          slug: `retargeted-${index}`,
          status: "active" as const,
        })),
      );
      await upsertPublicationAutomation({
        id: ruleId,
        publisherId: parentId,
        name: "C click to D",
        sourceNewsletterId: retargetedIds[0]!,
        destinationNewsletterId: retargetedIds[1]!,
        enabled: true,
        definition: {
          ...definition,
          destination: {
            ...definition.destination,
            subscribe: false,
            welcomeJourneyId: undefined,
          },
        },
      });

      const workspaceId = side === "source" ? sourceId : destinationId;
      const userId =
        side === "source" ? sourceUserId : originalDestinationUserId;
      const userHash = createHash("sha256")
        .update(JSON.stringify([workspaceId, userId]))
        .digest("hex");
      await db().insert(newsletterErasure).values({ workspaceId, userHash });
      await deletePublicationAutomationData({
        workspaceId,
        userIds: [userId],
      });

      const [erased] = await actionRows();
      expect(erased).toMatchObject({
        id: completed.id,
        sourceUserId: `erased:${createHash("sha256")
          .update(JSON.stringify([sourceId, sourceUserId]))
          .digest("hex")}`,
        destinationUserId: `erased:${createHash("sha256")
          .update(JSON.stringify([destinationId, originalDestinationUserId]))
          .digest("hex")}`,
        sourceEventId: createHash("sha256")
          .update(event.messageId)
          .digest("hex"),
        state: { erased: true },
        disposition: "blocked",
        error: "Subscriber data erased",
      });
      expect(erased?.state).toEqual({ erased: true });

      // Restoring the old route and replaying its native event cannot recreate it.
      await upsertPublicationAutomation({
        id: ruleId,
        publisherId: parentId,
        name: "A click to B again",
        sourceNewsletterId: sourceId,
        destinationNewsletterId: destinationId,
        enabled: true,
        definition,
      });
      await insertUserEvents({ workspaceId: sourceId, userEvents: [event] });
      await drainPublicationAutomations();
      expect(await actionRows()).toEqual([erased]);
      expect(startWorkflow).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects cross-publisher rules and stops repeated rules in event lineage", async () => {
    await expect(
      upsertPublicationAutomation({
        publisherId: randomUUID(),
        name: "Escalation",
        sourceNewsletterId: sourceId,
        destinationNewsletterId: destinationId,
        enabled: true,
        definition,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const messageId = randomUUID();
    await insertUserEvents({
      workspaceId: sourceId,
      userEvents: [
        {
          messageId,
          messageRaw: {
            type: EventType.Track,
            userId: sourceUserId,
            messageId,
            event: InternalEventType.EmailClicked,
            properties: { url: "https://b.example.com/join" },
            context: { publicationAutomation: { lineage: [ruleId] } },
          },
        },
      ],
    });
    await drainPublicationAutomations();
    expect(await actionRows()).toHaveLength(0);
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});
