import { WorkspaceObject, WorkspaceTopology } from "./workspaceTopology";

export interface OrganizationDiagramNode {
  id: string;
  object: WorkspaceObject;
  x: number;
  y: number;
  width: number;
  height: number;
  href?: string;
}
export interface OrganizationDiagram {
  nodes: OrganizationDiagramNode[];
  edges: { id: string; path: string }[];
  width: number;
  height: number;
}
interface Branch {
  id: string;
  object: WorkspaceObject;
  href?: string;
  children: Branch[];
  width: number;
  compactLeaves: boolean;
}
const cardWidth = 208;
const cardHeight = 80;
const columnGap = 24;
const siblingGap = 16;
const rankGap = 28;

/** Ownership ranks fan out horizontally; terminal assets use compact paired branches. */
export function organizationDiagram(
  topology: WorkspaceTopology,
): OrganizationDiagram {
  const objects = new Map(
    topology.objects.map((object) => [object.id, object]),
  );
  const children = new Map<string, WorkspaceObject[]>();
  const accountIds = new Set(
    topology.objects
      .filter((object) => object.kind === "account")
      .map((object) => object.resourceId),
  );
  for (const link of topology.links) {
    if (link.membership) continue;
    const child = objects.get(link.target);
    if (!child || !objects.has(link.source)) continue;
    const siblings = children.get(link.source);
    if (siblings) siblings.push(child);
    else children.set(link.source, [child]);
  }
  const root = topology.objects.find((object) => object.kind === "workspace");
  const diagram: OrganizationDiagram = {
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
  };
  if (!root) return diagram;
  const branch = (
    object: WorkspaceObject,
    id: string,
    href?: string,
  ): Branch => {
    const descendants: Branch[] = [];
    for (const child of children.get(object.id) ?? []) {
      const configurations = child.configurations?.filter((configuration) =>
        object.kind === "account"
          ? configuration.accountId === object.resourceId
          : !accountIds.has(configuration.accountId),
      );
      if (configurations?.length) {
        configurations.forEach((configuration, index) =>
          descendants.push(
            branch(
              {
                ...child,
                name:
                  configurations.length > 1
                    ? `${child.name} · ${index + 1}`
                    : child.name,
                status: configuration.status,
              },
              `${id}/${child.id}/${index}`,
              configuration.path,
            ),
          ),
        );
      } else descendants.push(branch(child, `${id}/${child.id}`, child.path));
    }
    const compactLeaves =
      object.kind !== "workspace" &&
      object.kind !== "group" &&
      descendants.length > 0 &&
      descendants.every((child) => child.children.length === 0);
    let width = cardWidth;
    if (object.kind === "workspace") width = 240;
    if (object.kind === "group") width = 160;
    if (compactLeaves)
      width = Math.max(
        width,
        Math.min(2, descendants.length) * cardWidth +
          (descendants.length > 1 ? columnGap : 0),
      );
    else if (descendants.length)
      width = Math.max(
        width,
        descendants.reduce((sum, child) => sum + child.width, 0) +
          (descendants.length - 1) *
            (object.kind === "workspace" ? 32 : siblingGap),
      );
    return { id, object, href, children: descendants, width, compactLeaves };
  };
  const tree = branch(root, root.id);
  const place = (
    current: Branch,
    left: number,
    top: number,
  ): OrganizationDiagramNode => {
    let width = cardWidth;
    let height = cardHeight;
    if (current.object.kind === "workspace") {
      width = 240;
      height = 44;
    }
    if (current.object.kind === "group") {
      width = 160;
      height = 34;
    }
    const node = {
      id: current.id,
      object: current.object,
      href: current.href,
      x: left + (current.width - width) / 2,
      y: top,
      width,
      height,
    };
    diagram.nodes.push(node);
    diagram.height = Math.max(diagram.height, top + height + 12);
    const nextY = top + height + rankGap;
    if (current.compactLeaves) {
      current.children.forEach((child, index) => {
        const childLeft = left + (index % 2) * (cardWidth + columnGap);
        const childNode = place(
          child,
          childLeft,
          nextY + Math.floor(index / 2) * (cardHeight + 12),
        );
        const center = node.x + node.width / 2;
        let path = `M ${center} ${top + height} V ${childNode.y} `;
        if (current.children.length === 1)
          path += `H ${childNode.x + childNode.width / 2}`;
        else
          path = `M ${center} ${top + height} V ${childNode.y + childNode.height / 2} H ${index % 2 ? childNode.x : childNode.x + childNode.width}`;
        diagram.edges.push({ id: `${node.id}->${childNode.id}`, path });
      });
    } else {
      const gap = current.object.kind === "workspace" ? 32 : siblingGap;
      const total =
        current.children.reduce((sum, child) => sum + child.width, 0) +
        Math.max(0, current.children.length - 1) * gap;
      let cursor = left + (current.width - total) / 2;
      for (const child of current.children) {
        const childNode = place(child, cursor, nextY);
        diagram.edges.push({
          id: `${node.id}->${childNode.id}`,
          path: `M ${node.x + node.width / 2} ${top + height} V ${top + height + rankGap / 2} H ${childNode.x + childNode.width / 2} V ${childNode.y}`,
        });
        cursor += child.width + gap;
      }
    }
    return node;
  };
  place(tree, 12, 12);
  diagram.width = tree.width + 24;
  return diagram;
}
