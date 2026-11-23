import { fastifyRequestContext } from "@fastify/request-context";
import { createAdminApiKey } from "backend-lib/src/adminApiKeys";
import config from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import { publisherSendgridAccount } from "backend-lib/src/db/publisherSchema";
import { workspace } from "backend-lib/src/db/schema";
import { createNewsletter, createPublisher } from "backend-lib/src/newsletters";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import fastify, { FastifyInstance } from "fastify";
import { API_OPERATION_SCOPES } from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { NewsletterTrackingResponse } from "isomorphic-lib/src/publications";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

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
          url: "/api/admin/publications/infrastructure/account",
          headers: headers(apiKey),
          payload: {
            workspaceId: publisherId,
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
              url: "/api/admin/publications/infrastructure/account",
              headers: headers(apiKey),
              payload: {
                workspaceId: publisherId,
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
      url: "/api/admin/publications/infrastructure/account",
      headers: headers(apiKey),
      payload: {
        workspaceId: publisherId,
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
});
