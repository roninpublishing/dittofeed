import { randomUUID } from "crypto";
import { Resolver } from "dns/promises";
import { and, eq, inArray } from "drizzle-orm";

import config, { Config } from "./config";
import { db } from "./db";
import { newsletter, newsletterTrackingDomain, publisher } from "./db/publisherSchema";
import { workspace } from "./db/schema";
import {
  configureNewsletterTrackingDomain, getNewsletterTrackingDomains, getNewsletterTrackingOrigin,
  getTrackingHostnameNewsletter, provisionNewsletterTrackingDomain, verifyNewsletterTrackingDomain,
} from "./newsletterTracking";
import { NewsletterTrackingCloudflareClient, TrackingCustomHostname } from "./newsletterTrackingCloudflare";

describe("per-newsletter tracking hostname ownership", () => {
  let publisherId: string;
  let newsletterId: string;
  let siblingId: string;
  let original: Pick<Config, "cloudflareTrackingApiToken" | "cloudflareTrackingZoneId" | "cloudflareTrackingCnameTarget" | "cloudflareTrackingAllowProvisioning">;
  let providerRows: TrackingCustomHostname[];
  let cnames: string[];
  let requests: string[];
  let domain: string;
  let hostname: string;
  let pauseFind: (() => Promise<void>) | undefined;
  const ids: string[] = [];
  const input = () => ({ publisherId, newsletterId });

  beforeEach(async () => {
    const c = config();
    original = { cloudflareTrackingApiToken: c.cloudflareTrackingApiToken, cloudflareTrackingZoneId: c.cloudflareTrackingZoneId,
      cloudflareTrackingCnameTarget: c.cloudflareTrackingCnameTarget, cloudflareTrackingAllowProvisioning: c.cloudflareTrackingAllowProvisioning };
    Object.assign(c, { cloudflareTrackingApiToken: "provider-fixture-secret", cloudflareTrackingZoneId: "a".repeat(32),
      cloudflareTrackingCnameTarget: "tracking.saas.example", cloudflareTrackingAllowProvisioning: false });
    const [parent] = await db().insert(workspace).values({ name: "Tracking fixture", type: "Parent" }).returning();
    publisherId = parent!.id;
    ids.push(publisherId);
    await db().insert(publisher).values({ workspaceId: publisherId });
    const children = await db().insert(workspace).values([
      { name: "Tracking A", type: "Child", parentWorkspaceId: publisherId },
      { name: "Tracking B", type: "Child", parentWorkspaceId: publisherId },
    ]).returning();
    newsletterId = children[0]!.id;
    siblingId = children[1]!.id;
    ids.push(newsletterId, siblingId);
    await db().insert(newsletter).values([{ workspaceId: newsletterId, publisherId, slug: "a" }, { workspaceId: siblingId, publisherId, slug: "b" }]);
    domain = `${randomUUID()}.example.com`;
    hostname = `dt.${domain}`;
    providerRows = [{ id: randomUUID(), hostname, status: "active", ssl: { status: "active" } }];
    cnames = ["tracking.saas.example."];
    requests = [];
    pauseFind = undefined;
    jest.spyOn(Resolver.prototype, "resolveCname").mockImplementation(async () => cnames);
    jest.spyOn(NewsletterTrackingCloudflareClient.prototype, "request").mockImplementation(async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      requests.push(`${method} ${path}`);
      if (method === "GET") {
        const result = providerRows.filter((row) => row.hostname === new URL(`https://fixture.invalid${path}`).searchParams.get("hostname"));
        if (pauseFind) await pauseFind();
        return result as T;
      }
      if (!body || typeof body !== "object" || !("hostname" in body) || typeof body.hostname !== "string") throw new Error("Invalid fixture request");
      const row = { id: randomUUID(), hostname: body.hostname, status: "pending", ssl: { status: "pending_validation" } };
      providerRows.push(row);
      return row as T;
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    Object.assign(config(), original);
    await db().delete(workspace).where(inArray(workspace.id, ids.splice(0)));
  });

  it("configures pending locally without DNS/provider calls and never falls back for a newsletter", async () => {
    await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_configured" });
    expect(await getNewsletterTrackingOrigin(publisherId)).toBeUndefined();
    const result = await configureNewsletterTrackingDomain({ ...input(), domain: ` ${domain.toUpperCase()}. ` });
    expect(result.domains).toEqual([expect.objectContaining({ domain, hostname, isCurrent: true, status: "pending", cnameVerified: false })]);
    expect(requests).toEqual([]);
    expect(Resolver.prototype.resolveCname).not.toHaveBeenCalled();
    await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_active" });
    await expect(provisionNewsletterTrackingDomain(input())).rejects.toMatchObject({ code: "tracking_provisioning_disabled" });
    expect(requests).toEqual([]);
  });

  it("refuses explicit provider operations when provider configuration is incomplete", async () => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    config().cloudflareTrackingApiToken = undefined;
    config().cloudflareTrackingAllowProvisioning = true;
    await expect(verifyNewsletterTrackingDomain(input())).rejects.toMatchObject({ code: "tracking_provider_not_configured" });
    await expect(provisionNewsletterTrackingDomain(input())).rejects.toMatchObject({ code: "tracking_provider_not_configured" });
    expect(requests).toEqual([]);
    expect(Resolver.prototype.resolveCname).not.toHaveBeenCalled();
    expect((await getNewsletterTrackingDomains(publisherId)).configured).toBe(false);
  });

  it.each(["https://example.com/path", "example.com/path", "example.com?query", "example.com#fragment", "example.com:443", "example.com%2fpath", "127.0.0.1", "localhost", "user@example.com", "*.example.com", `${"a".repeat(64)}.example.com`])("rejects URL/IP/wildcard input %s before any outbound request", async (value) => {
    await expect(configureNewsletterTrackingDomain({ ...input(), domain: value })).rejects.toMatchObject({ code: "tracking_domain_invalid" });
    expect(requests).toEqual([]);
    expect(Resolver.prototype.resolveCname).not.toHaveBeenCalled();
  });

  it("serializes same-newsletter current selection and cross-newsletter hostname claims", async () => {
    const next = `${randomUUID()}.example.com`;
    await Promise.all([configureNewsletterTrackingDomain({ ...input(), domain }), configureNewsletterTrackingDomain({ ...input(), domain: next })]);
    const result = await getNewsletterTrackingDomains(publisherId, newsletterId);
    expect(result.domains).toHaveLength(2);
    expect(result.domains.filter((row) => row.isCurrent)).toHaveLength(1);
    const claim = `${randomUUID()}.example.com`;
    const claims = await Promise.allSettled([
      configureNewsletterTrackingDomain({ ...input(), domain: claim }),
      configureNewsletterTrackingDomain({ publisherId, newsletterId: siblingId, domain: claim }),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "tracking_hostname_owned" } });
  });

  it.each([
    ["pending", "active", ["tracking.saas.example"], false],
    ["active", "pending_validation", ["tracking.saas.example"], false],
    ["active", "active", [], false],
    ["active", "active", ["wrong.example"], false],
    ["active", "active", ["tracking.saas.example", "other.example"], false],
    ["active", "active", ["TRACKING.SAAS.EXAMPLE."], true],
  ])("requires active hostname %s, TLS %s and a direct exact CNAME %j", async (providerStatus, tlsStatus, answers, active) => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    providerRows[0]!.status = providerStatus as string;
    providerRows[0]!.ssl!.status = tlsStatus as string;
    cnames = answers as string[];
    const result = await verifyNewsletterTrackingDomain(input());
    expect(result.domains[0]!.status).toBe(active ? "active" : "pending");
    expect(await getTrackingHostnameNewsletter(hostname)).toBe(active ? newsletterId : null);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    if (active) {
      await db().transaction(async (tx) => expect(await getNewsletterTrackingOrigin(newsletterId, tx)).toBe(`https://${hostname}`));
    } else await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_active" });
  });

  it.each([
    ["bücher.中国", "xn--bcher-kva.xn--fiqs8s"],
    ["xn--bcher-kva.xn--fiqs8s", "xn--bcher-kva.xn--fiqs8s"],
  ])("normalizes IDNA newsletter domain %s to canonical ASCII ownership", async (value, normalized) => {
    const report = await configureNewsletterTrackingDomain({ ...input(), domain: value });
    expect(report.domains[0]).toMatchObject({ domain: normalized, hostname: `dt.${normalized}`, status: "pending" });
    const second = await configureNewsletterTrackingDomain({ ...input(), domain: normalized });
    expect(second.domains).toHaveLength(1);
    await expect(configureNewsletterTrackingDomain({ publisherId, newsletterId: siblingId, domain: value })).rejects.toMatchObject({ code: "tracking_hostname_owned" });
    expect(requests).toEqual([]);
    expect(Resolver.prototype.resolveCname).not.toHaveBeenCalled();
  });

  it("preserves historical verification through A→B→A pending, provisioning and failed verification", async () => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    const initial = await verifyNewsletterTrackingDomain(input());
    const verifiedAt = initial.domains[0]!.verifiedAt;
    expect(verifiedAt).not.toBeNull();
    await configureNewsletterTrackingDomain({ ...input(), domain: `${randomUUID()}.example.com` });
    const reselected = await configureNewsletterTrackingDomain({ ...input(), domain });
    expect(reselected.domains.find((row) => row.isCurrent)).toMatchObject({ hostname, status: "pending", verifiedAt });
    expect(await getTrackingHostnameNewsletter(hostname)).toBe(newsletterId);
    await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_active" });

    config().cloudflareTrackingAllowProvisioning = true;
    await provisionNewsletterTrackingDomain(input());
    expect(await getTrackingHostnameNewsletter(hostname)).toBe(newsletterId);
    await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_active" });

    cnames = [];
    const failed = await verifyNewsletterTrackingDomain(input());
    expect(failed.domains.find((row) => row.isCurrent)).toMatchObject({ hostname, status: "pending", cnameVerified: false, verifiedAt });
    expect(await getTrackingHostnameNewsletter(hostname)).toBe(newsletterId);
    await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_active" });
    expect(await getTrackingHostnameNewsletter(`dt.never-verified.${domain}`)).toBeNull();
  });

  it("retains historical active hosts for their original newsletter without selecting them globally", async () => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    await verifyNewsletterTrackingDomain(input());
    await configureNewsletterTrackingDomain({ ...input(), domain: `${randomUUID()}.example.com` });
    expect(await getTrackingHostnameNewsletter(hostname)).toBe(newsletterId);
    await expect(getNewsletterTrackingOrigin(newsletterId)).rejects.toMatchObject({ code: "tracking_domain_not_active" });
    await expect(configureNewsletterTrackingDomain({ publisherId, newsletterId: siblingId, domain })).rejects.toMatchObject({ code: "tracking_hostname_owned" });
    expect((await getNewsletterTrackingDomains(publisherId, newsletterId)).domains).toContainEqual(expect.objectContaining({ hostname, isCurrent: false, status: "active" }));
  });

  it("rejects a stale verification even after switching A→B→A", async () => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    const { promise: began, resolve: started } = Promise.withResolvers<void>();
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
    pauseFind = async () => { started(); await blocked; };
    const verification = verifyNewsletterTrackingDomain(input());
    const rejected = expect(verification).rejects.toMatchObject({ code: "tracking_configuration_changed" });
    await began;
    await configureNewsletterTrackingDomain({ ...input(), domain: `${randomUUID()}.example.com` });
    await configureNewsletterTrackingDomain({ ...input(), domain });
    release();
    await rejected;
    expect(await getTrackingHostnameNewsletter(hostname)).toBeNull();
  });

  it("adopts exact existing hostname without POST; concurrent provisioning never duplicates creation", async () => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    config().cloudflareTrackingAllowProvisioning = true;
    await provisionNewsletterTrackingDomain(input());
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
    expect(await getTrackingHostnameNewsletter(hostname)).toBeNull();
    providerRows = [];
    await Promise.all([provisionNewsletterTrackingDomain(input()), provisionNewsletterTrackingDomain(input())]);
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(1);
  });

  it("bounds public validation requirements and excludes provider IDs/secrets/raw errors", async () => {
    await configureNewsletterTrackingDomain({ ...input(), domain });
    providerRows[0]!.ssl!.validation_records = Array.from({ length: 40 }, (_, i) => ({ txt_name: `_acme-challenge.${domain}`, txt_value: `public-challenge-${i}` }));
    const report = await verifyNewsletterTrackingDomain(input());
    expect(report.domains[0]!.dnsRecords).toHaveLength(20);
    expect(JSON.stringify(report)).not.toContain("provider-fixture-secret");
    expect(JSON.stringify(report)).not.toContain(providerRows[0]!.id);
    expect(JSON.stringify(report)).not.toContain("customHostnameId");
    await expect(db().update(newsletterTrackingDomain).set({ newsletterId: siblingId }).where(eq(newsletterTrackingDomain.hostname, hostname))).rejects.toThrow();
  });

  it("rejects foreign newsletter access for reads and mutations", async () => {
    const [foreign] = await db().insert(workspace).values({ name: "Foreign", type: "Parent" }).returning();
    ids.push(foreign!.id);
    await db().insert(publisher).values({ workspaceId: foreign!.id });
    await expect(getNewsletterTrackingDomains(foreign!.id, newsletterId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(configureNewsletterTrackingDomain({ publisherId: foreign!.id, newsletterId, domain })).rejects.toMatchObject({ statusCode: 403 });
    expect(await db().select().from(newsletterTrackingDomain).where(and(eq(newsletterTrackingDomain.newsletterId, newsletterId), eq(newsletterTrackingDomain.isCurrent, true)))).toEqual([]);
  });
});
