/* eslint-disable arrow-body-style */
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { getOrCreateWriteKey, getWriteKeys } from "backend-lib/src/auth";
import { db, upsert } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import { upsertEmailProvider } from "backend-lib/src/messaging/email";
import { and, eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import {
  BadRequestResponse,
  DefaultEmailProviderResource,
  DeleteWriteKeyResource,
  EmptyResponse,
  ListWriteKeyRequest,
  ListWriteKeyResource,
  UpsertDefaultEmailProviderRequest,
  UpsertEmailProviderRequest,
  UpsertWriteKeyResource,
  WriteKeyResource,
} from "isomorphic-lib/src/types";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function settingsController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/email-providers/default",
    {
      schema: {
        description: "Create or update email provider default",
        tags: ["Settings"],
        body: UpsertDefaultEmailProviderRequest,
        response: {
          201: EmptyResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, fromAddress } = request.body;
      let resource: DefaultEmailProviderResource;
      if ("emailProviderId" in request.body) {
        resource = request.body;
      } else {
        const emailProvider = await db().query.emailProvider.findFirst({
          where: and(
            eq(schema.emailProvider.workspaceId, workspaceId),
            eq(schema.emailProvider.type, request.body.emailProvider),
          ),
        });
        if (!emailProvider) {
          return reply.status(400).send({
            message: "Invalid payload. Email provider not found.",
          });
        }
        resource = {
          workspaceId,
          emailProviderId: emailProvider.id,
          fromAddress,
        };
      }

      await upsert({
        table: schema.defaultEmailProvider,
        values: resource,
        target: [schema.defaultEmailProvider.workspaceId],
        set: resource,
      });

      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/write-keys",
    {
      schema: {
        description: "Create a write key.",
        tags: ["Settings"],
        body: UpsertWriteKeyResource,
        response: {
          200: WriteKeyResource,
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, writeKeyName } = request.body;

      await getOrCreateWriteKey({
        workspaceId,
        writeKeyName,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/write-keys",
    {
      schema: {
        description: "Get write keys.",
        tags: ["Settings"],
        querystring: ListWriteKeyRequest,
        response: {
          200: ListWriteKeyResource,
        },
      },
    },
    async (request, reply) => {
      const resource = await getWriteKeys({
        workspaceId: request.query.workspaceId,
      });
      return reply.status(200).send(resource);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/write-keys",
    {
      schema: {
        description: "Delete a write key.",
        tags: ["Settings"],
        body: DeleteWriteKeyResource,
        response: {
          204: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, writeKeyName } = request.body;
      const result = await db()
        .delete(schema.secret)
        .where(
          and(
            eq(schema.secret.workspaceId, workspaceId),
            eq(schema.secret.name, writeKeyName),
          ),
        )
        .returning();
      if (!result.length) {
        return reply.status(404).send();
      }
      return reply.status(204).send();
    },
  );
}
