import { Resolver } from "dns/promises";
import { and, asc, eq, sql } from "drizzle-orm";
import { domainToASCII } from "url";

import config from "./config";
import { Db, db } from "./db";
import { newsletter, newsletterTrackingDomain, TrackingDnsRecord } from "./db/publisherSchema";
import { NewsletterTrackingCloudflareClient, NewsletterTrackingError, TrackingCustomHostname } from "./newsletterTrackingCloudflare";
import { requireNewsletterAccess, requirePublisherAccess } from "./newsletters";

export { NewsletterTrackingError } from "./newsletterTrackingCloudflare";
type Domain = typeof newsletterTrackingDomain.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface NewsletterTrackingInput { publisherId: string; newsletterId: string }
const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/;
function fail(code: string, status = 409): never { throw new NewsletterTrackingError(status, code); }
function domainName(value: string): string {
  const trimmed = value.trim();
  // Reject URL syntax before IDNA normalization, which otherwise parses away
  // delimiters such as a path. Only a bare newsletter domain is accepted.
  if (/[\s/\\:@?#%\[\]\x00-\x1f\x7f]/.test(trimmed)) fail("tracking_domain_invalid", 400);
  const normalized = domainToASCII(trimmed).toLowerCase().replace(/\.$/, "");
  if (normalized.length > 250 || !dnsName.test(normalized)) fail("tracking_domain_invalid", 400);
  return normalized;
}
function cnameTarget(): string | null {
  return config().cloudflareTrackingCnameTarget?.toLowerCase().replace(/\.$/, "") ?? null;
}
function configured(): boolean {
  const c = config();
  return !!(c.cloudflareTrackingApiToken && c.cloudflareTrackingZoneId && cnameTarget());
}
function client(): NewsletterTrackingCloudflareClient {
  const c = config();
  if (!configured()) fail("tracking_provider_not_configured");
  return new NewsletterTrackingCloudflareClient({ token: c.cloudflareTrackingApiToken!, zoneId: c.cloudflareTrackingZoneId!, allowProvisioning: c.cloudflareTrackingAllowProvisioning });
}
async function authorized(input: NewsletterTrackingInput): Promise<void> {
  await requirePublisherAccess(input.publisherId, input.publisherId);
  await requireNewsletterAccess(input.publisherId, input.newsletterId);
}
async function lockNewsletter(tx: Transaction, input: NewsletterTrackingInput): Promise<void> {
  const [row] = await tx.select({ id: newsletter.workspaceId }).from(newsletter).where(and(eq(newsletter.workspaceId, input.newsletterId), eq(newsletter.publisherId, input.publisherId))).for("update");
  if (!row) fail("newsletter_not_found", 404);
}
function status(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : null;
}
function publicDns(records: TrackingDnsRecord[]): TrackingDnsRecord[] {
  return records.filter((record) => record && (record.type === "TXT" || record.type === "CNAME") &&
    typeof record.name === "string" && record.name.length <= 253 && /^[a-z0-9_.-]+$/i.test(record.name) &&
    typeof record.value === "string" && record.value.length > 0 && record.value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(record.value))
    .slice(0, 20).map(({ type, name, value }) => ({ type, name, value }));
}
function recordsFor(hostname: string, provider?: TrackingCustomHostname | null): TrackingDnsRecord[] {
  const records: TrackingDnsRecord[] = [];
  const target = cnameTarget();
  if (target) records.push({ type: "CNAME", name: hostname, value: target });
  const ownership = provider?.ownership_verification;
  if (ownership?.type === "txt" && ownership.name && ownership.value) records.push({ type: "TXT", name: ownership.name, value: ownership.value });
  for (const row of provider?.ssl?.validation_records?.slice(0, 19) ?? []) {
    if (row.txt_name && row.txt_value) records.push({ type: "TXT", name: row.txt_name, value: row.txt_value });
  }
  return publicDns(records);
}
function publicDomain(row: Domain) {
  return { id: row.id, newsletterId: row.newsletterId, domain: row.domain, hostname: row.hostname,
    isCurrent: row.isCurrent, status: row.status, cloudflareStatus: status(row.cloudflareStatus), sslStatus: status(row.sslStatus),
    cnameVerified: row.cnameVerified, dnsRecords: publicDns(row.dnsRecords), lastCheckedAt: row.lastCheckedAt,
    verifiedAt: row.verifiedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function getNewsletterTrackingDomains(publisherId: string, newsletterId?: string) {
  await requirePublisherAccess(publisherId, publisherId);
  if (newsletterId) await authorized({ publisherId, newsletterId });
  const rows = await db().select({ domain: newsletterTrackingDomain }).from(newsletterTrackingDomain)
    .innerJoin(newsletter, eq(newsletter.workspaceId, newsletterTrackingDomain.newsletterId))
    .where(and(eq(newsletter.publisherId, publisherId), newsletterId ? eq(newsletter.workspaceId, newsletterId) : undefined))
    .orderBy(asc(newsletterTrackingDomain.createdAt));
  return { domains: rows.map(({ domain }) => publicDomain(domain)), cnameTarget: cnameTarget(),
    provisioningEnabled: configured() && config().cloudflareTrackingAllowProvisioning, configured: configured() };
}

/** Local-only selection. Ownership rows survive domain changes and cannot be transferred. */
export async function configureNewsletterTrackingDomain(input: NewsletterTrackingInput & { domain: string }) {
  await authorized(input);
  const domain = domainName(input.domain);
  const hostname = `dt.${domain}`;
  await db().transaction(async (tx) => {
    await lockNewsletter(tx, input);
    // Serialize claims even across publishers; the unique constraint remains the final guard.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hostname}, 0))`);
    const [owned] = await tx.select().from(newsletterTrackingDomain).where(eq(newsletterTrackingDomain.hostname, hostname));
    if (owned && owned.newsletterId !== input.newsletterId) fail("tracking_hostname_owned");
    if (owned?.isCurrent) return;
    await tx.update(newsletterTrackingDomain).set({ isCurrent: false, revision: sql`${newsletterTrackingDomain.revision} + 1` })
      .where(and(eq(newsletterTrackingDomain.newsletterId, input.newsletterId), eq(newsletterTrackingDomain.isCurrent, true)));
    if (owned) {
      // Re-selection requires a fresh explicit check, even if this historical host was active.
      await tx.update(newsletterTrackingDomain).set({ isCurrent: true, status: "pending", cnameVerified: false,
        revision: sql`${newsletterTrackingDomain.revision} + 1` }).where(eq(newsletterTrackingDomain.id, owned.id));
    } else {
      await tx.insert(newsletterTrackingDomain).values({ newsletterId: input.newsletterId, domain, hostname, dnsRecords: recordsFor(hostname) });
    }
  });
  return getNewsletterTrackingDomains(input.publisherId, input.newsletterId);
}

async function current(input: NewsletterTrackingInput, executor: Pick<Db, "select"> = db()): Promise<Domain> {
  const [row] = await executor.select().from(newsletterTrackingDomain).where(and(eq(newsletterTrackingDomain.newsletterId, input.newsletterId), eq(newsletterTrackingDomain.isCurrent, true)));
  if (!row) fail("tracking_domain_not_configured");
  return row;
}

/** Only this explicit operation may create; TXT certificate validation never sends mail. */
export async function provisionNewsletterTrackingDomain(input: NewsletterTrackingInput) {
  await authorized(input);
  if (!config().cloudflareTrackingAllowProvisioning) fail("tracking_provisioning_disabled");
  const providerClient = client();
  await db().transaction(async (tx) => {
    await lockNewsletter(tx, input);
    const row = await current(input, tx);
    const provider = await providerClient.find(row.hostname) ?? await providerClient.create(row.hostname);
    await tx.update(newsletterTrackingDomain).set({ customHostnameId: provider.id,
      cloudflareStatus: status(provider.status), sslStatus: status(provider.ssl?.status), dnsRecords: recordsFor(row.hostname, provider),
      status: "pending", cnameVerified: false, revision: row.revision + 1 })
      .where(eq(newsletterTrackingDomain.id, row.id));
  });
  return getNewsletterTrackingDomains(input.publisherId, input.newsletterId);
}

/** DNS-only CNAME onboarding: flattened/proxied A/AAAA answers do not qualify. */
export async function resolveTrackingCname(hostname: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  try { return await resolver.resolveCname(hostname); }
  catch { return []; }
}

/** Read-only provider inspection. Optimistic revision blocks A→B→A and stale verification. */
export async function verifyNewsletterTrackingDomain(input: NewsletterTrackingInput) {
  await authorized(input);
  const providerClient = client();
  const row = await current(input);
  const target = cnameTarget();
  const [provider, cnames] = await Promise.all([providerClient.find(row.hostname), resolveTrackingCname(row.hostname)]);
  const cnameVerified = !!target && cnames.length === 1 && cnames[0]!.toLowerCase().replace(/\.$/, "") === target;
  const cloudflareStatus = status(provider?.status);
  const sslStatus = status(provider?.ssl?.status);
  const active = !!provider && cloudflareStatus === "active" && sslStatus === "active" && cnameVerified;
  const now = new Date();
  await db().transaction(async (tx) => {
    await lockNewsletter(tx, input);
    const selected = await current(input, tx);
    if (selected.id !== row.id || selected.revision !== row.revision || target !== cnameTarget()) fail("tracking_configuration_changed");
    await tx.update(newsletterTrackingDomain).set({ status: active ? "active" : "pending", cloudflareStatus, sslStatus,
      customHostnameId: provider?.id ?? null, cnameVerified, dnsRecords: recordsFor(row.hostname, provider),
      lastCheckedAt: now, verifiedAt: active ? now : row.verifiedAt, revision: row.revision + 1 }).where(eq(newsletterTrackingDomain.id, row.id));
  });
  return getNewsletterTrackingDomains(input.publisherId, input.newsletterId);
}

/** Undefined ONLY for legacy workspaces: registered newsletters must never fall back globally. */
export async function getNewsletterTrackingOrigin(workspaceId: string, executor: Pick<Db, "select"> = db()): Promise<string | undefined> {
  const [registered] = await executor.select({ id: newsletter.workspaceId }).from(newsletter).where(eq(newsletter.workspaceId, workspaceId));
  if (!registered) return undefined;
  const row = await current({ publisherId: "", newsletterId: workspaceId }, executor);
  if (row.status !== "active" || !row.cnameVerified || row.cloudflareStatus !== "active" || row.sslStatus !== "active" || !row.verifiedAt) {
    fail("tracking_domain_not_active");
  }
  return `https://${row.hostname}`;
}

/** Ever-verified immutable ownership survives pending transitions for token-bound receipts. */
export async function getTrackingHostnameNewsletter(hostname: string): Promise<string | null> {
  if (hostname !== hostname.toLowerCase() || !hostname.startsWith("dt.") || hostname.length > 253 || !dnsName.test(hostname)) return null;
  const [row] = await db().select().from(newsletterTrackingDomain).where(eq(newsletterTrackingDomain.hostname, hostname));
  return row?.verifiedAt ? row.newsletterId : null;
}
