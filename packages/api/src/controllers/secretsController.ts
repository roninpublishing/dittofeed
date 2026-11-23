import { Type, TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { db, upsert } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import { and, eq, inArray, SQL } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { isObject } from "isomorphic-lib/src/objects";
import {
  AdminApiKeyType,
  DeleteSecretRequest,
  EmptyResponse,
  JSONValue,
  ListSecretsRequest,
  SecretResource,
  UpsertSecretRequest,
} from "isomorphic-lib/src/types";

function isApiKeySecret(secret: {
  name: string;
  configValue?: unknown;
}): boolean {
  return (
    secret.name.startsWith("df-admin-api-key-") ||
    (isObject(secret.configValue) &&
      secret.configValue.type === AdminApiKeyType.AdminApiKey)
  );
}

// eslint-disable-next-line @typescript-eslint/require-await
export default async function secretsController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/",
    {
      schema: {
        description: "List secrets.",
        querystring: ListSecretsRequest,
        tags: ["Secrets"],
        response: {
          200: Type.Array(SecretResource),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, names } = request.query;

      const conditions: SQL[] = [eq(schema.secret.workspaceId, workspaceId)];
      if (names?.length) {
        conditions.push(inArray(schema.secret.name, names));
      }

      const secrets = (
        await db()
          .select()
          .from(schema.secret)
          .where(and(...conditions))
      ).flatMap((secret) => {
        if (!secret.value) {
          return [];
        }
        return {
          workspaceId: secret.workspaceId,
          name: secret.name,
          value: secret.value,
        };
      });
      return reply.status(200).send(secrets);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/",
    {
      schema: {
        description:
          "Create or patch a provider secret. API key secrets require the dedicated admin-key lifecycle APIs.",
        tags: ["Secrets"],
        body: UpsertSecretRequest,
        response: {
          204: EmptyResponse,
          403: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, name, value, configValue } = request.body;
      if (isApiKeySecret({ name, configValue })) {
        return reply.status(403).send({
          message: "Use the admin-key lifecycle APIs for API key secrets",
        });
      }
      const saved = await db().transaction(async (pTx) => {
        const [secret] = await pTx
          .select()
          .from(schema.secret)
          .where(
            and(
              eq(schema.secret.workspaceId, workspaceId),
              eq(schema.secret.name, name),
            ),
          )
          .for("update");
        if (secret) {
          const linkedKey = await pTx.query.adminApiKey.findFirst({
            columns: { id: true },
            where: eq(schema.adminApiKey.secretId, secret.id),
          });
          // Identity and linkage remain authoritative if a name or type is stale.
          if (isApiKeySecret(secret) || linkedKey) return false;
        }
        const existingConfigValue =
          secret?.configValue && isObject(secret.configValue)
            ? secret.configValue
            : undefined;

        let newConfig: Record<string, unknown> | undefined;
        if (configValue) {
          newConfig = {
            ...existingConfigValue,
            ...configValue,
          };
        } else {
          newConfig = undefined;
        }
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const configValueToSave = newConfig as
          | Record<string, JSONValue>
          | undefined;
        await upsert({
          table: schema.secret,
          tx: pTx,
          values: {
            id: secret?.id,
            workspaceId,
            name,
            value,
            configValue: configValueToSave,
          },
          target: [schema.secret.workspaceId, schema.secret.name],
          set: {
            value,
            configValue: configValueToSave,
          },
        });
        return true;
      });
      if (!saved) {
        return reply.status(403).send({
          message: "Use the admin-key lifecycle APIs for API key secrets",
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/",
    {
      schema: {
        description:
          "Delete a provider secret. API key secrets require the dedicated admin-key lifecycle APIs.",
        querystring: DeleteSecretRequest,
        tags: ["Secrets"],
        response: {
          204: EmptyResponse,
          403: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, id } = request.query;
      const status = await db().transaction(async (pTx) => {
        const [secret] = await pTx
          .select()
          .from(schema.secret)
          .where(
            and(
              eq(schema.secret.workspaceId, workspaceId),
              eq(schema.secret.id, id),
            ),
          )
          .for("update");
        if (!secret) return 404;
        const linkedKey = await pTx.query.adminApiKey.findFirst({
          columns: { id: true },
          where: eq(schema.adminApiKey.secretId, secret.id),
        });
        if (isApiKeySecret(secret) || linkedKey) return 403;
        await pTx.delete(schema.secret).where(eq(schema.secret.id, secret.id));
        return 204;
      });
      if (status === 403) {
        return reply.status(403).send({
          message: "Use the admin-key lifecycle APIs for API key secrets",
        });
      }
      return reply.status(status).send();
    },
  );
}
