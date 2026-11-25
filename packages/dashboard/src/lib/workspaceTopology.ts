import {
  RecordValue,
  rows,
  text,
} from "../components/publications/settingsShared";

export type WorkspaceObjectKind =
  | "workspace"
  | "group"
  | "newsletter"
  | "account"
  | "ip"
  | "pool";
export interface WorkspaceObject {
  id: string;
  resourceId: string;
  kind: WorkspaceObjectKind;
  name: string;
  path: string;
  status?: string;
  accountName?: string;
  provider?: string;
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

export function workspaceTopology(
  workspaceId: string,
  workspaceName: string,
  infrastructure: RecordValue,
  newsletters: unknown,
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
