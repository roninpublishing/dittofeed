import { RecordValue, rows } from "../publications/settingsShared";

/** Match immutable historical attribution, never today's pool members or defaults. */
export function ipDeliverySummary(
  resource: RecordValue,
  kind: "ips" | "pools",
  health: RecordValue | undefined,
): RecordValue | undefined {
  const source = kind === "ips" ? health?.ipCohorts : health?.pools;
  if (!Array.isArray(source)) return undefined;
  const cohorts = rows(source).filter(
    (row) => row.accountId === resource.accountId,
  );
  const matched = cohorts.filter((row) => {
    if (kind === "pools") return row.poolId === resource.id;
    // A provider-reported address wins over the chosen dedicated route, which
    // describes intent, not proof of the physical IP that actually delivered.
    return row.actualIp
      ? row.actualIp === resource.address
      : row.ipId === resource.id;
  });
  const unattributed = cohorts.filter((row) =>
    kind === "pools" ? !row.poolId : !row.ipId && !row.actualIp,
  );
  const observationsAvailable =
    health?.observationsAvailable !== false &&
    matched.every((row) => row.observationsAvailable !== false);
  const hasTerminalAttribution = matched.some((row) =>
    [row.delivered, row.bounced, row.dropped].some(
      (value) => typeof value === "number" && value > 0,
    ),
  );
  const summary: RecordValue = { observationsAvailable };
  for (const key of [
    "sends",
    "delivered",
    "bounced",
    "dropped",
    "complaints",
  ] as const) {
    const total = matched.reduce((sum, row) => {
      const value = row[key];
      return sum + (typeof value === "number" ? value : 0);
    }, 0);
    // Counts cover only attributable history. An attempts-only cohort must not
    // turn older unattributed outcomes into a false observed zero.
    const unknown =
      (key === "sends" || key === "complaints"
        ? total === 0
        : !hasTerminalAttribution) &&
      unattributed.some((row) =>
        (key === "sends" || key === "complaints"
          ? [row[key]]
          : [row.delivered, row.bounced, row.dropped]
        ).some((value) => typeof value === "number" && value > 0),
      );
    summary[key] =
      unknown || (key !== "sends" && !observationsAvailable) ? null : total;
  }
  const resolved =
    typeof summary.delivered === "number" &&
    typeof summary.bounced === "number" &&
    typeof summary.dropped === "number"
      ? summary.delivered + summary.bounced + summary.dropped
      : null;
  summary.resolvedOutcomes = resolved;
  summary.deliverabilityRate =
    resolved && typeof summary.delivered === "number"
      ? (100 * summary.delivered) / resolved
      : null;
  return summary;
}
