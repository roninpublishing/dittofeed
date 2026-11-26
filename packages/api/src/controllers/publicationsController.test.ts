import { fastifyRequestContext } from "@fastify/request-context";
import { createAdminApiKey } from "backend-lib/src/adminApiKeys";
import config from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import { publisherSendgridAccount } from "backend-lib/src/db/publisherSchema";
import {
  journey,
  workspace,
  workspaceMember,
  workspaceMemberRole,
} from "backend-lib/src/db/schema";
import { createNewsletter, createPublisher } from "backend-lib/src/newsletters";
import { JourneyNodeType } from "backend-lib/src/types";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import fastify, { FastifyInstance } from "fastify";
import { API_OPERATION_SCOPES } from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { NewsletterTrackingResponse } from "isomorphic-lib/src/publications";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

// This fixture constructs Fastify directly; retain the real app's context types.
import type {} from "../buildApp";
import adminAuth from "../buildApp/adminAuth";
import publicationsController from "./publicationsController";

interface PublicationSummary {
  workspaceId: string;
  publisherId: string;
  name: string;
  slug: string;
}

let app: FastifyInstance;
let publisherId: string;
const workspaceIds: string[] = [];
let originalKey: string | undefined;
let originalEnvironmentKey: string | undefined;

beforeEach(async () => {
  originalKey = config().secretKey;
  originalEnvironmentKey = process.env.SECRET_KEY;
  process.env.SECRET_KEY = Buffer.alloc(32, 23).toString("base64");
  config().secretKey = process.env.SECRET_KEY;
  const parent = await createPublisher({
    name: `api-publisher-${randomUUID()}`,
  });
  publisherId = parent.id;
  workspaceIds.push(parent.id);
  app = fastify();
  await app.register(fastifyRequestContext);
  await app.register(adminAuth);
  await app.register(publicationsController, {
    prefix: "/api/admin/publications",
  });
});
afterEach(async () => {
  await app.close();
  if (workspaceIds.length)
    await db()
      .delete(workspace)
      .where(inArray(workspace.id, workspaceIds.splice(0)));
  config().secretKey = originalKey;
  if (originalEnvironmentKey === undefined) delete process.env.SECRET_KEY;
  else process.env.SECRET_KEY = originalEnvironmentKey;
});

async function key(
  scopes: (typeof API_OPERATION_SCOPES)[number][],
  target = publisherId,
) {
  return unwrap(
    await createAdminApiKey({
      workspaceId: target,
      name: randomUUID(),
      scopes,
    }),
  ).apiKey;
}
function headers(apiKey: string, target = publisherId) {
  return { authorization: `Bearer ${apiKey}`, [WORKSPACE_ID_HEADER]: target };
}

describe("publication management API", () => {
  it("returns actual delivery summary totals for an empty publisher workspace", async () => {
    const result = await app.inject({
      method: "GET",
      url: `/api/admin/publications/delivery-summary?workspaceId=${publisherId}`,
      headers: headers(await key(["read"])),
    });
    expect(result.statusCode).toBe(200);
    const body = result.json<{
      data: { periodStart: string; periodEnd: string };
    }>();
    expect(body).toEqual({
      data: {
        periodStart: expect.any(String),
        periodEnd: expect.any(String),
        observationsAvailable: true,
        summary: {
          sends: 0,
          delivered: 0,
          bounced: 0,
          dropped: 0,
          complaints: 0,
          resolvedOutcomes: 0,
          deliverabilityRate: null,
          observationsAvailable: true,
        },
      },
    });
    const periodStart = new Date(body.data.periodStart);
    const periodEnd = new Date(body.data.periodEnd);
    expect(periodStart.toISOString()).toBe(body.data.periodStart);
    expect(periodEnd.toISOString()).toBe(body.data.periodEnd);
    expect(periodEnd.getTime() - periodStart.getTime()).toBe(30 * 86400_000);
  });

  it("denies foreign credentials and missing read scope after warming the delivery summary cache", async () => {
    const url = `/api/admin/publications/delivery-summary?workspaceId=${publisherId}`;
    const warmed = await app.inject({
      method: "GET",
      url,
      headers: headers(await key(["read"])),
    });
    expect(warmed.statusCode).toBe(200);
    expect(warmed.json()).toMatchObject({ data: { summary: { sends: 0 } } });

    const foreign = await createPublisher({
      name: `foreign-summary-${randomUUID()}`,
    });
    workspaceIds.push(foreign.id);
    const foreignAttempt = await app.inject({
      method: "GET",
      url,
      headers: headers(await key(["read"], foreign.id)),
    });
    expect(foreignAttempt.statusCode).toBe(401);
    expect(foreignAttempt.json()).not.toHaveProperty("data");

    const missingScopeAttempt = await app.inject({
      method: "GET",
      url,
      headers: headers(await key(["write"])),
    });
    expect(missingScopeAttempt.statusCode).toBe(403);
    expect(missingScopeAttempt.json()).not.toHaveProperty("data");
  });

  it("creates a separate workspace with membership for the authenticated manager", async () => {
    const email = `${randomUUID()}@example.test`;
    const [member] = await db()
      .insert(workspaceMember)
      .values({ email })
      .returning();
    if (!member) throw new Error("Missing member");
    try {
      await db()
        .insert(workspaceMemberRole)
        .values({
          workspaceId: publisherId,
          workspaceMemberId: member.id,
          role: "Admin",
        });
      app.addHook("onRequest", (request, _reply, done) => {
        request.requestContext.set("member", {
          id: member.id,
          email,
          createdAt: member.createdAt.toISOString(),
          emailVerified: member.emailVerified,
        });
        done();
      });
      const result = await app.inject({
        method: "POST",
        url: "/api/admin/publications/publisher",
        headers: headers(await key([...API_OPERATION_SCOPES])),
        payload: {
          workspaceId: publisherId,
          name: `new-workspace-${randomUUID()}`,
          createNewWorkspace: true,
        },
      });
      expect(result.statusCode).toBe(200);
      const created = result.json<{
        data: { workspaceId: string; type: string };
      }>().data;
      workspaceIds.push(created.workspaceId);
      expect(created.workspaceId).not.toBe(publisherId);
      expect(created.type).toBe("Parent");
      expect(
        await db()
          .select()
          .from(workspaceMemberRole)
          .where(eq(workspaceMemberRole.workspaceId, created.workspaceId)),
      ).toEqual([
        expect.objectContaining({
          workspaceMemberId: member.id,
          role: "Admin",
        }),
      ]);
    } finally {
      await db()
        .delete(workspaceMemberRole)
        .where(eq(workspaceMemberRole.workspaceMemberId, member.id));
      await db()
        .delete(workspaceMember)
        .where(eq(workspaceMember.id, member.id));
    }
  });

  it("does not let workspace-scoped bearer keys create another root workspace", async () => {
    const name = `denied-workspace-${randomUUID()}`;
    const result = await app.inject({
      method: "POST",
      url: "/api/admin/publications/publisher",
      headers: headers(await key([...API_OPERATION_SCOPES])),
      payload: { workspaceId: publisherId, name, createNewWorkspace: true },
    });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({
      code: "workspace_creation_requires_session",
    });
    expect(
      await db().select().from(workspace).where(eq(workspace.name, name)),
    ).toEqual([]);
  });

  it("creates independent newsletter resources through the authenticated publisher", async () => {
    const apiKey = await key([...API_OPERATION_SCOPES]);
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/publications/",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        name: "AI Stock News",
        slug: "aistocknews",
      },
    });
    expect(created.statusCode).toBe(200);
    const publication = created.json<{ data: PublicationSummary }>().data;
    expect(publication).toMatchObject({
      publisherId,
      slug: "aistocknews",
      name: "AI Stock News",
    });
    workspaceIds.push(publication.workspaceId);
    expect(publication.workspaceId).not.toBe(publisherId);
    const list = await app.inject({
      method: "GET",
      url: `/api/admin/publications/?workspaceId=${publisherId}`,
      headers: headers(apiKey),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: PublicationSummary[] }>().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: publication.workspaceId }),
      ]),
    );
  });

  it("allows read-key contact queries but prevents credential administration and suppression removal", async () => {
    const apiKey = await key(["read"]);
    const search = await app.inject({
      method: "POST",
      url: "/api/admin/publications/contacts/search",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        searchTerm: "nobody@example.com",
        limit: 10,
      },
    });
    expect(search.statusCode).toBe(200);
    expect(
      search.json<{ data: { contacts: unknown[] } }>().data.contacts,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/publications/infrastructure/accounts",
          headers: headers(apiKey),
          payload: {
            workspaceId: publisherId,
            name: "Unauthorized",
            provider: "SendGrid",
            managementApiKey: "not-authorized",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/publications/suppressions/deactivate",
          headers: headers(apiKey),
          payload: { workspaceId: publisherId, suppressionId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      await db()
        .select()
        .from(publisherSendgridAccount)
        .where(eq(publisherSendgridAccount.publisherId, publisherId)),
    ).toEqual([]);
  });

  it("requires all independent grants for stored management credentials and never returns the key", async () => {
    const partialGrants: (typeof API_OPERATION_SCOPES)[number][][] = [
      ["write"],
      ["sensitive"],
      ["read", "write", "sensitive"],
    ];
    await Promise.all(
      partialGrants.map(async (scopes) => {
        const apiKey = await key(scopes);
        expect(
          (
            await app.inject({
              method: "PUT",
              url: "/api/admin/publications/infrastructure/accounts",
              headers: headers(apiKey),
              payload: {
                workspaceId: publisherId,
                name: "Partial grant",
                provider: "SendGrid",
                managementApiKey: "partial-grant-must-not-be-stored",
              },
            })
          ).statusCode,
        ).toBe(403);
      }),
    );
    const apiKey = await key([...API_OPERATION_SCOPES]);
    const value = "SG.management_test_id.management_test_secret";
    const configured = await app.inject({
      method: "PUT",
      url: "/api/admin/publications/infrastructure/accounts",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        name: "First account",
        provider: "SendGrid",
        managementApiKey: value,
        region: "global",
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain(value);
    const read = await app.inject({
      method: "GET",
      url: `/api/admin/publications/infrastructure?workspaceId=${publisherId}`,
      headers: headers(apiKey),
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(value);
    expect(read.body).not.toContain("encryptedManagementKey");
    expect(read.body).not.toContain("encryptedApiKey");
  });

  it("supports two local accounts, optional defaults and newsletter-scoped redacted choices through authenticated HTTP", async () => {
    const apiKey = await key([...API_OPERATION_SCOPES]);
    const child = await createNewsletter({
      publisherId,
      name: "Selection newsletter",
      slug: "selection-newsletter",
    });
    workspaceIds.push(child.workspaceId);
    const childKey = await key(["read"], child.workspaceId);
    const create = async (name: string) => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/admin/publications/infrastructure/accounts",
        headers: headers(apiKey),
        payload: {
          workspaceId: publisherId,
          name,
          provider: "SendGrid",
          managementApiKey: `SG.management_${name}.fixture_secret`,
          apiKey: `SG.runtime_${name}.fixture_secret`,
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{
        data: { id: string; connectionId: string; allowRealSends: boolean };
      }>().data;
    };
    const first = await create("first");
    const second = await create("second");
    expect(first.id).not.toBe(second.id);
    expect(first.allowRealSends).toBe(false);
    const choices = () =>
      app.inject({
        method: "GET",
        url: `/api/admin/publications/sending-options?workspaceId=${child.workspaceId}`,
        headers: headers(childKey, child.workspaceId),
      });
    const unconfigured = await choices();
    expect(unconfigured.statusCode).toBe(200);
    const { data: unconfiguredData } = unconfigured.json<{
      data: { selection: unknown; accounts: unknown[] };
    }>();
    expect(unconfiguredData.selection).toBeNull();
    expect(unconfiguredData.accounts).toEqual(expect.any(Array));
    expect(unconfigured.body).not.toMatch(
      /fixture_secret|allowRealSends|hasManagementKey|encrypted|callbackBaseUrl/,
    );
    const save = await app.inject({
      method: "PUT",
      url: "/api/admin/publications/infrastructure/defaults",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        newsletterId: child.workspaceId,
        selection: { accountId: second.id, mode: "automatic" },
      },
    });
    expect(save.statusCode).toBe(200);
    expect(
      (await choices()).json<{ data: { selection: unknown } }>().data.selection,
    ).toEqual({ accountId: second.id, mode: "automatic" });
    const clear = await app.inject({
      method: "PUT",
      url: "/api/admin/publications/infrastructure/defaults",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        newsletterId: child.workspaceId,
        selection: null,
      },
    });
    expect(clear.statusCode).toBe(200);
    expect(
      (await choices()).json<{ data: { selection: unknown } }>().data.selection,
    ).toBeNull();
    const inventory = await app.inject({
      method: "GET",
      url: `/api/admin/publications/infrastructure?workspaceId=${publisherId}`,
      headers: headers(apiKey),
    });
    const { data } = inventory.json<{ data: Record<string, unknown> }>();
    expect(data.accounts).toHaveLength(2);
    expect(data).not.toHaveProperty("account");
    expect(data).not.toHaveProperty("routes");
    const removedRoutes = await Promise.all(
      [
        "/infrastructure/account",
        "/infrastructure/routes",
        "/infrastructure/connections",
      ].map((path) =>
        app.inject({
          method: "PUT",
          url: `/api/admin/publications${path}`,
          headers: headers(apiKey),
          payload: { workspaceId: publisherId },
        }),
      ),
    );
    removedRoutes.forEach((response) => expect(response.statusCode).toBe(404));
    const closedGates = await app.inject({
      method: "PUT",
      url: "/api/admin/publications/infrastructure/accounts",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        id: first.id,
        name: "Cannot enable sends",
        provider: "SendGrid",
        allowRealSends: true,
      },
    });
    expect(closedGates.statusCode).toBe(200);
    expect(
      closedGates.json<{ data: { allowRealSends: boolean } }>().data
        .allowRealSends,
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/publications/sends?workspaceId=${publisherId}&accountId=${second.id}&limit=25&offset=0`,
          headers: headers(apiKey),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/publications/sends?workspaceId=${publisherId}&accountId=${randomUUID()}&limit=25`,
          headers: headers(apiKey),
        })
      ).statusCode,
    ).toBe(404);
  });
  it("does not let a child credential become a publisher credential", async () => {
    const child = await createNewsletter({
      publisherId,
      name: "Scoped child",
      slug: "scoped-child",
    });
    workspaceIds.push(child.workspaceId);
    const childKey = await key([...API_OPERATION_SCOPES], child.workspaceId);
    const attempt = await app.inject({
      method: "GET",
      url: `/api/admin/publications/?workspaceId=${publisherId}`,
      headers: headers(childKey, publisherId),
    });
    expect(attempt.statusCode).toBe(401);
    const ownScopeAttempt = await app.inject({
      method: "GET",
      url: `/api/admin/publications/?workspaceId=${child.workspaceId}`,
      headers: headers(childKey, child.workspaceId),
    });
    expect(ownScopeAttempt.statusCode).toBe(404);
  });

  it("refuses to adopt a foreign root workspace even with a publisher administrator key", async () => {
    const foreign = await createPublisher({ name: `foreign-${randomUUID()}` });
    workspaceIds.push(foreign.id);
    const apiKey = await key([...API_OPERATION_SCOPES]);
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/publications/adopt",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
        newsletterId: foreign.id,
        slug: "foreign",
      },
    });
    expect(response.statusCode).toBe(409);
    const [unchanged] = await db()
      .select()
      .from(workspace)
      .where(eq(workspace.id, foreign.id));
    expect(unchanged?.parentWorkspaceId).toBeNull();
  });

  it("keeps tracking domain setup local, redacted, pending and restricted to publisher managers", async () => {
    const child = await createNewsletter({
      publisherId,
      name: "Tracking child",
      slug: "tracking-child",
    });
    workspaceIds.push(child.workspaceId);
    const readKey = await key(["read"]);
    const apiKey = await key([...API_OPERATION_SCOPES]);
    const payload = {
      workspaceId: publisherId,
      newsletterId: child.workspaceId,
      domain: `${randomUUID()}.example.com`,
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/publications/tracking-domains",
          headers: headers(readKey),
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const configured = await app.inject({
      method: "PUT",
      url: "/api/admin/publications/tracking-domains",
      headers: headers(apiKey),
      payload,
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json<NewsletterTrackingResponse>().data.domains).toEqual([
      expect.objectContaining({
        newsletterId: child.workspaceId,
        hostname: `dt.${payload.domain}`,
        status: "pending",
        isCurrent: true,
      }),
    ]);
    const list = await app.inject({
      method: "GET",
      url: `/api/admin/publications/tracking-domains?workspaceId=${publisherId}&newsletterId=${child.workspaceId}`,
      headers: headers(readKey),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<NewsletterTrackingResponse>().data.domains).toHaveLength(
      1,
    );
    for (const forbidden of [
      "customHostnameId",
      "cloudflareTrackingApiToken",
      "openTrackingRelaySecret",
      "Authorization",
    ])
      expect(list.body).not.toContain(forbidden);
    const originalGate = config().cloudflareTrackingAllowProvisioning;
    config().cloudflareTrackingAllowProvisioning = false;
    try {
      const provision = await app.inject({
        method: "POST",
        url: "/api/admin/publications/tracking-domains/provision",
        headers: headers(apiKey),
        payload: { workspaceId: publisherId, newsletterId: child.workspaceId },
      });
      expect(provision.statusCode).toBe(409);
      expect(provision.json()).toEqual({
        code: "tracking_provisioning_disabled",
        message: "tracking provisioning disabled",
      });
    } finally {
      config().cloudflareTrackingAllowProvisioning = originalGate;
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/publications/tracking-domains/verify",
          headers: headers(readKey),
          payload: {
            workspaceId: publisherId,
            newsletterId: child.workspaceId,
          },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("does not let another publisher read or configure a newsletter's tracking hostname", async () => {
    const child = await createNewsletter({
      publisherId,
      name: "Isolated tracking child",
      slug: "isolated-tracking-child",
    });
    workspaceIds.push(child.workspaceId);
    const foreign = await createPublisher({
      name: `foreign-tracking-${randomUUID()}`,
    });
    workspaceIds.push(foreign.id);
    const foreignKey = await key([...API_OPERATION_SCOPES], foreign.id);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/publications/tracking-domains?workspaceId=${foreign.id}&newsletterId=${child.workspaceId}`,
          headers: headers(foreignKey, foreign.id),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/publications/tracking-domains",
          headers: headers(foreignKey, foreign.id),
          payload: {
            workspaceId: foreign.id,
            newsletterId: child.workspaceId,
            domain: `${randomUUID()}.example.com`,
          },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("lists only eligible welcome journeys inside the authorized workspace", async () => {
    const own = await createNewsletter({
      publisherId,
      name: "Welcome destination",
      slug: "welcome-destination",
    });
    workspaceIds.push(own.workspaceId);
    const foreign = await createPublisher({
      name: `foreign-welcome-${randomUUID()}`,
    });
    workspaceIds.push(foreign.id);
    const sibling = await createNewsletter({
      publisherId: foreign.id,
      name: "Foreign",
      slug: "foreign",
    });
    workspaceIds.push(sibling.workspaceId);
    const eligibleId = randomUUID();
    const definition = {
      entryNode: {
        type: JourneyNodeType.EventEntryNode,
        event: "Welcome",
        child: JourneyNodeType.ExitNode,
      },
      nodes: [],
      exitNode: { type: JourneyNodeType.ExitNode },
    };
    await db()
      .insert(journey)
      .values([
        {
          id: eligibleId,
          workspaceId: own.workspaceId,
          name: "Eligible welcome",
          status: "Running",
          definition,
        },
        {
          workspaceId: own.workspaceId,
          name: "Draft welcome",
          status: "NotStarted",
          definition,
        },
        {
          workspaceId: own.workspaceId,
          name: "Keyed welcome",
          status: "Running",
          definition: {
            ...definition,
            entryNode: { ...definition.entryNode, key: "properties.key" },
          },
        },
        {
          workspaceId: own.workspaceId,
          name: "Wildcard welcome",
          status: "Running",
          definition: {
            ...definition,
            entryNode: { ...definition.entryNode, event: "Welcome*" },
          },
        },
        {
          workspaceId: sibling.workspaceId,
          name: "Foreign welcome",
          status: "Running",
          definition,
        },
      ]);
    const result = await app.inject({
      method: "GET",
      url: `/api/admin/publications/automations/options?workspaceId=${publisherId}`,
      headers: headers(await key(["read"])),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      data: {
        welcomeJourneys: [
          {
            id: eligibleId,
            name: "Eligible welcome",
            newsletterId: own.workspaceId,
          },
        ],
      },
    });
  });
});
