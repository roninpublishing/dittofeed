import { v5 as uuidv5 } from "uuid";

import {
  record,
  RecordValue,
  rows,
} from "../components/publications/settingsShared";

export interface WorkspaceDomain {
  /** Presentation identity only; backend operations must use the owning resource. */
  viewId: string;
  kind: "sending" | "tracking";
  ownerId: string;
  hostname: string;
  status: string;
  isCurrent?: boolean;
  evidence: RecordValue;
}

function hostname(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\.$/, "")
    : "";
}

export function buildWorkspaceDomains(
  workspaceId: string,
  infrastructure: RecordValue,
  trackingData: unknown,
): WorkspaceDomain[] {
  const domains: WorkspaceDomain[] = [];
  const viewId = (
    kind: WorkspaceDomain["kind"],
    ownerId: string,
    name: string,
  ) =>
    uuidv5(
      JSON.stringify(["workspace-domains", workspaceId, kind, ownerId, name]),
      uuidv5.URL,
    );
  for (const account of rows(infrastructure.accounts)) {
    if (typeof account.id !== "string") continue;
    const observations = new Map<string, RecordValue[]>();
    const registered = Array.isArray(account.senderDomains)
      ? account.senderDomains
      : [];
    for (const value of registered) {
      const name = hostname(value);
      if (name) observations.set(name, []);
    }
    for (const evidence of rows(record(account.provisioning).domains)) {
      const name = hostname(evidence.domain);
      if (!name) continue;
      const existing = observations.get(name);
      if (existing) existing.push(evidence);
      else observations.set(name, [evidence]);
    }
    for (const [name, authentications] of observations) {
      let status = authentications.length ? "not verified" : "not checked";
      if (authentications.some((item) => item.valid === true))
        status = "verified";
      domains.push({
        viewId: viewId("sending", account.id, name),
        kind: "sending",
        ownerId: account.id,
        hostname: name,
        status,
        evidence: {
          domain: name,
          authentications,
          inspectedAt: record(account.provisioning).inspectedAt,
        },
      });
    }
  }
  const seen = new Set<string>();
  for (const evidence of rows(record(trackingData).domains)) {
    const name = hostname(evidence.hostname);
    if (!name || typeof evidence.newsletterId !== "string") continue;
    const id = viewId("tracking", evidence.newsletterId, name);
    if (seen.has(id)) continue;
    seen.add(id);
    domains.push({
      viewId: id,
      kind: "tracking",
      ownerId: evidence.newsletterId,
      hostname: name,
      status: evidence.status === "active" ? "active" : "pending",
      isCurrent: evidence.isCurrent === true,
      evidence,
    });
  }
  return domains;
}
