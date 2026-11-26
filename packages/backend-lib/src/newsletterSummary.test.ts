import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { once } from "node:events";

import { installNewsletterSecretFixture } from "../test/newsletterSecretFixture";
import { submitBatch } from "./apps/batch";
import * as clickhouse from "./clickhouse";
import { db } from "./db";
import {
  newsletter,
  newsletterSend,
  sendingConnection,
} from "./db/publisherSchema";
import { workspace } from "./db/schema";
import { configureSendgridAccount } from "./newsletterInfrastructure";
import { getPublisherDeliverySummary } from "./newsletterReporting";
import { createNewsletter, createPublisher } from "./newsletters";
import { EventType, InternalEventType } from "./types";

let restoreSecret: () => void;
let workspaces: string[];
beforeEach(() => {
  restoreSecret = installNewsletterSecretFixture();
  workspaces = [];
});
afterEach(async () => {
  jest.restoreAllMocks();
  restoreSecret();
  if (workspaces.length)
    await db().delete(workspace).where(inArray(workspace.id, workspaces));
});

async function fixture() {
  const parent = await createPublisher({ name: `summary-${randomUUID()}` });
  workspaces.push(parent.id);
  const child = await createNewsletter({
    publisherId: parent.id,
    name: "Summary",
    slug: "summary",
  });
  workspaces.push(child.workspaceId);
  return { parent, child };
}

async function delivered(workspaceId: string) {
  await submitBatch(
    {
      workspaceId,
      data: {
        batch: [
          {
            type: EventType.Track,
            event: InternalEventType.EmailDelivered,
            messageId: randomUUID(),
            userId: "summary-reader",
            timestamp: new Date().toISOString(),
            properties: { newsletterSendId: randomUUID() },
          },
        ],
      },
    },
    { writeModeOverride: "ch-sync" },
  );
}

async function attempt(publisherId: string, workspaceId: string) {
  const account = await configureSendgridAccount({
    publisherId,
    name: "Summary account",
    provider: "SendGrid",
  });
  const [connection] = await db()
    .select()
    .from(sendingConnection)
    .where(eq(sendingConnection.accountId, account.id));
  if (!connection) throw new Error("Missing fixture connection");
  await db()
    .insert(newsletterSend)
    .values({
      publisherId,
      workspaceId,
      accountId: account.id,
      accountRevision: 1,
      connectionId: connection.id,
      connectionRevision: 1,
      selection: { accountId: account.id, mode: "automatic" },
      candidateIpIds: [],
      logicalMessageId: randomUUID(),
      userId: "summary-reader",
      mailboxHash: "summary-fixture",
      payloadHash: "summary-fixture",
      state: "unknown",
      createdAt: new Date(Date.now() - 3600_000),
    });
}

it("shares concurrent summaries and refreshes changed metrics when the short cache expires", async () => {
  const { parent, child } = await fixture();
  await delivered(child.workspaceId);
  const query = jest.spyOn(clickhouse, "query");
  const summaries = await Promise.all(
    Array.from({ length: 4 }, () => getPublisherDeliverySummary(parent.id)),
  );
  expect(summaries.map((item) => item.summary.delivered)).toEqual([1, 1, 1, 1]);
  expect(query).toHaveBeenCalledTimes(1);
  query.mockRestore();

  await delivered(child.workspaceId);
  const cached = await getPublisherDeliverySummary(parent.id);
  expect(cached.summary.delivered).toBe(1);
  expect(cached.periodEnd).toBe(summaries[0]!.periodEnd);
  const now = Date.now();
  jest.spyOn(Date, "now").mockReturnValue(now + 16_000);
  expect((await getPublisherDeliverySummary(parent.id)).summary.delivered).toBe(
    2,
  );
});

it("isolates workspace totals and rechecks newsletter ownership before serving cached data", async () => {
  const { parent, child } = await fixture();
  const other = await createPublisher({
    name: `other-summary-${randomUUID()}`,
  });
  workspaces.push(other.id);
  await delivered(child.workspaceId);
  expect((await getPublisherDeliverySummary(parent.id)).summary.delivered).toBe(
    1,
  );
  expect((await getPublisherDeliverySummary(other.id)).summary.delivered).toBe(
    0,
  );

  await db()
    .update(newsletter)
    .set({ publisherId: other.id })
    .where(eq(newsletter.workspaceId, child.workspaceId));
  expect((await getPublisherDeliverySummary(parent.id)).summary.delivered).toBe(
    0,
  );
  expect((await getPublisherDeliverySummary(other.id)).summary.delivered).toBe(
    1,
  );
  await db().delete(workspace).where(eq(workspace.id, parent.id));
  await expect(getPublisherDeliverySummary(parent.id)).rejects.toMatchObject({
    statusCode: 404,
  });
});

it("preserves known attempts without inventing delivery zeros or caching an analytics failure", async () => {
  const { parent, child } = await fixture();
  await attempt(parent.id, child.workspaceId);
  const query = jest
    .spyOn(clickhouse, "query")
    .mockRejectedValueOnce(new Error("unavailable"));
  const unavailable = await getPublisherDeliverySummary(parent.id);
  expect(unavailable.summary).toEqual({
    sends: 1,
    delivered: null,
    bounced: null,
    dropped: null,
    complaints: null,
    resolvedOutcomes: null,
    deliverabilityRate: null,
    observationsAvailable: false,
  });
  query.mockRestore();
  expect((await getPublisherDeliverySummary(parent.id)).summary).toEqual({
    sends: 1,
    delivered: 0,
    bounced: 0,
    dropped: 0,
    complaints: 0,
    resolvedOutcomes: 0,
    deliverabilityRate: null,
    observationsAvailable: true,
  });
});

it("aborts stalled analytics and returns unavailable observations with the known attempt count", async () => {
  const { parent, child } = await fixture();
  await attempt(parent.id, child.workspaceId);
  let signal: AbortSignal | undefined;
  jest.spyOn(clickhouse, "query").mockImplementationOnce(async (params) => {
    signal = params.abort_signal;
    if (!signal) throw new Error("Missing cancellation signal");
    await once(signal, "abort");
    throw new Error("aborted");
  });
  const result = await getPublisherDeliverySummary(parent.id);
  expect(signal?.aborted).toBe(true);
  expect(result.summary).toMatchObject({
    sends: 1,
    delivered: null,
    complaints: null,
    observationsAvailable: false,
  });
}, 15_000);
