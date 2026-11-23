import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import logger from "backend-lib/src/logger";
import { WorkspaceStatusDbEnum } from "backend-lib/src/types";
import { createHash, timingSafeEqual } from "crypto";
import { and, eq, exists, or } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { requiredApiScopes } from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  AdminApiKeyDefinition,
  AdminApiKeyScope,
  WorkspaceIdentifier,
} from "isomorphic-lib/src/types";

import { getWorkspaceIdentifier } from "../workspace";

export type AuthenticateAdminKeyParams = {
  actualKey: string;
} & WorkspaceIdentifier;

export interface AuthenticatedAdminApiKey {
  workspaceId: string;
  keyId: string;
  // Undefined means a persisted legacy administrator key.
  scopes?: AdminApiKeyScope[];
}

export async function authenticateAdminApiKeyFull({
  actualKey,
  ...identifier
}: AuthenticateAdminKeyParams): Promise<AuthenticatedAdminApiKey | null> {
  if (!actualKey) {
    return null;
  }
  const actualKeyDigest = createHash("sha256").update(actualKey).digest();
  const actualKeyDigestView = new Uint8Array(
    actualKeyDigest.buffer,
    actualKeyDigest.byteOffset,
    actualKeyDigest.byteLength,
  );
  let apiKeys: {
    id: string;
    workspaceId: string;
    configValue: unknown;
  }[];
  if ("workspaceId" in identifier) {
    const { workspaceId } = identifier;
    apiKeys = await db()
      .select({
        id: schema.adminApiKey.id,
        workspaceId: schema.adminApiKey.workspaceId,
        configValue: schema.secret.configValue,
      })
      .from(schema.adminApiKey)
      .innerJoin(
        schema.secret,
        eq(schema.adminApiKey.secretId, schema.secret.id),
      )
      .where(
        or(
          // Condition 1: API key belongs DIRECTLY to the target workspace, and that workspace is active.
          and(
            eq(schema.adminApiKey.workspaceId, workspaceId), // Key's workspace IS the target workspace
            exists(
              // And the target workspace is active
              db()
                .select({ id: schema.workspace.id })
                .from(schema.workspace)
                .where(
                  and(
                    eq(schema.workspace.id, workspaceId),
                    eq(schema.workspace.status, WorkspaceStatusDbEnum.Active),
                  ),
                ),
            ),
          ),
          // Condition 2: API key belongs to the PARENT of the target workspace,
          // and the target workspace is active, and the parent workspace (key owner) is also active.
          and(
            exists(
              // Check: target workspace is active AND its parent is the API key's workspace
              db()
                .select({ id: schema.workspace.id }) // Target workspace
                .from(schema.workspace)
                .where(
                  and(
                    eq(schema.workspace.id, workspaceId), // This is the target workspace
                    eq(schema.workspace.status, WorkspaceStatusDbEnum.Active), // Target is active
                    eq(
                      schema.workspace.parentWorkspaceId,
                      schema.adminApiKey.workspaceId,
                    ), // Target's parent is key's workspace
                  ),
                ),
            ),
            exists(
              // Also ensure the API key's own workspace (the parent) is active
              db()
                .select({ id: schema.workspace.id }) // API key's own workspace (parent)
                .from(schema.workspace)
                .where(
                  and(
                    eq(schema.workspace.id, schema.adminApiKey.workspaceId),
                    eq(schema.workspace.status, WorkspaceStatusDbEnum.Active),
                  ),
                ),
            ),
          ),
        ),
      );
  } else {
    const { externalId } = identifier;
    apiKeys = await db()
      .select({
        id: schema.adminApiKey.id,
        workspaceId: schema.adminApiKey.workspaceId,
        configValue: schema.secret.configValue,
      })
      .from(schema.adminApiKey)
      .innerJoin(
        schema.secret,
        eq(schema.adminApiKey.secretId, schema.secret.id),
      )
      .where(
        or(
          // Condition 1: API key belongs to the workspace identified by externalId, and that workspace is active.
          exists(
            db()
              .select({ id: schema.workspace.id })
              .from(schema.workspace) // This is the key's workspace / target workspace
              .where(
                and(
                  eq(schema.workspace.id, schema.adminApiKey.workspaceId), // Key belongs to this workspace
                  eq(schema.workspace.externalId, externalId), // This workspace has the given externalId
                  eq(schema.workspace.status, WorkspaceStatusDbEnum.Active), // And this workspace is active
                ),
              ),
          ),
          // Condition 2: API key belongs to the PARENT of the workspace identified by externalId.
          // Both the target workspace (with externalId) and the parent workspace (key owner) must be active.
          and(
            exists(
              // Check: target workspace (identified by externalId) is active AND its parent is the API key's workspace
              db()
                .select({ id: schema.workspace.id }) // Target workspace
                .from(schema.workspace)
                .where(
                  and(
                    eq(schema.workspace.externalId, externalId), // Target has the externalId
                    eq(schema.workspace.status, WorkspaceStatusDbEnum.Active), // Target is active
                    eq(
                      schema.workspace.parentWorkspaceId,
                      schema.adminApiKey.workspaceId,
                    ), // Target's parent is key's workspace
                  ),
                ),
            ),
            exists(
              // Also ensure the API key's own workspace (the parent) is active
              db()
                .select({ id: schema.workspace.id }) // API key's own workspace (parent)
                .from(schema.workspace)
                .where(
                  and(
                    eq(schema.workspace.id, schema.adminApiKey.workspaceId),
                    eq(schema.workspace.status, WorkspaceStatusDbEnum.Active),
                  ),
                ),
            ),
          ),
        ),
      );
  }

  for (const apiKey of apiKeys) {
    const definitionResult = schemaValidate(
      apiKey.configValue,
      AdminApiKeyDefinition,
    );
    if (definitionResult.isErr()) {
      logger().error(
        {
          ...identifier,
          apiKeyId: apiKey.id,
        },
        "Invalid admin API key definition",
      );
      continue;
    }
    const definition = definitionResult.value;
    let expectedDigest: Buffer;
    if ("keyHash" in definition) {
      // Legacy JSON can contain extra properties; never decode a malformed
      // digest or interpret an unscoped digest as a legacy administrator.
      if (
        typeof definition.keyHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(definition.keyHash) ||
        definition.scopes === undefined
      ) {
        continue;
      }
      expectedDigest = Buffer.from(definition.keyHash, "hex");
    } else {
      expectedDigest = createHash("sha256").update(definition.key).digest();
    }
    // Zero-copy views bridge Buffer and older Node iterator typings.
    if (
      timingSafeEqual(
        new Uint8Array(
          expectedDigest.buffer,
          expectedDigest.byteOffset,
          expectedDigest.byteLength,
        ),
        actualKeyDigestView,
      )
    ) {
      return {
        workspaceId: apiKey.workspaceId,
        keyId: apiKey.id,
        scopes: definition.scopes,
      };
    }
  }

  logger().debug(
    {
      ...identifier,
    },
    "API key not found among workspace's API keys",
  );
  return null;
}

export async function authenticateAdminApiKey(
  params: AuthenticateAdminKeyParams,
): Promise<boolean> {
  const apiKeyId = await authenticateAdminApiKeyFull(params);
  return apiKeyId !== null;
}

// eslint-disable-next-line @typescript-eslint/require-await
const adminAuth = fp(async (fastify: FastifyInstance) => {
  fastify.addHook("preHandler", async (request, reply) => {
    const routePath =
      request.routeOptions.url ?? request.url.split("?")[0] ?? "/";
    if (
      request.body !== null &&
      typeof request.body === "object" &&
      "externalId" in request.body
    ) {
      return reply.status(400).send({
        message: "externalId is supported only as a query workspace identifier",
      });
    }
    // Handlers may consume externalId independently; never authorize one tenant
    // identifier while allowing a second, unchecked identifier through.
    const hasExternalId = [request.body, request.query].some(
      (source) =>
        source !== null && typeof source === "object" && "externalId" in source,
    );
    const hasWorkspaceId =
      [request.body, request.query].some(
        (source) =>
          source !== null &&
          typeof source === "object" &&
          "workspaceId" in source,
      ) || request.headers[WORKSPACE_ID_HEADER] !== undefined;
    if (hasExternalId && hasWorkspaceId) {
      return reply
        .status(400)
        .send({ message: "Ambiguous workspace identifiers" });
    }
    const workspaceIdentifierResult = await getWorkspaceIdentifier(request);
    if (workspaceIdentifierResult.isErr()) {
      logger().info(
        {
          err: workspaceIdentifierResult.error,
          path: routePath,
          method: request.method,
        },
        "Error getting workspace identifier for admin auth",
      );
      return reply.status(400).send({
        message: workspaceIdentifierResult.error.message,
      });
    }
    const workspaceIdentifier = workspaceIdentifierResult.value;
    if (!workspaceIdentifier) {
      const errorMessage = "workspace identifier missing for request";
      logger().info(
        {
          path: routePath,
          method: request.method,
        },
        errorMessage,
      );
      return reply.status(401).send({
        message: errorMessage,
      });
    }
    if (!request.headers.authorization) {
      const errorMessage = "No authorization header";
      logger().info(
        {
          path: routePath,
          method: request.method,
        },
        errorMessage,
      );
      return reply.status(401).send({
        message: errorMessage,
      });
    }
    const splitAuth = request.headers.authorization.trim().split(" ");
    if (splitAuth.length !== 2 || splitAuth[0] !== "Bearer") {
      const errorMessage = "Invalid authorization header";
      logger().info(
        {
          path: routePath,
          method: request.method,
        },
        errorMessage,
      );
      return reply.status(401).send({
        message: errorMessage,
      });
    }
    const actualKey = splitAuth[1];
    if (!actualKey) {
      const errorMessage = "API key missing for request";
      logger().info(
        {
          path: routePath,
          method: request.method,
        },
        errorMessage,
      );
      return reply.status(401).send({
        message: errorMessage,
      });
    }
    const authenticated = await authenticateAdminApiKeyFull({
      ...workspaceIdentifier,
      actualKey,
    });
    if (!authenticated) {
      const errorMessage = "API key not valid";
      logger().info(
        {
          path: routePath,
          method: request.method,
          ...workspaceIdentifier,
        },
        errorMessage,
      );
      return reply.status(401).send({
        message: errorMessage,
      });
    }
    const requiredScopes = requiredApiScopes(
      request.method,
      request.routeOptions.url ?? request.url,
    );
    const { scopes } = authenticated;
    if (
      scopes !== undefined &&
      !requiredScopes.every((scope) => scopes.includes(scope))
    ) {
      return reply.status(403).send({ message: "API key scope not granted" });
    }
  });
});

export default adminAuth;
