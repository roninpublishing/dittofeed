import { organizationDiagram } from "./organizationDiagram";
import { WorkspaceObject, WorkspaceTopology } from "./workspaceTopology";

function object(id: string, kind: WorkspaceObject["kind"]): WorkspaceObject {
  return { id, resourceId: id, kind, name: id, path: `/workspace/${id}` };
}
function connect(
  topology: WorkspaceTopology,
  source: string,
  target: string,
  membership = false,
) {
  topology.links.push({
    id: `${source}->${target}`,
    source,
    target,
    membership,
  });
}

it("keeps sibling newsletters and accounts on one rank, with every asset readable and nonoverlapping", () => {
  const topology: WorkspaceTopology = {
    objects: [
      object("workspace", "workspace"),
      object("newsletters", "group"),
      object("accounts", "group"),
    ],
    links: [],
  };
  connect(topology, "workspace", "newsletters");
  connect(topology, "workspace", "accounts");
  for (let index = 0; index < 3; index += 1) {
    topology.objects.push(
      object(`newsletter-${index}`, "newsletter"),
      object(`tracking-${index}`, "domain"),
    );
    connect(topology, "newsletters", `newsletter-${index}`);
    connect(topology, `newsletter-${index}`, `tracking-${index}`);
  }
  for (let index = 0; index < 2; index += 1) {
    topology.objects.push(object(`account-${index}`, "account"));
    connect(topology, "accounts", `account-${index}`);
    for (let asset = 0; asset < 8; asset += 1) {
      topology.objects.push(object(`asset-${index}-${asset}`, "domain"));
      connect(topology, `account-${index}`, `asset-${index}-${asset}`);
    }
  }
  const diagram = organizationDiagram(topology);
  expect(diagram.nodes.map((node) => node.object.id).sort()).toEqual(
    topology.objects.map((node) => node.id).sort(),
  );
  const siblings = diagram.nodes.filter(
    (node) =>
      node.object.kind === "account" || node.object.kind === "newsletter",
  );
  expect(new Set(siblings.map((node) => node.y))).toEqual(
    new Set([siblings[0]!.y]),
  );
  expect(diagram.width).toBeLessThan(1400);
  expect(diagram.height).toBeLessThan(600);
  for (const [index, node] of diagram.nodes.entries()) {
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
    expect(node.x + node.width).toBeLessThanOrEqual(diagram.width);
    expect(node.y + node.height).toBeLessThanOrEqual(diagram.height);
    for (const other of diagram.nodes.slice(index + 1)) {
      expect(
        node.x < other.x + other.width &&
          node.x + node.width > other.x &&
          node.y < other.y + other.height &&
          node.y + node.height > other.y,
      ).toBe(false);
    }
  }
});

it("retains every account-local IP configuration without treating pool membership as ownership", () => {
  const physicalIp = object("physical-ip", "ip");
  physicalIp.configurations = [
    { accountId: "account-a", accountName: "A", path: "/workspace/ips/a" },
    {
      accountId: "account-a",
      accountName: "A",
      path: "/workspace/ips/alias-a",
    },
    { accountId: "account-b", accountName: "B", path: "/workspace/ips/b" },
  ];
  const topology: WorkspaceTopology = {
    objects: [
      object("workspace", "workspace"),
      object("accounts", "group"),
      object("account-a", "account"),
      object("account-b", "account"),
      physicalIp,
      object("pool", "pool"),
    ],
    links: [],
  };
  connect(topology, "workspace", "accounts");
  connect(topology, "accounts", "account-a");
  connect(topology, "accounts", "account-b");
  connect(topology, "account-a", "physical-ip");
  connect(topology, "account-b", "physical-ip");
  connect(topology, "account-a", "pool");
  connect(topology, "pool", "physical-ip", true);
  const diagram = organizationDiagram(topology);
  expect(
    diagram.nodes
      .filter((node) => node.object.kind === "ip")
      .map((node) => node.href)
      .sort(),
  ).toEqual(
    ["/workspace/ips/a", "/workspace/ips/alias-a", "/workspace/ips/b"].sort(),
  );
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  for (const node of diagram.nodes.filter(
    (candidate) => candidate.object.kind === "ip",
  )) {
    const edge = diagram.edges.find((candidate) =>
      candidate.id.endsWith(`->${node.id}`),
    )!;
    const parent = byId.get(edge.id.split("->")[0]!)!;
    expect(parent.object.kind).toBe("account");
    expect(node.href).toContain(
      parent.object.resourceId === "account-b" ? "/b" : "/a",
    );
  }
});
