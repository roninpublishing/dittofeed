import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { installNewsletterSecretFixture } from "../test/newsletterSecretFixture";

import { submitBatch } from "./apps/batch";
import { db } from "./db";
import { workspace } from "./db/schema";
import { getPublisherDeliveryHealth } from "./newsletterReporting";
import { createNewsletter, createPublisher } from "./newsletters";
import { BatchTrackData, EventType, InternalEventType } from "./types";

let restoreSecret: () => void;
beforeEach(() => { restoreSecret = installNewsletterSecretFixture(); });
afterEach(() => { restoreSecret(); });

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
