import {
  compareInventoryValues,
  InventorySortDirection,
} from "../../lib/tableSorting";
import { WorkspaceDomain } from "../../lib/workspaceDomains";
import { RecordValue, rows, text } from "../publications/settingsShared";
import { domainDeliverySummary } from "./deliveryMetrics";

export interface DomainTableRow {
  id: string;
  domain?: WorkspaceDomain;
  hostname: string;
  kind: WorkspaceDomain["kind"];
  ownerId: string;
  owner: string;
  status: string;
  use: string;
  metrics?: RecordValue;
}
export type DomainSortKey =
  | "hostname"
  | "kind"
  | "owner"
  | "status"
  | "use"
  | "sends"
  | "delivered"
  | "deliverabilityRate";
export interface DomainTableFilters {
  search: string;
  kind: string;
  owner: string;
  status: string;
}
export const emptyDomainFilters: DomainTableFilters = {
  search: "",
  kind: "",
  owner: "",
  status: "",
};

export function buildDomainTableRows(
  domains: WorkspaceDomain[],
  owners: ReadonlyMap<string, string>,
  health?: RecordValue,
): DomainTableRow[] {
  const result: DomainTableRow[] = domains.map((domain) => {
    let use = "—";
    if (domain.kind === "tracking")
      use = domain.isCurrent ? "Current" : "Historical";
    return {
      id: domain.viewId,
      domain,
      hostname: domain.hostname,
      kind: domain.kind,
      ownerId: domain.ownerId,
      owner: owners.get(`${domain.kind}:${domain.ownerId}`) ?? "Unknown",
      status: domain.status,
      use,
      metrics: domainDeliverySummary(domain, health),
    };
  });
  for (const cohort of rows(health?.domains)) {
    if (
      cohort.senderDomain ||
      ![cohort.sends, cohort.resolvedOutcomes, cohort.complaints].some(
        (value) => typeof value === "number" && value > 0,
      )
    )
      continue;
    const ownerId = text(cohort.accountId);
    result.push({
      id: `unknown:${ownerId}`,
      hostname: "Unknown sender",
      kind: "sending",
      ownerId,
      owner: owners.get(`sending:${ownerId}`) ?? "Unknown",
      status: "unknown",
      use: "—",
      metrics: cohort,
    });
  }
  return result;
}

export function selectDomainTableRows(
  data: DomainTableRow[],
  filters: DomainTableFilters,
  sort: DomainSortKey,
  direction: InventorySortDirection,
): DomainTableRow[] {
  const search = filters.search.trim().toLowerCase();
  const value = (row: DomainTableRow) => {
    if (
      sort === "sends" ||
      sort === "delivered" ||
      sort === "deliverabilityRate"
    ) {
      if (
        row.metrics?.notApplicable ||
        (sort !== "sends" && row.metrics?.observationsAvailable === false)
      )
        return null;
      const metric = row.metrics?.[sort];
      return typeof metric === "number" ? metric : null;
    }
    return row[sort];
  };
  return data
    .filter(
      (row) =>
        (!filters.kind || row.kind === filters.kind) &&
        (!filters.owner || `${row.kind}:${row.ownerId}` === filters.owner) &&
        (!filters.status || row.status === filters.status) &&
        (!search ||
          `${row.hostname} ${row.owner}`.toLowerCase().includes(search)),
    )
    .sort((left, right) =>
      compareInventoryValues(value(left), value(right), direction),
    );
}
