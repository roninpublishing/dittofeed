import { createHash, randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { EspSelection } from "isomorphic-lib/src/publications";
import { isIP } from "net";

import { db } from "./db";
import {
  newsletter,
  newsletterDefault,
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
} from "./newsletterSecrets";
import {
  NEWSLETTER_WEBHOOK_EVENTS,
  NewsletterInfrastructureError,
  NewsletterSendgridClient,
  SENDGRID_SELECTION_CAPABILITIES,
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
export interface ResolvedNewsletterSelection {
  selection: EspSelection;
  account: Account;
  connection: Connection;
  pool?: typeof sendingPool.$inferSelect;
  ips: (typeof sendingIp.$inferSelect)[];
  providerPoolName?: string;
}
export interface ConnectionInput {
  publisherId: string;
  connectionId: string;
}
export interface DomainInput extends ConnectionInput {
  domain: string;
  subdomain?: string;
  validate?: boolean;
}
export interface ConfigureSendgridAccountInput {
  publisherId: string;
  id?: string;
  name: string;
  provider: "SendGrid";
  managementApiKey?: string;
  apiKey?: string;
  username?: string;
  region?: "global" | "eu";
  callbackBaseUrl?: string;
  senderDomains?: string[];
  senderEmails?: string[];
}
export interface SendingIpInput {
  publisherId: string;
  id?: string;
  accountId?: string;
  address: string;
  status?: "active" | "paused";
  hourlyLimit?: number;
  dailyLimit?: number;
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
  accountId?: string;
  providerPoolName?: string;
  ipIds: string[];
}
export interface PoolBindingInput extends ConnectionInput {
  poolId: string;
  providerPoolName: string;
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
  await requireAccount(input.publisherId, row.accountId);
  return row;
}
export async function requireAccount(publisherId: string, accountId: string) {
  await requirePublisher(publisherId);
  const [account] = await db()
    .select()
    .from(publisherSendgridAccount)
    .where(
      and(
        eq(publisherSendgridAccount.publisherId, publisherId),
        eq(publisherSendgridAccount.id, accountId),
      ),
    );
  if (!account) fail("esp_account_not_found", 404);
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
function publicAccount(account: Account, connection?: Connection) {
  const resource = connection ? publicSendingConnection(connection) : undefined;
  return {
    id: account.id,
    publisherId: account.publisherId,
    name: account.name,
    provider: account.provider,
    hasManagementKey: !!account.encryptedManagementKey,
    hasApiKey: !!connection?.encryptedApiKey,
    region: account.region,
    callbackBaseUrl: account.callbackBaseUrl,
    allowProviderWrites: account.allowProviderWrites,
    allowIpReassignment: account.allowIpReassignment,
    allowRealSends: account.allowRealSends,
    allTrafficControlled: account.allTrafficControlled,
    status: connection?.status ?? "draft",
    connectionId: connection?.id,
    username: connection?.username || undefined,
    revision: account.revision,
    senderDomains: connection?.senderDomains ?? [],
    senderEmails: connection?.senderEmails ?? [],
    provisioning: resource?.provisioning ?? {
      inspectedAt: undefined,
      ready: false,
      findings: [],
      domains: [],
      key: undefined,
      webhook: undefined,
    },
    capabilities: SENDGRID_SELECTION_CAPABILITIES,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
export function publicSendingConnection(connection: Connection) {
  return {
    id: connection.id,
    publisherId: connection.publisherId,
    newsletterId: connection.newsletterId,
    accountId: connection.accountId,
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
      domains: Array.isArray(connection.provisioning.domains)
        ? connection.provisioning.domains.flatMap((value: unknown) => {
            if (
              !value ||
              typeof value !== "object" ||
              !("domain" in value) ||
              typeof value.domain !== "string" ||
              !("subdomain" in value) ||
              typeof value.subdomain !== "string"
            )
              return [];
            const dns =
              "dns" in value && Array.isArray(value.dns)
                ? value.dns.flatMap((item: unknown) => {
                    if (
                      !item ||
                      typeof item !== "object" ||
                      !("type" in item) ||
                      typeof item.type !== "string" ||
                      !("host" in item) ||
                      typeof item.host !== "string" ||
                      !("data" in item) ||
                      typeof item.data !== "string"
                    )
                      return [];
                    return [
                      {
                        type: item.type,
                        host: item.host,
                        data: item.data,
                        valid: "valid" in item && item.valid === true,
                      },
                    ];
                  })
                : [];
            return [
              {
                domain: value.domain,
                subdomain: value.subdomain,
                valid: "valid" in value && value.valid === true,
                dns,
              },
            ];
          })
        : [],
      key:
        connection.provisioning.key &&
        typeof connection.provisioning.key === "object"
          ? {
              present:
                "present" in connection.provisioning.key &&
                connection.provisioning.key.present === true,
              restricted:
                "restricted" in connection.provisioning.key &&
                connection.provisioning.key.restricted === true,
              credentialStored: !!connection.encryptedApiKey,
            }
          : undefined,
      webhook:
        connection.provisioning.webhook &&
        typeof connection.provisioning.webhook === "object"
          ? {
              enabled:
                "enabled" in connection.provisioning.webhook &&
                connection.provisioning.webhook.enabled === true,
              signed:
                "signed" in connection.provisioning.webhook &&
                connection.provisioning.webhook.signed === true,
              ready:
                "ready" in connection.provisioning.webhook &&
                connection.provisioning.webhook.ready === true,
            }
          : undefined,
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function getSendingInfrastructure(publisherId: string) {
  await requirePublisher(publisherId);
  const [accounts, connections, ips, pools, memberships, bindings, defaults] =
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
          newsletterId: newsletter.workspaceId,
          selection: newsletterDefault.selection,
        })
        .from(newsletter)
        .leftJoin(
          newsletterDefault,
          eq(newsletter.workspaceId, newsletterDefault.newsletterId),
        )
        .where(eq(newsletter.publisherId, publisherId)),
    ]);
  return {
    accounts: accounts.map((account) =>
      publicAccount(
        account,
        connections.find((connection) => connection.accountId === account.id),
      ),
    ),
    connections: connections.map(publicSendingConnection),
    ips,
    pools,
    memberships,
    bindings,
    defaults,
  };
}

export async function configureSendgridAccount(
  input: ConfigureSendgridAccountInput,
) {
  await requirePublisher(input.publisherId);
  if (input.provider !== "SendGrid") fail("unsupported_esp_provider", 400);
  if (!input.name.trim() || input.name.length > 256)
    fail("invalid_account_name", 400);
  if (
    input.username !== undefined &&
    !/^[a-zA-Z0-9_-]{0,64}$/.test(input.username)
  )
    fail("invalid_subuser_username", 400);
  if (input.region !== undefined && !["global", "eu"].includes(input.region))
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
  const apiKeyId =
    input.apiKey !== undefined ? runtimeKeyId(input.apiKey) : undefined;
  const senderDomains = input.senderDomains?.map(domainName);
  const senderEmails = input.senderEmails?.map(mailbox);
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`esp-account:${input.publisherId}:${input.id ?? "new"}`}, 0))`,
    );
    const existing = input.id
      ? await requireAccount(input.publisherId, input.id)
      : undefined;
    const [connection] = existing
      ? await tx
          .select()
          .from(sendingConnection)
          .where(eq(sendingConnection.accountId, existing.id))
      : [];
    if (existing && !connection) fail("account_connection_required");
    if (
      connection?.encryptedApiKey &&
      input.username !== undefined &&
      input.username !== connection.username
    )
      fail("credential_owner_is_immutable", 400);
    const managementKey =
      input.managementApiKey ??
      (existing?.encryptedManagementKey
        ? decryptNewsletterSecret(existing.encryptedManagementKey)
        : undefined);
    const runtimeKey =
      input.apiKey ??
      (connection?.encryptedApiKey
        ? decryptNewsletterSecret(connection.encryptedApiKey)
        : undefined);
    if (managementKey && managementKey === runtimeKey)
      fail("management_and_runtime_keys_must_differ", 400);
    const configurationChanged =
      !existing ||
      (input.managementApiKey !== undefined &&
        (!existing.encryptedManagementKey ||
          input.managementApiKey !==
            decryptNewsletterSecret(existing.encryptedManagementKey))) ||
      (input.apiKey !== undefined &&
        (!connection?.encryptedApiKey ||
          decryptNewsletterSecret(connection.encryptedApiKey) !==
            input.apiKey)) ||
      (input.region !== undefined && input.region !== existing.region) ||
      (baseUrl !== undefined && baseUrl !== existing.callbackBaseUrl) ||
      (input.username !== undefined &&
        input.username !== connection?.username) ||
      (senderDomains !== undefined &&
        JSON.stringify(senderDomains) !==
          JSON.stringify(connection?.senderDomains)) ||
      (senderEmails !== undefined &&
        JSON.stringify(senderEmails) !==
          JSON.stringify(connection?.senderEmails));
    const id = existing?.id ?? randomUUID();
    const accountValues = {
      name: input.name.trim(),
      provider: input.provider,
      ...(input.managementApiKey !== undefined
        ? {
            encryptedManagementKey: encryptNewsletterSecret(
              input.managementApiKey,
            ),
          }
        : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(baseUrl !== undefined ? { callbackBaseUrl: baseUrl } : {}),
      revision: existing
        ? existing.revision + (configurationChanged ? 1 : 0)
        : 1,
      updatedAt: new Date(),
    };
    const [account] = existing
      ? await tx
          .update(publisherSendgridAccount)
          .set(accountValues)
          .where(eq(publisherSendgridAccount.id, id))
          .returning()
      : await tx
          .insert(publisherSendgridAccount)
          .values({ id, publisherId: input.publisherId, ...accountValues })
          .returning();
    const connectionValues = {
      ...(input.apiKey !== undefined
        ? { encryptedApiKey: encryptNewsletterSecret(input.apiKey), apiKeyId }
        : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(senderDomains !== undefined ? { senderDomains } : {}),
      ...(senderEmails !== undefined ? { senderEmails } : {}),
      ...(configurationChanged
        ? { status: "draft" as const, provisioning: {} }
        : {}),
      revision: connection
        ? connection.revision + (configurationChanged ? 1 : 0)
        : 1,
      updatedAt: new Date(),
    };
    const [resource] = connection
      ? await tx
          .update(sendingConnection)
          .set(connectionValues)
          .where(eq(sendingConnection.id, connection.id))
          .returning()
      : await tx
          .insert(sendingConnection)
          .values({
            publisherId: input.publisherId,
            accountId: id,
            username: input.username ?? "",
            administrativeEmail: "",
            ...connectionValues,
          })
          .returning();
    return publicAccount(account!, resource);
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
    valid: domain.valid,
    dns: Object.values(domain.dns ?? {}).map((record) => ({
      type: record.type,
      host: record.host,
      data: record.data,
      valid: record.valid,
    })),
  };
}
async function inspectResources(
  client: NewsletterSendgridClient,
  username: string,
) {
  const subuser = username ? await client.subuser(username) : null;
  if (username && !subuser)
    return {
      subuser: null,
      keys: [],
      domains: [],
      senders: [],
      webhooks: [],
      ips: [],
      pools: [],
    };
  const ownerUsername = await client.identityUsername(username);
  const [keys, domains, senderResult, webhookResult, ips, pools] =
    await Promise.all([
      client.apiKeys(username),
      client.list<SendgridDomain>(
        `/whitelabel/domains?username=${encodeURIComponent(ownerUsername)}`,
      ),
      client.senders(username),
      client.request<{ webhooks: SendgridWebhook[] }>(
        "GET",
        "/user/webhooks/event/settings/all",
        undefined,
        username,
      ),
      username
        ? client.list<SendgridIp>(
            `/ips?subuser=${encodeURIComponent(username)}`,
          )
        : client.list<SendgridIp>("/ips/assigned"),
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
        domain.username === ownerUsername ||
        domain.subusers?.some((user) => user.username === ownerUsername),
    ),
    senders: senderResult,
    webhooks: webhookResult.webhooks ?? [],
    ips,
    pools,
  };
}

/** Account inspection changes no provider resources and stores verified readiness. */
export async function inspectSendgridAccount(input: {
  publisherId: string;
  accountId: string;
}) {
  await requireAccount(input.publisherId, input.accountId);
  const [connection] = await db()
    .select()
    .from(sendingConnection)
    .where(eq(sendingConnection.accountId, input.accountId));
  if (!connection) fail("account_connection_required");
  try {
    return {
      accountId: input.accountId,
      ...(await recordInspection({
        publisherId: input.publisherId,
        connectionId: connection.id,
      })),
    };
  } catch (error) {
    const report = {
      accountId: input.accountId,
      connectionId: connection.id,
      username: connection.username,
      inspectedAt: new Date().toISOString(),
      ready: false,
      findings: [
        error instanceof NewsletterInfrastructureError
          ? error.code
          : "inspection_failed",
      ],
      domains: [],
      bindings: [],
      ips: [],
      key: {
        present: false,
        restricted: false,
        credentialStored: !!connection.encryptedApiKey,
      },
      webhook: { id: null, enabled: false, signed: false, ready: false },
    };
    await db()
      .update(sendingConnection)
      .set({ provisioning: report, status: "error", updatedAt: new Date() })
      .where(eq(sendingConnection.id, connection.id));
    return report;
  }
}

async function inspectConnectionState(input: ConnectionInput) {
  const connection = await requireConnection(input);
  const account = await requireAccount(input.publisherId, connection.accountId);
  const client = clientFor(account);
  const resources = await inspectResources(client, connection.username);
  const localIps = await db()
    .select()
    .from(sendingIp)
    .where(eq(sendingIp.accountId, account.id));
  if (localIps.length) {
    await db().transaction(async (tx) => {
      const roots = [...new Set(localIps.map((ip) => ip.canonicalIpId))].sort();
      await tx
        .select({ id: sendingIp.id })
        .from(sendingIp)
        .where(inArray(sendingIp.id, roots))
        .orderBy(sendingIp.id)
        .for("update");
      const verifiedAt = new Date();
      for (const ip of localIps) {
        const verified = resources.ips.some(
          (remote) => remote.ip === ip.address && remote.whitelabeled,
        );
        await tx
          .update(sendingIp)
          .set({
            providerVerifiedAt: verified ? verifiedAt : null,
            verifiedAccountRevision: verified ? account.revision : null,
          })
          .where(eq(sendingIp.id, ip.id));
      }
    });
  }
  const expectedUrl = callbackUrl(account, connection.id);
  const webhook = resources.webhooks.find((row) => row.url === expectedUrl);
  const key =
    connection.apiKeyId && (!connection.username || resources.subuser)
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
  if (connection.username && !resources.subuser)
    findings.push("subuser_missing");
  if (resources.subuser?.disabled) findings.push("subuser_disabled");
  if (
    connection.administrativeEmail &&
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
        local.pool.accountId === connection.accountId &&
        local.pool.providerPoolName === binding.providerPoolName &&
        sameAddresses(
          local.ips.map((ip) => ip.address),
          remote?.ips ?? [],
        ) &&
        local.ips.every((ip) =>
          resources.ips.some(
            (remoteIp) => remoteIp.ip === ip.address && remoteIp.whitelabeled,
          ),
        );
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
  return recordInspection(input);
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

async function reconcileDomainUnlocked(input: DomainInput) {
  const connection = await requireConnection(input);
  const account = await requireAccount(input.publisherId, connection.accountId);
  const client = clientFor(account);
  const domain = domainName(input.domain);
  const ownerUsername = await client.identityUsername(connection.username);
  if (input.subdomain && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.subdomain))
    fail("invalid_return_path_subdomain", 400);
  let domains = await client.list<SendgridDomain>(
    `/whitelabel/domains?username=${encodeURIComponent(ownerUsername)}&domain=${encodeURIComponent(domain)}`,
  );
  let match = domains.find(
    (row) =>
      row.domain === domain &&
      (!input.subdomain || row.subdomain === input.subdomain) &&
      (row.username === ownerUsername ||
        row.subusers?.some((user) => user.username === ownerUsername)),
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
        ...(connection.username ? { username: connection.username } : {}),
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
      `/whitelabel/domains?username=${encodeURIComponent(ownerUsername)}&domain=${encodeURIComponent(domain)}`,
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
  const account = await requireAccount(input.publisherId, connection.accountId);
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
    NEWSLETTER_WEBHOOK_EVENTS.some((event) => webhook[event] !== true)
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
    const account = await requireAccount(
      input.publisherId,
      connection.accountId,
    );
    const client = clientFor(account);
    const email = mailbox(input.fromEmail);
    const replyTo = mailbox(input.replyTo);
    const senders = await client.senders(connection.username);
    let sender = senders.find((row) => row.from_email === email);
    if (!sender) {
      requireProviderMutation(account);
      if (!input.sendVerificationEmail)
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
    return { id: sender.id, verified: sender.verified };
  });
}

function sameAddresses(left: string[], right: string[]) {
  return (
    left.length > 0 &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((address) => right.includes(address))
  );
}
async function localPool(
  publisherId: string,
  poolId: string,
  accountId?: string,
) {
  const [pool] = await db()
    .select()
    .from(sendingPool)
    .where(
      and(eq(sendingPool.id, poolId), eq(sendingPool.publisherId, publisherId)),
    );
  if (!pool) fail("sending_pool_not_found", 404);
  if (accountId && pool.accountId !== accountId)
    fail("pool_account_mismatch", 400);
  const rows = await db()
    .select({ ip: sendingIp })
    .from(sendingPoolIp)
    .innerJoin(sendingIp, eq(sendingIp.id, sendingPoolIp.ipId))
    .where(eq(sendingPoolIp.poolId, poolId));
  if (
    rows.some(
      ({ ip }) =>
        ip.publisherId !== publisherId || ip.accountId !== pool.accountId,
    )
  )
    fail("foreign_pool_ip");
  return { pool, ips: rows.map(({ ip }) => ip) };
}
export async function upsertSendingIp(input: SendingIpInput) {
  await requirePublisher(input.publisherId);
  if (isIP(input.address) !== 4) fail("invalid_dedicated_ip", 400);
  const [existing] = input.id
    ? await db()
        .select()
        .from(sendingIp)
        .where(
          and(
            eq(sendingIp.id, input.id),
            eq(sendingIp.publisherId, input.publisherId),
          ),
        )
    : [];
  if (input.id && !existing) fail("sending_ip_not_found", 404);
  const accountId = existing?.accountId ?? input.accountId;
  if (!accountId) fail("account_id_required", 400);
  if (existing && input.accountId && input.accountId !== existing.accountId)
    fail("ip_account_is_immutable", 400);
  await requireAccount(input.publisherId, accountId);
  if (existing && existing.address !== input.address)
    fail("sending_ip_address_is_immutable", 400);
  const validLimit = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
  if (
    (input.status !== undefined &&
      !["active", "paused"].includes(input.status)) ||
    (input.hourlyLimit !== undefined && !validLimit(input.hourlyLimit)) ||
    (input.dailyLimit !== undefined && !validLimit(input.dailyLimit))
  )
    fail("invalid_ip_capacity", 400);
  const { warmupSchedule } = input;
  if (
    warmupSchedule?.some(
      (step, index) =>
        !Number.isInteger(step.afterDays) ||
        step.afterDays < 0 ||
        !validLimit(step.hourlyLimit) ||
        !validLimit(step.dailyLimit) ||
        (index > 0 && step.afterDays <= warmupSchedule[index - 1]!.afterDays),
    )
  )
    fail("invalid_warmup_schedule", 400);
  const warmupStartedAt =
    input.warmupStartedAt === undefined
      ? undefined
      : input.warmupStartedAt === null
        ? null
        : new Date(input.warmupStartedAt);
  if (warmupStartedAt && !Number.isFinite(warmupStartedAt.getTime()))
    fail("invalid_warmup_start", 400);
  // Undefined policy fields are omitted from UPDATE, including conflict retries.
  const changes = {
    address: input.address,
    status:
      input.status === "active"
        ? sql<
            "active" | "paused"
          >`case when ${input.hourlyLimit ?? sql`${sendingIp.hourlyLimit}`} > 0 and ${input.dailyLimit ?? sql`${sendingIp.dailyLimit}`} > 0 then 'active' else 'paused' end`
        : input.status,
    hourlyLimit: input.hourlyLimit,
    dailyLimit: input.dailyLimit,
    warmupStartedAt,
    warmupSchedule,
    updatedAt: new Date(),
  };
  return db().transaction(async (tx) => {
    if (existing?.canonicalIpId)
      await tx
        .select({ id: sendingIp.id })
        .from(sendingIp)
        .where(eq(sendingIp.id, existing.canonicalIpId))
        .for("update");
    const id = existing?.id ?? randomUUID();
    const [row] = existing
      ? await tx
          .update(sendingIp)
          .set(changes)
          .where(eq(sendingIp.id, existing.id))
          .returning()
      : await tx
          .insert(sendingIp)
          .values({
            id,
            canonicalIpId: id,
            publisherId: input.publisherId,
            accountId,
            address: input.address,
            status:
              input.hourlyLimit && input.dailyLimit
                ? input.status ?? "paused"
                : "paused",
            hourlyLimit: input.hourlyLimit ?? 0,
            dailyLimit: input.dailyLimit ?? 0,
            warmupStartedAt,
            warmupSchedule,
          })
          .onConflictDoUpdate({
            target: [sendingIp.accountId, sendingIp.address],
            set: changes,
          })
          .returning();
    return row!;
  });
}
export async function upsertSendingPool(input: SendingPoolInput) {
  await requirePublisher(input.publisherId);
  const name = input.name.trim();
  if (!name || name.length > 64) fail("invalid_pool_name", 400);
  const [existing] = input.id
    ? await db()
        .select()
        .from(sendingPool)
        .where(
          and(
            eq(sendingPool.id, input.id),
            eq(sendingPool.publisherId, input.publisherId),
          ),
        )
    : [];
  if (input.id && !existing) fail("sending_pool_not_found", 404);
  const accountId = existing?.accountId ?? input.accountId;
  if (!accountId) fail("account_id_required", 400);
  if (existing && input.accountId && input.accountId !== accountId)
    fail("pool_account_is_immutable", 400);
  await requireAccount(input.publisherId, accountId);
  const providerPoolName = poolName(
    input.providerPoolName ??
      existing?.providerPoolName ??
      `pool-${createHash("sha256").update(`${accountId}:${name}`).digest("hex").slice(0, 40)}`,
  );
  const ipIds = [...new Set(input.ipIds)];
  if (ipIds.length !== input.ipIds.length) fail("duplicate_pool_ip", 400);
  const ips = ipIds.length
    ? await db()
        .select()
        .from(sendingIp)
        .where(
          and(
            eq(sendingIp.publisherId, input.publisherId),
            eq(sendingIp.accountId, accountId),
            inArray(sendingIp.id, ipIds),
          ),
        )
    : [];
  if (ips.length !== ipIds.length) fail("pool_ip_account_mismatch", 400);
  return db().transaction(async (tx) => {
    const values = { name, providerPoolName, updatedAt: new Date() };
    const [row] = existing
      ? await tx
          .update(sendingPool)
          .set(values)
          .where(eq(sendingPool.id, existing.id))
          .returning()
      : await tx
          .insert(sendingPool)
          .values({ publisherId: input.publisherId, accountId, ...values })
          .onConflictDoUpdate({
            target: [sendingPool.accountId, sendingPool.name],
            set: {
              ...values,
              providerPoolName:
                input.providerPoolName === undefined
                  ? sql`${sendingPool.providerPoolName}`
                  : providerPoolName,
            },
          })
          .returning();
    if (existing && existing.providerPoolName !== providerPoolName)
      await tx
        .delete(sendingPoolBinding)
        .where(eq(sendingPoolBinding.poolId, existing.id));
    await tx.delete(sendingPoolIp).where(eq(sendingPoolIp.poolId, row!.id));
    if (ipIds.length)
      await tx
        .insert(sendingPoolIp)
        .values(ipIds.map((ipId) => ({ poolId: row!.id, ipId })));
    return { ...row!, ipIds };
  });
}
export async function upsertPoolBinding(input: PoolBindingInput) {
  const connection = await requireConnection(input);
  const local = await localPool(
    input.publisherId,
    input.poolId,
    connection.accountId,
  );
  if (local.pool.providerPoolName !== poolName(input.providerPoolName))
    fail("provider_pool_name_mismatch", 400);
  const [binding] = await db()
    .insert(sendingPoolBinding)
    .values({
      connectionId: connection.id,
      poolId: local.pool.id,
      providerPoolName: input.providerPoolName,
    })
    .onConflictDoUpdate({
      target: [sendingPoolBinding.connectionId, sendingPoolBinding.poolId],
      set: { providerPoolName: input.providerPoolName },
    })
    .returning();
  return binding!;
}
async function selectionResources(
  publisherId: string,
  selection: EspSelection,
): Promise<ResolvedNewsletterSelection> {
  const account = await requireAccount(publisherId, selection.accountId);
  const [connection] = await db()
    .select()
    .from(sendingConnection)
    .where(
      and(
        eq(sendingConnection.accountId, account.id),
        eq(sendingConnection.publisherId, publisherId),
      ),
    );
  if (!connection) fail("account_connection_required");
  if (selection.mode === "pool") {
    const local = await localPool(publisherId, selection.poolId, account.id);
    if (!local.ips.length) fail("pool_has_no_ips");
    return {
      selection,
      account,
      connection,
      ...local,
      providerPoolName: local.pool.providerPoolName,
    };
  }
  const ips = await db()
    .select()
    .from(sendingIp)
    .where(
      and(
        eq(sendingIp.publisherId, publisherId),
        eq(sendingIp.accountId, account.id),
      ),
    );
  if (selection.mode === "automatic")
    return {
      selection,
      account,
      connection,
      ips,
      pool: undefined,
      providerPoolName: undefined,
    };
  if (selection.mode !== "ip") fail("unsupported_esp_selection", 400);
  const ip = ips.find((row) => row.id === selection.ipId);
  if (!ip) fail("ip_account_mismatch", 400);
  const memberships = await db()
    .select({ pool: sendingPool, ipId: sendingPoolIp.ipId })
    .from(sendingPool)
    .innerJoin(sendingPoolIp, eq(sendingPoolIp.poolId, sendingPool.id))
    .where(eq(sendingPool.accountId, account.id))
    .orderBy(sendingPool.id);
  const pool = memberships.find(
    (row) =>
      row.ipId === ip.id &&
      memberships.filter((member) => member.pool.id === row.pool.id).length ===
        1,
  )?.pool;
  if (!pool) fail("ip_requires_singleton_provider_pool");
  return {
    selection,
    account,
    connection,
    pool,
    ips: [ip],
    providerPoolName: pool.providerPoolName,
  };
}
export async function getNewsletterDefaultSelection(input: {
  publisherId: string;
  newsletterId: string;
}): Promise<EspSelection | null> {
  await requireNewsletter(input.publisherId, input.newsletterId);
  const [row] = await db()
    .select()
    .from(newsletterDefault)
    .where(eq(newsletterDefault.newsletterId, input.newsletterId));
  return row?.selection ?? null;
}
export async function upsertNewsletterDefault(input: {
  publisherId: string;
  newsletterId: string;
  selection: EspSelection | null;
}) {
  await requireNewsletter(input.publisherId, input.newsletterId);
  if (input.selection)
    await selectionResources(input.publisherId, input.selection);
  const [row] = await db()
    .insert(newsletterDefault)
    .values({ newsletterId: input.newsletterId, selection: input.selection })
    .onConflictDoUpdate({
      target: newsletterDefault.newsletterId,
      set: { selection: input.selection, updatedAt: new Date() },
    })
    .returning();
  return { newsletterId: row!.newsletterId, selection: row!.selection };
}
export async function getNewsletterSendingOptions(newsletterId: string) {
  const [publication] = await db()
    .select()
    .from(newsletter)
    .where(eq(newsletter.workspaceId, newsletterId));
  if (!publication) fail("newsletter_not_found", 404);
  const inventory = await getSendingInfrastructure(publication.publisherId);
  return {
    accounts: inventory.accounts.map(
      ({
        id,
        name,
        provider,
        status,
        senderDomains,
        senderEmails,
        capabilities,
      }) => ({
        id,
        name,
        provider,
        status,
        senderDomains,
        senderEmails,
        capabilities,
      }),
    ),
    ips: inventory.ips.map(({ id, accountId, address, status }) => ({
      id,
      accountId,
      address,
      status,
      eligibleSingletonPool: inventory.memberships.some(
        (member) =>
          member.ipId === id &&
          inventory.memberships.filter(
            (other) => other.poolId === member.poolId,
          ).length === 1,
      ),
    })),
    pools: inventory.pools.map(({ id, accountId, name, providerPoolName }) => ({
      id,
      accountId,
      name,
      providerPoolName,
    })),
    memberships: inventory.memberships,
    selection: await getNewsletterDefaultSelection({
      publisherId: publication.publisherId,
      newsletterId,
    }),
  };
}
export async function resolveNewsletterSelection(input: {
  publisherId: string;
  newsletterId: string;
  selection?: EspSelection | null;
}) {
  await requireNewsletter(input.publisherId, input.newsletterId);
  const selection =
    input.selection === undefined
      ? await getNewsletterDefaultSelection(input)
      : input.selection;
  if (!selection) fail("esp_selection_required", 400);
  const resolved = await selectionResources(input.publisherId, selection);
  if (
    resolved.connection.status !== "ready" ||
    !resolved.connection.encryptedApiKey
  )
    fail("esp_account_not_ready");
  await verifyResolvedSelection(resolved);
  return resolved;
}
async function verifyResolvedSelection(resolved: ResolvedNewsletterSelection) {
  const { account, connection, selection, ips, providerPoolName } = resolved;
  if (!ips.length) fail("provider_capacity_inventory_required");
  if (ips.some((ip) => ip.status !== "active")) fail("selected_ip_paused");
  const inspected = await inspectConnectionState({
    publisherId: account.publisherId,
    connectionId: connection.id,
  });
  if (!inspected.report.ready) fail("esp_account_not_ready");
  const assigned = inspected.resources.ips;
  if (
    selection.mode === "automatic" &&
    !sameAddresses(
      ips.map((ip) => ip.address),
      assigned.map((ip) => ip.ip),
    )
  )
    fail("automatic_capacity_inventory_incomplete");
  if (
    ips.some(
      (ip) =>
        !assigned.some(
          (remote) => remote.ip === ip.address && remote.whitelabeled,
        ),
    )
  )
    fail("provider_ip_not_ready");
  if (providerPoolName) {
    const remote = await clientFor(account).pool(
      providerPoolName,
      connection.username,
    );
    if (
      !sameAddresses(
        ips.map((ip) => ip.address),
        remote?.ips ?? [],
      )
    )
      fail("provider_routing_drift");
  }
}
export async function verifyPinnedNewsletterSelection(input: {
  publisherId: string;
  accountId: string;
  connectionId: string;
  connectionRevision: number;
  accountRevision?: number;
  selection: EspSelection;
  candidateIpIds: string[];
  providerPoolName?: string;
}) {
  if (input.accountId !== input.selection.accountId)
    fail("pinned_account_mismatch");
  const resolved = await selectionResources(input.publisherId, input.selection);
  if (
    resolved.connection.id !== input.connectionId ||
    resolved.connection.revision !== input.connectionRevision ||
    (input.accountRevision !== undefined &&
      resolved.account.revision !== input.accountRevision)
  )
    fail("pinned_credential_revision_changed");
  if (
    resolved.providerPoolName !== input.providerPoolName ||
    !sameAddresses(
      resolved.ips.map((ip) => ip.id),
      input.candidateIpIds,
    )
  )
    fail("pinned_selection_changed");
  await verifyResolvedSelection(resolved);
}
export async function reconcileSendgridPool(input: PoolBindingInput) {
  return connectionLock(input, async () => {
    const connection = await requireConnection(input);
    const account = await requireAccount(
      input.publisherId,
      connection.accountId,
    );
    const client = clientFor(account);
    const local = await localPool(input.publisherId, input.poolId, account.id);
    if (local.pool.providerPoolName !== poolName(input.providerPoolName))
      fail("provider_pool_name_mismatch", 400);
    if (!local.ips.length) fail("pool_has_no_ips");
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
      remote.ips.some(
        (address) => !local.ips.some((ip) => ip.address === address),
      )
    )
      fail("provider_routing_drift");
    for (const ip of local.ips) {
      if (remote.ips.includes(ip.address)) continue;
      requireProviderMutation(account, true);
      await client.request(
        "POST",
        `/ips/pools/${encodeURIComponent(input.providerPoolName)}/ips`,
        { ip: ip.address },
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
    const account = await requireAccount(
      input.publisherId,
      connection.accountId,
    );
    requireProviderMutation(account, true);
    if (
      !input.confirm ||
      !input.ipIds.length ||
      new Set(input.ipIds).size !== input.ipIds.length
    )
      fail("explicit_ip_assignment_required", 400);
    if (!connection.username) fail("parent_ip_reassignment_unsupported", 400);
    const ips = await db()
      .select()
      .from(sendingIp)
      .where(
        and(
          eq(sendingIp.publisherId, input.publisherId),
          eq(sendingIp.accountId, account.id),
          inArray(sendingIp.id, input.ipIds),
        ),
      );
    if (ips.length !== input.ipIds.length) fail("ip_account_mismatch", 400);
    const client = clientFor(account);
    const owned = await client.list<SendgridIp>("/ips");
    if (ips.some((ip) => !owned.some((remote) => remote.ip === ip.address)))
      fail("ip_not_owned_by_provider_account");
    const current = await client.list<SendgridIp>(
      `/ips?subuser=${encodeURIComponent(connection.username)}`,
    );
    if (
      !sameAddresses(
        ips.map((ip) => ip.address),
        current.map((ip) => ip.ip),
      )
    )
      await client.request(
        "PUT",
        `/subusers/${encodeURIComponent(connection.username)}/ips`,
        ips.map((ip) => ip.address),
        undefined,
        true,
      );
    return recordInspection(input);
  });
}
