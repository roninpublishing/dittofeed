import { compareInventoryValues } from "../../lib/tableSorting";
import { deliveryMetricValue } from "./deliveryMetrics";
import { ipDeliverySummary } from "./ipMetrics";

const ip = { id: "ip-a", accountId: "account-a", address: "192.0.2.10" };
const pool = { id: "pool-a", accountId: "account-a" };

it("prefers reported actual IP over chosen route, isolates accounts, and never infers multi-IP candidates", () => {
  const health = {
    observationsAvailable: true,
    ipCohorts: [
      {
        accountId: "account-b",
        ipId: "ip-a",
        actualIp: ip.address,
        sends: 100,
        delivered: 100,
      },
      {
        accountId: "account-a",
        ipId: "ip-a",
        actualIp: "192.0.2.11",
        sends: 10,
        delivered: 10,
      },
      {
        accountId: "account-a",
        ipId: "ip-a",
        actualIp: null,
        sends: 2,
        delivered: 1,
        bounced: 1,
      },
      {
        accountId: "account-a",
        ipId: null,
        actualIp: ip.address,
        sends: 8,
        delivered: 5,
        bounced: 1,
        dropped: 2,
        complaints: 1,
      },
    ],
  };
  expect(ipDeliverySummary(ip, "ips", health)).toEqual({
    sends: 10,
    delivered: 6,
    bounced: 2,
    dropped: 2,
    complaints: 1,
    resolvedOutcomes: 10,
    deliverabilityRate: 60,
    observationsAvailable: true,
  });
  const unknownHealth = {
    ...health,
    ipCohorts: [
      ...health.ipCohorts,
      {
        accountId: "account-a",
        ipId: null,
        actualIp: null,
        candidateIpIds: ["ip-a", "ip-b"],
        sends: 4,
        delivered: 4,
      },
    ],
  };
  expect(ipDeliverySummary(ip, "ips", unknownHealth)).toMatchObject({
    sends: 10,
    delivered: 6,
    bounced: 2,
    complaints: 1,
    resolvedOutcomes: 10,
    deliverabilityRate: 60,
  });
  expect(
    ipDeliverySummary(
      { ...ip, id: "unrecorded", address: "192.0.2.99" },
      "ips",
      unknownHealth,
    ),
  ).toMatchObject({ sends: null, delivered: null, deliverabilityRate: null });
});

it("uses pinned pool IDs, never combines pools sharing the same current members, and never averages rates", () => {
  const health = {
    observationsAvailable: true,
    pools: [
      {
        accountId: "account-a",
        poolId: "pool-a",
        sends: 12,
        delivered: 1,
        bounced: 1,
      },
      {
        accountId: "account-a",
        poolId: "pool-a",
        sends: 8,
        delivered: 6,
        dropped: 2,
        complaints: 2,
      },
      { accountId: "account-a", poolId: "pool-b", sends: 90, delivered: 90 },
      { accountId: "account-b", poolId: "pool-a", sends: 100, delivered: 100 },
    ],
    memberships: [
      { poolId: "pool-a", ipId: "ip-a" },
      { poolId: "pool-b", ipId: "ip-a" },
    ],
  };
  expect(ipDeliverySummary(pool, "pools", health)).toEqual({
    sends: 20,
    delivered: 7,
    bounced: 1,
    dropped: 2,
    complaints: 2,
    resolvedOutcomes: 10,
    deliverabilityRate: 70,
    observationsAvailable: true,
  });
});

it("distinguishes known empty, unattributed history, unavailable observations and unavailable health", () => {
  const empty = ipDeliverySummary(ip, "ips", {
    observationsAvailable: true,
    ipCohorts: [],
  });
  expect(deliveryMetricValue(empty, "sends")).toBe("0");
  expect(deliveryMetricValue(empty, "delivered")).toBe("0");
  expect(deliveryMetricValue(empty, "deliverabilityRate")).toBe("Unknown");
  const unknown = ipDeliverySummary(pool, "pools", {
    observationsAvailable: true,
    pools: [
      {
        accountId: "account-a",
        poolId: null,
        sends: 1,
        delivered: 1,
        resolvedOutcomes: 1,
      },
    ],
  });
  expect(deliveryMetricValue(unknown, "sends")).toBe("Unknown");
  expect(deliveryMetricValue(unknown, "delivered")).toBe("Unknown");
  const otherAccount = ipDeliverySummary(pool, "pools", {
    observationsAvailable: true,
    pools: [
      {
        accountId: "account-b",
        poolId: null,
        sends: 1,
        delivered: 1,
        resolvedOutcomes: 1,
      },
    ],
  });
  expect(deliveryMetricValue(otherAccount, "sends")).toBe("0");
  const oldPoolHistory = ipDeliverySummary(pool, "pools", {
    observationsAvailable: true,
    pools: [
      { accountId: "account-a", poolId: "pool-a", sends: 4, delivered: 0 },
      { accountId: "account-a", poolId: null, sends: 0, delivered: 3 },
    ],
  });
  expect(deliveryMetricValue(oldPoolHistory, "sends")).toBe("4");
  expect(deliveryMetricValue(oldPoolHistory, "delivered")).toBe("Unknown");
  expect(deliveryMetricValue(oldPoolHistory, "deliverabilityRate")).toBe(
    "Unknown",
  );
  const unavailable = ipDeliverySummary(ip, "ips", {
    observationsAvailable: false,
    ipCohorts: [
      { accountId: "account-a", ipId: "ip-a", sends: 3, delivered: null },
    ],
  });
  expect(deliveryMetricValue(unavailable, "sends")).toBe("3");
  expect(deliveryMetricValue(unavailable, "delivered")).toBe("Unavailable");
  expect(ipDeliverySummary(ip, "ips", undefined)).toBeUndefined();
  expect(
    ipDeliverySummary(ip, "ips", { observationsAvailable: true }),
  ).toBeUndefined();
  expect(deliveryMetricValue(undefined, "delivered", "loading")).toBe(
    "Loading",
  );
  expect(deliveryMetricValue(undefined, "delivered", "unavailable")).toBe(
    "Unavailable",
  );
});

it("sorts resource metric values numerically and keeps unknown rates last in either direction", () => {
  const values = [null, 10, 0, undefined, 2];
  for (const direction of ["asc", "desc"] as const) {
    const ordered = [...values].sort((a, b) =>
      compareInventoryValues(a, b, direction),
    );
    expect(ordered.slice(0, 3)).toEqual(
      direction === "asc" ? [0, 2, 10] : [10, 2, 0],
    );
    expect(ordered.slice(3).every((value) => value == null)).toBe(true);
  }
});
