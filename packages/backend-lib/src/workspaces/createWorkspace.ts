import { eq } from "drizzle-orm";
import { Result } from "neverthrow";

import { provisionBuiltinUserProperties } from "../builtinUserProperties";
import { insert, QueryError, upsert } from "../db";
import { workspace as dbWorkspace } from "../db/schema";
import logger from "../logger";

export async function createWorkspace(
  values: typeof dbWorkspace.$inferInsert,
): Promise<Result<typeof dbWorkspace.$inferSelect, QueryError>> {
  logger().debug(
    {
      values,
    },
    "creating workspace",
  );
  const result = await insert({
    table: dbWorkspace,
    values,
    doNothingOnConflict: true,
    lookupExisting: eq(dbWorkspace.name, values.name),
  });
  if (result.isOk()) {
    await provisionBuiltinUserProperties(result.value.id);
  }
  return result;
}

export async function upsertWorkspace(
  values: typeof dbWorkspace.$inferInsert,
): Promise<Result<typeof dbWorkspace.$inferSelect, QueryError>> {
  if (
    values.domain === undefined &&
    values.externalId === undefined &&
    values.type === undefined &&
    values.status === undefined &&
    values.parentWorkspaceId === undefined
  ) {
    return createWorkspace(values);
  }
  const result = await upsert({
    table: dbWorkspace,
    values,
    target: [dbWorkspace.parentWorkspaceId, dbWorkspace.name],
    set: {
      domain: values.domain,
      type: values.type,
      externalId: values.externalId,
      status: values.status,
      parentWorkspaceId: values.parentWorkspaceId,
    },
  });
  if (result.isOk()) {
    await provisionBuiltinUserProperties(result.value.id);
  }
  return result;
}
