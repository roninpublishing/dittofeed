import { v5 as uuidv5, validate as validateUuid } from "uuid";

import { buildWorkspaceDomains } from "./workspaceDomains";

const infrastructure = {
  accounts: [
    {
      id: "owner-a",
      senderDomains: ["Example.COM", "pending.example"],
      provisioning: {
        domains: [
          {
            domain: "example.com",
            subdomain: "em1",
            valid: true,
            dns: [
              {
                type: "cname",
                host: "em1.example.com",
                data: "target.example",
                valid: true,
              },
            ],
          },
          { domain: "example.com", subdomain: "em2", valid: false },
          { domain: "observed.example", subdomain: "em", valid: false },
        ],
      },
    },
    { id: "owner-b", senderDomains: ["example.com"] },
  ],
};
const tracking = {
  domains: [
    {
      id: "current",
      newsletterId: "owner-a",
      hostname: "dt.example.com",
      domain: "example.com",
      isCurrent: true,
      status: "pending",
      cnameVerified: true,
      cloudflareStatus: "active",
      sslStatus: "pending",
    },
    {
      id: "history",
      newsletterId: "owner-a",
      hostname: "dt.old.example",
      domain: "old.example",
      isCurrent: false,
      status: "active",
      cnameVerified: true,
    },
  ],
};

describe("workspace domains", () => {
  it("combines local registrations and provider evidence without inventing verification", () => {
    const domains = buildWorkspaceDomains(
      "workspace",
      infrastructure,
      tracking,
    );
    const sending = domains.filter(
      (item) => item.kind === "sending" && item.ownerId === "owner-a",
    );
    expect(sending.map((item) => [item.hostname, item.status])).toEqual([
      ["example.com", "verified"],
      ["pending.example", "not checked"],
      ["observed.example", "not verified"],
    ]);
    expect(sending[0]?.evidence.authentications).toEqual(
      infrastructure.accounts[0]?.provisioning?.domains.slice(0, 2),
    );
    expect(
      domains.find(
        (item) => item.kind === "sending" && item.ownerId === "owner-b",
      )?.status,
    ).toBe("not checked");
  });

  it("retains newsletter ownership and historical hosts without promoting a CNAME to active", () => {
    const domains = buildWorkspaceDomains(
      "workspace",
      infrastructure,
      tracking,
    ).filter((item) => item.kind === "tracking");
    expect(
      domains.map((item) => [
        item.ownerId,
        item.hostname,
        item.isCurrent,
        item.status,
      ]),
    ).toEqual([
      ["owner-a", "dt.example.com", true, "pending"],
      ["owner-a", "dt.old.example", false, "active"],
    ]);
    expect(domains[1]?.evidence.id).toBe("history");
  });

  it("uses stable scoped UUID view identities independent of statuses and row order", () => {
    const initial = buildWorkspaceDomains(
      "workspace",
      infrastructure,
      tracking,
    );
    const changed = buildWorkspaceDomains(
      "workspace",
      { accounts: [...infrastructure.accounts].reverse() },
      {
        domains: tracking.domains
          .map((item) => ({ ...item, status: "active", isCurrent: false }))
          .reverse(),
      },
    );
    expect(initial.every((item) => validateUuid(item.viewId))).toBe(true);
    expect(
      initial.find(
        (item) => item.hostname === "example.com" && item.ownerId === "owner-a",
      )?.viewId,
    ).toBe(
      uuidv5(
        JSON.stringify([
          "workspace-domains",
          "workspace",
          "sending",
          "owner-a",
          "example.com",
        ]),
        uuidv5.URL,
      ),
    );
    for (const item of changed) {
      expect(
        initial.find(
          (candidate) =>
            candidate.kind === item.kind &&
            candidate.ownerId === item.ownerId &&
            candidate.hostname === item.hostname,
        )?.viewId,
      ).toBe(item.viewId);
    }
    expect(new Set(initial.map((item) => item.viewId)).size).toBe(
      initial.length,
    );
    const otherWorkspace = buildWorkspaceDomains(
      "other",
      infrastructure,
      tracking,
    );
    expect(
      otherWorkspace.some((item) =>
        initial.some((candidate) => candidate.viewId === item.viewId),
      ),
    ).toBe(false);
  });

  it("ignores malformed owners and deduplicates catalog rows", () => {
    expect(
      buildWorkspaceDomains(
        "workspace",
        { accounts: [{ senderDomains: ["example.com"] }] },
        {},
      ),
    ).toEqual([]);
    const domains = buildWorkspaceDomains(
      "workspace",
      {},
      {
        domains: [
          tracking.domains[0],
          tracking.domains[0],
          { hostname: "dt.invalid.example" },
        ],
      },
    );
    expect(domains).toHaveLength(1);
  });
});
