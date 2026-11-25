import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { ClickHouseQueryBuilder, query as chQuery } from "./clickhouse";
import { db } from "./db";
import {
  newsletterSend,
  publisherSendgridAccount,
  sendingIp,
  sendingIpBudget,
} from "./db/publisherSchema";
import {
  getNewsletterDeliveryHealth,
  newsletterCapacityLimits,
} from "./newsletterDelivery";
import { requireAccount } from "./newsletterInfrastructure";
import { listNewsletters } from "./newsletters";
import { InternalEventType } from "./types";

interface Observation {
  newsletterId: string;
  accountId: string | null;
  ipId: string | null;
  event: string;
  sendsWithEvent: number;
  observedEventCount: number;
}

/** Native observations retain publication and historical IP attribution; never infer an old IP from today's route. */
export async function getPublisherDeliveryHealth(
  publisherId: string,
  accountId?: string,
) {
  if (accountId) await requireAccount(publisherId, accountId);
  const publications = await listNewsletters(publisherId);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 86400_000);
  const [queue, ips, accounts, sendCounts] = await Promise.all([
    getNewsletterDeliveryHealth(publisherId, accountId),
    db()
      .select()
      .from(sendingIp)
      .where(
        and(
          eq(sendingIp.publisherId, publisherId),
          accountId ? eq(sendingIp.accountId, accountId) : undefined,
        ),
      ),
    db()
      .select({
        id: publisherSendgridAccount.id,
        allTrafficControlled: publisherSendgridAccount.allTrafficControlled,
      })
      .from(publisherSendgridAccount)
      .where(
        and(
          eq(publisherSendgridAccount.publisherId, publisherId),
          accountId ? eq(publisherSendgridAccount.id, accountId) : undefined,
        ),
      ),
    db()
      .select({
        accountId: newsletterSend.accountId,
        senderDomain: newsletterSend.senderDomain,
        sends: count(),
      })
      .from(newsletterSend)
      .where(
        and(
          eq(newsletterSend.publisherId, publisherId),
          accountId ? eq(newsletterSend.accountId, accountId) : undefined,
          gte(newsletterSend.createdAt, periodStart),
          lte(newsletterSend.createdAt, periodEnd),
        ),
      )
      .groupBy(newsletterSend.accountId, newsletterSend.senderDomain),
  ]);
  const canonicalIds = [...new Set(ips.map((ip) => ip.canonicalIpId))];
  const [budgets, peers] = canonicalIds.length
    ? await Promise.all([
        db()
          .select()
          .from(sendingIpBudget)
          .where(
            and(
              inArray(sendingIpBudget.ipId, canonicalIds),
              sql`${sendingIpBudget.windowStart} + ${sendingIpBudget.windowSeconds} * interval '1 second' > clock_timestamp()`,
            ),
          ),
        db()
          .select({ ip: sendingIp })
          .from(sendingIp)
          .innerJoin(
            publisherSendgridAccount,
            eq(publisherSendgridAccount.id, sendingIp.accountId),
          )
          .where(
            and(
              inArray(sendingIp.canonicalIpId, canonicalIds),
              sql`${sendingIp.providerVerifiedAt} is not null`,
              eq(
                sendingIp.verifiedAccountRevision,
                publisherSendgridAccount.revision,
              ),
            ),
          ),
      ])
    : [[], []];
  let observations: Observation[] = [];
  let observationsAvailable = true;
  type Outcome = {
    delivered: number; bounced: number; dropped: number; complaints: number;
  };
  const emptyOutcome = (): Outcome => ({
    delivered: 0, bounced: 0, dropped: 0, complaints: 0,
  });
  const outcomes = new Map<string, {
    accountId: string | null; senderDomain: string | null; outcome: Outcome;
  }>();
  const cohortKey = (account: string | null, domain: string | null) =>
    JSON.stringify([account, domain]);
  const accountIds = new Set(accounts.map((account) => account.id));
  if (publications.length) {
    const qb = new ClickHouseQueryBuilder();
    try {
      const result = await chQuery({
        // Resolve native sends before account filtering: an unattributed newer
        // terminal outcome must not leave an older attributed outcome in the rate.
        // Historical IP observations and complaints remain independent counts.
        query: `WITH window_events AS (
          SELECT workspace_id, user_or_anonymous_id, message_id, event_time, event,
            JSONExtractString(properties, 'sendingAccountId') AS accountId,
            JSONExtractString(properties, 'sendingIpId') AS ipId,
            lowerUTF8(replaceRegexpOne(trimBoth(JSONExtractString(properties, 'senderDomain')), '[.]+$', '')) AS senderDomain,
            JSONExtractString(properties, 'newsletterSendId') AS nativeSendId,
            JSONExtractString(properties, 'messageId') AS logicalMessageId,
            nativeSendId != '' OR logicalMessageId != '' AS hasSendIdentity,
            if(nativeSendId != '',
              tuple('native', nativeSendId, ''),
              tuple('message', if(logicalMessageId = '', message_id, logicalMessageId), user_or_anonymous_id)) AS sendIdentity
          FROM user_events_v2
          WHERE workspace_id IN ${qb.addQueryValue(
            publications.map((item) => item.workspaceId),
            "Array(String)",
          )}
            AND event_time >= parseDateTime64BestEffort(${qb.addQueryValue(periodStart.toISOString(), "String")}, 3, 'UTC')
            AND event_time <= parseDateTime64BestEffort(${qb.addQueryValue(periodEnd.toISOString(), "String")}, 3, 'UTC')
            AND event IN ${qb.addQueryValue([InternalEventType.MessageSent, InternalEventType.EmailDelivered, InternalEventType.EmailBounced, InternalEventType.EmailDropped, InternalEventType.EmailMarkedSpam, InternalEventType.EmailOpened, InternalEventType.EmailClicked], "Array(String)")}
        ), resolved_sends AS (
          SELECT workspace_id, sendIdentity,
            argMax(tuple(accountId, event, senderDomain), tuple(event_time,
              multiIf(event = '${InternalEventType.EmailDropped}', 3, event = '${InternalEventType.EmailBounced}', 2, 1),
              message_id, accountId, senderDomain)) AS outcome
          FROM window_events
          WHERE hasSendIdentity AND event IN ${qb.addQueryValue([InternalEventType.EmailDelivered, InternalEventType.EmailBounced, InternalEventType.EmailDropped], "Array(String)")}
          GROUP BY workspace_id, sendIdentity
        ), resolved_complaints AS (
          SELECT workspace_id, sendIdentity,
            argMax(tuple(accountId, senderDomain), tuple(event_time, message_id, accountId, senderDomain)) AS attribution
          FROM window_events
          WHERE hasSendIdentity AND event = '${InternalEventType.EmailMarkedSpam}'
          GROUP BY workspace_id, sendIdentity
        )
        SELECT workspace_id AS newsletterId, accountId, ipId, '' AS senderDomain, event, 0 AS accountSummary,
          uniqExact(tuple(workspace_id, sendIdentity)) AS sendsWithEvent,
          uniqExact(tuple(message_id, event_time)) AS observedEventCount
        FROM window_events
        ${accountId ? `WHERE accountId = ${qb.addQueryValue(accountId, "String")}` : ""}
        GROUP BY workspace_id, accountId, ipId, event
        UNION ALL
        SELECT '' AS newsletterId, tupleElement(outcome, 1) AS accountId, '' AS ipId,
          tupleElement(outcome, 3) AS senderDomain,
          tupleElement(outcome, 2) AS event, 1 AS accountSummary,
          count() AS sendsWithEvent, 0 AS observedEventCount
        FROM resolved_sends
        ${accountId ? `WHERE accountId = ${qb.addQueryValue(accountId, "String")}` : ""}
        GROUP BY accountId, senderDomain, event
        UNION ALL
        SELECT '' AS newsletterId, tupleElement(attribution, 1) AS accountId, '' AS ipId,
          tupleElement(attribution, 2) AS senderDomain,
          '${InternalEventType.EmailMarkedSpam}' AS event, 1 AS accountSummary,
          count() AS sendsWithEvent, 0 AS observedEventCount
        FROM resolved_complaints
        ${accountId ? `WHERE accountId = ${qb.addQueryValue(accountId, "String")}` : ""}
        GROUP BY accountId, senderDomain`,
        query_params: qb.getQueries(),
        format: "JSONEachRow",
      });
      const raw = await result.json<{
        newsletterId: string;
        accountId: string;
        ipId: string;
        senderDomain: string;
        event: string;
        accountSummary: string | number;
        sendsWithEvent: string | number;
        observedEventCount: string | number;
      }>();
      for (const row of raw) {
        if (Number(row.accountSummary) !== 0) {
          const attributedAccount = accountIds.has(row.accountId)
            ? row.accountId : null;
          const domain = attributedAccount ? row.senderDomain || null : null;
          const key = cohortKey(attributedAccount, domain);
          const outcome = outcomes.get(key)?.outcome ?? emptyOutcome();
          if (row.event === InternalEventType.EmailDelivered)
            outcome.delivered += Number(row.sendsWithEvent);
          if (row.event === InternalEventType.EmailBounced)
            outcome.bounced += Number(row.sendsWithEvent);
          if (row.event === InternalEventType.EmailDropped)
            outcome.dropped += Number(row.sendsWithEvent);
          if (row.event === InternalEventType.EmailMarkedSpam)
            outcome.complaints += Number(row.sendsWithEvent);
          outcomes.set(key, { accountId: attributedAccount, senderDomain: domain, outcome });
        } else {
          observations.push({
            newsletterId: row.newsletterId,
            accountId: row.accountId || null,
            ipId: row.ipId || null,
            event: row.event,
            sendsWithEvent: Number(row.sendsWithEvent),
            observedEventCount: Number(row.observedEventCount),
          });
        }
      }
    } catch {
      observationsAvailable = false;
      observations = [];
      outcomes.clear();
    }
  }
  const summarize = (sends: number, outcome: Outcome) => {
    const resolvedOutcomes = outcome.delivered + outcome.bounced + outcome.dropped;
    return {
      sends,
      delivered: observationsAvailable ? outcome.delivered : null,
      bounced: observationsAvailable ? outcome.bounced : null,
      dropped: observationsAvailable ? outcome.dropped : null,
      resolvedOutcomes: observationsAvailable ? resolvedOutcomes : null,
      deliverabilityRate: observationsAvailable && resolvedOutcomes > 0
        ? (100 * outcome.delivered) / resolvedOutcomes : null,
      complaints: observationsAvailable ? outcome.complaints : null,
      observationsAvailable,
    };
  };
  const totalOutcome = emptyOutcome();
  const accountOutcomes = new Map<string, Outcome>();
  for (const { accountId: owner, outcome } of outcomes.values()) {
    const accountOutcome = owner
      ? accountOutcomes.get(owner) ?? emptyOutcome() : null;
    for (const key of ["delivered", "bounced", "dropped", "complaints"] as const) {
      totalOutcome[key] += outcome[key];
      if (accountOutcome) accountOutcome[key] += outcome[key];
    }
    if (owner && accountOutcome) accountOutcomes.set(owner, accountOutcome);
  }
  const accountAttempts = new Map<string, number>();
  const domainAttempts = new Map<string, number>();
  let totalAttempts = 0;
  for (const row of sendCounts) {
    totalAttempts += row.sends;
    accountAttempts.set(row.accountId, (accountAttempts.get(row.accountId) ?? 0) + row.sends);
    domainAttempts.set(cohortKey(row.accountId, row.senderDomain), row.sends);
    const key = cohortKey(row.accountId, row.senderDomain);
    if (!outcomes.has(key))
      outcomes.set(key, { accountId: row.accountId, senderDomain: row.senderDomain, outcome: emptyOutcome() });
  }
  return {
    ...queue,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    observations,
    observationsAvailable,
    summary: summarize(totalAttempts, totalOutcome),
    domains: [...outcomes.entries()].map(([key, cohort]) => ({
      accountId: cohort.accountId,
      senderDomain: cohort.senderDomain,
      ...summarize(domainAttempts.get(key) ?? 0, cohort.outcome),
    })),
    accounts: accounts.map((account) => ({
      accountId: account.id,
      ...summarize(accountAttempts.get(account.id) ?? 0, accountOutcomes.get(account.id) ?? emptyOutcome()),
    })),
    ips: ips.map((ip) => {
      const shared = peers
        .map(({ ip: peer }) => peer)
        .filter((peer) => peer.canonicalIpId === ip.canonicalIpId);
      const limits = shared.map((peer) =>
        peer.status === "active"
          ? newsletterCapacityLimits(peer, periodEnd)
          : { hourly: 0, daily: 0 },
      );
      return {
        id: ip.id,
        accountId: ip.accountId,
        address: ip.address,
        status: ip.status,
        currentLimits: limits.length
          ? {
              hourly: Math.min(...limits.map((limit) => limit.hourly)),
              daily: Math.min(...limits.map((limit) => limit.daily)),
            }
          : null,
        windows: budgets.filter((budget) => budget.ipId === ip.canonicalIpId),
      };
    }),
    allTrafficControlled:
      accounts.length > 0 &&
      accounts.every((account) => account.allTrafficControlled),
    interpretation:
      "Attempts count durable send records created in the 30-day window, including queued and uncertain records. Delivery outcomes use the latest terminal event per stable send identity in that window; ties prefer dropped, bounced, delivered, then event ID and attribution. Deliverability is delivered / (delivered + bounced + dropped), never acceptance or inbox placement. Complaints resolve independently per send. Workspace totals include unattributed outcomes; domains use immutable sender attribution, never current account inventory or newsletter defaults. Null outcomes mean observations unavailable; null rate means no resolved outcomes or unavailable observations. Historical IP observations remain independent.",
  };
}
