import axios from "axios";
import { Pool } from "pg";

import { NewsletterCiphertext } from "../src/db/publisherSchema";
import {
  decryptNewsletterSecret,
  requireNewsletterSecretKey,
} from "../src/newsletterSecrets";
import {
  NewsletterSendgridClient,
  NEWSLETTER_WEBHOOK_EVENTS,
  SendgridApiKey,
  SendgridDomain,
  SendgridIp,
  SendgridWebhook,
} from "../src/newsletterSendgrid";

// Read-only by construction: the database transaction prohibits writes and the
// provider client has every write gate closed. Do not import a provisioner here.
const username = "aistocknews-ditto";
interface RegistryRow {
  publisherId: string;
  encryptedManagementKey: NewsletterCiphertext | null;
  region: "global" | "eu";
  callbackBaseUrl: string | null;
  connectionId: string | null;
  encryptedApiKey: NewsletterCiphertext | null;
  apiKeyId: string | null;
}
async function main() {
  let findings = 0;
  let incomplete = false;
  let registry: RegistryRow | undefined;
  const report = (code: string, count?: number) =>
    console.log(
      JSON.stringify({ code, ...(count === undefined ? {} : { count }) }),
    );
  if (!process.env.DATABASE_URL) {
    report("database_configuration_missing");
    incomplete = true;
  } else {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await client.query<RegistryRow>(
          `
          SELECT a."publisherId", a."encryptedManagementKey", a.region, a."callbackBaseUrl",
                 c.id AS "connectionId", c."encryptedApiKey", c."apiKeyId"
          FROM "PublisherSendgridAccount" a
          LEFT JOIN "SendingConnection" c ON c."publisherId" = a."publisherId" AND c.username = $1
          ${process.env.NEWSLETTER_PUBLISHER_ID ? 'WHERE a."publisherId" = $2' : ""}
        `,
          process.env.NEWSLETTER_PUBLISHER_ID
            ? [username, process.env.NEWSLETTER_PUBLISHER_ID]
            : [username],
        );
        await client.query("COMMIT");
        if (result.rows.length === 1) [registry] = result.rows;
        else {
          report(
            result.rows.length
              ? "publisher_selection_required"
              : "publisher_registry_missing",
          );
          findings += 1;
        }
      } finally {
        client.release();
      }
    } catch {
      report("database_inspection_incomplete");
      incomplete = true;
    } finally {
      await pool.end();
    }
  }
  let managementKey = process.env.SENDGRID_MANAGEMENT_API_KEY;
  let runtimeKey = process.env.SENDGRID_NEWSLETTER_API_KEY;
  try {
    requireNewsletterSecretKey();
    if (!managementKey && registry?.encryptedManagementKey)
      managementKey = decryptNewsletterSecret(registry.encryptedManagementKey);
    if (!runtimeKey && registry?.encryptedApiKey)
      runtimeKey = decryptNewsletterSecret(registry.encryptedApiKey);
  } catch {
    report("stable_secret_key_or_decryption_unavailable");
    incomplete = true;
  }
  if (!runtimeKey) {
    report("existing_runtime_credential_required");
    findings += 1;
  }
  if (!managementKey) {
    report("management_credential_required");
    incomplete = true;
  } else {
    const client = new NewsletterSendgridClient({
      apiKey: managementKey,
      region: registry?.region ?? process.env.SENDGRID_REGION ?? "global",
      allowProviderWrites: false,
      allowIpReassignment: false,
    });
    try {
      const subuser = await client.subuser(username);
      if (!subuser) {
        report("existing_subuser_not_found");
        findings += 1;
      } else {
        report("existing_subuser_found");
        if (subuser.disabled) {
          report("existing_subuser_disabled");
          findings += 1;
        }
        const [keys, domains, ips, pools, webhookResult] = await Promise.all([
          client.apiKeys(username),
          client.list<SendgridDomain>(
            `/whitelabel/domains?username=${username}`,
          ),
          client.list<SendgridIp>(`/ips?subuser=${username}`),
          client.request<{ name: string }[]>(
            "GET",
            "/ips/pools",
            undefined,
            username,
          ),
          client.request<{ webhooks: SendgridWebhook[] }>(
            "GET",
            "/user/webhooks/event/settings/all",
            undefined,
            username,
          ),
        ]);
        let restrictedKeys = 0;
        let adoptedKeyValid = false;
        const runtimeId = runtimeKey
          ? /^SG\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(runtimeKey)?.[1]
          : undefined;
        for (const key of keys) {
          const response = await client.request<
            SendgridApiKey | { result: SendgridApiKey[] }
          >(
            "GET",
            `/api_keys/${encodeURIComponent(key.api_key_id)}`,
            undefined,
            username,
          );
          const detail =
            "result" in response
              ? response.result.find(
                  (entry) => entry.api_key_id === key.api_key_id,
                )
              : response;
          const restricted =
            detail?.scopes?.length === 1 && detail.scopes[0] === "mail.send";
          if (restricted) restrictedKeys += 1;
          if (
            restricted &&
            runtimeId === key.api_key_id &&
            (!registry?.apiKeyId || registry.apiKeyId === runtimeId)
          )
            adoptedKeyValid = true;
        }
        report("provider_key_metadata_inspected", keys.length);
        report("restricted_mail_send_keys", restrictedKeys);
        if (!adoptedKeyValid) {
          report("existing_restricted_credential_adoption_incomplete");
          findings += 1;
        }
        if (runtimeKey === managementKey) {
          report("management_and_runtime_keys_must_differ");
          findings += 1;
        }
        const ownDomains = domains.filter(
          (domain) =>
            domain.username === username ||
            domain.subusers?.some((user) => user.username === username),
        );
        report("authenticated_domains_inspected", ownDomains.length);
        report(
          "authenticated_domains_verified",
          ownDomains.filter((domain) => domain.valid).length,
        );
        if (!ownDomains.some((domain) => domain.valid)) {
          report("verified_domain_required");
          findings += 1;
        }
        report("assigned_dedicated_ips_inspected", ips.length);
        report("provider_pools_inspected", pools.length);
        for (const providerPool of pools) {
          const details = await client.pool(providerPool.name, username);
          if (
            !details ||
            details.ips.length !== 1 ||
            ips.length !== 1 ||
            details.ips[0] !== ips[0]?.ip
          ) {
            report("pool_single_ip_routing_not_ready");
            findings += 1;
          }
        }
        if (ips.length !== 1 || !ips[0]?.whitelabeled || !pools.length) {
          report("single_ip_route_or_reverse_dns_not_ready");
          findings += 1;
        }
        const url =
          registry?.callbackBaseUrl && registry.connectionId
            ? `${registry.callbackBaseUrl}/api/public/webhooks/sendgrid/connections/${registry.connectionId}`
            : null;
        const ready =
          url &&
          webhookResult.webhooks.some(
            (webhook) =>
              webhook.url === url &&
              webhook.enabled &&
              webhook.public_key &&
              NEWSLETTER_WEBHOOK_EVENTS.every(
                (event) => webhook[event] === true,
              ),
          );
        if (!ready) {
          report("signed_connection_webhook_not_ready");
          findings += 1;
        }
        if (!registry?.connectionId) {
          report("local_existing_connection_adoption_required");
          findings += 1;
        }
      }
    } catch {
      // No raw provider errors: transport errors include keys and request data.
      report("provider_inspection_incomplete");
      incomplete = true;
    }
  }
  // The existing Google administrative group is externally owned, never created.
  // Optional short-lived Directory credentials permit metadata-only inspection.
  if (
    process.env.GOOGLE_ADMIN_ACCESS_TOKEN &&
    process.env.RONIN_NEWSLETTER_ADMIN_GROUP_ID
  ) {
    try {
      const response = await axios.get<{ id?: string }>(
        `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(process.env.RONIN_NEWSLETTER_ADMIN_GROUP_ID)}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GOOGLE_ADMIN_ACCESS_TOKEN}`,
          },
          timeout: 20_000,
          maxRedirects: 0,
        },
      );
      if (!response.data.id) {
        report("administrative_group_metadata_invalid");
        incomplete = true;
      } else report("existing_administrative_group_found");
    } catch {
      report("administrative_group_inspection_incomplete");
      incomplete = true;
    }
  } else {
    report("administrative_group_external_metadata_unavailable");
    incomplete = true;
  }
  report("read_only_no_resources_mutated");
  process.exitCode = incomplete ? 2 : findings ? 1 : 0;
}
void main().catch(() => {
  console.error(JSON.stringify({ code: "preflight_incomplete" }));
  process.exitCode = 2;
});
