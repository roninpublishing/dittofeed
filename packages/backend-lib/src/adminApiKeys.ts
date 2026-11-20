import { createHash, randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { err, ok, Result } from "neverthrow";
import { PostgresError } from "pg-error-enum";

import { db, queryResult } from "./db";
import { adminApiKey as dbAdminApiKey, secret as dbSecret } from "./db/schema";
import {
  AdminApiKeyDefinition,
  AdminApiKeyPermission,
  AdminApiKeyResource,
  AdminApiKeyType,
  CreateAdminApiKeyRequest,
  CreateAdminApiKeyResponse,
} from "./types";

export enum AdminApiKeyCreateErrorType {
  Conflict = "Conflict",
}

export interface AdminApiKeyCreateConflictError {
  type: AdminApiKeyCreateErrorType.Conflict;
}

export type AdminApiKeyCreateError = AdminApiKeyCreateConflictError;

export async function createAdminApiKey(
  data: CreateAdminApiKeyRequest,
): Promise<Result<CreateAdminApiKeyResponse, AdminApiKeyCreateError>> {
  const newKey = randomBytes(32).toString("hex");

  const result = await queryResult(
    db().transaction(async (tx) => {
      const configValue: AdminApiKeyDefinition = {
        type: AdminApiKeyType.AdminApiKey,
        keyHash: createHash("sha256").update(newKey).digest("hex"),
        permissions: [AdminApiKeyPermission.Admin],
        scopes: data.scopes ?? ["read"],
      };
      // Rotate orphaned secrets left by older revocation code. A conflicting
      // live key rolls back this transaction instead of disclosing its secret.
      const [secret] = await tx
        .insert(dbSecret)
        .values({
          workspaceId: data.workspaceId,
          name: `df-admin-api-key-${data.name}`,
          configValue,
        })
        .onConflictDoUpdate({
          target: [dbSecret.workspaceId, dbSecret.name],
          set: { configValue, value: null },
        })
        .returning();
      if (!secret) {
        throw new Error("Failed to create secret");
      }
      const [adminApiKey] = await tx
        .insert(dbAdminApiKey)
        .values({
          name: data.name,
          workspaceId: data.workspaceId,
          secretId: secret.id,
        })
        .returning();
      if (!adminApiKey) {
        throw new Error("Failed to create admin API key");
      }
      return { adminApiKey, secret };
    }),
  );
  if (result.isErr()) {
    if (
      result.error.code === PostgresError.UNIQUE_VIOLATION ||
      result.error.code === PostgresError.FOREIGN_KEY_VIOLATION
    ) {
      return err({ type: AdminApiKeyCreateErrorType.Conflict });
    }
    throw result.error;
  }
  const secretConfig = unwrap(
    schemaValidateWithErr(
      result.value.secret.configValue,
      AdminApiKeyDefinition,
    ),
  );
  return ok({
    workspaceId: data.workspaceId,
    apiKey: newKey,
    name: data.name,
    id: result.value.adminApiKey.id,
    createdAt: result.value.adminApiKey.createdAt.getTime(),
    scopes: secretConfig.scopes,
  });
}

export async function getAdminApiKeys({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<AdminApiKeyResource[]> {
  const keys = await db()
    .select({
      id: dbAdminApiKey.id,
      name: dbAdminApiKey.name,
      createdAt: dbAdminApiKey.createdAt,
      configValue: dbSecret.configValue,
    })
    .from(dbAdminApiKey)
    .innerJoin(dbSecret, eq(dbAdminApiKey.secretId, dbSecret.id))
    .where(eq(dbAdminApiKey.workspaceId, workspaceId));
  return keys.map((key) => {
    const definition = unwrap(
      schemaValidateWithErr(key.configValue, AdminApiKeyDefinition),
    );
    return {
      workspaceId,
      id: key.id,
      name: key.name,
      createdAt: key.createdAt.getTime(),
      scopes: definition.scopes,
    };
  });
}
