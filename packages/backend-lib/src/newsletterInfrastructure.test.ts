import axios from "axios";
import { generateKeyPairSync, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { createServer, Server } from "http";
import { AddressInfo } from "net";

import config from "./config";
import { db } from "./db";
import {
  newsletter,
  publisher,
  publisherSendgridAccount,
  sendingConnection,
  sendingIp,
} from "./db/publisherSchema";
import { workspace } from "./db/schema";
import { newsletterCapacityLimits } from "./newsletterDelivery";
import {
  configureSendgridAccount,
  getNewsletterSendingOptions,
  getSendingInfrastructure,
  inspectSendgridAccount,
  reassignSendgridIps,
  reconcileSendgridDomain,
  resolveNewsletterSelection,
  upsertNewsletterDefault,
  upsertSendingIp,
  upsertSendingPool,
  verifyPinnedNewsletterSelection,
} from "./newsletterInfrastructure";
import { NEWSLETTER_WEBHOOK_EVENTS } from "./newsletterSendgrid";

interface ProviderFixture {
  username: string;
  connectionId: string;
  keyId: string;
  ips: string[];
  pools: Record<string, string[]>;
  disabled?: boolean;
  missing?: boolean;
  validDomain?: boolean;
  signed?: boolean;
  scopes?: string[];
}

describe("independent ESP registry with read-only HTTP provider inspection", () => {
  let publisherId: string;
  let newsletterId: string;
  let server: Server;
  let originalKey: string | undefined;
  let originalEnvironmentKey: string | undefined;
  const fixtures = new Map<string, ProviderFixture>();
  const requests: {
    method: string;
    path: string;
    username?: string;
    credential: string;
  }[] = [];
  const signingKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();

  beforeEach(async () => {
    originalKey = config().secretKey;
    originalEnvironmentKey = process.env.SECRET_KEY;
    process.env.SECRET_KEY = Buffer.alloc(32, 71).toString("base64");
    config().secretKey = process.env.SECRET_KEY;
    fixtures.clear();
    requests.length = 0;
    const [parent] = await db()
      .insert(workspace)
      .values({ name: "ESP fixture", type: "Parent" })
      .returning();
    publisherId = parent!.id;
    await db().insert(publisher).values({ workspaceId: publisherId });
    const [child] = await db()
      .insert(workspace)
      .values({
        name: "Independent newsletter",
        type: "Child",
        parentWorkspaceId: publisherId,
      })
      .returning();
    newsletterId = child!.id;
    await db()
      .insert(newsletter)
      .values({ publisherId, workspaceId: newsletterId, slug: "independent" });
    server = createServer((request, response) => {
      const credential =
        request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const fixture = fixtures.get(credential);
      const path = new URL(request.url!, "http://fixture");
      const username = request.headers["on-behalf-of"] as string | undefined;
      requests.push({
        method: request.method!,
        path: path.pathname,
        username,
        credential,
      });
      response.setHeader("content-type", "application/json");
      if (request.method !== "GET") {
        response.writeHead(405).end("{}");
        return;
      }
      if (!fixture || (username && username !== fixture.username)) {
        response.writeHead(403).end("{}");
        return;
      }
      let body: unknown;
      if (path.pathname === "/subusers")
        body = fixture.missing
          ? []
          : [
              {
                username: fixture.username,
                email: "adopted@example.com",
                disabled: fixture.disabled ?? false,
                region: "global",
              },
            ];
      else if (path.pathname === "/user/username")
        body = { username: fixture.username || "parent-provider" };
      else if (path.pathname === "/api_keys")
        body = { result: [{ api_key_id: fixture.keyId, name: "existing" }] };
      else if (path.pathname.startsWith("/api_keys/"))
        body = {
          api_key_id: fixture.keyId,
          name: "existing",
          scopes: fixture.scopes ?? ["mail.send"],
        };
      else if (path.pathname === "/whitelabel/domains")
        body = [
          {
            id: 1,
            domain: "example.com",
            subdomain: "mail",
            username: fixture.username || "parent-provider",
            valid: fixture.validDomain !== false,
            dns: {
              dkim: {
                type: "cname",
                host: "s1._domainkey.example.com",
                data: "provider.example",
                valid: fixture.validDomain !== false,
              },
            },
          },
        ];
      else if (path.pathname === "/verified_senders") body = { results: [] };
      else if (path.pathname === "/user/webhooks/event/settings/all")
        body = {
          webhooks: [
            {
              id: "existing",
              url: `https://callbacks.example.com/api/public/webhooks/sendgrid/connections/${fixture.connectionId}`,
              enabled: true,
              ...(fixture.signed !== false ? { public_key: signingKey } : {}),
              ...Object.fromEntries(
                NEWSLETTER_WEBHOOK_EVENTS.map((event) => [event, true]),
              ),
            },
          ],
        };
      else if (path.pathname === "/ips" || path.pathname === "/ips/assigned")
        body = fixture.ips.map((ip) => ({
          ip,
          subusers: [fixture.username],
          pools: Object.keys(fixture.pools),
          whitelabeled: true,
        }));
      else if (path.pathname === "/ips/pools")
        body = Object.keys(fixture.pools).map((name) => ({ name }));
      else if (path.pathname.startsWith("/ips/pools/")) {
        const name = decodeURIComponent(
          path.pathname.slice("/ips/pools/".length),
        );
        if (!fixture.pools[name]) {
          response.writeHead(404).end("{}");
          return;
        }
        body = { pool_name: name, ips: fixture.pools[name] };
      } else {
        response.writeHead(404).end("{}");
        return;
      }
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = axios.request.bind(axios);
    jest.spyOn(axios, "request").mockImplementation((options) =>
      request({
        ...options,
        url: `${origin}${new URL(options.url!).pathname.replace(/^\/v3/, "")}${new URL(options.url!).search}`,
        proxy: false,
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db().delete(workspace).where(eq(workspace.id, newsletterId));
    await db().delete(workspace).where(eq(workspace.id, publisherId));
    config().secretKey = originalKey;
    if (originalEnvironmentKey === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = originalEnvironmentKey;
  });

  async function account(name: string, username = `${name}-existing`) {
    const managementApiKey = `SG.management_${name}.management_secret`;
    const apiKey = `SG.runtime_${name}.runtime_secret`;
    const created = await configureSendgridAccount({
      publisherId,
      name,
      provider: "SendGrid",
      username,
      managementApiKey,
      apiKey,
      callbackBaseUrl: "https://callbacks.example.com",
      senderDomains: ["example.com"],
    });
    const fixture: ProviderFixture = {
      username,
      connectionId: created.connectionId!,
      keyId: `runtime_${name}`,
      ips: ["192.0.2.10"],
      pools: {},
    };
    fixtures.set(managementApiKey, fixture);
    return { ...created, managementApiKey, apiKey, fixture };
  }
  async function ip(accountId: string, address = "192.0.2.10") {
    return upsertSendingIp({
      publisherId,
      accountId,
      address,
      status: "active",
      hourlyLimit: 100,
      dailyLimit: 1000,
    });
  }
  async function ready(value: { id: string }) {
    expect(
      (await inspectSendgridAccount({ publisherId, accountId: value.id }))
        .ready,
    ).toBe(true);
  }

  it("registers two same-provider accounts without provider provisioning, and preserves omitted secrets and identities on edit", async () => {
    const first = await account("first", "aistocknews-ditto");
    const second = await account("second");
    expect(first.id).not.toBe(second.id);
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(requests).toEqual([]);
    await ready(first);
    const [before] = await db()
      .select()
      .from(publisherSendgridAccount)
      .where(eq(publisherSendgridAccount.id, first.id));
    const [credentialBefore] = await db()
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.id, first.connectionId!));
    const edited = await configureSendgridAccount({
      publisherId,
      id: first.id,
      name: "Renamed",
      provider: "SendGrid",
    });
    const [after] = await db()
      .select()
      .from(publisherSendgridAccount)
      .where(eq(publisherSendgridAccount.id, first.id));
    const [credentialAfter] = await db()
      .select()
      .from(sendingConnection)
      .where(eq(sendingConnection.id, first.connectionId!));
    expect(after!.encryptedManagementKey).toEqual(
      before!.encryptedManagementKey,
    );
    expect(credentialAfter!.encryptedApiKey).toEqual(
      credentialBefore!.encryptedApiKey,
    );
    expect(credentialAfter!.username).toBe("aistocknews-ditto");
    expect(edited.status).toBe("ready");
    const registry = await getSendingInfrastructure(publisherId);
    expect(registry.accounts).toHaveLength(2);
    expect(registry.defaults).toEqual([{ newsletterId, selection: null }]);
    expect(
      registry.accounts.every(
        (row) =>
          !row.allowProviderWrites &&
          !row.allowIpReassignment &&
          !row.allowRealSends,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(registry);
    for (const secret of [
      first.managementApiKey,
      first.apiKey,
      signingKey,
      "encryptedApiKey",
      "encryptedManagementKey",
      "webhookKeys",
    ])
      expect(serialized).not.toContain(secret);
    expect(
      registry.accounts.find((row) => row.id === first.id)!.provisioning
        .domains,
    ).toHaveLength(1);
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("supports newsletters with no default and explicit independent overrides without singleton fallback", async () => {
    const first = await account("first");
    const second = await account("second");
    await ip(first.id);
    await ip(second.id);
    await ready(first);
    await ready(second);
    await expect(
      resolveNewsletterSelection({ publisherId, newsletterId }),
    ).rejects.toThrow("esp_selection_required");
    await upsertNewsletterDefault({
      publisherId,
      newsletterId,
      selection: { accountId: first.id, mode: "automatic" },
    });
    expect(
      (await resolveNewsletterSelection({ publisherId, newsletterId })).account
        .id,
    ).toBe(first.id);
    expect(
      (
        await resolveNewsletterSelection({
          publisherId,
          newsletterId,
          selection: { accountId: second.id, mode: "automatic" },
        })
      ).account.id,
    ).toBe(second.id);
    await upsertNewsletterDefault({
      publisherId,
      newsletterId,
      selection: null,
    });
    await expect(
      resolveNewsletterSelection({ publisherId, newsletterId }),
    ).rejects.toThrow("esp_selection_required");
    await expect(
      resolveNewsletterSelection({
        publisherId,
        newsletterId,
        selection: null,
      }),
    ).rejects.toThrow("esp_selection_required");
    const options = await getNewsletterSendingOptions(newsletterId);
    expect(options.selection).toBeNull();
    expect(options.accounts).toHaveLength(2);
    expect(JSON.stringify(options)).not.toMatch(
      /allowRealSends|hasManagementKey|callbackBaseUrl|encrypted/,
    );
  });

  it("keeps physical budgets canonical and rejects cross-account IP/pool borrowing", async () => {
    const first = await account("first");
    const second = await account("second");
    const firstIp = await ip(first.id);
    const secondIp = await ip(second.id);
    expect(firstIp.id).not.toBe(secondIp.id);
    expect(firstIp.canonicalIpId).toBe(secondIp.canonicalIpId);
    await expect(
      upsertSendingPool({
        publisherId,
        accountId: second.id,
        name: "foreign",
        ipIds: [firstIp.id],
      }),
    ).rejects.toThrow("pool_ip_account_mismatch");
    const pool = await upsertSendingPool({
      publisherId,
      accountId: first.id,
      name: "owned",
      ipIds: [firstIp.id],
    });
    await expect(
      upsertNewsletterDefault({
        publisherId,
        newsletterId,
        selection: { accountId: second.id, mode: "pool", poolId: pool.id },
      }),
    ).rejects.toThrow("pool_account_mismatch");
    await expect(
      upsertSendingIp({
        publisherId,
        id: firstIp.id,
        accountId: second.id,
        address: firstIp.address,
        status: "active",
        hourlyLimit: 10,
        dailyLimit: 100,
      }),
    ).rejects.toThrow("ip_account_is_immutable");
    await expect(
      configureSendgridAccount({
        publisherId: newsletterId,
        id: first.id,
        name: "foreign",
        provider: "SendGrid",
      }),
    ).rejects.toThrow("publisher_not_found");
    await expect(
      resolveNewsletterSelection({
        publisherId,
        newsletterId,
        selection: { accountId: randomUUID(), mode: "automatic" },
      }),
    ).rejects.toThrow("esp_account_not_found");
  });

  it("registers safe paused drafts without a capacity policy or provider requests", async () => {
    const value = await account("draft");
    const draft = await upsertSendingIp({
      publisherId,
      accountId: value.id,
      address: "192.0.2.30",
    });
    expect(draft).toMatchObject({
      status: "paused",
      hourlyLimit: 0,
      dailyLimit: 0,
      warmupStartedAt: null,
      warmupSchedule: [],
    });
    expect(newsletterCapacityLimits(draft, new Date())).toEqual({
      hourly: 0,
      daily: 0,
    });
    const repeated = await upsertSendingIp({
      publisherId,
      accountId: value.id,
      address: draft.address,
      status: "active",
    });
    expect(repeated).toMatchObject({
      id: draft.id,
      status: "paused",
      hourlyLimit: 0,
      dailyLimit: 0,
    });
    const partial = await upsertSendingIp({
      publisherId,
      accountId: value.id,
      address: "192.0.2.31",
      status: "active",
      hourlyLimit: 20,
    });
    expect(partial).toMatchObject({
      status: "paused",
      hourlyLimit: 20,
      dailyLimit: 0,
    });
    expect(newsletterCapacityLimits(partial, new Date()).daily).toBe(0);
    expect(requests).toEqual([]);
  });

  it("preserves omitted limits, status and warmup policy on edits and repeated registration", async () => {
    const value = await account("policy");
    const warmupStartedAt = "2026-11-01T00:00:00.000Z";
    const warmupSchedule = [{ afterDays: 0, hourlyLimit: 5, dailyLimit: 25 }];
    const configured = await upsertSendingIp({
      publisherId,
      accountId: value.id,
      address: "192.0.2.32",
      status: "active",
      hourlyLimit: 40,
      dailyLimit: 200,
      warmupStartedAt,
      warmupSchedule,
    });
    const policy = {
      id: configured.id,
      status: "active",
      hourlyLimit: 40,
      dailyLimit: 200,
      warmupStartedAt: new Date(warmupStartedAt),
      warmupSchedule,
    };
    const edited = await upsertSendingIp({
      publisherId,
      id: configured.id,
      address: configured.address,
    });
    expect(edited).toMatchObject(policy);
    const repeated = await upsertSendingIp({
      publisherId,
      accountId: value.id,
      address: configured.address,
    });
    expect(repeated).toMatchObject(policy);
    const paused = await upsertSendingIp({
      publisherId,
      id: configured.id,
      address: configured.address,
      status: "paused",
      hourlyLimit: 30,
    });
    expect(paused).toMatchObject({
      ...policy,
      status: "paused",
      hourlyLimit: 30,
    });
    const retained = await upsertSendingIp({
      publisherId,
      id: configured.id,
      address: configured.address,
    });
    expect(retained).toMatchObject({
      ...policy,
      status: "paused",
      hourlyLimit: 30,
    });
    expect(requests).toEqual([]);
  });

  it("keeps readable pool names independent from stable provider identifiers without provisioning", async () => {
    const value = await account("named");
    const member = await upsertSendingIp({
      publisherId,
      accountId: value.id,
      address: "192.0.2.33",
    });
    const created = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: "Équipe / Shared · East",
      ipIds: [member.id],
    });
    expect(created.name).toBe("Équipe / Shared · East");
    expect(created.providerPoolName).toMatch(
      /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/,
    );
    const repeated = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: created.name,
      ipIds: [member.id],
    });
    expect(repeated).toMatchObject({
      id: created.id,
      providerPoolName: created.providerPoolName,
    });
    const renamed = await upsertSendingPool({
      publisherId,
      id: created.id,
      name: "Shared / West",
      ipIds: [member.id],
    });
    expect(renamed).toMatchObject({
      name: "Shared / West",
      providerPoolName: created.providerPoolName,
    });
    const existing = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: "Existing / Pool",
      providerPoolName: "adopted-provider-pool",
      ipIds: [member.id],
    });
    const adopted = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: existing.name,
      ipIds: [member.id],
    });
    expect(adopted.providerPoolName).toBe("adopted-provider-pool");
    expect(requests).toEqual([]);
  });

  it("verifies complete automatic and multi-IP pool inventories and pins resource choices", async () => {
    const value = await account("multi");
    const firstIp = await ip(value.id);
    const secondIp = await ip(value.id, "192.0.2.11");
    value.fixture.ips.push(secondIp.address);
    const pool = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: "Distributed",
      providerPoolName: "provider-distributed",
      ipIds: [firstIp.id, secondIp.id],
    });
    value.fixture.pools[pool.providerPoolName] = [
      firstIp.address,
      secondIp.address,
    ];
    await ready(value);
    const automatic = await resolveNewsletterSelection({
      publisherId,
      newsletterId,
      selection: { accountId: value.id, mode: "automatic" },
    });
    expect(automatic.ips).toHaveLength(2);
    expect(automatic.providerPoolName).toBeUndefined();
    const selected = await resolveNewsletterSelection({
      publisherId,
      newsletterId,
      selection: { accountId: value.id, mode: "pool", poolId: pool.id },
    });
    const pinned = {
      publisherId,
      accountId: value.id,
      connectionId: selected.connection.id,
      connectionRevision: selected.connection.revision,
      accountRevision: selected.account.revision,
      selection: selected.selection,
      candidateIpIds: selected.ips.map((row) => row.id),
      providerPoolName: selected.providerPoolName,
    };
    await upsertNewsletterDefault({
      publisherId,
      newsletterId,
      selection: null,
    });
    await expect(
      verifyPinnedNewsletterSelection(pinned),
    ).resolves.toBeUndefined();
    value.fixture.pools[pool.providerPoolName]!.push("192.0.2.12");
    await expect(verifyPinnedNewsletterSelection(pinned)).rejects.toThrow(
      "provider_routing_drift",
    );
    value.fixture.ips.push("192.0.2.12");
    await expect(
      resolveNewsletterSelection({
        publisherId,
        newsletterId,
        selection: { accountId: value.id, mode: "automatic" },
      }),
    ).rejects.toThrow("automatic_capacity_inventory_incomplete");
    await expect(
      resolveNewsletterSelection({
        publisherId,
        newsletterId,
        selection: { accountId: value.id, mode: "ip", ipId: firstIp.id },
      }),
    ).rejects.toThrow("ip_requires_singleton_provider_pool");
  });

  it("rejects a legacy singleton snapshot when the current local pool has broadened", async () => {
    const value = await account("legacy");
    const originalIp = await ip(value.id);
    const addedIp = await ip(value.id, "192.0.2.15");
    value.fixture.ips.push(addedIp.address);
    const pool = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: "Legacy",
      ipIds: [originalIp.id, addedIp.id],
    });
    value.fixture.pools[pool.providerPoolName] = [
      originalIp.address,
      addedIp.address,
    ];
    await ready(value);
    await expect(
      verifyPinnedNewsletterSelection({
        publisherId,
        accountId: value.id,
        connectionId: value.connectionId!,
        connectionRevision: value.revision,
        accountRevision: value.revision,
        selection: { accountId: value.id, mode: "pool", poolId: pool.id },
        candidateIpIds: [originalIp.id],
        providerPoolName: pool.providerPoolName,
      }),
    ).rejects.toThrow("pinned_selection_changed");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("labels an IP choice truthfully as a verified singleton pool, never a raw-IP instruction", async () => {
    const value = await account("single");
    const selectedIp = await ip(value.id);
    const pool = await upsertSendingPool({
      publisherId,
      accountId: value.id,
      name: "Single",
      ipIds: [selectedIp.id],
    });
    value.fixture.pools[pool.providerPoolName] = [selectedIp.address];
    await ready(value);
    const selected = await resolveNewsletterSelection({
      publisherId,
      newsletterId,
      selection: { accountId: value.id, mode: "ip", ipId: selectedIp.id },
    });
    expect(selected.providerPoolName).toBe(pool.providerPoolName);
    expect(value.capabilities).toMatchObject({
      ip: true,
      rawIp: false,
      multiIp: true,
    });
    expect(
      (await getNewsletterSendingOptions(newsletterId)).ips[0]!
        .eligibleSingletonPool,
    ).toBe(true);
  });

  it("persists truthful failures, never provisions missing adopted subusers and resolves provider operations to the actual account", async () => {
    const first = await account("first");
    const second = await account("second");
    second.fixture.missing = true;
    const report = await inspectSendgridAccount({
      publisherId,
      accountId: second.id,
    });
    expect(report.ready).toBe(false);
    expect(report.findings).toContain("subuser_missing");
    second.fixture.missing = false;
    second.fixture.scopes = ["mail.send", "api_keys.create"];
    second.fixture.validDomain = false;
    second.fixture.signed = false;
    expect(
      (await inspectSendgridAccount({ publisherId, accountId: second.id }))
        .findings,
    ).toEqual(
      expect.arrayContaining([
        "restricted_key_required",
        "sender_identity_not_verified",
        "signed_webhook_not_ready",
      ]),
    );
    await expect(
      reconcileSendgridDomain({
        publisherId,
        connectionId: second.connectionId!,
        domain: "other.example.com",
      }),
    ).rejects.toThrow("provider_writes_disabled");
    await expect(
      reassignSendgridIps({
        publisherId,
        connectionId: first.connectionId!,
        ipIds: [],
        confirm: true,
      }),
    ).rejects.toThrow("provider_writes_disabled");
    expect(
      requests
        .filter((entry) => entry.username === second.fixture.username)
        .every((entry) => entry.credential === second.managementApiKey),
    ).toBe(true);
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("supports a parent credential identity without inventing a subuser and intentionally clears warmup dates", async () => {
    const value = await account("parent", "");
    const selectedIp = await ip(value.id);
    await ready(value);
    expect(requests.some((entry) => entry.path === "/subusers")).toBe(false);
    expect(requests.some((entry) => entry.path === "/ips/assigned")).toBe(true);
    await upsertSendingIp({
      publisherId,
      id: selectedIp.id,
      address: selectedIp.address,
      status: "active",
      hourlyLimit: 100,
      dailyLimit: 1000,
      warmupStartedAt: "2026-01-01T00:00:00.000Z",
    });
    await upsertSendingIp({
      publisherId,
      id: selectedIp.id,
      address: selectedIp.address,
      status: "active",
      hourlyLimit: 100,
      dailyLimit: 1000,
    });
    const [kept] = await db()
      .select()
      .from(sendingIp)
      .where(
        and(eq(sendingIp.accountId, value.id), eq(sendingIp.id, selectedIp.id)),
      );
    expect(kept!.warmupStartedAt).not.toBeNull();
    const cleared = await upsertSendingIp({
      publisherId,
      id: selectedIp.id,
      address: selectedIp.address,
      status: "active",
      hourlyLimit: 100,
      dailyLimit: 1000,
      warmupStartedAt: null,
    });
    expect(cleared.warmupStartedAt).toBeNull();
  });
});
