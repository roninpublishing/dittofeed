import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";

import { installNewsletterSecretFixture } from "../test/newsletterSecretFixture";
import { submitBatch } from "./apps/batch";
import * as clickhouse from "./clickhouse";
import { db } from "./db";
import { newsletterSend, sendingConnection } from "./db/publisherSchema";
import { workspace } from "./db/schema";
import { configureSendgridAccount } from "./newsletterInfrastructure";
import { getPublisherDeliveryHealth } from "./newsletterReporting";
import { createNewsletter, createPublisher } from "./newsletters";
import { BatchTrackData, EventType, InternalEventType } from "./types";

let restoreSecret: () => void;
beforeEach(() => {
  restoreSecret = installNewsletterSecretFixture();
});
afterEach(() => {
  restoreSecret();
});

it("deduplicates observations, isolates publishers, and never guesses historical IP attribution", async () => {
  const first = await createPublisher({ name: `report-${randomUUID()}` });
  const other = await createPublisher({ name: `other-report-${randomUUID()}` });
  const a = await createNewsletter({
    publisherId: first.id,
    name: "A",
    slug: "a",
  });
  const b = await createNewsletter({
    publisherId: other.id,
    name: "B",
    slug: "b",
  });
  try {
    const eventId = randomUUID();
    const oldIpId = randomUUID();
    const timestamp = new Date().toISOString();
    const delivery: BatchTrackData = {
      type: EventType.Track,
      event: InternalEventType.EmailDelivered,
      messageId: eventId,
      userId: "same-local-id",
      timestamp,
      properties: { messageId: "send-one", sendingIpId: oldIpId },
    };
    await submitBatch(
      {
        workspaceId: a.workspaceId,
        data: {
          batch: [
            delivery,
            delivery,
            {
              ...delivery,
              messageId: randomUUID(),
              properties: { messageId: "legacy-send" },
            },
          ],
        },
      },
      { writeModeOverride: "ch-sync" },
    );
    await submitBatch(
      {
        workspaceId: b.workspaceId,
        data: { batch: [{ ...delivery, messageId: randomUUID() }] },
      },
      { writeModeOverride: "ch-sync" },
    );
    const report = await getPublisherDeliveryHealth(first.id);
    const attributed = report.observations.find(
      (item) => item.ipId === oldIpId,
    );
    expect(attributed).toMatchObject({
      newsletterId: a.workspaceId,
      event: InternalEventType.EmailDelivered,
      sendsWithEvent: 1,
      observedEventCount: 1,
    });
    expect(
      report.observations.find((item) => item.ipId === null),
    ).toMatchObject({
      newsletterId: a.workspaceId,
      sendsWithEvent: 1,
      observedEventCount: 1,
    });
    expect(
      report.observations.some((item) => item.newsletterId === b.workspaceId),
    ).toBe(false);
    expect(report.summary).toMatchObject({
      sends: 0,
      delivered: 2,
      resolvedOutcomes: 2,
      deliverabilityRate: 100,
    });
    expect(report.domains).toEqual([
      expect.objectContaining({ accountId: null, senderDomain: null, delivered: 2 }),
    ]);
  } finally {
    await db()
      .delete(workspace)
      .where(
        inArray(workspace.id, [
          a.workspaceId,
          b.workspaceId,
          first.id,
          other.id,
        ]),
      );
  }
});

it("resolves event-time terminal outcomes once per native send without changing historical IP or complaint observations", async () => {
  const parent = await createPublisher({
    name: `resolved-report-${randomUUID()}`,
  });
  const child = await createNewsletter({
    publisherId: parent.id,
    name: "Resolved",
    slug: "resolved",
  });
  try {
    const first = await configureSendgridAccount({
      publisherId: parent.id,
      name: "First",
      provider: "SendGrid",
    });
    const second = await configureSendgridAccount({
      publisherId: parent.id,
      name: "Second",
      provider: "SendGrid",
    });
    const empty = await configureSendgridAccount({
      publisherId: parent.id,
      name: "Empty",
      provider: "SendGrid",
    });
    const connections = await db().select().from(sendingConnection)
      .where(inArray(sendingConnection.accountId, [first.id, second.id]));
    await db().insert(newsletterSend).values([
      { accountId: first.id, senderDomain: "primary.example.test" },
      { accountId: first.id, senderDomain: "secondary.example.test" },
      { accountId: first.id, senderDomain: null },
      { accountId: second.id, senderDomain: "primary.example.test" },
    ].map((cohort) => ({
      ...cohort,
      publisherId: parent.id,
      workspaceId: child.workspaceId,
      accountRevision: 1,
      connectionId: connections.find((item) => item.accountId === cohort.accountId)!.id,
      connectionRevision: 1,
      selection: { accountId: cohort.accountId, mode: "automatic" as const },
      candidateIpIds: [],
      logicalMessageId: randomUUID(),
      userId: "reader",
      mailboxHash: "synthetic-report-fixture",
      payloadHash: "synthetic-report-fixture",
    })));
    const oldIp = randomUUID();
    const recentIp = randomUUID();
    const now = Date.now();
    const day = 86400_000;
    const delivered = InternalEventType.EmailDelivered;
    const bounced = InternalEventType.EmailBounced;
    const dropped = InternalEventType.EmailDropped;
    const spam = InternalEventType.EmailMarkedSpam;
    const fixture = (
      send: string,
      event: InternalEventType,
      ageDays: number,
      properties: Record<string, string> = {},
      userId = "reader",
    ): BatchTrackData => ({
      type: EventType.Track,
      event,
      userId,
      messageId: randomUUID(),
      timestamp: new Date(now - ageDays * day).toISOString(),
      properties: {
        newsletterSendId: send,
        messageId: `logical-${send}`,
        sendingAccountId: first.id,
        sendingIpId: oldIp,
        senderDomain: "primary.example.test",
        ...properties,
      },
    });
    const retried = fixture("bounced-last", delivered, 5);
    const batch = [
      retried,
      retried,
      fixture("bounced-last", delivered, 5), // A second receipt is still the same native send.
      fixture("bounced-last", bounced, 1, { sendingIpId: recentIp }),
      fixture("bounced-last", spam, 0.5),
      fixture("bounced-last", spam, 0.4, { messageId: "another-logical-id" }),
      fixture("delivered-last", bounced, 5),
      fixture("delivered-last", delivered, 1, { senderDomain: " SECONDARY.EXAMPLE.TEST. " }),
      fixture("dropped-last", delivered, 5),
      fixture("dropped-last", dropped, 1),
      fixture("tied", delivered, 1),
      fixture("tied", bounced, 1),
      fixture("tied", dropped, 1),
      fixture("complaint-only", spam, 1),
      fixture("no-account", delivered, 1, { sendingAccountId: "" }),
      fixture("", delivered, 1, { newsletterSendId: "", messageId: "" }),
      fixture("", delivered, 1, { newsletterSendId: "", messageId: "" }),
      fixture("outside-window", delivered, 40),
      fixture("old-bounce", bounced, 40),
      fixture("old-bounce", delivered, 1),
      fixture("accepted-only", InternalEventType.MessageSent, 1),
      fixture("no-ip", delivered, 1, { sendingIpId: "" }),
      fixture("native-identity", delivered, 1),
      fixture(
        "native-identity",
        delivered,
        1,
        { messageId: "changed-logical-id" },
        "changed-reader",
      ),
      fixture("lost-attribution", delivered, 5),
      fixture("lost-attribution", bounced, 1, { sendingAccountId: "", senderDomain: "" }),
      fixture("changed-account", bounced, 5),
      fixture("changed-account", delivered, 1, { sendingAccountId: second.id }),
      fixture(
        "",
        delivered,
        1,
        { newsletterSendId: "", messageId: "legacy-logical" },
        "legacy-reader-one",
      ),
      fixture(
        "",
        delivered,
        1,
        { newsletterSendId: "", messageId: "legacy-logical" },
        "legacy-reader-two",
      ),
    ];
    await submitBatch(
      { workspaceId: child.workspaceId, data: { batch } },
      { writeModeOverride: "ch-sync" },
    );
    const report = await getPublisherDeliveryHealth(parent.id);
    expect(report.observationsAvailable).toBe(true);
    expect(report.accounts).toEqual(
      expect.arrayContaining([
        {
          accountId: first.id,
          sends: 3,
          delivered: 6,
          bounced: 1,
          dropped: 2,
          resolvedOutcomes: 9,
          deliverabilityRate: (100 * 6) / 9,
          complaints: 2,
          observationsAvailable: true,
        },
        {
          accountId: second.id,
          sends: 1,
          delivered: 1,
          bounced: 0,
          dropped: 0,
          resolvedOutcomes: 1,
          deliverabilityRate: 100,
          complaints: 0,
          observationsAvailable: true,
        },
        {
          accountId: empty.id,
          sends: 0,
          delivered: 0,
          bounced: 0,
          dropped: 0,
          resolvedOutcomes: 0,
          deliverabilityRate: null,
          complaints: 0,
          observationsAvailable: true,
        },
      ]),
    );
    expect(report.summary).toMatchObject({
      sends: 4,
      delivered: 8,
      bounced: 2,
      dropped: 2,
      resolvedOutcomes: 12,
      deliverabilityRate: (100 * 8) / 12,
      complaints: 2,
    });
    expect(report.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: first.id, senderDomain: "secondary.example.test",
        delivered: 1, bounced: 0, dropped: 0, deliverabilityRate: 100,
      }),
      expect.objectContaining({
        accountId: first.id, senderDomain: "primary.example.test",
        delivered: 5, bounced: 1, dropped: 2, deliverabilityRate: (100 * 5) / 8,
      }),
      expect.objectContaining({
        accountId: second.id, senderDomain: "primary.example.test",
        delivered: 1, bounced: 0, dropped: 0, deliverabilityRate: 100,
      }),
      expect.objectContaining({
        accountId: null, senderDomain: null,
        delivered: 1, bounced: 1, dropped: 0, deliverabilityRate: 50,
      }),
      expect.objectContaining({
        accountId: first.id, senderDomain: null, sends: 1,
        delivered: 0, resolvedOutcomes: 0, deliverabilityRate: null,
      }),
    ]));
    expect(
      report.observations.find(
        (item) =>
          item.accountId === first.id &&
          item.ipId === oldIp &&
          item.event === delivered,
      ),
    ).toMatchObject({
      accountId: first.id,
      sendsWithEvent: 11,
      observedEventCount: 13,
    });
    expect(
      report.observations.find(
        (item) => item.ipId === recentIp && item.event === bounced,
      ),
    ).toMatchObject({
      accountId: first.id,
      sendsWithEvent: 1,
      observedEventCount: 1,
    });
    expect(
      report.observations.find(
        (item) => item.ipId === null && item.event === delivered,
      ),
    ).toMatchObject({
      accountId: first.id,
      sendsWithEvent: 1,
      observedEventCount: 1,
    });
    const scoped = await getPublisherDeliveryHealth(parent.id, first.id);
    expect(scoped.accounts).toEqual(
      report.accounts.filter((item) => item.accountId === first.id),
    );
    expect(scoped.summary).toEqual(expect.objectContaining({
      delivered: 6, bounced: 1, dropped: 2, resolvedOutcomes: 9,
      deliverabilityRate: (100 * 6) / 9,
    }));
    expect(scoped.domains.every((item) => item.accountId === first.id)).toBe(true);

    const failure = jest.spyOn(clickhouse, "query").mockRejectedValueOnce(new Error("unavailable"));
    try {
      const unavailable = await getPublisherDeliveryHealth(parent.id);
      expect(unavailable.observationsAvailable).toBe(false);
      expect(unavailable.summary).toMatchObject({
        sends: 4, delivered: null, bounced: null, dropped: null,
        complaints: null, resolvedOutcomes: null, deliverabilityRate: null,
      });
      expect(unavailable.accounts.every((item) => item.delivered === null)).toBe(true);
    } finally {
      failure.mockRestore();
    }
  } finally {
    await db()
      .delete(workspace)
      .where(inArray(workspace.id, [child.workspaceId, parent.id]));
  }
});

it("reports a known empty workspace without inventing a delivery rate", async () => {
  const parent = await createPublisher({ name: `empty-report-${randomUUID()}` });
  try {
    const report = await getPublisherDeliveryHealth(parent.id);
    expect(report.summary).toMatchObject({
      sends: 0, delivered: 0, bounced: 0, dropped: 0,
      resolvedOutcomes: 0, complaints: 0, deliverabilityRate: null,
      observationsAvailable: true,
    });
    expect(report.domains).toEqual([]);
  } finally {
    await db().delete(workspace).where(inArray(workspace.id, [parent.id]));
  }
});
