import { and, eq, sql } from "drizzle-orm";

import { ClickHouseQueryBuilder, query as chQuery } from "./clickhouse";
import { db } from "./db";
import {
  publisherSendgridAccount,
  sendingIp,
  sendingIpBudget,
} from "./db/publisherSchema";
import {
  getNewsletterDeliveryHealth,
  newsletterCapacityLimits,
} from "./newsletterDelivery";
import { listNewsletters } from "./newsletters";
import { InternalEventType } from "./types";

/** Native observations retain publication and historical IP attribution; never infer an old IP from today's route. */
export async function getPublisherDeliveryHealth(publisherId: string) {
  const publications = await listNewsletters(publisherId);
  const [queue, ips, budgets, accounts] = await Promise.all([
    getNewsletterDeliveryHealth(publisherId),
    db().select().from(sendingIp).where(eq(sendingIp.publisherId, publisherId)),
    db()
      .select({
        ipId: sendingIpBudget.ipId,
        windowStart: sendingIpBudget.windowStart,
        windowSeconds: sendingIpBudget.windowSeconds,
        reserved: sendingIpBudget.reserved,
      })
      .from(sendingIpBudget)
      .innerJoin(sendingIp, eq(sendingIp.id, sendingIpBudget.ipId))
      .where(
        and(
          eq(sendingIp.publisherId, publisherId),
          sql`${sendingIpBudget.windowStart} + ${sendingIpBudget.windowSeconds} * interval '1 second' > clock_timestamp()`,
        ),
      ),
    db()
      .select({
        allTrafficControlled: publisherSendgridAccount.allTrafficControlled,
      })
      .from(publisherSendgridAccount)
      .where(eq(publisherSendgridAccount.publisherId, publisherId)),
  ]);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 86400_000);
  type Observation = {
    newsletterId: string;
    ipId: string | null;
    event: string;
    sendsWithEvent: number;
    observedEventCount: number;
  };
  let observations: Observation[] = [];
  if (publications.length) {
    const qb = new ClickHouseQueryBuilder();
    const result = await chQuery({
      query: `SELECT workspace_id AS newsletterId, JSONExtractString(properties, 'sendingIpId') AS ipId, event,
        uniqExact(tuple(user_or_anonymous_id, if(JSONExtractString(properties, 'messageId') = '', message_id, JSONExtractString(properties, 'messageId')))) AS sendsWithEvent,
        uniqExact(tuple(message_id, event_time)) AS observedEventCount
        FROM user_events_v2
        WHERE workspace_id IN ${qb.addQueryValue(
          publications.map((item) => item.workspaceId),
          "Array(String)",
        )}
          AND event_time >= parseDateTime64BestEffort(${qb.addQueryValue(periodStart.toISOString(), "String")}, 3, 'UTC')
          AND event_time <= parseDateTime64BestEffort(${qb.addQueryValue(periodEnd.toISOString(), "String")}, 3, 'UTC')
          AND event IN ${qb.addQueryValue([InternalEventType.MessageSent, InternalEventType.EmailDelivered, InternalEventType.EmailBounced, InternalEventType.EmailDropped, InternalEventType.EmailMarkedSpam, InternalEventType.EmailOpened, InternalEventType.EmailClicked], "Array(String)")}
        GROUP BY workspace_id, ipId, event ORDER BY workspace_id, ipId, event`,
      query_params: qb.getQueries(),
      format: "JSONEachRow",
    });
    const raw = await result.json<{
      newsletterId: string;
      ipId: string;
      event: string;
      sendsWithEvent: string | number;
      observedEventCount: string | number;
    }>();
    observations = raw.map((row) => ({
      ...row,
      ipId: row.ipId || null,
      sendsWithEvent: Number(row.sendsWithEvent),
      observedEventCount: Number(row.observedEventCount),
    }));
  }
  return {
    ...queue,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    observations,
    ips: ips.map((ip) => ({
      id: ip.id,
      address: ip.address,
      status: ip.status,
      currentLimits: newsletterCapacityLimits(ip, periodEnd),
      windows: budgets.filter((budget) => budget.ipId === ip.id),
    })),
    allTrafficControlled: accounts[0]?.allTrafficControlled ?? false,
    interpretation:
      "Budgets measure Ditto admission, not provider SMTP delivery timing. External traffic can bypass them. Event counts are native observations, not people or verified human engagement. Missing historical IP attribution remains unassigned; current routes are never applied retroactively. Counts use event occurrence time within the displayed period, not a delivery-cohort rate.",
  };
}
