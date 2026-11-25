import {
  RecordValue,
  rows,
  text,
} from "../components/publications/settingsShared";
import { WorkspaceDomain } from "./workspaceDomains";

export type WorkspaceObjectKind =
  | "workspace"
  | "group"
  | "newsletter"
  | "account"
  | "ip"
  | "pool"
  | "domain";
export interface WorkspaceObject {
  id: string;
  resourceId: string;
  kind: WorkspaceObjectKind;
  name: string;
  path: string;
  status?: string;
  accountName?: string;
  provider?: string;
  domainKind?: WorkspaceDomain["kind"];
  configurations?: { accountName: string; path: string }[];
}
export interface WorkspaceLink {
  id: string;
  source: string;
  target: string;
  membership: boolean;
}
export interface WorkspaceTopology {
  objects: WorkspaceObject[];
  links: WorkspaceLink[];
}

export const workspaceNodeSize = { width: 212, height: 36 };

export function workspaceTopologyPositions(topology: WorkspaceTopology) {
  const positions = new Map<string, { x: number; y: number }>();
  const objects = new Map(
    topology.objects.map((object) => [object.id, object]),
  );
  const children = new Map<string, WorkspaceObject[]>();
  for (const link of topology.links) {
    if (link.membership) continue;
    const child = objects.get(link.target);
    if (!child) continue;
    const siblings = children.get(link.source);
    if (siblings) siblings.push(child);
    else children.set(link.source, [child]);
  }
  const root = topology.objects.find((object) => object.kind === "workspace");
  if (!root) return positions;
  const groups = children.get(root.id) ?? [];
  const groupY = workspaceNodeSize.height + 28;
  const childY = groupY + workspaceNodeSize.height + 28;
  const indent = workspaceNodeSize.width / 2 + 24;
  const columnWidth = indent + workspaceNodeSize.width;
  const columnGap = 32;
  let x = 24;
  // Vertical leaf lists keep real infrastructures readable instead of creating
  // one enormous horizontal rank. Edges still express actual ownership.
  for (const group of groups) {
    const groupX = x;
    const members = children.get(group.id) ?? [];
    const accounts = members.filter((member) => member.kind === "account");
    if (accounts.length) {
      positions.set(group.id, {
        x: x + ((accounts.length - 1) * (columnWidth + columnGap)) / 2,
        y: groupY,
      });
      accounts.forEach((account, column) => {
        const accountX = groupX + column * (columnWidth + columnGap);
        positions.set(account.id, { x: accountX, y: childY });
        let row = 0;
        for (const asset of children.get(account.id) ?? []) {
          // One physical IP can have several account-local configurations.
          if (positions.has(asset.id)) continue;
          positions.set(asset.id, {
            x: accountX + indent,
            y:
              childY +
              workspaceNodeSize.height +
              32 +
              row * (workspaceNodeSize.height + 12),
          });
          row += 1;
        }
      });
      x += accounts.length * columnWidth + (accounts.length - 1) * columnGap;
    } else {
      positions.set(group.id, { x, y: groupY });
      let row = 0;
      members.forEach((member) => {
        positions.set(member.id, {
          x: groupX + indent,
          y: childY + row * (workspaceNodeSize.height + 12),
        });
        row += 1;
        for (const domain of children.get(member.id) ?? []) {
          positions.set(domain.id, {
            x: groupX + indent + 24,
            y: childY + row * (workspaceNodeSize.height + 12),
          });
          row += 1;
        }
      });
      x += members.length ? columnWidth + 24 : workspaceNodeSize.width;
    }
    x += 64;
  }
  const first = groups[0] && positions.get(groups[0].id);
  const last = groups.at(-1);
  const lastPosition = last && positions.get(last.id);
  positions.set(root.id, {
    x: first && lastPosition ? (first.x + lastPosition.x) / 2 : 24,
    y: 0,
  });
  return positions;
}

export function workspaceTopology(
  workspaceId: string,
  workspaceName: string,
  infrastructure: RecordValue,
  newsletters: unknown,
  domains: WorkspaceDomain[] = [],
): WorkspaceTopology {
  const objects: WorkspaceObject[] = [
    {
      id: `workspace:${workspaceId}`,
      resourceId: workspaceId,
      kind: "workspace",
      name: workspaceName,
      path: "/workspace/settings",
    },
  ];
  const links: WorkspaceLink[] = [];
  const accounts = rows(infrastructure.accounts);
  const accountById = new Map(
    accounts.map((account) => [text(account.id), account]),
  );
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const linkIds = new Set<string>();
  const ipNodeIds = new Map<string, string>();
  const add = (object: WorkspaceObject, parentId: string) => {
    if (!objectById.has(object.id)) {
      objects.push(object);
      objectById.set(object.id, object);
    }
    const id = `${parentId}:${object.id}`;
    if (!linkIds.has(id)) {
      links.push({
        id,
        source: parentId,
        target: object.id,
        membership: false,
      });
      linkIds.add(id);
    }
  };
  const rootId = objects[0]!.id;
  add(
    {
      id: "group:newsletters",
      resourceId: "newsletters",
      kind: "group",
      name: "Newsletters",
      path: "/workspace/newsletters",
    },
    rootId,
  );
  add(
    {
      id: "group:accounts",
      resourceId: "accounts",
      kind: "group",
      name: "ESP accounts",
      path: "/workspace/esp-accounts",
    },
    rootId,
  );
  for (const newsletter of rows(newsletters)) {
    const id = text(newsletter.workspaceId);
    add(
      {
        id: `newsletter:${id}`,
        resourceId: id,
        kind: "newsletter",
        name: text(newsletter.name),
        status: text(newsletter.status),
        path: `/workspace/newsletters/${id}`,
      },
      "group:newsletters",
    );
  }
  for (const account of accounts) {
    const id = text(account.id);
    add(
      {
        id: `account:${id}`,
        resourceId: id,
        kind: "account",
        name: text(account.name),
        provider: text(account.provider),
        status: text(account.status),
        path: `/workspace/esp-accounts/${id}`,
      },
      "group:accounts",
    );
  }
  for (const domain of domains) {
    const parentId = `${domain.kind === "sending" ? "account" : "newsletter"}:${domain.ownerId}`;
    const owner = objectById.get(parentId);
    if (!owner) continue;
    add(
      {
        id: `domain:${domain.viewId}`,
        resourceId: domain.viewId,
        kind: "domain",
        domainKind: domain.kind,
        name: domain.hostname,
        status: domain.status,
        accountName: owner.name,
        path: `/workspace/domains/${domain.viewId}`,
      },
      parentId,
    );
  }
  for (const pool of rows(infrastructure.pools)) {
    const id = text(pool.id);
    const account = accountById.get(text(pool.accountId));
    add(
      {
        id: `pool:${id}`,
        resourceId: id,
        kind: "pool",
        name: text(pool.name),
        accountName: account ? text(account.name) : undefined,
        path: `/workspace/ip-pools/${id}`,
      },
      account ? `account:${text(account.id)}` : rootId,
    );
  }
  for (const ip of rows(infrastructure.ips)) {
    const id = text(ip.id);
    const nodeId = `ip:${text(ip.canonicalIpId ?? ip.id)}`;
    const account = accountById.get(text(ip.accountId));
    const accountName = account ? text(account.name) : "Unknown";
    const path = `/workspace/ips/${id}`;
    ipNodeIds.set(id, nodeId);
    const existing = objectById.get(nodeId);
    if (existing) {
      if (
        !existing.configurations?.some(
          (configuration) => configuration.path === path,
        )
      ) {
        existing.configurations?.push({ accountName, path });
        existing.accountName = existing.configurations
          ?.map((configuration) => configuration.accountName)
          .join(", ");
        if (existing.status !== ip.status) existing.status = "mixed";
      }
    } else {
      add(
        {
          id: nodeId,
          resourceId: id,
          kind: "ip",
          name: text(ip.address),
          status: typeof ip.status === "string" ? ip.status : undefined,
          accountName,
          path,
          configurations: [{ accountName, path }],
        },
        account ? `account:${text(account.id)}` : rootId,
      );
    }
    add(
      existing ?? objectById.get(nodeId)!,
      account ? `account:${text(account.id)}` : rootId,
    );
  }
  for (const membership of rows(infrastructure.memberships)) {
    const source = `pool:${text(membership.poolId)}`;
    const target = ipNodeIds.get(text(membership.ipId));
    if (target && objectById.has(source) && objectById.has(target))
      links.push({
        id: `membership:${source}:${target}`,
        source,
        target,
        membership: true,
      });
  }
  return { objects, links };
}
