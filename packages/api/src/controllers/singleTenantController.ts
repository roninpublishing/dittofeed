import { Type, TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { requireGoogleOrigin } from "backend-lib/src/accountAuthorization";
import backendConfig from "backend-lib/src/config";
import logger from "backend-lib/src/logger";
import { getRequestContext, SESSION_KEY, SESSION_WORKSPACE_KEY } from "backend-lib/src/requestContext";
import { FastifyInstance } from "fastify";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function authController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/workspace",
    {
      schema: {
        description: "Select an authorized newsletter for a shared-login browser session.",
        body: Type.Object({ workspaceId: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const { authMode } = backendConfig();
      if (authMode !== "single-tenant" && authMode !== "anonymous") {
        return reply.status(404).send();
      }
      if (authMode === "single-tenant" && request.session.get(SESSION_KEY) !== true) {
        return reply.status(401).send();
      }
      try {
        requireGoogleOrigin(request.headers.origin, request.method);
      } catch {
        return reply.status(403).send();
      }
      const context = await getRequestContext({ [SESSION_KEY]: "true" });
      if (context.isErr() || !context.value.memberRoles.some((role) => role.workspaceId === request.body.workspaceId)) {
        return reply.status(403).send();
      }
      request.session.set(SESSION_WORKSPACE_KEY, request.body.workspaceId);
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/login",
    {
      schema: {
        description: "Login in single-tenant auth mode.",
        body: Type.Object({
          password: Type.String(),
        }),
      },
    },
    async (request, reply) => {
      const { password, authMode } = backendConfig();
      if (authMode !== "single-tenant") {
        return reply.status(404).send();
      }

      if (!password?.length) {
        logger().error("No password configured in single tenant mode.");
        return reply.status(500).send({
          error: "Application is misconfigured, contact support.",
        });
      }

      if (request.body.password !== password) {
        return reply.status(401).send({
          error: "Invalid password.",
        });
      }
      request.session.set(SESSION_KEY, true);
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/signout",
    {
      schema: {
        description: "Signout in single-tenant auth mode.",
      },
    },
    async (request, reply) => {
      const { authMode } = backendConfig();
      if (authMode !== "single-tenant") {
        return reply.status(404).send();
      }
      request.session.delete();
      return reply.redirect(302, "/dashboard/auth/single-tenant");
    },
  );
}
