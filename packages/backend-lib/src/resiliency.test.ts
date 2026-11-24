import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import {
  LAST_CLICKED_PROPERTY_NAME,
  LAST_OPENED_PROPERTY_NAME,
} from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import { db, insert } from "./db";
import {
  computedPropertyPeriod as dbComputedPropertyPeriod,
  segment as dbSegment,
  userProperty as dbUserProperty,
  workspace as dbWorkspace,
} from "./db/schema";
import {
  findActiveWorkspaces,
  observeWorkspaceComputeLatency,
} from "./resiliency";
import {
  ComputedPropertyStepEnum,
  SegmentDefinition,
  SegmentNodeType,
  SegmentOperatorType,
  WorkspaceStatusDb,
  WorkspaceStatusDbEnum,
  WorkspaceTypeAppEnum,
} from "./types";
import { upsertWorkspace } from "./workspaces/createWorkspace";

async function insertOldComputeAssignmentsPeriod(workspaceId: string) {
  await insert({
    table: dbComputedPropertyPeriod,
    values: {
      id: randomUUID(),
      workspaceId,
      type: "Segment",
      computedPropertyId: randomUUID(),
      version: Date.now().toString(),
      from: new Date(Date.now() - 1000 * 60),
      to: new Date(Date.now() - 1000 * 55),
      step: ComputedPropertyStepEnum.ComputeAssignments,
    },
  });
}

describe("resiliency", () => {
  describe("observeWorkspaceComputeLatency", () => {
    beforeEach(async () => {
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: randomUUID(),
          updatedAt: new Date(),
          status: WorkspaceStatusDbEnum.Active,
        },
      });
    });
    test("does not throw", async () => {
      await observeWorkspaceComputeLatency();
    });
  });

  async function createWorkspace(status: WorkspaceStatusDb): Promise<{
    workspaceId: string;
  }> {
    const workspace = await insert({
      table: dbWorkspace,
      values: {
        id: randomUUID(),
        name: randomUUID(),
        status,
        updatedAt: new Date(),
      },
    }).then(unwrap);

    await insert({
      table: dbSegment,
      values: {
        id: randomUUID(),
        workspaceId: workspace.id,
        name: randomUUID(),
        definition: {
          entryNode: {
            id: randomUUID(),
            type: SegmentNodeType.Trait,
            path: "trait",
            operator: {
              type: SegmentOperatorType.Within,
              windowSeconds: 1000,
            },
          },
          nodes: [],
        } satisfies SegmentDefinition,
        updatedAt: new Date(),
      },
    });

    await insert({
      table: dbComputedPropertyPeriod,
      values: {
        id: randomUUID(),
        step: ComputedPropertyStepEnum.ComputeAssignments,
        from: new Date(Date.now() - 1000 * 60),
        to: new Date(),
        type: "Segment",
        version: Date.now().toString(),
        computedPropertyId: randomUUID(),
        workspaceId: workspace.id,
      },
    });

    return { workspaceId: workspace.id };
  }

  describe("findActiveWorkspaces", () => {
    describe("when you have an active and tombstoned workspace", () => {
      let activeWorkspace: string;
      let tombstonedWorkspace: string;
      beforeEach(async () => {
        const [active, tombstoned] = await Promise.all([
          createWorkspace(WorkspaceStatusDbEnum.Active),
          createWorkspace(WorkspaceStatusDbEnum.Tombstoned),
        ]);
        activeWorkspace = active.workspaceId;
        tombstonedWorkspace = tombstoned.workspaceId;
      });

      test("returns active workspaces and their latest compute period", async () => {
        const { workspaces } = await findActiveWorkspaces();
        expect(
          workspaces.find((w) => w.id === activeWorkspace),
        ).not.toBeUndefined();
        expect(
          workspaces.find((w) => w.id === tombstonedWorkspace),
        ).toBeUndefined();
      });
    });
    describe("when you have an active root workspace and a child workspace without any segments or user properties that has old compute periods", () => {
      let activeWorkspace: string;
      let childWorkspace: string;
      beforeEach(async () => {
        const parentWorkspace = await upsertWorkspace({
          name: randomUUID(),
          status: WorkspaceStatusDbEnum.Active,
          updatedAt: new Date(),
          type: WorkspaceTypeAppEnum.Parent,
        }).then(unwrap);

        [activeWorkspace, childWorkspace] = await Promise.all([
          createWorkspace(WorkspaceStatusDbEnum.Active).then(
            (w) => w.workspaceId,
          ),
          upsertWorkspace({
            name: randomUUID(),
            status: WorkspaceStatusDbEnum.Active,
            updatedAt: new Date(),
            type: WorkspaceTypeAppEnum.Child,
            domain: randomUUID(),
            externalId: randomUUID(),
            parentWorkspaceId: parentWorkspace.id,
          })
            .then(unwrap)
            .then((w) => w.id),
        ]);

        // Workspace creation provisions the protected last_clicked/last_opened
        // properties. Remove them to model a workspace with no computed properties.
        await db()
          .delete(dbUserProperty)
          .where(eq(dbUserProperty.workspaceId, childWorkspace));

        await insertOldComputeAssignmentsPeriod(childWorkspace);
      });
      test("returns active workspaces and their latest compute period but excludes the child workspace with old compute periods and no computed properties", async () => {
        const { periods } = await findActiveWorkspaces();
        expect(
          periods.find((w) => w.workspaceId === activeWorkspace),
        ).not.toBeUndefined();
        expect(
          periods.find((w) => w.workspaceId === childWorkspace),
        ).toBeUndefined();
      });
    });
    describe("when a workspace has only the built-in protected user properties", () => {
      let workspaceId: string;
      beforeEach(async () => {
        workspaceId = await upsertWorkspace({
          name: randomUUID(),
          status: WorkspaceStatusDbEnum.Active,
          updatedAt: new Date(),
        })
          .then(unwrap)
          .then((w) => w.id);
        await insertOldComputeAssignmentsPeriod(workspaceId);
      });
      test("includes its latest compute period because the built-in properties are computed", async () => {
        const builtins = await db()
          .select({ name: dbUserProperty.name })
          .from(dbUserProperty)
          .where(eq(dbUserProperty.workspaceId, workspaceId));
        expect(builtins.map((p) => p.name).sort()).toEqual(
          [LAST_CLICKED_PROPERTY_NAME, LAST_OPENED_PROPERTY_NAME].sort(),
        );

        const { periods } = await findActiveWorkspaces();
        expect(
          periods.find((w) => w.workspaceId === workspaceId),
        ).not.toBeUndefined();
      });
    });
  });
});
