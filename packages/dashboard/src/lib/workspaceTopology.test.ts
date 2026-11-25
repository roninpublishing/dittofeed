import {
  workspaceNodeSize,
  workspaceTopology,
  workspaceTopologyPositions,
} from "./workspaceTopology";

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
  it("lays out organizational levels top-down without ranking pool memberships", () => {
    const topology = workspaceTopology(
      "root",
      "RONIN",
      {
        accounts: [
          account,
          { ...account, id: "account-b", name: "SendGrid B" },
        ],
        ips: [
          ip,
          { ...ip, id: "ip-b", accountId: "account-b", address: "192.0.2.11" },
        ],
        pools: [
          { id: "pool-a", accountId: account.id, name: "Pool A" },
          { id: "pool-b", accountId: account.id, name: "Pool B" },
          { id: "pool-c", accountId: "account-b", name: "Pool C" },
        ],
        memberships: [
          { poolId: "pool-a", ipId: ip.id },
          { poolId: "pool-b", ipId: ip.id },
          { poolId: "pool-c", ipId: "ip-b" },
        ],
      },
      [
        { workspaceId: "newsletter-a", name: "Newsletter A" },
        { workspaceId: "newsletter-b", name: "Newsletter B" },
      ],
    );
    const positions = workspaceTopologyPositions(topology);
    const y = (id: string) => positions.get(id)!.y;
    expect(positions.size).toBe(topology.objects.length);
    expect(y("workspace:root")).toBeLessThan(y("group:accounts"));
    expect(y("group:newsletters")).toBe(y("group:accounts"));
    expect(y("group:accounts")).toBeLessThan(y("account:account-a"));
    expect(y("newsletter:newsletter-a")).toBe(y("account:account-a"));
    expect(y("newsletter:newsletter-b")).toBeGreaterThan(
      y("newsletter:newsletter-a"),
    );
    for (const link of topology.links.filter((item) => !item.membership))
      expect(y(link.target)).toBeGreaterThan(y(link.source));
    const rectangles = [...positions.values()];
    for (let index = 0; index < rectangles.length; index += 1)
      for (const other of rectangles.slice(index + 1)) {
        const rectangle = rectangles[index]!;
        expect(
          rectangle.x + workspaceNodeSize.width <= other.x ||
            other.x + workspaceNodeSize.width <= rectangle.x ||
            rectangle.y + workspaceNodeSize.height <= other.y ||
            other.y + workspaceNodeSize.height <= rectangle.y,
        ).toBe(true);
      }
    expect(positions).toEqual(
      workspaceTopologyPositions({
        ...topology,
        links: topology.links.filter((link) => !link.membership),
      }),
    );
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
