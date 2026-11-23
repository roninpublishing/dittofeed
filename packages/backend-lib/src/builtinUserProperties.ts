import { and, eq } from "drizzle-orm";
import {
  LAST_CLICKED_PROPERTY_NAME,
  LAST_OPENED_PROPERTY_NAME,
} from "isomorphic-lib/src/constants";

import { db } from "./db";
import { userProperty } from "./db/schema";
import {
  EventValueSource,
  InternalEventType,
  PerformedUserPropertyDefinition,
  UserPropertyDefinitionType,
} from "./types";

export const LAST_CLICKED_DEFINITION: PerformedUserPropertyDefinition = {
  type: UserPropertyDefinitionType.Performed,
  event: InternalEventType.EmailClicked,
  valueSource: EventValueSource.EventTime,
};

export const LAST_OPENED_DEFINITION: PerformedUserPropertyDefinition = {
  type: UserPropertyDefinitionType.Performed,
  event: InternalEventType.EmailOpened,
  valueSource: EventValueSource.EventTime,
};

async function provisionBuiltinUserProperty(
  workspaceId: string,
  name: string,
  definition: PerformedUserPropertyDefinition,
) {
  await db()
    .insert(userProperty)
    .values({
      workspaceId,
      name,
      definition,
      status: "Running",
    })
    .onConflictDoNothing({ target: [userProperty.workspaceId, userProperty.name] });
  const existing = await db().query.userProperty.findFirst({
    where: and(
      eq(userProperty.workspaceId, workspaceId),
      eq(userProperty.name, name),
      eq(userProperty.definition, definition),
    ),
  });
  if (!existing) {
    throw new Error(
      `Cannot provision ${name} in workspace ${workspaceId}: an incompatible property already uses that name. Export and rename that property administratively before retrying; its definition and assignments have not been changed.`,
    );
  }
  if (existing.status !== "Running") {
    const [updated] = await db()
      .update(userProperty)
      .set({ status: "Running" })
      .where(eq(userProperty.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  return existing;
}

/** Provision both observations without replacing existing definitions or assignments.
 * Keep returning last_clicked for existing provisioning callers.
 */
export async function provisionBuiltinUserProperties(workspaceId: string) {
  const lastClicked = await provisionBuiltinUserProperty(
    workspaceId,
    LAST_CLICKED_PROPERTY_NAME,
    LAST_CLICKED_DEFINITION,
  );
  await provisionBuiltinUserProperty(
    workspaceId,
    LAST_OPENED_PROPERTY_NAME,
    LAST_OPENED_DEFINITION,
  );
  return lastClicked;
}
