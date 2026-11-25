import { WorkspaceDomain } from "../../lib/workspaceDomains";
import {
  buildDomainTableRows,
  DomainTableRow,
  emptyDomainFilters,
  selectDomainTableRows,
} from "./domainTable";

const domains: WorkspaceDomain[] = [
  {
    viewId: "sending",
    kind: "sending",
    ownerId: "same-id",
    hostname: "news2.example.test",
    status: "not checked",
    evidence: {},
  },
  {
    viewId: "tracking",
    kind: "tracking",
    ownerId: "same-id",
    hostname: "dt.news10.example.test",
    status: "pending",
    isCurrent: true,
    evidence: {},
  },
];
const owners = new Map([
  ["sending:same-id", "Primary ESP"],
  ["tracking:same-id", "Morning newsletter"],
]);

it("filters owner identities by type and includes unknown sender history only with sending rows", () => {
  const rows = buildDomainTableRows(domains, owners, {
    observationsAvailable: true,
    domains: [
      {
        accountId: "same-id",
        senderDomain: "news2.example.test",
        sends: 10,
        delivered: 9,
        deliverabilityRate: 90,
      },
      { accountId: "same-id", senderDomain: null, sends: 2, delivered: 1 },
    ],
  });
  expect(
    selectDomainTableRows(
      rows,
      { ...emptyDomainFilters, kind: "tracking" },
      "hostname",
      "asc",
    ).map((row) => row.id),
  ).toEqual(["tracking"]);
  expect(
    selectDomainTableRows(
      rows,
      { ...emptyDomainFilters, owner: "sending:same-id", search: "PRIMARY" },
      "hostname",
      "asc",
    ).map((row) => row.id),
  ).toEqual(["sending", "unknown:same-id"]);
  expect(
    selectDomainTableRows(
      rows,
      { ...emptyDomainFilters, kind: "tracking", status: "not checked" },
      "hostname",
      "asc",
    ),
  ).toEqual([]);
  expect(rows.find((row) => row.id === "tracking")?.metrics).toEqual({
    notApplicable: true,
  });
});

it("sorts numeric metrics as numbers, keeps unknown/N-A last in both directions, and preserves input order", () => {
  const base: DomainTableRow = {
    id: "base",
    hostname: "base",
    kind: "sending",
    ownerId: "esp",
    owner: "ESP",
    status: "active",
    use: "—",
  };
  const rows = [
    { ...base, id: "unknown", metrics: { delivered: null } },
    { ...base, id: "ten", metrics: { delivered: 10 } },
    { ...base, id: "zero", metrics: { delivered: 0 } },
    { ...base, id: "two", metrics: { delivered: 2 } },
    {
      ...base,
      id: "tracking",
      kind: "tracking" as const,
      metrics: { notApplicable: true },
    },
  ];
  expect(
    selectDomainTableRows(rows, emptyDomainFilters, "delivered", "asc").map(
      (row) => row.id,
    ),
  ).toEqual(["zero", "two", "ten", "unknown", "tracking"]);
  expect(
    selectDomainTableRows(rows, emptyDomainFilters, "delivered", "desc").map(
      (row) => row.id,
    ),
  ).toEqual(["ten", "two", "zero", "unknown", "tracking"]);
  expect(rows.map((row) => row.id)).toEqual([
    "unknown",
    "ten",
    "zero",
    "two",
    "tracking",
  ]);
});

it("sorts hostnames naturally and retains known attempt volumes when analytics are unavailable", () => {
  const rows = buildDomainTableRows(domains, owners, {
    observationsAvailable: false,
    domains: [
      {
        accountId: "same-id",
        senderDomain: "news2.example.test",
        sends: 0,
        delivered: null,
        observationsAvailable: false,
      },
    ],
  });
  const sending = rows.find((row) => row.id === "sending");
  if (!sending) throw new Error("Sending fixture missing");
  const extra = {
    ...sending,
    id: "news10",
    hostname: "news10.example.test",
    metrics: { sends: 12, observationsAvailable: false },
  };
  const combined = [extra, sending];
  expect(
    selectDomainTableRows(combined, emptyDomainFilters, "hostname", "asc").map(
      (row) => row.id,
    ),
  ).toEqual(["sending", "news10"]);
  expect(
    selectDomainTableRows(combined, emptyDomainFilters, "sends", "desc").map(
      (row) => row.id,
    ),
  ).toEqual(["news10", "sending"]);
});
