import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";

import { db } from "../db";
import * as schema from "../db/schema";
import { LAST_CLICKED_DEFINITION, LAST_OPENED_DEFINITION } from "../builtinUserProperties";
import { createWorkspace, upsertWorkspace } from "./createWorkspace";

describe("createWorkspaces", () => {
  it.each([createWorkspace, upsertWorkspace])("provisions the canonical running builtin on creation", async (create) => {
    const result = await create({ name: randomUUID() });
    const workspace = result._unsafeUnwrap();
    expect(await db().query.userProperty.findMany({
      where: eq(schema.userProperty.workspaceId, workspace.id),
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "last_clicked", status: "Running", definition: LAST_CLICKED_DEFINITION }),
      expect.objectContaining({ name: "last_opened", status: "Running", definition: LAST_OPENED_DEFINITION }),
    ]));
  });
  describe("upsertWorkspace", () => {
    describe("when a workspace already exists", () => {
      let workspaceName: string;
      beforeEach(async () => {
        workspaceName = randomUUID();
        await upsertWorkspace({
          name: workspaceName,
        });
      });
      it("should create a workspace", async () => {
        const workspace = await upsertWorkspace({
          name: workspaceName,
        });
        expect(workspace).toBeDefined();
        const workspacesFromDb = await db().query.workspace.findMany({
          where: eq(schema.workspace.name, workspaceName),
        });
        expect(workspacesFromDb).toHaveLength(1);
        expect(workspacesFromDb[0]?.name).toBe(workspaceName);
      });
    });
  });
});
