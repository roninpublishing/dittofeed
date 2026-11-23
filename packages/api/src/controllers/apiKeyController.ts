import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  createAdminApiKey,
  getAdminApiKeys,
} from "backend-lib/src/adminApiKeys";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import { and, eq, inArray } from "drizzle-orm";
import {
  AdminApiKeyResource,
  CreateAdminApiKeyRequest,
  CreateAdminApiKeyResponse,
  DeleteAdminApiKeyRequest,
  EmptyResponse,
} from "isomorphic-lib/src/types";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function apiKeyController(
  fastify: DittofeedFastifyInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/",
    {
      schema: {
        description: "List admin API keys and grants, without secret values.",
        tags: ["API Key", "Admin"],
        querystring: Type.Object({ workspaceId: Type.String() }),
        response: { 200: Type.Array(AdminApiKeyResource) },
      },
    },
    async (request, reply) =>
      reply.status(200).send(await getAdminApiKeys(request.query)),
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/",
    {
      schema: {
        description:
          "Create an admin API key. Defaults to read scope; the secret is returned only at creation.",
        tags: ["API Key", "Admin"],
        body: CreateAdminApiKeyRequest,
        response: {
          200: CreateAdminApiKeyResponse,
          409: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      const adminApiKey = await createAdminApiKey(request.body);
      if (adminApiKey.isErr()) {
        return reply.status(409).send();
      }
      return reply.status(200).send(adminApiKey.value);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/",
    {
      schema: {
        description: "Delete an admin API key.",
        tags: ["API Key", "Admin"],
        querystring: DeleteAdminApiKeyRequest,
        response: {
          204: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, workspaceId }: DeleteAdminApiKeyRequest = request.query;
      await db().transaction(async (tx) => {
        const revoked = await tx
          .delete(schema.adminApiKey)
          .where(
            and(
              eq(schema.adminApiKey.workspaceId, workspaceId),
              eq(schema.adminApiKey.id, id),
            ),
          )
          .returning({ secretId: schema.adminApiKey.secretId });
        if (revoked.length) {
          await tx.delete(schema.secret).where(
            and(
              eq(schema.secret.workspaceId, workspaceId),
              inArray(
                schema.secret.id,
                revoked.map((key) => key.secretId),
              ),
            ),
          );
        }
      });

      return reply.status(204).send();
    },
  );
}
