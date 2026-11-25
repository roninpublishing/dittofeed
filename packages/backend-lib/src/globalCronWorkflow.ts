import { patched, proxyActivities } from "@temporalio/workflow";

import type * as activities from "./temporal/activities";

const { emitGlobalSignals } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
});

const { drainTelnyxEmailEvents } = proxyActivities<typeof activities>({
  // One ingestion call can use the existing 180-second ClickHouse timeout.
  startToCloseTimeout: "5 minutes",
  scheduleToCloseTimeout: "15 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5 seconds",
    maximumInterval: "30 seconds",
  },
});

const {
  drainNewsletterSends,
  drainNewsletterWebhookReceipts,
  drainPublicationAutomations,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  scheduleToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", maximumInterval: "30 seconds" },
});

export const GLOBAL_CRON_ID = "global-cron-workflow";

export async function globalCronWorkflow() {
  await emitGlobalSignals();
  if (patched("telnyx-email-events-v1")) {
    await drainTelnyxEmailEvents();
  }
  if (patched("ronin-publication-workers-v1")) {
    // Apply suppression receipts before admitting queued mail or coordinating subscribers.
    await drainNewsletterWebhookReceipts();
    await drainPublicationAutomations();
    await drainNewsletterSends();
  }
}
