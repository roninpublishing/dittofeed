import { buildWorkspaceDomains } from "./workspaceDomains";
import { workspaceTopology } from "./workspaceTopology";

const account = {
  id: "account-a",
  name: "SendGrid A",
  provider: "SendGrid",
  status: "draft",
};
const ip = {
  id: "ip-a",
  accountId: account.id,
  address: "192.0.2.10",
  status: "paused",
};

describe("workspace organizational hierarchy", () => {
  it("keeps newsletters independent even when a sending default exists", () => {
    const topology = workspaceTopology(
      "root",
      "RONIN",
      {
        accounts: [account],
        ips: [ip],
        defaults: [
          {
            newsletterId: "newsletter-a",
            selection: { accountId: account.id, mode: "ip", ipId: ip.id },
          },
        ],
      },
      [{ workspaceId: "newsletter-a", name: "Newsletter A" }],
    );
    expect(
      topology.links.filter(
        (link) => link.source === "newsletter:newsletter-a",
      ),
    ).toEqual([]);
    expect(topology.links).toContainEqual(
      expect.objectContaining({
        source: "group:newsletters",
        target: "newsletter:newsletter-a",
      }),
    );
    expect(topology.links).toContainEqual(
      expect.objectContaining({
        source: "account:account-a",
        target: "ip:ip-a",
      }),
    );
  });
  it("renders a shared IP once while retaining every pool membership", () => {
    const topology = workspaceTopology(
      "root",
      "RONIN",
      {
        accounts: [account],
        ips: [ip, ip],
        pools: [
          { id: "pool-a", accountId: account.id, name: "Pool A" },
          { id: "pool-b", accountId: account.id, name: "Pool B" },
        ],
        memberships: [
          { poolId: "pool-a", ipId: ip.id },
          { poolId: "pool-b", ipId: ip.id },
        ],
      },
      [],
    );
    expect(
      topology.objects
        .filter((object) => object.kind === "ip")
        .map((object) => object.resourceId),
    ).toEqual([ip.id]);
    expect(
      topology.links
        .filter((link) => link.membership)
        .map((link) => [link.source, link.target]),
    ).toEqual([
      ["pool:pool-a", "ip:ip-a"],
      ["pool:pool-b", "ip:ip-a"],
    ]);
  });
  it("does not collapse account and newsletter objects with the same identifier", () => {
    const topology = workspaceTopology(
      "root",
      "RONIN",
      { accounts: [account] },
      [{ workspaceId: account.id, name: "Newsletter" }],
    );
    expect(
      topology.objects.find(
        (object) => object.id === `newsletter:${account.id}`,
      )?.path,
    ).toBe(`/workspace/newsletters/${account.id}`);
    expect(
      topology.objects.find((object) => object.id === `account:${account.id}`)
        ?.path,
    ).toBe(`/workspace/esp-accounts/${account.id}`);
  });
});

it("merges physical aliases without navigating to a hidden canonical resource", () => {
  const otherAccount = {
    id: "account-b",
    name: "SendGrid B",
    provider: "SendGrid",
  };
  const topology = workspaceTopology(
    "root",
    "RONIN",
    {
      accounts: [account, otherAccount],
      ips: [
        { ...ip, canonicalIpId: "hidden-canonical" },
        {
          ...ip,
          id: "ip-b",
          accountId: otherAccount.id,
          canonicalIpId: "hidden-canonical",
        },
      ],
    },
    [],
  );
  const physical = topology.objects.filter((object) => object.kind === "ip");
  expect(physical.map((object) => object.id)).toEqual(["ip:hidden-canonical"]);
  expect(physical[0]?.configurations).toEqual([
    {
      accountId: account.id,
      accountName: "SendGrid A",
      path: "/workspace/ips/ip-a",
      status: "paused",
    },
    {
      accountId: otherAccount.id,
      accountName: "SendGrid B",
      path: "/workspace/ips/ip-b",
      status: "paused",
    },
  ]);
  expect(
    topology.links
      .filter((link) => link.target === "ip:hidden-canonical")
      .map((link) => link.source),
  ).toEqual(["account:account-a", "account:account-b"]);
});

it("places sending and historical tracking domains below their actual owners", () => {
  const infrastructure = {
    accounts: [{ ...account, senderDomains: ["same.example"] }],
    ips: [ip],
    defaults: [
      { newsletterId: "newsletter-a", selection: { accountId: account.id } },
    ],
  };
  const newsletters = [
    { workspaceId: "newsletter-a", name: "Newsletter A" },
    { workspaceId: "newsletter-b", name: "Newsletter B" },
  ];
  const domains = buildWorkspaceDomains("root", infrastructure, {
    domains: [
      {
        newsletterId: "newsletter-a",
        hostname: "dt.same.example",
        status: "pending",
        isCurrent: true,
      },
      {
        newsletterId: "newsletter-a",
        hostname: "dt.old.example",
        status: "active",
        isCurrent: false,
      },
    ],
  });
  const topology = workspaceTopology(
    "root",
    "RONIN",
    infrastructure,
    newsletters,
    domains,
  );
  for (const domain of domains) {
    const nodeId = `domain:${domain.viewId}`;
    const parentId = `${domain.kind === "sending" ? "account" : "newsletter"}:${domain.ownerId}`;
    expect(topology.links.filter((link) => link.target === nodeId)).toEqual([
      expect.objectContaining({
        source: parentId,
        target: nodeId,
        membership: false,
      }),
    ]);
    expect(topology.objects.find((item) => item.id === nodeId)?.path).toBe(
      `/workspace/domains/${domain.viewId}`,
    );
  }
  expect(
    topology.links.some(
      (link) =>
        link.source === "newsletter:newsletter-a" &&
        link.target === `account:${account.id}`,
    ),
  ).toBe(false);
});

it("retains account-local configurations when account names match", () => {
  const topology = workspaceTopology(
    "root",
    "RONIN",
    {
      accounts: [account, { ...account, id: "account-b" }],
      ips: [
        { ...ip, canonicalIpId: "physical" },
        {
          ...ip,
          id: "ip-b",
          accountId: "account-b",
          canonicalIpId: "physical",
          status: "active",
        },
        {
          ...ip,
          id: "ip-c",
          canonicalIpId: "physical",
          status: "draft",
        },
      ],
    },
    [],
  );
  const physical = topology.objects.find(
    (object) => object.id === "ip:physical",
  );
  expect(physical?.configurations).toEqual([
    {
      accountId: account.id,
      accountName: account.name,
      path: "/workspace/ips/ip-a",
      status: "paused",
    },
    {
      accountId: "account-b",
      accountName: account.name,
      path: "/workspace/ips/ip-b",
      status: "active",
    },
    {
      accountId: account.id,
      accountName: account.name,
      path: "/workspace/ips/ip-c",
      status: "draft",
    },
  ]);
  expect(physical?.status).toBe("mixed");
  expect(
    topology.links
      .filter((link) => link.target === physical?.id)
      .map((link) => link.source),
  ).toEqual(["account:account-a", "account:account-b"]);
});

it("keeps resources with unavailable owners visible without assigning another owner", () => {
  const topology = workspaceTopology(
    "root",
    "RONIN",
    {
      accounts: [account],
      pools: [{ id: "orphan-pool", accountId: "unavailable", name: "Pool" }],
      ips: [{ ...ip, accountId: "unavailable" }],
    },
    [],
    [
      {
        viewId: "orphan-domain",
        kind: "tracking",
        ownerId: "unavailable",
        hostname: "dt.example.com",
        status: "pending",
        evidence: {},
      },
    ],
  );
  expect(
    topology.links
      .filter((link) => link.source === "group:unassigned")
      .map((link) => link.target),
  ).toEqual(["domain:orphan-domain", "pool:orphan-pool", "ip:ip-a"]);
  expect(
    topology.links.filter((link) => link.source === "account:account-a"),
  ).toEqual([]);
  expect(
    topology.links.filter((link) => link.target === "group:unassigned"),
  ).toEqual([
    expect.objectContaining({ source: "workspace:root", membership: false }),
  ]);
});
