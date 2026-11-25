export const workspaceSections = [
  "overview",
  "newsletters",
  "esp-accounts",
  "ips",
  "ip-pools",
  "subscribers",
  "reports",
  "settings",
] as const;

export type WorkspaceSection = (typeof workspaceSections)[number];
export interface WorkspaceRoute {
  section: WorkspaceSection;
  resourceId: string | null;
}
const detailSections: Partial<Record<WorkspaceSection, true>> = {
  newsletters: true,
  "esp-accounts": true,
  ips: true,
  "ip-pools": true,
};
const resourceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWorkspaceRoute(
  value: string | string[] | undefined,
): WorkspaceRoute | null {
  const parts = typeof value === "string" ? [value] : value ?? [];
  if (parts.length === 0) return { section: "overview", resourceId: null };
  const section = workspaceSections.find(
    (candidate) => candidate !== "overview" && candidate === parts[0],
  );
  if (!section || parts.length > 2) return null;
  if (parts.length === 1) return { section, resourceId: null };
  const resourceId = parts[1];
  if (
    !detailSections[section] ||
    !resourceId ||
    !resourceIdPattern.test(resourceId)
  )
    return null;
  return { section, resourceId };
}
