import { WorkspaceDomain } from "../../lib/workspaceDomains";
import { deliveryMetricValue, domainDeliverySummary } from "./deliveryMetrics";

const domain: WorkspaceDomain = {
  viewId: "domain",
  ownerId: "account-a",
  kind: "sending",
  hostname: "EXAMPLE.TEST.",
  status: "not checked",
  evidence: {},
};

it("scopes normalized sending domains to the ESP account, not newsletter or account defaults", () => {
  const health = {
    observationsAvailable: true,
    domains: [
      { accountId: "account-b", senderDomain: "example.test", delivered: 100 },
      { accountId: "account-a", senderDomain: "alternate.test", delivered: 30 },
      { accountId: "account-a", senderDomain: "example.test", delivered: 2 },
    ],
  };
  expect(domainDeliverySummary(domain, health)?.delivered).toBe(2);
  expect(
    domainDeliverySummary({ ...domain, hostname: "alternate.test" }, health)
      ?.delivered,
  ).toBe(30);
});

it("keeps tracking hosts not applicable even when their owner and hostname match a sender", () => {
  const summary = domainDeliverySummary(
    { ...domain, kind: "tracking" },
    {
      domains: [
        { accountId: "account-a", senderDomain: "example.test", delivered: 2 },
      ],
    },
  );
  expect(deliveryMetricValue(summary, "delivered")).toBe("N/A");
  expect(deliveryMetricValue(summary, "deliverabilityRate")).toBe("N/A");
  expect(deliveryMetricValue(summary, "delivered", "loading")).toBe("N/A");
  expect(deliveryMetricValue(summary, "delivered", "unavailable")).toBe("N/A");
});

it("distinguishes zero, unknown history, unavailable observations and loading", () => {
  const empty = domainDeliverySummary(domain, {
    observationsAvailable: true,
    domains: [],
  });
  expect(deliveryMetricValue(empty, "sends")).toBe("0");
  expect(deliveryMetricValue(empty, "delivered")).toBe("0");
  expect(deliveryMetricValue(empty, "deliverabilityRate")).toBe("Unknown");
  const historical = domainDeliverySummary(domain, {
    observationsAvailable: true,
    domains: [{ accountId: "account-a", senderDomain: null, sends: 3 }],
  });
  expect(deliveryMetricValue(historical, "sends")).toBe("Unknown");
  expect(deliveryMetricValue(historical, "delivered")).toBe("Unknown");
  expect(
    deliveryMetricValue(
      { delivered: null, observationsAvailable: false },
      "delivered",
    ),
  ).toBe("Unavailable");
  expect(
    deliveryMetricValue({ sends: 0, observationsAvailable: false }, "sends"),
  ).toBe("0");
  expect(deliveryMetricValue(undefined, "sends", "loading")).toBe("Loading");
  expect(deliveryMetricValue(undefined, "sends", "unavailable")).toBe(
    "Unavailable",
  );
  expect(
    deliveryMetricValue({ deliverabilityRate: 0 }, "deliverabilityRate"),
  ).toBe("0.0%");
});
