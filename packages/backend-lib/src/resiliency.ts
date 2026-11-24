import { aliasedTable, and, eq, inArray, max, not, or } from "drizzle-orm";

import config from "./config";
import { WORKSPACE_COMPUTE_LATENCY_METRIC } from "./constants";
import { db } from "./db";
import {
  computedPropertyPeriod as dbComputedPropertyPeriod,
  segment as dbSegment,
  userProperty as dbUserProperty,
  workspace as dbWorkspace,
} from "./db/schema";
import logger from "./logger";
import { getMeter } from "./openTelemetry";
import {
  ComputedPropertyStepEnum,
  Workspace,
  WorkspaceStatusDbEnum,
  WorkspaceTypeAppEnum,
} from "./types";
import { getRecomputableWorkspaces } from "./workspaces";

function observeWorkspaceComputeLatencyInner({
  workspaces,
  periods,
}: {
  workspaces: Workspace[];
  periods: { to: Date; workspaceId: string }[];
}) {
  const maxToByWorkspaceId = periods.reduce<Map<string, Date>>(
    (acc, period) => {
      acc.set(period.workspaceId, period.to);
      return acc;
    },
    new Map(),
  );

  const now = Date.now();

  const histogram = getMeter().createHistogram(
    WORKSPACE_COMPUTE_LATENCY_METRIC,
    {
      description: "Workspace compute latency",
      unit: "ms",
    },
  );
  const { appVersion } = config();

  for (const workspace of workspaces) {
    const maxTo = maxToByWorkspaceId.get(workspace.id);
    if (!maxTo) {
      logger().info(
        {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        },
        `Could not find maxTo for workspace`,
      );
      continue;
    }
    const latency = now - maxTo.getTime();

    histogram.record(latency, {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      appVersion,
    });
    logger().info(
      {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        latency,
        appVersion,
      },
      "Observed workspace compute latency.",
    );
  }
}

/**
 * Deprecated keeping around so doesn't cause temporal errors
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
export async function observeWorkspaceComputeLatency() {}

export async function findActiveWorkspaces(): Promise<{
  workspaces: Workspace[];
  periods: { to: Date; workspaceId: string }[];
}> {
  const w = aliasedTable(dbWorkspace, "w");
  const cpp = aliasedTable(dbComputedPropertyPeriod, "cpp");
  const periodsQuery = db()
    .select({
      workspaceId: cpp.workspaceId,
      to: max(cpp.to),
    })
    .from(cpp)
    .innerJoin(w, eq(cpp.workspaceId, w.id))
    .where(
      and(
        eq(cpp.step, ComputedPropertyStepEnum.ComputeAssignments),
        eq(w.status, WorkspaceStatusDbEnum.Active),
        not(eq(w.type, WorkspaceTypeAppEnum.Parent)),
        or(
          inArray(
            w.id,
            db().select({ id: dbSegment.workspaceId }).from(dbSegment),
          ),
          inArray(
            w.id,
            db()
              .select({ id: dbUserProperty.workspaceId })
              .from(dbUserProperty),
          ),
        ),
      ),
    )
    .groupBy(cpp.workspaceId);

  const [periodsRaw, workspaces] = await Promise.all([
    periodsQuery,
    getRecomputableWorkspaces(),
  ]);

  const periods = periodsRaw.flatMap((row) => {
    if (!row.to) {
      logger().error(
        { workspaceId: row.workspaceId },
        "Could not find maxTo for workspace",
      );
      return [];
    }
    return {
      to: new Date(row.to),
      workspaceId: row.workspaceId,
    };
  });

  return {
    workspaces,
    periods,
  };
}

export async function emitGlobalSignals() {
  logger().info("Emitting global signals");
  const { workspaces, periods } = await findActiveWorkspaces();

  observeWorkspaceComputeLatencyInner({
    workspaces,
    periods,
  });

}
