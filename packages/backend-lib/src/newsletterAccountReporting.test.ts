import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { installNewsletterSecretFixture } from "../test/newsletterSecretFixture";

import { query as chQuery } from "./clickhouse";
import { db } from "./db";
import { newsletter, newsletterSend, publisher } from "./db/publisherSchema";
import { workspace } from "./db/schema";
import { configureSendgridAccount, upsertSendingIp } from "./newsletterInfrastructure";
import { getPublisherDeliveryHealth } from "./newsletterReporting";
import { InternalEventType } from "./types";

jest.mock("./clickhouse", () => ({
  ...jest.requireActual("./clickhouse"), query: jest.fn(),
}));

describe("account delivery summaries from durable records and resolved observations", () => {
  let publisherId: string;
  let newsletterId: string;
  let restoreSecret: () => void;

  beforeEach(async () => {
    restoreSecret = installNewsletterSecretFixture();
    jest.clearAllMocks();
    const [parent] = await db().insert(workspace).values({ name: "Account reporting", type: "Parent" }).returning();
    publisherId = parent!.id;
    await db().insert(publisher).values({ workspaceId: publisherId });
    const [child] = await db().insert(workspace).values({ name: "Reporting newsletter", type: "Child", parentWorkspaceId: publisherId }).returning();
    newsletterId = child!.id;
    await db().insert(newsletter).values({ publisherId, workspaceId: newsletterId, slug: "reporting" });
  });
  afterEach(async () => {
    await db().delete(workspace).where(eq(workspace.id, newsletterId));
    await db().delete(workspace).where(eq(workspace.id, publisherId));
    restoreSecret();
  });

  async function account(name: string, address: string) {
    const configured = await configureSendgridAccount({ publisherId, name, provider: "SendGrid" });
    const ip = await upsertSendingIp({ publisherId, accountId: configured.id, address, status: "active", hourlyLimit: 100, dailyLimit: 1000 });
    return { ...configured, ip };
  }
  async function record(accountId: string, connectionId: string, ipId: string, ageDays = 0) {
    await db().insert(newsletterSend).values({
      publisherId, workspaceId: newsletterId, accountId, accountRevision: 1,
      connectionId, connectionRevision: 1, selection: { accountId, mode: "automatic" }, candidateIpIds: [ipId],
      logicalMessageId: randomUUID(), userId: "fixture-reader", mailboxHash: "fixture-hash", payloadHash: "fixture-payload",
      state: "queued", createdAt: new Date(Date.now() - ageDays * 86400_000),
    });
  }
  function observed(accountId: string, event: string, sends: number, accountSummary = 1, ipId = "") {
    return { accountId, event, sendsWithEvent: String(sends), observedEventCount: String(sends), accountSummary, newsletterId, ipId };
  }

  it("returns independent 30-day SQL record counts and deduplicated observed outcomes without assigning legacy history", async () => {
    const first = await account("First", "192.0.2.41");
    const second = await account("Second", "192.0.2.42");
    await record(first.id, first.connectionId!, first.ip.id);
    await record(first.id, first.connectionId!, first.ip.id);
    await record(first.id, first.connectionId!, first.ip.id, 40);
    await record(second.id, second.connectionId!, second.ip.id);
    const rows = [
      observed(first.id, InternalEventType.EmailDelivered, 2, 0, first.ip.id),
      observed(first.id, InternalEventType.EmailDelivered, 2, 0, randomUUID()),
      observed(first.id, InternalEventType.EmailDelivered, 3),
      observed(first.id, InternalEventType.EmailMarkedSpam, 1),
      observed(first.id, InternalEventType.EmailBounced, 1),
      observed(first.id, InternalEventType.EmailDropped, 2),
      observed(second.id, InternalEventType.EmailBounced, 1),
      observed("", InternalEventType.EmailDelivered, 9),
      observed(randomUUID(), InternalEventType.EmailDelivered, 100),
    ];
    (chQuery as jest.Mock).mockResolvedValue({ json: async () => rows });
    const report = await getPublisherDeliveryHealth(publisherId);
    expect(report.accounts).toEqual(expect.arrayContaining([
      { accountId: first.id, sends: 2, delivered: 3, bounced: 1, dropped: 2, resolvedOutcomes: 6, deliverabilityRate: 50, complaints: 1, observationsAvailable: true },
      { accountId: second.id, sends: 1, delivered: 0, bounced: 1, dropped: 0, resolvedOutcomes: 1, deliverabilityRate: 0, complaints: 0, observationsAvailable: true },
    ]));
    expect(report.accounts).toHaveLength(2);
    expect(report.observations).toHaveLength(2);
    expect(report.observationsAvailable).toBe(true);
    expect(chQuery).toHaveBeenCalledTimes(1);
    expect(jest.mocked(chQuery).mock.calls[0]![0]).toMatchObject({
      query: expect.stringContaining("argMax(tuple(accountId, event)"),
      format: "JSONEachRow",
    });
    const scoped = await getPublisherDeliveryHealth(publisherId, second.id);
    expect(scoped.accounts).toEqual([
      { accountId: second.id, sends: 1, delivered: 0, bounced: 1, dropped: 0, resolvedOutcomes: 1, deliverabilityRate: 0, complaints: 0, observationsAvailable: true },
    ]);
  });

  it("keeps SQL counts while reporting unavailable observations as unknown, not invented zero outcomes", async () => {
    const first = await account("First", "192.0.2.43");
    await record(first.id, first.connectionId!, first.ip.id);
    (chQuery as jest.Mock).mockRejectedValue(new Error("Fixture analytics unavailable"));
    const report = await getPublisherDeliveryHealth(publisherId);
    expect(report.accounts).toEqual([
      { accountId: first.id, sends: 1, delivered: null, bounced: null, dropped: null, resolvedOutcomes: null, deliverabilityRate: null, complaints: null, observationsAvailable: false },
    ]);
    expect(report.observationsAvailable).toBe(false);
    expect(report.observations).toEqual([]);
    jest.mocked(chQuery).mockClear();
    await expect(getPublisherDeliveryHealth(publisherId, randomUUID())).rejects.toMatchObject({ code: "esp_account_not_found" });
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("reports successful empty observations as zero observed outcomes", async () => {
    const first = await account("Empty", "192.0.2.44");
    (chQuery as jest.Mock).mockResolvedValue({ json: async () => [] });
    expect((await getPublisherDeliveryHealth(publisherId)).accounts).toEqual([
      { accountId: first.id, sends: 0, delivered: 0, bounced: 0, dropped: 0, resolvedOutcomes: 0, deliverabilityRate: null, complaints: 0, observationsAvailable: true },
    ]);
  });
});
