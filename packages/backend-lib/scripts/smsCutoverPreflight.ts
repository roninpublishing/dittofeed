import { Client, Connection } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { Pool } from "pg";

// Cutover-only inspection: historical SQL artifacts and event/contact data are
// deliberately retained. Never print payloads, credentials, or resource bodies.
const legacyChannelPath = '$.** ? (@.type == "Sms" || @.channel == "Sms")';

function hasLegacyChannel(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const object = value as Record<string, unknown>;
  if (object.channel === "Sms") {
    return true;
  }
  const definition = object.definition as
    | { nodes?: { variant?: { type?: unknown } }[] }
    | undefined;
  return Array.isArray(definition?.nodes) &&
    definition.nodes.some((node) => node.variant?.type === "Sms");
}

async function inspectDatabase(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      // A server-side cursor bounds returned identifiers without loading any
      // definitions or contact data into this process.
      await client.query(`DECLARE legacy_resources NO SCROLL CURSOR FOR
        SELECT 'Journey' AS resource, id, "workspaceId" FROM "Journey"
        WHERE jsonb_path_exists(definition, '${legacyChannelPath}')
           OR jsonb_path_exists(draft, '${legacyChannelPath}')
        UNION ALL
        SELECT 'MessageTemplate', id, "workspaceId" FROM "MessageTemplate"
        WHERE jsonb_path_exists(definition, '${legacyChannelPath}')
           OR jsonb_path_exists(draft, '${legacyChannelPath}')
        UNION ALL
        SELECT 'Broadcast', id, "workspaceId" FROM "Broadcast"
        WHERE jsonb_path_exists(config, '${legacyChannelPath}')
        UNION ALL
        SELECT 'SubscriptionGroup', id, "workspaceId" FROM "SubscriptionGroup"
        WHERE channel::text = 'Sms'`);
      let count = 0;
      for (;;) {
        const batch = await client.query<{
          resource: string;
          id: string;
          workspaceId: string;
        }>("FETCH FORWARD 100 FROM legacy_resources");
        if (batch.rows.length === 0) {
          break;
        }
        for (const row of batch.rows) {
          console.log(JSON.stringify(row));
          count += 1;
        }
      }
      await client.query("CLOSE legacy_resources");
      await client.query("COMMIT");
      console.log(`Database inspection complete: ${count} legacy resources`);
      return count;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function inspectTemporal(): Promise<number> {
  if (!process.env.TEMPORAL_ADDRESS) {
    throw new Error("TEMPORAL_ADDRESS is required");
  }
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const apiKey = process.env.TEMPORAL_API_KEY;
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS,
    connectTimeout: 10000,
    ...(apiKey
      ? { tls: true, apiKey, metadata: { "temporal-namespace": namespace } }
      : {}),
  });
  try {
    const client = new Client({ connection, namespace });
    let count = 0;
    let inspected = 0;
    for await (const execution of client.workflow.list({
      query: "ExecutionStatus = 'Running'",
      pageSize: 100,
    })) {
      let nextPageToken: Uint8Array | undefined;
      let legacy = false;
      do {
        const page = await connection.withDeadline(Date.now() + 10000, () =>
          connection.workflowService.getWorkflowExecutionHistory({
            namespace,
            execution: {
              workflowId: execution.workflowId,
              runId: execution.runId,
            },
            maximumPageSize: 100,
            nextPageToken,
          }),
        );
        for (const event of page.history?.events ?? []) {
          const scheduled = event.activityTaskScheduledEventAttributes;
          if (/sms|twilio|signalwire/i.test(scheduled?.activityType?.name ?? "")) {
            legacy = true;
          }
          const payloads = event.workflowExecutionStartedEventAttributes?.input?.payloads ??
            scheduled?.input?.payloads ?? [];
          for (const payload of payloads) {
            if (hasLegacyChannel(defaultPayloadConverter.fromPayload(payload))) {
              legacy = true;
            }
          }
        }
        nextPageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      } while (nextPageToken && !legacy);
      inspected += 1;
      if (legacy) {
        console.log(JSON.stringify({
          resource: "TemporalWorkflow",
          workflowId: execution.workflowId,
          runId: execution.runId,
        }));
        count += 1;
      }
    }
    console.log(`Temporal inspection complete: ${inspected} running workflows, ${count} legacy workflows`);
    return count;
  } finally {
    await connection.close();
  }
}

async function main() {
  let findings = 0;
  let incomplete = false;
  for (const [name, inspect] of [
    ["Database", inspectDatabase],
    ["Temporal", inspectTemporal],
  ] as const) {
    try {
      findings += await inspect();
    } catch {
      // Underlying driver errors can contain credentials or payloads.
      console.error(`${name} inspection incomplete. Check connection configuration, permissions, schema, and payload codec support.`);
      incomplete = true;
    }
  }
  if (incomplete) {
    process.exitCode = 2;
  } else if (findings) {
    console.error("Cutover blocked: explicitly retire or migrate the listed resources/workflows before deployment; no records were modified.");
    process.exitCode = 1;
  } else {
    console.log("Cutover preflight passed; no legacy SMS resources or running workflow inputs found.");
  }
}

void main();
