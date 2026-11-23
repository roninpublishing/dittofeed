import { randomBytes } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isIP } from "net";

import { db } from "./db";
import {
  newsletter,
  newsletterRoute,
  publisher,
  publisherSendgridAccount,
  sendingConnection,
  sendingIp,
  sendingPool,
  sendingPoolBinding,
  sendingPoolIp,
} from "./db/publisherSchema";
import {
  decryptNewsletterSecret,
  encryptNewsletterSecret,
  requireNewsletterSecretKey,
} from "./newsletterSecrets";
import {
  assertSingleIpRouting,
  NewsletterInfrastructureError,
  NewsletterSendgridClient,
  NEWSLETTER_WEBHOOK_EVENTS,
  SendgridApiKey,
  SendgridDomain,
  SendgridIp,
  SendgridSender,
  SendgridWebhook,
  webhookIsReady,
} from "./newsletterSendgrid";

export { NewsletterInfrastructureError } from "./newsletterSendgrid";

const PROTECTED_SUBUSER = "aistocknews-ditto";
type Connection = typeof sendingConnection.$inferSelect;
type Account = typeof publisherSendgridAccount.$inferSelect;
export interface ConnectionInput {
  publisherId: string;
  connectionId: string;
}
export interface DomainInput extends ConnectionInput {
  domain: string;
  subdomain?: string;
  validate?: boolean;
}
export interface ProvisionConnectionInput extends ConnectionInput {
  domain?: string;
  subdomain?: string;
  configureWebhook?: boolean;
}
export interface ConfigureSendgridAccountInput {
  publisherId: string;
  managementApiKey?: string;
  region?: "global" | "eu";
  callbackBaseUrl?: string;
  allowProviderWrites?: boolean;
  allowIpReassignment?: boolean;
  allowRealSends?: boolean;
  allTrafficControlled?: boolean;
}
export interface CreateSendingConnectionInput {
  publisherId: string;
  newsletterId: string;
  apiKey?: string;
  apiKeyId?: string;
  senderDomains?: string[];
  senderEmails?: string[];
}
export interface SendingIpInput {
  publisherId: string;
  id?: string;
  address: string;
  status: "active" | "paused";
  hourlyLimit: number;
  dailyLimit: number;
  warmupStartedAt?: string | null;
  warmupSchedule?: {
    afterDays: number;
    hourlyLimit: number;
    dailyLimit: number;
  }[];
}
export interface SendingPoolInput {
  publisherId: string;
  id?: string;
  name: string;
  ipIds: string[];
}
export interface PoolBindingInput extends ConnectionInput {
  poolId: string;
  providerPoolName: string;
}
export interface NewsletterRouteInput {
  publisherId: string;
  newsletterId: string;
  connectionId: string;
  poolId: string;
}
export interface PinnedNewsletterRoutingInput extends NewsletterRouteInput {
  ipId: string;
  providerPoolName: string;
  connectionRevision: number;
}
export interface SenderIdentityInput extends ConnectionInput {
  nickname: string;
  fromEmail: string;
  replyTo: string;
  fromName?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  sendVerificationEmail: true;
}

function fail(code: string, status = 409): never {
  throw new NewsletterInfrastructureError(status, code);
}
function domainName(value: string) {
  const normalized = value.toLowerCase();
  if (
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
  )
    fail("invalid_sender_domain", 400);
  return normalized;
}
function mailbox(value: string) {
  if (value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(value))
    fail("invalid_sender_email", 400);
  const at = value.lastIndexOf("@");
  return `${value.slice(0, at)}@${domainName(value.slice(at + 1))}`;
}
function poolName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(value))
    fail("invalid_pool_name", 400);
  return value;
}
function runtimeKeyId(value: string) {
  const match = /^SG\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) fail("invalid_sendgrid_api_key", 400);
  return match[1]!;
}
function callbackUrl(account: Account, connectionId: string) {
  return account.callbackBaseUrl
    ? `${account.callbackBaseUrl}/api/public/webhooks/sendgrid/connections/${connectionId}`
    : null;
}
async function requirePublisher(publisherId: string) {
  const [row] = await db()
    .select({ id: publisher.workspaceId })
    .from(publisher)
    .where(eq(publisher.workspaceId, publisherId));
  if (!row) fail("publisher_not_found", 404);
}
async function requireNewsletter(publisherId: string, newsletterId: string) {
  const [row] = await db()
    .select()
    .from(newsletter)
    .where(
      and(
        eq(newsletter.workspaceId, newsletterId),
        eq(newsletter.publisherId, publisherId),
      ),
    );
  if (!row) fail("newsletter_not_found", 404);
  return row;
}
async function requireConnection(input: ConnectionInput) {
  const [row] = await db()
    .select()
    .from(sendingConnection)
    .where(
      and(
        eq(sendingConnection.id, input.connectionId),
        eq(sendingConnection.publisherId, input.publisherId),
      ),
    );
  if (!row) fail("sending_connection_not_found", 404);
  await requireNewsletter(input.publisherId, row.newsletterId);
  return row;
}
async function requireAccount(publisherId: string) {
  await requirePublisher(publisherId);
  const [account] = await db()
    .select()
    .from(publisherSendgridAccount)
    .where(eq(publisherSendgridAccount.publisherId, publisherId));
  if (!account?.encryptedManagementKey) fail("management_credentials_required");
  return account;
}
function clientFor(account: Account) {
  if (!account.encryptedManagementKey) fail("management_credentials_required");
  return new NewsletterSendgridClient({
    apiKey: decryptNewsletterSecret(account.encryptedManagementKey),
    region: account.region,
    allowProviderWrites: account.allowProviderWrites,
    allowIpReassignment: account.allowIpReassignment,
  });
}
function publicAccount(account: Account) {
  return {
    publisherId: account.publisherId,
    hasManagementKey: !!account.encryptedManagementKey,
    region: account.region,
    callbackBaseUrl: account.callbackBaseUrl,
    allowProviderWrites: account.allowProviderWrites,
    allowIpReassignment: account.allowIpReassignment,
    allowRealSends: account.allowRealSends,
    allTrafficControlled: account.allTrafficControlled,
    updatedAt: account.updatedAt,
  };
}
export function publicSendingConnection(connection: Connection) {
  return {
    id: connection.id,
    publisherId: connection.publisherId,
    newsletterId: connection.newsletterId,
    username: connection.username,
    administrativeEmail: connection.administrativeEmail,
    hasApiKey: !!connection.encryptedApiKey,
    apiKeyId: connection.apiKeyId,
    revision: connection.revision,
    senderDomains: connection.senderDomains,
    senderEmails: connection.senderEmails,
    hasWebhookKey: connection.webhookKeys.length > 0,
    status: connection.status,
    // Only this module writes provisioning, but never expose arbitrary stored JSON.
    provisioning: {
      inspectedAt:
        typeof connection.provisioning.inspectedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(connection.provisioning.inspectedAt)
          ? connection.provisioning.inspectedAt
          : undefined,
      ready: connection.provisioning.ready === true,
      findings: Array.isArray(connection.provisioning.findings)
        ? connection.provisioning.findings.filter(
            (value): value is string =>
              typeof value === "string" && /^[a-z_]+$/.test(value),
          )
        : [],
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function getSendingInfrastructure(publisherId: string) {
  await requirePublisher(publisherId);
  const [accounts, connections, ips, pools, memberships, bindings, routes] =
    await Promise.all([
      db()
        .select()
        .from(publisherSendgridAccount)
        .where(eq(publisherSendgridAccount.publisherId, publisherId)),
      db()
        .select()
        .from(sendingConnection)
        .where(eq(sendingConnection.publisherId, publisherId)),
      db()
        .select()
        .from(sendingIp)
        .where(eq(sendingIp.publisherId, publisherId)),
      db()
        .select()
        .from(sendingPool)
        .where(eq(sendingPool.publisherId, publisherId)),
      db()
        .select({ poolId: sendingPoolIp.poolId, ipId: sendingPoolIp.ipId })
        .from(sendingPoolIp)
        .innerJoin(sendingPool, eq(sendingPool.id, sendingPoolIp.poolId))
        .where(eq(sendingPool.publisherId, publisherId)),
      db()
        .select({
          id: sendingPoolBinding.id,
          connectionId: sendingPoolBinding.connectionId,
          poolId: sendingPoolBinding.poolId,
          providerPoolName: sendingPoolBinding.providerPoolName,
        })
        .from(sendingPoolBinding)
        .innerJoin(
          sendingConnection,
          eq(sendingConnection.id, sendingPoolBinding.connectionId),
        )
        .where(eq(sendingConnection.publisherId, publisherId)),
      db()
        .select({
          newsletterId: newsletterRoute.newsletterId,
          connectionId: newsletterRoute.connectionId,
          poolId: newsletterRoute.poolId,
          version: newsletterRoute.version,
          updatedAt: newsletterRoute.updatedAt,
        })
        .from(newsletterRoute)
        .innerJoin(
          newsletter,
          eq(newsletter.workspaceId, newsletterRoute.newsletterId),
        )
        .where(eq(newsletter.publisherId, publisherId)),
    ]);
  return {
    account: accounts[0] ? publicAccount(accounts[0]) : null,
    connections: connections.map(publicSendingConnection),
    ips,
    pools,
    memberships,
    bindings,
    routes,
  };
}

export async function configureSendgridAccount(
  input: ConfigureSendgridAccountInput,
) {
  await requirePublisher(input.publisherId);
  if (
    input.region !== undefined &&
    input.region !== "global" &&
    input.region !== "eu"
  )
    fail("invalid_sendgrid_region", 400);
  let baseUrl: string | undefined;
  if (input.callbackBaseUrl !== undefined) {
    try {
      const url = new URL(input.callbackBaseUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        fail("invalid_callback_origin", 400);
      baseUrl = url.origin;
    } catch {
      fail("invalid_callback_origin", 400);
    }
  }
  if (input.managementApiKey !== undefined)
    runtimeKeyId(input.managementApiKey);
  const values = {
    ...(input.managementApiKey !== undefined
      ? {
          encryptedManagementKey: encryptNewsletterSecret(
            input.managementApiKey,
          ),
        }
      : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(baseUrl !== undefined ? { callbackBaseUrl: baseUrl } : {}),
    ...(input.allowProviderWrites !== undefined
      ? { allowProviderWrites: input.allowProviderWrites }
      : {}),
    ...(input.allowIpReassignment !== undefined
      ? { allowIpReassignment: input.allowIpReassignment }
      : {}),
    ...(input.allowRealSends !== undefined
      ? { allowRealSends: input.allowRealSends }
      : {}),
    ...(input.allTrafficControlled !== undefined
      ? { allTrafficControlled: input.allTrafficControlled }
      : {}),
    updatedAt: new Date(),
  };
  if (input.managementApiKey) {
    const connections = await db()
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.publisherId, input.publisherId));
    for (const connection of connections) {
      if (
        connection.encryptedApiKey &&
        decryptNewsletterSecret(connection.encryptedApiKey) ===
          input.managementApiKey
      )
        fail("management_and_runtime_keys_must_differ", 400);
    }
  }
  const [account] = await db()
    .insert(publisherSendgridAccount)
    .values({ publisherId: input.publisherId, ...values })
    .onConflictDoUpdate({
      target: publisherSendgridAccount.publisherId,
      set: values,
    })
    .returning();
  return publicAccount(account!);
}

export async function createSendingConnection(
  input: CreateSendingConnectionInput,
) {
  const publication = await requireNewsletter(
    input.publisherId,
    input.newsletterId,
  );
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publication.slug) ||
    publication.slug.length > 50
  )
    fail("invalid_newsletter_slug", 400);
  const senderDomains = input.senderDomains?.map(domainName);
  const senderEmails = input.senderEmails?.map(mailbox);
  const apiKeyId = input.apiKey ? runtimeKeyId(input.apiKey) : input.apiKeyId;
  if (input.apiKeyId && apiKeyId !== input.apiKeyId)
    fail("api_key_id_mismatch", 400);
  if (input.apiKey) {
    const [account] = await db()
      .select()
      .from(publisherSendgridAccount)
      .where(eq(publisherSendgridAccount.publisherId, input.publisherId));
    if (
      account?.encryptedManagementKey &&
      decryptNewsletterSecret(account.encryptedManagementKey) === input.apiKey
    )
      fail("management_and_runtime_keys_must_differ", 400);
  }
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`newsletter-connection:${input.newsletterId}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.newsletterId, input.newsletterId));
    if (existing && existing.publisherId !== input.publisherId)
      fail("sending_connection_not_found", 404);
    if (
      existing &&
      input.apiKeyId &&
      !input.apiKey &&
      existing.apiKeyId !== input.apiKeyId
    )
      fail("runtime_credential_required", 400);
    const values = {
      ...(input.apiKey
        ? {
            encryptedApiKey: encryptNewsletterSecret(input.apiKey),
            apiKeyId: apiKeyId!,
          }
        : {}),
      ...(senderDomains ? { senderDomains } : {}),
      ...(senderEmails ? { senderEmails } : {}),
    };
    if (existing) {
      const changed =
        input.apiKey &&
        (!existing.encryptedApiKey ||
          decryptNewsletterSecret(existing.encryptedApiKey) !== input.apiKey);
      const [updated] = await tx
        .update(sendingConnection)
        .set({
          ...values,
          revision: changed ? existing.revision + 1 : existing.revision,
          status: "draft",
          provisioning: {},
          updatedAt: new Date(),
        })
        .where(eq(sendingConnection.id, existing.id))
        .returning();
      return publicSendingConnection(updated!);
    }
    const [created] = await tx
      .insert(sendingConnection)
      .values({
        publisherId: input.publisherId,
        newsletterId: input.newsletterId,
        username: `${publication.slug}-ditto`,
        administrativeEmail: `${publication.slug}@roninpublishing.com`,
        ...(apiKeyId ? { apiKeyId } : {}),
        ...values,
      })
      .returning();
    return publicSendingConnection(created!);
  });
}

async function keyMetadata(
  client: NewsletterSendgridClient,
  username: string,
  id: string,
) {
  try {
    const result = await client.request<
      SendgridApiKey | { result: SendgridApiKey[] }
    >("GET", `/api_keys/${encodeURIComponent(id)}`, undefined, username);
    return "result" in result
      ? result.result.find((key) => key.api_key_id === id)
      : result;
  } catch (error) {
    if (
      error instanceof NewsletterInfrastructureError &&
      error.statusCode === 404
    )
      return undefined;
    throw error;
  }
}
function restrictedKey(key: SendgridApiKey | undefined) {
  return (
    !!key &&
    !!key.scopes &&
    key.scopes.length === 1 &&
    key.scopes[0] === "mail.send"
  );
}
function domainSummary(domain: SendgridDomain) {
  return {
    id: domain.id,
    domain: domain.domain,
    subdomain: domain.subdomain,
    valid: domain.valid === true,
    dns: Object.values(domain.dns ?? {}).map((record) => ({
      type: record.type,
      host: record.host,
      data: record.data,
      valid: record.valid === true,
    })),
  };
}
async function inspectResources(
  client: NewsletterSendgridClient,
  username: string,
) {
  const subuser = await client.subuser(username);
  if (!subuser)
    return {
      subuser: null,
      keys: [],
      domains: [],
      senders: [],
      webhooks: [],
      ips: [],
      pools: [],
    };
  const [keys, domains, senderResult, webhookResult, ips, pools] =
    await Promise.all([
      client.apiKeys(username),
      client.list<SendgridDomain>(
        `/whitelabel/domains?username=${encodeURIComponent(username)}`,
      ),
      client.senders(username),
      client.request<{ webhooks: SendgridWebhook[] }>(
        "GET",
        "/user/webhooks/event/settings/all",
        undefined,
        username,
      ),
      client.list<SendgridIp>(`/ips?subuser=${encodeURIComponent(username)}`),
      client.request<{ name: string }[]>(
        "GET",
        "/ips/pools",
        undefined,
        username,
      ),
    ]);
  return {
    subuser,
    keys,
    domains: domains.filter(
      (domain) =>
        domain.username === username ||
        domain.subusers?.some((user) => user.username === username),
    ),
    senders: senderResult,
    webhooks: webhookResult.webhooks ?? [],
    ips,
    pools,
  };
}

/** Inspection never changes provider or registry state. Public keys/credentials stay internal. */
export async function inspectPublisherSendgrid({
  publisherId,
  username = PROTECTED_SUBUSER,
}: {
  publisherId: string;
  username?: string;
}) {
  const account = await requireAccount(publisherId);
  if (!/^[a-z0-9-]+$/.test(username)) fail("invalid_subuser_username", 400);
  const client = clientFor(account);
  const resources = await inspectResources(client, username);
  const keyScopes = await Promise.all(
    resources.keys.map(async (key) => ({
      id: key.api_key_id,
      restricted: restrictedKey(
        await keyMetadata(client, username, key.api_key_id),
      ),
    })),
  );
  return {
    subuser: resources.subuser
      ? {
          username: resources.subuser.username,
          disabled: resources.subuser.disabled,
          region: resources.subuser.region,
        }
      : null,
    keys: keyScopes,
    domains: resources.domains.map(domainSummary),
    senders: resources.senders.map((sender) => ({
      id: sender.id,
      verified: sender.verified,
    })),
    webhooks: resources.webhooks.map((webhook) => ({
      id: webhook.id,
      enabled: webhook.enabled,
      signed: !!webhook.public_key,
      configuredEvents: NEWSLETTER_WEBHOOK_EVENTS.filter(
        (event) => webhook[event] === true,
      ),
    })),
    ips: resources.ips.map((ip) => ({
      address: ip.ip,
      pools: ip.pools,
      reverseDnsVerified: ip.whitelabeled,
    })),
    pools: resources.pools.map((pool) => ({ name: pool.name })),
    administrativeGroup: {
      status: "external_metadata_unavailable",
      managed: false,
    },
  };
}

async function inspectConnectionState(input: ConnectionInput) {
  const connection = await requireConnection(input);
  const account = await requireAccount(input.publisherId);
  const client = clientFor(account);
  const resources = await inspectResources(client, connection.username);
  const expectedUrl = callbackUrl(account, connection.id);
  const webhook = resources.webhooks.find((row) => row.url === expectedUrl);
  const key =
    connection.apiKeyId && resources.subuser
      ? await keyMetadata(client, connection.username, connection.apiKeyId)
      : undefined;
  const domains = resources.domains.map(domainSummary);
  const allowedDomains = domains
    .filter((row) => row.valid)
    .map((row) => row.domain);
  const allowedEmails = resources.senders
    .filter((sender) => sender.verified)
    .map((sender) => sender.from_email);
  const identityReady =
    connection.senderDomains.every((domain) =>
      allowedDomains.includes(domain),
    ) &&
    connection.senderEmails.every(
      (email) =>
        allowedEmails.includes(email) ||
        allowedDomains.includes(email.split("@")[1]!),
    ) &&
    connection.senderDomains.length + connection.senderEmails.length > 0;
  const findings: string[] = [];
  if (!resources.subuser) findings.push("subuser_missing");
  if (resources.subuser?.disabled) findings.push("subuser_disabled");
  if (
    resources.subuser?.email !== connection.administrativeEmail &&
    resources.subuser
  )
    findings.push("administrative_identity_mismatch");
  if (resources.subuser?.region && resources.subuser.region !== account.region)
    findings.push("subuser_region_mismatch");
  if (!connection.encryptedApiKey)
    findings.push("runtime_credentials_required");
  if (!restrictedKey(key)) findings.push("restricted_key_required");
  if (!identityReady) findings.push("sender_identity_not_verified");
  if (!expectedUrl) findings.push("callback_origin_required");
  if (!expectedUrl || !webhookIsReady(webhook, expectedUrl))
    findings.push("signed_webhook_not_ready");
  const bindings = await db()
    .select()
    .from(sendingPoolBinding)
    .where(eq(sendingPoolBinding.connectionId, connection.id));
  const bindingStatus = await Promise.all(
    bindings.map(async (binding) => {
      const local = await localPool(input.publisherId, binding.poolId);
      const remote = await client.pool(
        binding.providerPoolName,
        connection.username,
      );
      const valid =
        local.ips.length === 1 &&
        remote?.ips.length === 1 &&
        remote.ips[0] === local.ips[0]?.address &&
        resources.ips.length === 1 &&
        resources.ips[0]?.ip === local.ips[0]?.address &&
        resources.ips[0]?.whitelabeled === true;
      return {
        poolId: binding.poolId,
        providerPoolName: binding.providerPoolName,
        valid,
      };
    }),
  );
  // Identity readiness is independent of routing; delivery requires a verified route separately.
  return {
    connection,
    account,
    resources,
    webhook,
    report: {
      connectionId: connection.id,
      username: connection.username,
      inspectedAt: new Date().toISOString(),
      ready: findings.length === 0,
      findings,
      domains,
      key: {
        present: !!key,
        restricted: restrictedKey(key),
        credentialStored: !!connection.encryptedApiKey,
      },
      webhook: {
        id: webhook?.id ?? null,
        enabled: webhook?.enabled === true,
        signed: !!webhook?.public_key,
        ready: !!expectedUrl && webhookIsReady(webhook, expectedUrl),
      },
      bindings: bindingStatus,
      ips: resources.ips.map((ip) => ({
        address: ip.ip,
        reverseDnsVerified: ip.whitelabeled,
      })),
    },
  };
}
export async function inspectSendgridConnection(input: ConnectionInput) {
  return (await inspectConnectionState(input)).report;
}
async function recordInspection(input: ConnectionInput) {
  const result = await inspectConnectionState(input);
  const previousKeys = result.connection.webhookKeys;
  const currentKey = result.webhook?.public_key;
  // Keep old verification keys briefly to process already signed in-flight callbacks.
  const webhookKeys = currentKey
    ? [
        { key: currentKey },
        ...previousKeys
          .filter(
            (row) =>
              row.key !== currentKey &&
              (!row.validUntil ||
                new Date(row.validUntil).getTime() > Date.now()),
          )
          .map((row) => ({
            key: row.key,
            validUntil:
              row.validUntil ??
              new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          })),
      ].slice(0, 3)
    : previousKeys;
  await db()
    .update(sendingConnection)
    .set({
      provisioning: result.report,
      webhookKeys,
      status: result.report.ready ? "ready" : "provisioning",
      updatedAt: new Date(),
    })
    .where(eq(sendingConnection.id, result.connection.id));
  return result.report;
}

// Holding a transaction advisory lock serializes reconcilers while each completed
// provider step is durably committed separately. After a crash, inspect before POST.
async function connectionLock<T>(
  input: ConnectionInput,
  action: () => Promise<T>,
) {
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`newsletter-provider:${input.connectionId}`}, 0))`,
    );
    await requireConnection(input);
    try {
      return await action();
    } catch (error) {
      await db()
        .update(sendingConnection)
        .set({
          status: "error",
          provisioning: {
            findings: [
              error instanceof NewsletterInfrastructureError
                ? error.code
                : "provisioning_failed",
            ],
          },
          updatedAt: new Date(),
        })
        .where(eq(sendingConnection.id, input.connectionId));
      if (error instanceof NewsletterInfrastructureError) throw error;
      throw new NewsletterInfrastructureError(502, "provisioning_failed");
    }
  });
}
function requireProviderMutation(account: Account, ipAssignment = false) {
  if (!account.allowProviderWrites) fail("provider_writes_disabled");
  if (ipAssignment && !account.allowIpReassignment)
    fail("ip_reassignment_disabled");
}

export async function provisionSendgridConnection(
  input: ProvisionConnectionInput,
) {
  return connectionLock(input, async () => {
    const connection = await requireConnection(input);
    const account = await requireAccount(input.publisherId);
    const client = clientFor(account);
    const existing = await client.subuser(connection.username);
    if (!existing) {
      if (connection.username === PROTECTED_SUBUSER)
        fail("existing_subuser_required");
      requireProviderMutation(account);
      requireNewsletterSecretKey();
      // Empty IP assignment deliberately avoids the separate IP reassignment gate.
      await client.request("POST", "/subusers", {
        username: connection.username,
        email: connection.administrativeEmail,
        password: `${randomBytes(32).toString("base64url")}Aa1!`,
        ips: [],
        region: account.region,
        include_region: true,
      });
    } else if (
      existing.email !== connection.administrativeEmail ||
      (existing.region && existing.region !== account.region)
    ) {
      fail("subuser_identity_conflict");
    }
    if (!connection.encryptedApiKey) {
      const keys = await client.apiKeys(connection.username);
      // The provider never reveals an existing key again. Never rotate or create
      // another key to hide a missing runtime credential, including a crash gap.
      if (
        keys.length ||
        connection.apiKeyId ||
        connection.username === PROTECTED_SUBUSER
      )
        fail("existing_runtime_key_must_be_adopted");
      requireProviderMutation(account);
      requireNewsletterSecretKey();
      const key = await client.request<SendgridApiKey>(
        "POST",
        "/api_keys",
        {
          name: `ronin-${connection.id}`,
          scopes: ["mail.send"],
        },
        connection.username,
      );
      if (
        !key.api_key ||
        !key.api_key_id ||
        !restrictedKey(key) ||
        runtimeKeyId(key.api_key) !== key.api_key_id
      )
        fail("invalid_provider_key_response", 502);
      await db()
        .update(sendingConnection)
        .set({
          encryptedApiKey: encryptNewsletterSecret(key.api_key),
          apiKeyId: key.api_key_id,
          status: "provisioning",
          updatedAt: new Date(),
        })
        .where(eq(sendingConnection.id, connection.id));
    }
    if (input.domain)
      await reconcileDomainUnlocked({ ...input, domain: input.domain });
    if (input.configureWebhook) await reconcileWebhookUnlocked(input);
    return recordInspection(input);
  });
}

async function reconcileDomainUnlocked(input: DomainInput) {
  const connection = await requireConnection(input);
  const account = await requireAccount(input.publisherId);
  const client = clientFor(account);
  const domain = domainName(input.domain);
  if (input.subdomain && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.subdomain))
    fail("invalid_return_path_subdomain", 400);
  let domains = await client.list<SendgridDomain>(
    `/whitelabel/domains?username=${encodeURIComponent(connection.username)}&domain=${encodeURIComponent(domain)}`,
  );
  let match = domains.find(
    (row) =>
      row.domain === domain &&
      (!input.subdomain || row.subdomain === input.subdomain) &&
      (row.username === connection.username ||
        row.subusers?.some((user) => user.username === connection.username)),
  );
  if (!match) {
    if (connection.username === PROTECTED_SUBUSER)
      fail("existing_domain_required");
    requireProviderMutation(account);
    match = await client.request<SendgridDomain>(
      "POST",
      "/whitelabel/domains",
      {
        domain,
        ...(input.subdomain ? { subdomain: input.subdomain } : {}),
        username: connection.username,
        automatic_security: true,
        default: false,
        region: account.region,
      },
    );
  }
  if (input.validate) {
    requireProviderMutation(account);
    await client.request(
      "POST",
      `/whitelabel/domains/${match.id}/validate`,
      undefined,
      connection.username,
    );
    domains = await client.list<SendgridDomain>(
      `/whitelabel/domains?username=${encodeURIComponent(connection.username)}&domain=${encodeURIComponent(domain)}`,
    );
    match = domains.find((row) => row.id === match!.id) ?? match;
  }
  if (!connection.senderDomains.includes(domain))
    await db()
      .update(sendingConnection)
      .set({
        senderDomains: [...connection.senderDomains, domain],
        status: "provisioning",
        updatedAt: new Date(),
      })
      .where(eq(sendingConnection.id, connection.id));
  return domainSummary(match);
}
export async function reconcileSendgridDomain(input: DomainInput) {
  return connectionLock(input, async () => {
    const domain = await reconcileDomainUnlocked(input);
    await recordInspection(input);
    return domain;
  });
}
async function reconcileWebhookUnlocked(input: ConnectionInput) {
  const connection = await requireConnection(input);
  const account = await requireAccount(input.publisherId);
  const client = clientFor(account);
  const url = callbackUrl(account, connection.id);
  if (!url) fail("callback_origin_required");
  const result = await client.request<{ webhooks: SendgridWebhook[] }>(
    "GET",
    "/user/webhooks/event/settings/all",
    undefined,
    connection.username,
  );
  let webhook = result.webhooks.find((row) => row.url === url);
  const body = {
    enabled: true,
    url,
    friendly_name: `ronin-${connection.id}`,
    ...Object.fromEntries(
      NEWSLETTER_WEBHOOK_EVENTS.map((event) => [event, true]),
    ),
  };
  if (!webhook) {
    requireProviderMutation(account);
    // Sign before activation, so no new callback is ever emitted unsigned.
    webhook = await client.request<SendgridWebhook>(
      "POST",
      "/user/webhooks/event/settings",
      { ...body, enabled: false },
      connection.username,
    );
  }
  if (!webhook.public_key) {
    requireProviderMutation(account);
    await client.request(
      "PATCH",
      `/user/webhooks/event/settings/signed/${encodeURIComponent(webhook.id)}`,
      { enabled: true },
      connection.username,
    );
  }
  if (
    !webhook.enabled ||
    NEWSLETTER_WEBHOOK_EVENTS.some((event) => webhook![event] !== true)
  ) {
    requireProviderMutation(account);
    await client.request(
      "PATCH",
      `/user/webhooks/event/settings/${encodeURIComponent(webhook.id)}`,
      body,
      connection.username,
    );
  }
}
export async function reconcileSendgridWebhook(input: ConnectionInput) {
  return connectionLock(input, async () => {
    await reconcileWebhookUnlocked(input);
    return recordInspection(input);
  });
}
export async function createSendgridSenderIdentity(input: SenderIdentityInput) {
  return connectionLock(input, async () => {
    const connection = await requireConnection(input);
    const account = await requireAccount(input.publisherId);
    const client = clientFor(account);
    const email = mailbox(input.fromEmail);
    const replyTo = mailbox(input.replyTo);
    const senders = await client.senders(connection.username);
    let sender = senders.find((row) => row.from_email === email);
    if (!sender) {
      requireProviderMutation(account);
      if (input.sendVerificationEmail !== true)
        fail("sender_verification_email_requires_confirmation", 400);
      sender = await client.request<SendgridSender>(
        "POST",
        "/verified_senders",
        {
          nickname: input.nickname,
          from_email: email,
          reply_to: replyTo,
          from_name: input.fromName,
          address: input.address,
          city: input.city,
          state: input.state,
          zip: input.zip,
          country: input.country,
        },
        connection.username,
      );
    }
    if (!connection.senderEmails.includes(email))
      await db()
        .update(sendingConnection)
        .set({
          senderEmails: [...connection.senderEmails, email],
          status: "provisioning",
          updatedAt: new Date(),
        })
        .where(eq(sendingConnection.id, connection.id));
    await recordInspection(input);
    return { id: sender.id, verified: sender.verified === true };
  });
}

async function localPool(publisherId: string, poolId: string) {
  const [pool] = await db()
    .select()
    .from(sendingPool)
    .where(
      and(eq(sendingPool.id, poolId), eq(sendingPool.publisherId, publisherId)),
    );
  if (!pool) fail("sending_pool_not_found", 404);
  const rows = await db()
    .select({ ip: sendingIp })
    .from(sendingPoolIp)
    .innerJoin(sendingIp, eq(sendingIp.id, sendingPoolIp.ipId))
    .where(eq(sendingPoolIp.poolId, poolId));
  if (rows.some((row) => row.ip.publisherId !== publisherId))
    fail("foreign_pool_ip", 409);
  return { pool, ips: rows.map((row) => row.ip) };
}
export async function upsertSendingIp(input: SendingIpInput) {
  await requirePublisher(input.publisherId);
  if (isIP(input.address) !== 4) fail("invalid_dedicated_ip", 400);
  const validLimit = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
  if (
    !["active", "paused"].includes(input.status) ||
    !validLimit(input.hourlyLimit) ||
    !validLimit(input.dailyLimit)
  )
    fail("invalid_ip_capacity", 400);
  const warmupSchedule = input.warmupSchedule ?? [];
  if (
    warmupSchedule.some(
      (step, index) =>
        !Number.isInteger(step.afterDays) ||
        step.afterDays < 0 ||
        !validLimit(step.hourlyLimit) ||
        !validLimit(step.dailyLimit) ||
        (index > 0 && step.afterDays <= warmupSchedule[index - 1]!.afterDays),
    )
  )
    fail("invalid_warmup_schedule", 400);
  const warmupStartedAt = input.warmupStartedAt
    ? new Date(input.warmupStartedAt)
    : null;
  if (warmupStartedAt && !Number.isFinite(warmupStartedAt.getTime()))
    fail("invalid_warmup_start", 400);
  const values = {
    address: input.address,
    status: input.status,
    hourlyLimit: input.hourlyLimit,
    dailyLimit: input.dailyLimit,
    warmupStartedAt,
    warmupSchedule,
    updatedAt: new Date(),
  };
  if (input.id) {
    const [existing] = await db()
      .select({ address: sendingIp.address })
      .from(sendingIp)
      .where(
        and(
          eq(sendingIp.id, input.id),
          eq(sendingIp.publisherId, input.publisherId),
        ),
      );
    if (!existing) fail("sending_ip_not_found", 404);
    // A physical-IP budget/queued reservation must never acquire a new address.
    if (existing.address !== input.address)
      fail("sending_ip_address_is_immutable", 400);
    const [row] = await db()
      .update(sendingIp)
      .set(values)
      .where(
        and(
          eq(sendingIp.id, input.id),
          eq(sendingIp.publisherId, input.publisherId),
        ),
      )
      .returning();
    if (!row) fail("sending_ip_not_found", 404);
    return row;
  }
  const [row] = await db()
    .insert(sendingIp)
    .values({ publisherId: input.publisherId, ...values })
    .onConflictDoUpdate({
      target: [sendingIp.publisherId, sendingIp.address],
      set: values,
    })
    .returning();
  return row!;
}
export async function upsertSendingPool(input: SendingPoolInput) {
  await requirePublisher(input.publisherId);
  poolName(input.name);
  const ipIds = [...new Set(input.ipIds)];
  if (ipIds.length !== input.ipIds.length) fail("duplicate_pool_ip", 400);
  const ips = ipIds.length
    ? await db()
        .select()
        .from(sendingIp)
        .where(
          and(
            eq(sendingIp.publisherId, input.publisherId),
            inArray(sendingIp.id, ipIds),
          ),
        )
    : [];
  if (ips.length !== ipIds.length) fail("sending_ip_not_found", 404);
  return db().transaction(async (tx) => {
    let id = input.id;
    if (id) {
      const [row] = await tx
        .update(sendingPool)
        .set({ name: input.name, updatedAt: new Date() })
        .where(
          and(
            eq(sendingPool.id, id),
            eq(sendingPool.publisherId, input.publisherId),
          ),
        )
        .returning();
      if (!row) fail("sending_pool_not_found", 404);
    } else {
      const [row] = await tx
        .insert(sendingPool)
        .values({ publisherId: input.publisherId, name: input.name })
        .onConflictDoUpdate({
          target: [sendingPool.publisherId, sendingPool.name],
          set: { updatedAt: new Date() },
        })
        .returning();
      id = row!.id;
    }
    await tx.delete(sendingPoolIp).where(eq(sendingPoolIp.poolId, id));
    if (ipIds.length)
      await tx
        .insert(sendingPoolIp)
        .values(ipIds.map((ipId) => ({ poolId: id!, ipId })));
    return { id, publisherId: input.publisherId, name: input.name, ipIds };
  });
}
export async function upsertPoolBinding(input: PoolBindingInput) {
  await requireConnection(input);
  await localPool(input.publisherId, input.poolId);
  poolName(input.providerPoolName);
  const [binding] = await db()
    .insert(sendingPoolBinding)
    .values({
      connectionId: input.connectionId,
      poolId: input.poolId,
      providerPoolName: input.providerPoolName,
    })
    .onConflictDoUpdate({
      target: [sendingPoolBinding.connectionId, sendingPoolBinding.poolId],
      set: { providerPoolName: input.providerPoolName },
    })
    .returning();
  return binding!;
}
export async function assignNewsletterRoute(input: NewsletterRouteInput) {
  const connection = await requireConnection(input);
  if (connection.newsletterId !== input.newsletterId)
    fail("connection_newsletter_mismatch", 400);
  const local = await localPool(input.publisherId, input.poolId);
  if (local.ips.length !== 1) fail("route_requires_single_ip", 400);
  const [binding] = await db()
    .select()
    .from(sendingPoolBinding)
    .where(
      and(
        eq(sendingPoolBinding.connectionId, input.connectionId),
        eq(sendingPoolBinding.poolId, input.poolId),
      ),
    );
  if (!binding) fail("provider_pool_binding_required");
  const [route] = await db()
    .insert(newsletterRoute)
    .values({
      newsletterId: input.newsletterId,
      connectionId: input.connectionId,
      poolId: input.poolId,
    })
    .onConflictDoUpdate({
      target: newsletterRoute.newsletterId,
      set: {
        connectionId: input.connectionId,
        poolId: input.poolId,
        version: sql`${newsletterRoute.version} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return route!;
}
export async function verifyPinnedNewsletterRouting(
  input: PinnedNewsletterRoutingInput,
): Promise<void> {
  const connection = await requireConnection(input);
  if (connection.newsletterId !== input.newsletterId)
    fail("connection_newsletter_mismatch");
  const local = await localPool(input.publisherId, input.poolId);
  if (local.ips.length !== 1 || local.ips[0]!.id !== input.ipId)
    fail("route_requires_single_ip");
  const account = await requireAccount(input.publisherId);
  const client = clientFor(account);
  const subuser = await client.subuser(connection.username);
  if (!subuser || subuser.disabled) fail("subuser_not_available");
  const [providerPool, assignedIps] = await Promise.all([
    client.pool(input.providerPoolName, connection.username),
    client.list<SendgridIp>(
      `/ips?subuser=${encodeURIComponent(connection.username)}`,
    ),
  ]);
  assertSingleIpRouting(
    local.ips[0]!.address,
    providerPool?.ips ?? [],
    assignedIps.map((ip) => ip.ip),
  );
  if (!assignedIps[0]?.whitelabeled) fail("ip_reverse_dns_not_verified");
}
export async function verifyNewsletterRouting(input: {
  publisherId: string;
  newsletterId: string;
}) {
  await requireNewsletter(input.publisherId, input.newsletterId);
  const [route] = await db()
    .select()
    .from(newsletterRoute)
    .where(eq(newsletterRoute.newsletterId, input.newsletterId));
  if (!route) fail("newsletter_route_required");
  const connection = await requireConnection({
    publisherId: input.publisherId,
    connectionId: route.connectionId,
  });
  const local = await localPool(input.publisherId, route.poolId);
  if (local.ips.length !== 1) fail("route_requires_single_ip");
  const [binding] = await db()
    .select()
    .from(sendingPoolBinding)
    .where(
      and(
        eq(sendingPoolBinding.connectionId, route.connectionId),
        eq(sendingPoolBinding.poolId, route.poolId),
      ),
    );
  if (!binding) fail("provider_pool_binding_required");
  await verifyPinnedNewsletterRouting({
    ...input,
    connectionId: route.connectionId,
    poolId: route.poolId,
    ipId: local.ips[0]!.id,
    providerPoolName: binding.providerPoolName,
    connectionRevision: connection.revision,
  });
  return {
    connectionId: route.connectionId,
    poolId: route.poolId,
    ipId: local.ips[0]!.id,
    address: local.ips[0]!.address,
    providerPoolName: binding.providerPoolName,
    routeVersion: route.version,
  };
}
export async function reconcileSendgridPool(input: PoolBindingInput) {
  return connectionLock(input, async () => {
    const connection = await requireConnection(input);
    const account = await requireAccount(input.publisherId);
    const client = clientFor(account);
    const local = await localPool(input.publisherId, input.poolId);
    poolName(input.providerPoolName);
    if (local.ips.length !== 1) fail("route_requires_single_ip", 400);
    let remote = await client.pool(input.providerPoolName, connection.username);
    if (!remote) {
      requireProviderMutation(account);
      await client.request(
        "POST",
        "/ips/pools",
        { name: input.providerPoolName },
        connection.username,
      );
      remote = { pool_name: input.providerPoolName, ips: [] };
    }
    if (
      remote.ips.some((ip) => ip !== local.ips[0]!.address) ||
      remote.ips.length > 1
    )
      fail("provider_routing_drift");
    if (!remote.ips.length) {
      requireProviderMutation(account, true);
      await client.request(
        "POST",
        `/ips/pools/${encodeURIComponent(input.providerPoolName)}/ips`,
        { ip: local.ips[0]!.address },
        connection.username,
        true,
      );
    }
    await upsertPoolBinding(input);
    return recordInspection(input);
  });
}
export async function reassignSendgridIps(
  input: ConnectionInput & { ipIds: string[]; confirm: true },
) {
  return connectionLock(input, async () => {
    const connection = await requireConnection(input);
    const account = await requireAccount(input.publisherId);
    requireProviderMutation(account, true);
    if (input.confirm !== true || input.ipIds.length !== 1)
      fail("explicit_single_ip_assignment_required", 400);
    const ips = await db()
      .select()
      .from(sendingIp)
      .where(
        and(
          eq(sendingIp.publisherId, input.publisherId),
          inArray(sendingIp.id, input.ipIds),
        ),
      );
    if (ips.length !== 1) fail("sending_ip_not_found", 404);
    const client = clientFor(account);
    const owned = await client.list<SendgridIp>(
      `/ips?ip=${encodeURIComponent(ips[0]!.address)}`,
    );
    if (!owned.some((row) => row.ip === ips[0]!.address))
      fail("ip_not_owned_by_provider_account");
    const current = await client.list<SendgridIp>(
      `/ips?subuser=${encodeURIComponent(connection.username)}`,
    );
    if (current.length !== 1 || current[0]!.ip !== ips[0]!.address) {
      await client.request(
        "PUT",
        `/subusers/${encodeURIComponent(connection.username)}/ips`,
        [ips[0]!.address],
        undefined,
        true,
      );
    }
    return recordInspection(input);
  });
}
