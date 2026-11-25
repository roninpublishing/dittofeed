// From the repository root after building backend-lib:
// node -r dotenv/config packages/backend-lib/dist/scripts/seedWorkspaceDemo.js <workspace UUID>
import { createHash } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "../src/apps/batch";
import { clickhouseClient } from "../src/clickhouse";
import config from "../src/config";
import { db, endPool } from "../src/db";
import {
  newsletterSend,
  newsletterTrackingDomain,
  publicationAutomationAction,
} from "../src/db/publisherSchema";
import { segment, userProperty } from "../src/db/schema";
import { newsletterMailboxHash } from "../src/newsletterDelivery";
import {
  configureSendgridAccount,
  getSendingInfrastructure,
} from "../src/newsletterInfrastructure";
import { listNewsletters } from "../src/newsletters";
import {
  listPublicationAutomations,
  upsertPublicationAutomation,
} from "../src/publicationAutomations";
import {
  insertSegmentAssignments,
  SegmentBulkUpsertItem,
} from "../src/segments";
import {
  buildSubscriptionChangeEventInner,
  getSubscriptionGroupSegmentName,
} from "../src/subscriptionGroups";
import {
  BatchAppData,
  EventType,
  InternalEventType,
  SubscriptionChange,
} from "../src/types";
import {
  insertUserPropertyAssignments,
  UserPropertyBulkUpsertItem,
} from "../src/userProperties";

const day = 86_400_000;
const id = (value: string) =>
  uuidv5(`ronin-workspace-demo-v1:${value}`, uuidv5.URL);
const userId = (index: number) =>
  `ronin-workspace-demo-v1-${String(index).padStart(3, "0")}`;
const mailbox = (index: number) =>
  `demo.subscriber.${String(index).padStart(3, "0")}@example.test`;

async function main() {
  const cfg = config();
  const workspaceId = process.argv[2];
  if (!workspaceId || !/^[a-f0-9-]{36}$/i.test(workspaceId))
    throw new Error("Pass the development workspace UUID");
  if (
    new URL(cfg.databaseUrl).hostname !==
      "ep-soft-darkness-bcw72x10.c-16.us-east-1.aws.neon.tech" ||
    cfg.clickhouseDatabase !== "dittofeed_dev" ||
    cfg.temporalNamespace !== "ditto-dev.lrwcc" ||
    cfg.bootstrap ||
    cfg.bootstrapWorker
  )
    throw new Error(
      "Seeder requires the selected development resources with bootstrap disabled",
    );
  const publications = (await listNewsletters(workspaceId)).filter(
    (item) =>
      item.slug.startsWith("demo-") || item.name === "Development Newsletter",
  );
  if (publications.length < 2)
    throw new Error("Create the development demo newsletters first");
  const infrastructure = await getSendingInfrastructure(workspaceId);
  const accounts = infrastructure.accounts.filter((account) =>
    account.name.startsWith("Demo · SendGrid"),
  );
  if (
    accounts.length !== 2 ||
    accounts.some(
      (account) =>
        account.hasApiKey ||
        account.hasManagementKey ||
        account.allowRealSends ||
        account.allowProviderWrites ||
        account.allowIpReassignment,
    )
  )
    throw new Error(
      "Demo accounts must have no credentials or operational permissions",
    );

  const sends: (typeof newsletterSend.$inferInsert)[] = [];
  accounts.forEach((account, accountIndex) => {
    const pool = infrastructure.pools.find(
      (item) => item.accountId === account.id,
    );
    const members = new Set(
      infrastructure.memberships
        .filter((item) => item.poolId === pool?.id)
        .map((item) => item.ipId),
    );
    const ips = infrastructure.ips.filter(
      (item) => item.accountId === account.id && members.has(item.id),
    );
    if (!pool || !ips.length || ips.some((ip) => ip.status !== "paused"))
      throw new Error("Demo infrastructure must remain paused");
    const connection = infrastructure.connections.find(
      (item) => item.accountId === account.id,
    );
    if (!connection) throw new Error("Demo account connection is missing");
    for (let index = 1; index <= 40; index += 1) {
      const publication = publications[(index - 1) % publications.length]!;
      const ip = ips[(index - 1) % ips.length]!;
      const createdAt = new Date(Date.now() - ((index % 26) + 1) * day);
      // Explicit synthetic From fixtures, never guessed from configured inventory.
      const syntheticFrom = `demo@demo-${accountIndex ? "secondary" : "primary"}${index % 2 === 0 ? "-alternate" : ""}.example.test`;
      sends.push({
        id: id(`attributed-send-v2:${account.id}:${index}`),
        publisherId: workspaceId,
        accountId: account.id,
        accountRevision: account.revision,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        workspaceId: publication.workspaceId,
        selection: { accountId: account.id, mode: "pool", poolId: pool.id },
        candidateIpIds: ips.map((item) => item.id),
        ipId: ip.id,
        poolId: pool.id,
        actualIp: ip.address,
        logicalMessageId: `synthetic-demo-attributed-v2:${account.id}:${index}`,
        userId: userId(index),
        mailboxHash: newsletterMailboxHash(mailbox(index)),
        senderDomain: syntheticFrom.split("@")[1]!,
        payloadHash: createHash("sha256")
          .update(`synthetic-only:${accountIndex}:${index}`)
          .digest("hex"),
        state: "accepted",
        providerMessageId: `synthetic-demo:${account.id}:${index}`,
        attempts: 0,
        acceptedEventAt: new Date(createdAt.getTime() + 1000),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + day),
      });
    }
    // A fresh, explicitly synthetic cohort; never rewrite v2 send/event history.
    // Pool selection and reported physical IP are separate fixture facts.
    for (const metricPool of infrastructure.pools.filter(
      (item) => item.accountId === account.id,
    )) {
      const memberIds = new Set(infrastructure.memberships
        .filter((item) => item.poolId === metricPool.id)
        .map((item) => item.ipId));
      const metricIps = infrastructure.ips.filter(
        (item) => item.accountId === account.id && memberIds.has(item.id),
      );
      if (!metricIps.length) continue;
      if (metricIps.some((item) => item.status !== "paused"))
        throw new Error("Demo metric pool members must remain paused");
      for (const metricIp of metricIps) {
        for (let index = 1; index <= 4; index += 1) {
          const fixtureIdentity = `${account.id}:${metricPool.id}:${metricIp.id}:${index}`;
          const publication = publications[(index - 1) % publications.length]!;
          const createdAt = new Date(Date.now() - (index + 1) * day);
          sends.push({
            id: id(`ip-metric-send-v3:${fixtureIdentity}`),
            publisherId: workspaceId,
            accountId: account.id,
            accountRevision: account.revision,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            workspaceId: publication.workspaceId,
            selection: { accountId: account.id, mode: "pool", poolId: metricPool.id },
            candidateIpIds: metricIps.map((item) => item.id),
            ipId: null,
            poolId: metricPool.id,
            actualIp: metricIp.address,
            logicalMessageId: `synthetic-demo-ip-v3:${fixtureIdentity}`,
            userId: userId(index),
            mailboxHash: newsletterMailboxHash(mailbox(index)),
            senderDomain: `demo-${accountIndex ? "secondary" : "primary"}.example.test`,
            payloadHash: createHash("sha256").update(`synthetic-only-ip-v3:${fixtureIdentity}`).digest("hex"),
            state: "accepted",
            providerMessageId: `synthetic-demo-ip-v3:${fixtureIdentity}`,
            attempts: 0,
            acceptedEventAt: new Date(createdAt.getTime() + 1000),
            createdAt,
            expiresAt: new Date(createdAt.getTime() + day),
          });
        }
      }
    }
  });
  await db().insert(newsletterSend).values(sends).onConflictDoNothing();
  const persisted = await db()
    .select()
    .from(newsletterSend)
    .where(
      inArray(
        newsletterSend.id,
        sends.map((send) => send.id!),
      ),
    );
  const anchor =
    Math.min(...persisted.map((send) => send.createdAt.getTime())) - day;

  for (const [index, account] of accounts.entries()) {
    await configureSendgridAccount({
      publisherId: workspaceId,
      id: account.id,
      name: account.name,
      provider: "SendGrid",
      senderDomains: [
        `demo-${index ? "secondary" : "primary"}.example.test`,
        `demo-${index ? "secondary" : "primary"}-alternate.example.test`,
      ],
    });
  }
  const names = [
    "Avery Chen",
    "Jordan Rivera",
    "Riley Morgan",
    "Casey Bennett",
    "Morgan Ellis",
    "Taylor Brooks",
    "Alex Parker",
    "Jamie Reed",
  ];
  for (const publication of publications) {
    const properties = await db()
      .select()
      .from(userProperty)
      .where(eq(userProperty.workspaceId, publication.workspaceId));
    const idProperty = properties.find((item) => item.name === "id");
    const emailProperty = properties.find((item) => item.name === "email");
    if (!idProperty || !emailProperty || !publication.subscriptionGroupId)
      throw new Error("Native newsletter setup is incomplete");
    const [subscription] = await db()
      .select()
      .from(segment)
      .where(
        and(
          eq(segment.workspaceId, publication.workspaceId),
          eq(
            segment.name,
            getSubscriptionGroupSegmentName(publication.subscriptionGroupId),
          ),
        ),
      );
    if (!subscription)
      throw new Error("Native subscription segment is missing");
    const assignments: UserPropertyBulkUpsertItem[] = [];
    const subscriptions: SegmentBulkUpsertItem[] = [];
    const batch: BatchAppData["batch"] = [];
    for (let index = 1; index <= 40; index += 1) {
      const subscribed = index % 7 !== 0;
      const timestamp = new Date(anchor + index * 1000).toISOString();
      assignments.push(
        {
          workspaceId: publication.workspaceId,
          userId: userId(index),
          userPropertyId: idProperty.id,
          value: JSON.stringify(userId(index)),
        },
        {
          workspaceId: publication.workspaceId,
          userId: userId(index),
          userPropertyId: emailProperty.id,
          value: JSON.stringify(mailbox(index)),
        },
      );
      subscriptions.push({
        workspaceId: publication.workspaceId,
        userId: userId(index),
        segmentId: subscription.id,
        inSegment: subscribed,
      });
      batch.push({
        type: EventType.Identify,
        messageId: id(`identify:${publication.workspaceId}:${index}`),
        userId: userId(index),
        timestamp,
        traits: {
          email: mailbox(index),
          name: names[(index - 1) % names.length]!,
          syntheticDemo: true,
          newsletter: publication.name,
        },
      });
      batch.push(
        buildSubscriptionChangeEventInner({
          messageId: id(`consent:${publication.workspaceId}:${index}`),
          userId: userId(index),
          subscriptionGroupId: publication.subscriptionGroupId,
          timestamp,
          action: subscribed
            ? SubscriptionChange.Subscribe
            : SubscriptionChange.Unsubscribe,
        }),
      );
    }
    for (const send of persisted.filter(
      (item) => item.workspaceId === publication.workspaceId,
    )) {
      const index = Number(send.userId.split("-").at(-1));
      const primary = send.accountId === accounts[0]!.id;
      const ipMetricFixture = send.logicalMessageId.startsWith("synthetic-demo-ip-v3:");
      const event = ipMetricFixture
        ? index <= 2
          ? InternalEventType.EmailDelivered
          : index === 3
            ? InternalEventType.EmailBounced : InternalEventType.EmailDropped
        : index <= (primary ? 35 : 38)
          ? InternalEventType.EmailDelivered
          : index === 40
            ? InternalEventType.EmailDropped : InternalEventType.EmailBounced;
      const properties = {
        newsletterSendId: send.id,
        messageId: send.logicalMessageId,
        sendingAccountId: send.accountId,
        senderDomain: send.senderDomain,
        sendingIpId: send.ipId,
        ...(ipMetricFixture ? {
          sendingPoolId: send.poolId,
          actualIp: send.actualIp,
          syntheticDemoVersion: "ip-v3",
        } : {}),
        syntheticDemo: true,
      };
      batch.push({
        type: EventType.Track,
        event: InternalEventType.MessageSent,
        messageId: id(`accepted:${send.id}`),
        userId: send.userId,
        timestamp: new Date(send.createdAt.getTime() + 1000).toISOString(),
        properties,
      });
      batch.push({
        type: EventType.Track,
        event,
        messageId: id(`outcome:${send.id}`),
        userId: send.userId,
        timestamp: new Date(send.createdAt.getTime() + 2000).toISOString(),
        properties,
      });
      if (!ipMetricFixture && index % 3 === 0)
        batch.push({
          type: EventType.Track,
          event: InternalEventType.EmailOpened,
          messageId: id(`open:${send.id}`),
          userId: send.userId,
          timestamp: new Date(send.createdAt.getTime() + 60_000).toISOString(),
          properties,
        });
      if (index % 5 === 0)
        batch.push({
          type: EventType.Track,
          event: InternalEventType.EmailClicked,
          messageId: id(`click:${send.id}`),
          userId: send.userId,
          timestamp: new Date(send.createdAt.getTime() + 90_000).toISOString(),
          properties: { ...properties, url: "https://example.test/demo/read" },
        });
      if (ipMetricFixture ? index === 2 : index === 39)
        batch.push({
          type: EventType.Track,
          event: InternalEventType.EmailMarkedSpam,
          messageId: id(`complaint:${send.id}`),
          userId: send.userId,
          timestamp: new Date(send.createdAt.getTime() + 120_000).toISOString(),
          properties,
        });
    }
    await submitBatch(
      { workspaceId: publication.workspaceId, data: { batch } },
      { writeModeOverride: "ch-sync" },
    );
    await insertUserPropertyAssignments(assignments);
    await insertSegmentAssignments(subscriptions);
    const currentHosts = await db()
      .select()
      .from(newsletterTrackingDomain)
      .where(
        and(
          eq(newsletterTrackingDomain.newsletterId, publication.workspaceId),
          eq(newsletterTrackingDomain.isCurrent, true),
        ),
      );
    if (!currentHosts.length)
      await db()
        .insert(newsletterTrackingDomain)
        .values({
          id: id(`tracking:${publication.workspaceId}`),
          newsletterId: publication.workspaceId,
          domain: `${publication.slug}.example.test`,
          hostname: `dt.${publication.slug}.example.test`,
          status: "pending",
          cnameVerified: false,
          dnsRecords: [
            {
              type: "CNAME",
              name: `dt.${publication.slug}.example.test`,
              value: "capture.example.test",
            },
          ],
        });
  }
  const existingRules = await listPublicationAutomations(workspaceId);
  for (let index = 0; index < 2; index += 1) {
    const source = publications[index]!;
    const destination = publications[(index + 1) % publications.length]!;
    const name = `Demo · ${index ? "Preference update" : "Newsletter signup"}`;
    const existing = existingRules.find((rule) => rule.name === name);
    const rule = await upsertPublicationAutomation({
      publisherId: workspaceId,
      id: existing?.id,
      name,
      sourceNewsletterId: source.workspaceId,
      destinationNewsletterId: destination.workspaceId,
      enabled: false,
      definition: {
        source: { eventType: "track", event: "DemoNewsletterSignup" },
        destination: {
          match: { field: "email", source: "traits", path: "email" },
          createIfMissing: true,
          subscribe: true,
          fieldMappings: [
            { source: "traits", path: "name", destination: "name" },
          ],
        },
        oncePerSubscriber: true,
      },
    });
    if (!rule) throw new Error("Demo automation was not saved");
    await db()
      .insert(publicationAutomationAction)
      .values({
        id: id(`action:${rule.id}`),
        ruleId: rule.id,
        sourceEventId: `synthetic-example:${rule.id}`,
        sourceUserId: userId(index + 1),
        destinationUserId: userId(index + 1),
        dedupeKey: `synthetic-example:${rule.id}`,
        disposition: "completed",
        state: {
          syntheticDemo: true,
          sourceNewsletterId: source.workspaceId,
          destinationNewsletterId: destination.workspaceId,
          ruleDefinition: rule.definition,
          profileCompleted: true,
          subscriptionCompleted: true,
          authorization: { ruleName: name, ruleUpdatedAt: rule.updatedAt },
        },
      })
      .onConflictDoNothing();
  }
  console.log(
    JSON.stringify({
      developmentOnly: true,
      syntheticSubscribers: publications.length * 40,
      syntheticHistoricalAttempts: persisted.length,
      syntheticIpMetricAttempts: persisted.filter(
        (send) => send.logicalMessageId.startsWith("synthetic-demo-ip-v3:"),
      ).length,
      accounts: accounts.length,
      pausedAutomations: 2,
      actualProviderSends: 0,
      credentialsAdded: false,
    }),
  );
}

void main()
  .finally(async () => {
    await Promise.all([endPool(), clickhouseClient().close()]);
  })
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Synthetic seed failed",
    );
    process.exitCode = 1;
  });
