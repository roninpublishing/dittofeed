import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";

import config from "./config";
import { db } from "./db";
import { newsletter, publisher, sendingConnection } from "./db/publisherSchema";
import { workspace } from "./db/schema";
import {
  assignNewsletterRoute,
  configureSendgridAccount,
  createSendingConnection,
  getSendingInfrastructure,
  inspectSendgridConnection,
  provisionSendgridConnection,
  reconcileSendgridDomain,
  reconcileSendgridPool,
  reassignSendgridIps,
  upsertPoolBinding,
  upsertSendingIp,
  upsertSendingPool,
  verifyNewsletterRouting,
  verifyPinnedNewsletterRouting,
} from "./newsletterInfrastructure";
import {
  NewsletterInfrastructureError,
  NewsletterSendgridClient,
  NEWSLETTER_WEBHOOK_EVENTS,
  SendgridApiKey,
  SendgridDomain,
  SendgridIp,
  SendgridWebhook,
} from "./newsletterSendgrid";

const managementKey = "SG.management.fixture-secret";
const runtimeKey = "SG.runtime.fixture-secret";

describe("newsletter sending registry and resumable SendGrid reconciliation", () => {
  let publisherId: string;
  let newsletterId: string;
  let connectionId: string;
  let originalKey: string | undefined;
  let originalEnvironmentKey: string | undefined;
  let username: string;
  let providerSubuser: boolean;
  let keys: SendgridApiKey[];
  let domains: SendgridDomain[];
  let webhooks: SendgridWebhook[];
  let ips: SendgridIp[];
  let pools: Record<string, string[]>;
  let writes: string[];
  let crashAfterKeyCreation: boolean;

  beforeEach(async () => {
    originalKey = config().secretKey;
    originalEnvironmentKey = process.env.SECRET_KEY;
    process.env.SECRET_KEY = randomBytes(32).toString("base64");
    config().secretKey = process.env.SECRET_KEY;
    const [parent] = await db()
      .insert(workspace)
      .values({ name: "Infrastructure fixture", type: "Parent" })
      .returning();
    publisherId = parent!.id;
    await db().insert(publisher).values({ workspaceId: publisherId });
    const [child] = await db()
      .insert(workspace)
      .values({
        name: "Newsletter fixture",
        type: "Child",
        parentWorkspaceId: publisherId,
      })
      .returning();
    newsletterId = child!.id;
    await db()
      .insert(newsletter)
      .values({ publisherId, workspaceId: newsletterId, slug: "fixture" });
    username = "fixture-ditto";
    providerSubuser = false;
    keys = [];
    domains = [];
    webhooks = [];
    ips = [
      {
        ip: "192.0.2.10",
        subusers: [username],
        pools: ["fixture-pool"],
        whitelabeled: true,
      },
    ];
    pools = {};
    writes = [];
    crashAfterKeyCreation = false;
    jest
      .spyOn(NewsletterSendgridClient.prototype, "request")
      .mockImplementation(async function request<T>(
        method: string,
        path: string,
        body?: unknown,
      ): Promise<T> {
        const data = body as Record<string, unknown> | undefined;
        if (method !== "GET") writes.push(`${method} ${path}`);
        let result: unknown;
        if (method === "GET" && path.startsWith("/subusers?")) {
          result = providerSubuser
            ? [
                {
                  username,
                  email: `${username.replace(/-ditto$/, "")}@roninpublishing.com`,
                  disabled: false,
                  region: "global",
                },
              ]
            : [];
        } else if (method === "POST" && path === "/subusers") {
          providerSubuser = true;
          result = {};
        } else if (method === "GET" && path === "/api_keys")
          result = { result: keys };
        else if (method === "GET" && path.startsWith("/api_keys/"))
          result = keys.find(
            (key) => key.api_key_id === path.slice("/api_keys/".length),
          );
        else if (method === "POST" && path === "/api_keys") {
          const key = {
            api_key_id: "runtime",
            api_key: runtimeKey,
            name: "fixture",
            scopes: ["mail.send"],
          };
          keys.push(key);
          if (crashAfterKeyCreation)
            throw new NewsletterInfrastructureError(
              502,
              "fixture_response_lost",
            );
          result = key;
        } else if (method === "GET" && path.startsWith("/whitelabel/domains?"))
          result = domains;
        else if (method === "POST" && path === "/whitelabel/domains") {
          const domain = {
            id: 1,
            domain: data!.domain as string,
            subdomain: "mail",
            username,
            valid: false,
            dns: {
              dkim: {
                type: "cname",
                host: "s1._domainkey.example.com",
                data: "provider.example",
                valid: false,
              },
            },
          };
          domains.push(domain);
          result = domain;
        } else if (method === "GET" && path.startsWith("/verified_senders?"))
          result = { results: [] };
        else if (
          method === "GET" &&
          path === "/user/webhooks/event/settings/all"
        )
          result = { webhooks };
        else if (
          method === "POST" &&
          path === "/user/webhooks/event/settings"
        ) {
          const webhook = { ...data, id: "webhook-1" } as SendgridWebhook;
          webhooks.push(webhook);
          result = webhook;
        } else if (method === "PATCH" && path.includes("/settings/signed/")) {
          webhooks[0]!.public_key = "fixture-verification-public-key";
          result = { public_key: webhooks[0]!.public_key };
        } else if (
          method === "PATCH" &&
          path.startsWith("/user/webhooks/event/settings/")
        ) {
          Object.assign(webhooks[0]!, data);
          result = webhooks[0];
        } else if (method === "GET" && path.startsWith("/ips?")) result = ips;
        else if (method === "GET" && path === "/ips/pools")
          result = Object.keys(pools).map((name) => ({ name }));
        else if (method === "GET" && path.startsWith("/ips/pools/")) {
          const name = decodeURIComponent(path.slice("/ips/pools/".length));
          if (!pools[name])
            throw new NewsletterInfrastructureError(
              404,
              "provider_resource_not_found",
            );
          result = { pool_name: name, ips: pools[name] };
        } else if (method === "POST" && path === "/ips/pools") {
          pools[data!.name as string] = [];
          result = {};
        } else if (method === "POST" && path.endsWith("/ips")) {
          const name = decodeURIComponent(path.split("/")[3]!);
          pools[name]!.push(data!.ip as string);
          result = {};
        } else if (method === "PUT" && path.startsWith("/subusers/"))
          result = {};
        else throw new Error("Unexpected fixture endpoint");
        return result as T;
      });
    await configureSendgridAccount({
      publisherId,
      managementApiKey: managementKey,
      callbackBaseUrl: "https://callbacks.example.com",
    });
    const connection = await createSendingConnection({
      publisherId,
      newsletterId,
    });
    connectionId = connection.id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    config().secretKey = originalKey;
    if (originalEnvironmentKey === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = originalEnvironmentKey;
    await db().delete(workspace).where(eq(workspace.id, newsletterId));
    await db().delete(workspace).where(eq(workspace.id, publisherId));
  });

  async function adoptReadyResources(slug = "fixture") {
    username = `${slug}-ditto`;
    await db()
      .update(newsletter)
      .set({ slug })
      .where(eq(newsletter.workspaceId, newsletterId));
    // This fixture changes the slug before adopting, as a real adopted workspace is created with its final slug.
    await db()
      .update(sendingConnection)
      .set({ username, administrativeEmail: `${slug}@roninpublishing.com` })
      .where(eq(sendingConnection.id, connectionId));
    providerSubuser = true;
    keys = [
      {
        api_key_id: "runtime",
        name: "existing restricted key",
        scopes: ["mail.send"],
      },
    ];
    domains = [
      {
        id: 1,
        domain: "example.com",
        subdomain: "mail",
        username,
        valid: true,
      },
    ];
    webhooks = [
      {
        id: "existing-webhook",
        url: `https://callbacks.example.com/api/public/webhooks/sendgrid/connections/${connectionId}`,
        enabled: true,
        public_key: "fixture-verification-public-key",
        ...Object.fromEntries(
          NEWSLETTER_WEBHOOK_EVENTS.map((event) => [event, true]),
        ),
      },
    ];
    await createSendingConnection({
      publisherId,
      newsletterId,
      apiKey: runtimeKey,
      apiKeyId: "runtime",
      senderDomains: ["example.com"],
    });
  }

  it("adopts AI Stock News resources without recreating, rotating, or exposing credentials", async () => {
    await adoptReadyResources("aistocknews");
    const report = await provisionSendgridConnection({
      publisherId,
      connectionId,
      domain: "example.com",
      configureWebhook: true,
    });
    expect(report.ready).toBe(true);
    expect(writes).toEqual([]);
    const registry = JSON.stringify(
      await getSendingInfrastructure(publisherId),
    );
    for (const forbidden of [
      managementKey,
      runtimeKey,
      "fixture-verification-public-key",
      "encryptedApiKey",
      "encryptedManagementKey",
      "webhookKeys",
    ])
      expect(registry).not.toContain(forbidden);
    expect(report.key).toEqual({
      present: true,
      restricted: true,
      credentialStored: true,
    });
  });

  it("resumes partial provisioning and adopts existing domain/webhook without duplicate POSTs", async () => {
    await configureSendgridAccount({ publisherId, allowProviderWrites: true });
    const first = await provisionSendgridConnection({
      publisherId,
      connectionId,
      domain: "example.com",
      configureWebhook: true,
    });
    expect(first.findings).toContain("sender_identity_not_verified");
    expect(first.domains[0]!.dns).toHaveLength(1);
    domains[0]!.valid = true;
    const second = await provisionSendgridConnection({
      publisherId,
      connectionId,
      domain: "example.com",
      configureWebhook: true,
    });
    expect(second.ready).toBe(true);
    for (const endpoint of [
      "POST /subusers",
      "POST /api_keys",
      "POST /whitelabel/domains",
      "POST /user/webhooks/event/settings",
    ])
      expect(writes.filter((entry) => entry === endpoint)).toHaveLength(1);
    expect(
      writes.filter((entry) => entry.includes("/settings/signed/")),
    ).toHaveLength(1);
  });

  it("never creates another key after an ambiguous provider key-creation result", async () => {
    await configureSendgridAccount({ publisherId, allowProviderWrites: true });
    crashAfterKeyCreation = true;
    await expect(
      provisionSendgridConnection({ publisherId, connectionId }),
    ).rejects.toThrow("fixture_response_lost");
    crashAfterKeyCreation = false;
    await expect(
      provisionSendgridConnection({ publisherId, connectionId }),
    ).rejects.toThrow("existing_runtime_key_must_be_adopted");
    expect(writes.filter((entry) => entry === "POST /api_keys")).toHaveLength(
      1,
    );
  });

  it("keeps writes and assignment gates independently closed", async () => {
    await expect(
      provisionSendgridConnection({ publisherId, connectionId }),
    ).rejects.toThrow("provider_writes_disabled");
    expect(writes).toEqual([]);
    await configureSendgridAccount({ publisherId, allowProviderWrites: true });
    await expect(
      reassignSendgridIps({
        publisherId,
        connectionId,
        ipIds: [],
        confirm: true,
      }),
    ).rejects.toThrow("ip_reassignment_disabled");
    expect(writes).toEqual([]);
  });

  it("rejects missing AI Stock News resources instead of recreating them", async () => {
    await adoptReadyResources("aistocknews");
    await configureSendgridAccount({ publisherId, allowProviderWrites: true });
    providerSubuser = false;
    await expect(
      provisionSendgridConnection({ publisherId, connectionId }),
    ).rejects.toThrow("existing_subuser_required");
    providerSubuser = true;
    domains = [];
    await expect(
      reconcileSendgridDomain({
        publisherId,
        connectionId,
        domain: "example.com",
      }),
    ).rejects.toThrow("existing_domain_required");
    expect(writes).toEqual([]);
  });

  it("requires verified sender identity, mail.send-only key and signed complete callbacks", async () => {
    await adoptReadyResources();
    keys[0]!.scopes = ["mail.send", "api_keys.create"];
    domains[0]!.valid = false;
    delete webhooks[0]!.public_key;
    const report = await inspectSendgridConnection({
      publisherId,
      connectionId,
    });
    expect(report.ready).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        "restricted_key_required",
        "sender_identity_not_verified",
        "signed_webhook_not_ready",
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(
      "fixture-verification-public-key",
    );
    expect(writes).toEqual([]);
  });

  it("validates singleton routing, refuses provider drift and foreign ownership", async () => {
    await adoptReadyResources();
    const ip = await upsertSendingIp({
      publisherId,
      address: "192.0.2.10",
      status: "active",
      hourlyLimit: 100,
      dailyLimit: 1000,
    });
    await expect(
      upsertSendingIp({
        publisherId,
        id: ip.id,
        address: "192.0.2.99",
        status: "active",
        hourlyLimit: 100,
        dailyLimit: 1000,
      }),
    ).rejects.toThrow("sending_ip_address_is_immutable");
    const pool = await upsertSendingPool({
      publisherId,
      name: "fixture-pool",
      ipIds: [ip.id],
    });
    pools["fixture-pool"] = [ip.address];
    await upsertPoolBinding({
      publisherId,
      connectionId,
      poolId: pool.id!,
      providerPoolName: "fixture-pool",
    });
    await assignNewsletterRoute({
      publisherId,
      newsletterId,
      connectionId,
      poolId: pool.id!,
    });
    await expect(
      verifyNewsletterRouting({ publisherId, newsletterId }),
    ).resolves.toMatchObject({ ipId: ip.id, address: ip.address });
    const nextPool = await upsertSendingPool({
      publisherId,
      name: "next-pool",
      ipIds: [ip.id],
    });
    await upsertPoolBinding({
      publisherId,
      connectionId,
      poolId: nextPool.id!,
      providerPoolName: "next-pool",
    });
    await assignNewsletterRoute({
      publisherId,
      newsletterId,
      connectionId,
      poolId: nextPool.id!,
    });
    await expect(
      verifyPinnedNewsletterRouting({
        publisherId,
        newsletterId,
        connectionId,
        poolId: pool.id!,
        ipId: ip.id,
        providerPoolName: "fixture-pool",
        connectionRevision: 1,
      }),
    ).resolves.toBeUndefined();
    await assignNewsletterRoute({
      publisherId,
      newsletterId,
      connectionId,
      poolId: pool.id!,
    });
    pools["fixture-pool"]!.push("192.0.2.11");
    await expect(
      verifyNewsletterRouting({ publisherId, newsletterId }),
    ).rejects.toThrow("provider_routing_drift");
    await expect(
      reconcileSendgridPool({
        publisherId: newsletterId,
        connectionId,
        poolId: pool.id!,
        providerPoolName: "fixture-pool",
      }),
    ).rejects.toThrow("sending_connection_not_found");
    const empty = await upsertSendingPool({
      publisherId,
      name: "empty-pool",
      ipIds: [],
    });
    await expect(
      assignNewsletterRoute({
        publisherId,
        newsletterId,
        connectionId,
        poolId: empty.id!,
      }),
    ).rejects.toThrow("route_requires_single_ip");
  });
});
