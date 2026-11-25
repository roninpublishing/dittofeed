import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { ClickHouseQueryBuilder, query as chQuery } from "./clickhouse";
import { db } from "./db";
import {
  publisherSendgridAccount,
  newsletterSend,
  sendingIp,
  sendingIpBudget,
} from "./db/publisherSchema";
import {
  getNewsletterDeliveryHealth,
  newsletterCapacityLimits,
} from "./newsletterDelivery";
import { listNewsletters } from "./newsletters";
import { requireAccount } from "./newsletterInfrastructure";
import { InternalEventType } from "./types";

/** Native observations retain publication and historical IP attribution; never infer an old IP from today's route. */
export async function getPublisherDeliveryHealth(publisherId: string, accountId?: string) {
  if (accountId) await requireAccount(publisherId, accountId);
  const publications = await listNewsletters(publisherId);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 86400_000);
  const [queue, ips, accounts, sendCounts] = await Promise.all([
    getNewsletterDeliveryHealth(publisherId, accountId),
    db().select().from(sendingIp).where(and(
      eq(sendingIp.publisherId, publisherId), accountId ? eq(sendingIp.accountId, accountId) : undefined,
    )),
    db().select({ id: publisherSendgridAccount.id, allTrafficControlled: publisherSendgridAccount.allTrafficControlled })
      .from(publisherSendgridAccount).where(and(
        eq(publisherSendgridAccount.publisherId, publisherId), accountId ? eq(publisherSendgridAccount.id, accountId) : undefined,
      )),
    db().select({ accountId: newsletterSend.accountId, sends: count() }).from(newsletterSend).where(and(
      eq(newsletterSend.publisherId, publisherId),
      accountId ? eq(newsletterSend.accountId, accountId) : undefined,
      gte(newsletterSend.createdAt, periodStart), lte(newsletterSend.createdAt, periodEnd),
    )).groupBy(newsletterSend.accountId),
  ]);
  const canonicalIds = [...new Set(ips.map((ip) => ip.canonicalIpId))];
  const [budgets, peers] = canonicalIds.length ? await Promise.all([
    db().select().from(sendingIpBudget).where(and(
      inArray(sendingIpBudget.ipId, canonicalIds),
      sql`${sendingIpBudget.windowStart} + ${sendingIpBudget.windowSeconds} * interval '1 second' > clock_timestamp()`,
    )),
    db().select({ ip: sendingIp }).from(sendingIp)
      .innerJoin(publisherSendgridAccount, eq(publisherSendgridAccount.id, sendingIp.accountId))
      .where(and(
        inArray(sendingIp.canonicalIpId, canonicalIds),
        sql`${sendingIp.providerVerifiedAt} is not null`,
        eq(sendingIp.verifiedAccountRevision, publisherSendgridAccount.revision),
      )),
  ]) : [[], []];
  type Observation = {
    newsletterId: string;
    accountId: string | null;
    ipId: string | null;
    event: string;
    sendsWithEvent: number;
    observedEventCount: number;
  };
  let observations: Observation[] = [];
  let observationsAvailable = true;
  const outcomes = new Map<string, { delivered: number; bounced: number; complaints: number }>();
  if (publications.length) {
    const qb = new ClickHouseQueryBuilder();
    try {
      const result = await chQuery({
        // Separate grouping sets deduplicate account outcomes across newsletters
        // and historical IP groups rather than summing potentially repeated sends.
        query: `SELECT workspace_id AS newsletterId,
          JSONExtractString(properties, 'sendingAccountId') AS accountId,
          JSONExtractString(properties, 'sendingIpId') AS ipId, event,
          GROUPING(workspace_id, ipId) AS accountSummary,
          uniqExact(tuple(workspace_id, user_or_anonymous_id, if(JSONExtractString(properties, 'messageId') = '', message_id, JSONExtractString(properties, 'messageId')))) AS sendsWithEvent,
          uniqExact(tuple(message_id, event_time)) AS observedEventCount
          FROM user_events_v2
          WHERE workspace_id IN ${qb.addQueryValue(publications.map((item) => item.workspaceId), "Array(String)")}
            AND event_time >= parseDateTime64BestEffort(${qb.addQueryValue(periodStart.toISOString(), "String")}, 3, 'UTC')
            AND event_time <= parseDateTime64BestEffort(${qb.addQueryValue(periodEnd.toISOString(), "String")}, 3, 'UTC')
            AND event IN ${qb.addQueryValue([InternalEventType.MessageSent, InternalEventType.EmailDelivered, InternalEventType.EmailBounced, InternalEventType.EmailDropped, InternalEventType.EmailMarkedSpam, InternalEventType.EmailOpened, InternalEventType.EmailClicked], "Array(String)")}
            ${accountId ? `AND JSONExtractString(properties, 'sendingAccountId') = ${qb.addQueryValue(accountId, "String")}` : ""}
          GROUP BY GROUPING SETS ((workspace_id, accountId, ipId, event), (accountId, event))`,
        query_params: qb.getQueries(),
        format: "JSONEachRow",
      });
      const raw = await result.json<{
        newsletterId: string; accountId: string; ipId: string; event: string;
        accountSummary: string | number; sendsWithEvent: string | number; observedEventCount: string | number;
      }>();
      for (const row of raw) {
        if (Number(row.accountSummary) !== 0) {
          if (!accounts.some((account) => account.id === row.accountId)) continue;
          const outcome = outcomes.get(row.accountId) ?? { delivered: 0, bounced: 0, complaints: 0 };
          if (row.event === InternalEventType.EmailDelivered) outcome.delivered = Number(row.sendsWithEvent);
          if (row.event === InternalEventType.EmailBounced) outcome.bounced = Number(row.sendsWithEvent);
          if (row.event === InternalEventType.EmailMarkedSpam) outcome.complaints = Number(row.sendsWithEvent);
          outcomes.set(row.accountId, outcome);
        } else {
          observations.push({
            newsletterId: row.newsletterId, accountId: row.accountId || null, ipId: row.ipId || null,
            event: row.event, sendsWithEvent: Number(row.sendsWithEvent), observedEventCount: Number(row.observedEventCount),
          });
        }
      }
    } catch {
      observationsAvailable = false;
      observations = [];
      outcomes.clear();
    }
  }
  return {
    ...queue,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    observations,
    observationsAvailable,
    accounts: accounts.map((account) => ({
      accountId: account.id,
      sends: sendCounts.find((row) => row.accountId === account.id)?.sends ?? 0,
      delivered: observationsAvailable ? outcomes.get(account.id)?.delivered ?? 0 : null,
      bounced: observationsAvailable ? outcomes.get(account.id)?.bounced ?? 0 : null,
      complaints: observationsAvailable ? outcomes.get(account.id)?.complaints ?? 0 : null,
      observationsAvailable,
    })),
    ips: ips.map((ip) => {
      const shared = peers.map(({ ip: peer }) => peer).filter((peer) => peer.canonicalIpId === ip.canonicalIpId);
      const limits = shared.map((peer) => peer.status === "active" ? newsletterCapacityLimits(peer, periodEnd) : { hourly: 0, daily: 0 });
      return {
        id: ip.id, accountId: ip.accountId, address: ip.address, status: ip.status,
        currentLimits: limits.length ? { hourly: Math.min(...limits.map((limit) => limit.hourly)), daily: Math.min(...limits.map((limit) => limit.daily)) } : null,
        windows: budgets.filter((budget) => budget.ipId === ip.canonicalIpId),
      };
    }),
    allTrafficControlled: accounts.length > 0 && accounts.every((account) => account.allTrafficControlled),
    interpretation:
      "Budgets measure Ditto admission, not provider SMTP delivery timing. External traffic can bypass them. Account sends count durable records created within the displayed period, including queued and uncertain records, not deliveries. Outcome counts are distinct sends with native events occurring within that period, not a delivery-cohort rate. Missing historical account/IP attribution remains unassigned; current configuration is never applied retroactively. Opens/clicks are not verified human engagement. Unavailable observations are explicitly unknown.",
  };
}
