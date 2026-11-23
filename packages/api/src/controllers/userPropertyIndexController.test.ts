import { db } from "backend-lib/src/db";
import { userProperty, userPropertyIndex } from "backend-lib/src/db/schema";
import { createWorkspace } from "backend-lib/src/workspaces";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import fastify from "fastify";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { TYPE_REFS } from "isomorphic-lib/src/typeRefs";

import userPropertyIndexController from "./userPropertyIndexController";

describe("user property index workspace ownership", () => {
  it.each(["foreign", "missing"])(
    "rejects a %s property before configuring or backfilling an index",
    async (kind) => {
      const caller = unwrap(await createWorkspace({ name: randomUUID() }));
      const owner = unwrap(await createWorkspace({ name: randomUUID() }));
      const foreign = await db().query.userProperty.findFirst({
        columns: { id: true },
        where: eq(userProperty.workspaceId, owner.id),
      });
      if (!foreign)
        throw new Error(
          "Workspace must provision its protected user properties.",
        );
      const userPropertyId = kind === "foreign" ? foreign.id : randomUUID();
      const app = fastify();
      TYPE_REFS.forEach((schema) => app.addSchema(schema));
      await app.register(userPropertyIndexController);
      try {
        const response = await app.inject({
          method: "PUT",
          url: "/",
          payload: { workspaceId: caller.id, userPropertyId, type: "String" },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          message: "User property not found.",
        });
        const index = await db().query.userPropertyIndex.findFirst({
          where: and(
            eq(userPropertyIndex.workspaceId, caller.id),
            eq(userPropertyIndex.userPropertyId, userPropertyId),
          ),
        });
        expect(index).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );
});
