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

describe("workspace organizational map", () => {
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
    { accountName: "SendGrid A", path: "/workspace/ips/ip-a" },
    { accountName: "SendGrid B", path: "/workspace/ips/ip-b" },
  ]);
  expect(
    topology.links
      .filter((link) => link.target === "ip:hidden-canonical")
      .map((link) => link.source),
  ).toEqual(["account:account-a", "account:account-b"]);
});
