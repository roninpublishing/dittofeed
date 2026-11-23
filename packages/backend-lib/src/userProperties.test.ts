import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import {
  LAST_CLICKED_DEFINITION,
  LAST_OPENED_DEFINITION,
  provisionBuiltinUserProperties,
} from "./builtinUserProperties";
import { db, insert } from "./db";
import {
  userProperty as dbUserProperty,
  workspace as dbWorkspace,
} from "./db/schema";
import {
  AppFileType,
  BlobStorageFile,
  EventValueSource,
  FileUserPropertyDefinition,
  InternalEventType,
  UserProperty,
  UserPropertyDefinition,
  UserPropertyDefinitionType,
  UserPropertyOperatorType,
  UpdateUserPropertyStatusErrorType,
  UpsertUserPropertyErrorType,
  UpsertUserPropertyResource,
  Workspace,
} from "./types";
import {
  findAllUserPropertyAssignments,
  deleteUserProperty,
  findAllUserPropertyAssignmentsById,
  findAllUserPropertyAssignmentsForWorkspace,
  findAllUserPropertyResources,
  findUserIdsByUserPropertyValue,
  insertUserPropertyAssignments,
  updateUserPropertyStatus,
  upsertUserProperty,
  UserPropertyBulkUpsertItem,
} from "./userProperties";
import { getUsers } from "./users";

describe("userProperties", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = unwrap(
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: `workspace-${randomUUID()}`,
          updatedAt: new Date(),
        },
      }),
    );
  });

  describe("last_clicked", () => {
    it("provisions idempotently and protects creation, ID-only edits, rename, deletion and status", async () => {
      const property = await provisionBuiltinUserProperties(workspace.id);
      expect(await provisionBuiltinUserProperties(workspace.id)).toMatchObject({
        id: property.id, name: "last_clicked", status: "Running",
        definition: LAST_CLICKED_DEFINITION,
      });
      for (const params of [
        { workspaceId: workspace.id, name: "last_clicked", definition: LAST_CLICKED_DEFINITION },
        { workspaceId: workspace.id, id: property.id, name: "other", definition: { type: UserPropertyDefinitionType.Trait, path: "bad" } },
        { workspaceId: workspace.id, id: property.id, name: "renamed", definition: LAST_CLICKED_DEFINITION },
      ] satisfies UpsertUserPropertyResource[]) {
        expect((await upsertUserProperty(params))._unsafeUnwrapErr().type)
          .toBe(UpsertUserPropertyErrorType.ProtectedUserProperty);
      }
      expect((await updateUserPropertyStatus({ workspaceId: workspace.id, id: property.id, status: "Paused" }))._unsafeUnwrapErr().type)
        .toBe(UpdateUserPropertyStatusErrorType.ProtectedUserProperty);
      expect(await deleteUserProperty({ workspaceId: workspace.id, id: property.id })).toBeNull();
    });

    it("fails explicitly without replacing an incompatible definition or assignment", async () => {
      const [existing] = await db().insert(dbUserProperty).values({
        workspaceId: workspace.id, name: "last_clicked",
        definition: { type: UserPropertyDefinitionType.Trait, path: "custom" },
      }).returning();
      if (!existing) throw new Error("missing property");
      await insertUserPropertyAssignments([{ workspaceId: workspace.id, userId: "user", userPropertyId: existing.id, value: "owned-value" }]);
      await expect(provisionBuiltinUserProperties(workspace.id)).rejects.toThrow("incompatible property");
      expect(await findAllUserPropertyAssignments({ workspaceId: workspace.id, userId: "user" }))
        .toEqual({ id: "user", last_clicked: "owned-value" });
    });

    it("uses unordered matching context event times, not clickedAt, and never regresses persisted max", async () => {
      const property = await provisionBuiltinUserProperties(workspace.id);
      await insertUserPropertyAssignments([{ workspaceId: workspace.id, userId: "user", userPropertyId: property.id, value: "2026-10-03T12:00:00.789Z" }]);
      const eventContext = [
        { event: InternalEventType.EmailClicked, messageId: "new", timestamp: "2026-10-03T09:00:00.123-04:00", properties: { clickedAt: "2099-01-01T00:00:00Z" } },
        { event: InternalEventType.EmailDelivered, messageId: "unrelated", timestamp: "2099-01-01T00:00:00Z" },
        { event: InternalEventType.EmailClicked, messageId: "old", timestamp: "2026-10-01T00:00:00Z" },
      ];
      expect(await findAllUserPropertyAssignments({ workspaceId: workspace.id, userId: "user", eventContext }))
        .toEqual({ id: "user", last_clicked: "2026-10-03T13:00:00.123Z" });
      expect(await findAllUserPropertyAssignmentsById({ workspaceId: workspace.id, userId: "user", eventContext: eventContext.slice(1) }))
        .toEqual({ id: "user", [property.id]: "2026-10-03T12:00:00.789Z" });
      expect(await findUserIdsByUserPropertyValue({ workspaceId: workspace.id, userPropertyName: "last_clicked", value: "2026-10-03T12:00:00.789Z" }))
        .toEqual(["user"]);
      const users = unwrap(await getUsers({
        workspaceId: workspace.id,
        userPropertyFilter: [{ id: property.id, values: ["2026-10-03T12:00:00.789Z"] }],
      }, { throwOnError: true }));
      expect(users.users.map((user) => user.id)).toEqual(["user"]);
      expect(users.users[0]?.properties[property.id]?.value).toBe("2026-10-03T12:00:00.789Z");
    });

    it("supports EventTime in grouped properties while keeping persisted maxima", async () => {
      const [property] = await db().insert(dbUserProperty).values({
        workspaceId: workspace.id, name: "grouped_click",
        definition: {
          type: UserPropertyDefinitionType.Group, entry: "any",
          nodes: [
            { type: UserPropertyDefinitionType.AnyOf, id: "any", children: ["click"] },
            { ...LAST_CLICKED_DEFINITION, id: "click", valueSource: EventValueSource.EventTime },
          ],
        },
      }).returning();
      if (!property) throw new Error("missing property");
      await insertUserPropertyAssignments([{ workspaceId: workspace.id, userId: "user", userPropertyId: property.id, value: "2026-10-03T12:00:00.789Z" }]);
      expect(await findAllUserPropertyAssignments({
        workspaceId: workspace.id, userId: "user",
        eventContext: [{ event: InternalEventType.EmailClicked, messageId: "old", timestamp: "2026-10-01T00:00:00Z" }],
      })).toEqual({ id: "user", grouped_click: "2026-10-03T12:00:00.789Z" });
    });
  });

  describe("last_opened", () => {
    async function openedProperty() {
      await provisionBuiltinUserProperties(workspace.id);
      const property = await db().query.userProperty.findFirst({
        where: and(
          eq(dbUserProperty.workspaceId, workspace.id),
          eq(dbUserProperty.name, "last_opened"),
        ),
      });
      if (!property) throw new Error("missing last_opened property");
      return property;
    }

    it("provisions idempotently while preserving the click return and protecting its lifecycle", async () => {
      const property = await openedProperty();
      expect(await provisionBuiltinUserProperties(workspace.id)).toMatchObject({
        name: "last_clicked", definition: LAST_CLICKED_DEFINITION,
      });
      expect(await openedProperty()).toMatchObject({
        id: property.id, name: "last_opened", status: "Running",
        definition: LAST_OPENED_DEFINITION,
      });
      for (const params of [
        { workspaceId: workspace.id, name: "last_opened", definition: LAST_OPENED_DEFINITION },
        { workspaceId: workspace.id, id: property.id, name: "other", definition: { type: UserPropertyDefinitionType.Trait, path: "bad" } },
        { workspaceId: workspace.id, id: property.id, name: "renamed", definition: LAST_OPENED_DEFINITION },
      ] satisfies UpsertUserPropertyResource[]) {
        expect((await upsertUserProperty(params))._unsafeUnwrapErr().type)
          .toBe(UpsertUserPropertyErrorType.ProtectedUserProperty);
      }
      expect((await updateUserPropertyStatus({ workspaceId: workspace.id, id: property.id, status: "Paused" }))._unsafeUnwrapErr().type)
        .toBe(UpdateUserPropertyStatusErrorType.ProtectedUserProperty);
      expect(await deleteUserProperty({ workspaceId: workspace.id, id: property.id })).toBeNull();
    });

    it("keeps conflicting definitions and assignments intact", async () => {
      const [existing] = await db().insert(dbUserProperty).values({
        workspaceId: workspace.id, name: "last_opened",
        definition: { type: UserPropertyDefinitionType.Trait, path: "custom" },
      }).returning();
      if (!existing) throw new Error("missing property");
      await insertUserPropertyAssignments([{ workspaceId: workspace.id, userId: "user", userPropertyId: existing.id, value: "owned-value" }]);
      await expect(provisionBuiltinUserProperties(workspace.id)).rejects.toThrow("Cannot provision last_opened");
      expect(await findAllUserPropertyAssignments({ workspaceId: workspace.id, userId: "user" }))
        .toEqual({ id: "user", last_opened: "owned-value" });
    });

    it("restarts a canonical paused builtin without changing its ID or assignments", async () => {
      const [existing] = await db().insert(dbUserProperty).values({
        workspaceId: workspace.id, name: "last_opened",
        definition: LAST_OPENED_DEFINITION, status: "Paused",
      }).returning();
      if (!existing) throw new Error("missing property");
      await insertUserPropertyAssignments([{ workspaceId: workspace.id, userId: "user", userPropertyId: existing.id, value: "2026-10-03T12:00:00.789Z" }]);
      expect(await openedProperty()).toMatchObject({ id: existing.id, status: "Running" });
      expect(await findAllUserPropertyAssignments({ workspaceId: workspace.id, userId: "user" }))
        .toEqual({ id: "user", last_opened: "2026-10-03T12:00:00.789Z" });
    });

    it("uses native open event time in unordered context, never clickedAt or openedAt payloads", async () => {
      const property = await openedProperty();
      expect(await findAllUserPropertyAssignments({
        workspaceId: workspace.id, userId: "never-opened",
        userProperties: ["last_opened"],
        context: [{ openedAt: "2099-01-01T00:00:00Z" }],
        eventContext: [
          { event: InternalEventType.EmailClicked, messageId: "click-only", timestamp: "2099-01-01T00:00:00Z" },
          { event: InternalEventType.EmailOpened, messageId: "invalid", timestamp: "invalid" },
        ],
      })).toEqual({ id: "never-opened" });
      await insertUserPropertyAssignments([{ workspaceId: workspace.id, userId: "user", userPropertyId: property.id, value: "2026-10-03T12:00:00.789Z" }]);
      const eventContext = [
        { event: InternalEventType.EmailOpened, messageId: "new", timestamp: "2026-10-03T09:00:00.123-04:00", properties: { openedAt: "2099-01-01T00:00:00Z" } },
        { event: InternalEventType.EmailOpened, messageId: "duplicate", timestamp: "2026-10-03T13:00:00.123Z" },
        { event: InternalEventType.EmailClicked, messageId: "click", timestamp: "2099-01-01T00:00:00Z" },
        { event: InternalEventType.EmailOpened, messageId: "old", timestamp: "2026-10-01T00:00:00Z" },
      ];
      expect(await findAllUserPropertyAssignments({ workspaceId: workspace.id, userId: "user", eventContext }))
        .toEqual({ id: "user", last_opened: "2026-10-03T13:00:00.123Z", last_clicked: "2099-01-01T00:00:00.000Z" });
      expect(await findAllUserPropertyAssignmentsById({ workspaceId: workspace.id, userId: "user", eventContext: eventContext.slice(3) }))
        .toEqual({ id: "user", [property.id]: "2026-10-03T12:00:00.789Z" });
      const users = unwrap(await getUsers({
        workspaceId: workspace.id,
        userPropertyFilter: [{ id: property.id, values: ["2026-10-03T12:00:00.789Z"] }],
      }, { throwOnError: true }));
      expect(users.users.map((user) => user.id)).toEqual(["user"]);
      expect(users.users[0]?.properties[property.id]?.value).toBe("2026-10-03T12:00:00.789Z");
    });
  });

  describe("findAllUserPropertyAssignments", () => {
    describe("when passing context with a Performed user property", () => {
      it("should return the user property assignment and override existing values", async () => {
        const upId1 = randomUUID();
        const upId2 = randomUUID();
        const upId3 = randomUUID();

        // Create a user property
        await db()
          .insert(dbUserProperty)
          .values([
            {
              id: upId1,
              workspaceId: workspace.id,
              name: `test-${upId1}`,
              updatedAt: new Date(),
              definition: {
                type: UserPropertyDefinitionType.Performed,
                event: "test",
                path: "nested1.nested2",
              } satisfies UserPropertyDefinition,
            },
            {
              id: upId2,
              workspaceId: workspace.id,
              name: `test-${upId2}`,
              definition: {
                type: UserPropertyDefinitionType.Performed,
                event: "test",
                path: "example",
              } satisfies UserPropertyDefinition,
              updatedAt: new Date(),
            },
            {
              id: upId3,
              workspaceId: workspace.id,
              name: `test-${upId3}`,
              updatedAt: new Date(),
              definition: {
                type: UserPropertyDefinitionType.Performed,
                event: "test",
                path: "propertyRestrictedPath",
                properties: [
                  {
                    path: "key1",
                    operator: {
                      type: UserPropertyOperatorType.Equals,
                      value: "matchesProperty",
                    },
                  },
                ],
              } satisfies UserPropertyDefinition,
            },
          ]);

        // Existing assignment states
        await insertUserPropertyAssignments([
          {
            workspaceId: workspace.id,
            userId: "userId",
            userPropertyId: upId1,
            value: "value1",
          },
          {
            workspaceId: workspace.id,
            userId: "userId",
            userPropertyId: upId2,
            value: "value2",
          },
        ]);

        // now find properties with contex override
        const actualAssignments = await findAllUserPropertyAssignments({
          userId: "userId",
          workspaceId: workspace.id,
          context: [
            {
              nested1: {
                nested2: "value3",
              },
            },
            {
              propertyRestrictedPath: "valueForMatching",
              key1: "matchesProperty",
            },
            {
              propertyRestrictedPath: "invalid",
              key1: "doesNotMatchProperty",
            },
          ],
        });

        expect(actualAssignments).toEqual({
          // pulls from context when able
          [`test-${upId1}`]: "value3",
          // falls back to existing assignment
          [`test-${upId2}`]: "value2",
          // checks properties before using context
          [`test-${upId3}`]: "valueForMatching",
          // always returns user id
          id: "userId",
        });
      });
    });

    describe("with a file user property", () => {
      let upId1: string;
      let definition: FileUserPropertyDefinition;
      let value: Omit<BlobStorageFile, "name">;

      beforeEach(async () => {
        upId1 = randomUUID();

        definition = {
          type: UserPropertyDefinitionType.File,
          name: "myFile.pdf",
        };

        await db()
          .insert(dbUserProperty)
          .values({
            id: upId1,
            workspaceId: workspace.id,
            name: `test-${upId1}`,
            definition,
            updatedAt: new Date(),
          });

        value = {
          type: AppFileType.BlobStorage,
          key: "/path/to/myFile.pdf",
          mimeType: "application/pdf",
        } satisfies Omit<BlobStorageFile, "name">;
      });
      describe("when passing context", () => {
        it("should use the name of the user property", async () => {
          const actualAssignments = await findAllUserPropertyAssignments({
            userId: "userId",
            workspaceId: workspace.id,
            context: [
              {
                [InternalEventType.AttachedFiles]: {
                  [definition.name]: {
                    ...value,
                  },
                },
              },
            ],
          });

          expect(actualAssignments).toEqual({
            [`test-${upId1}`]: {
              ...value,
              name: "myFile.pdf",
            },
            id: "userId",
          });
        });
      });

      describe("when loading from a user property", () => {
        it("should return the user property assignment", async () => {
          const assignments: UserPropertyBulkUpsertItem[] = [
            {
              workspaceId: workspace.id,
              userId: "userId",
              userPropertyId: upId1,
              value: JSON.stringify(value),
            },
          ];
          await insertUserPropertyAssignments(assignments);

          const actualAssignments = await findAllUserPropertyAssignments({
            userId: "userId",
            workspaceId: workspace.id,
          });

          expect(actualAssignments).toEqual({
            [`test-${upId1}`]: {
              ...value,
              name: "myFile.pdf",
            },
            id: "userId",
          });
        });
      });
    });

    describe("when passing context with a Group user property", () => {
      it("should return the user property assignment and respect the precedence of earlier group by operations", async () => {
        const upId1 = randomUUID();

        // Create a user property
        await db()
          .insert(dbUserProperty)
          .values([
            {
              id: upId1,
              workspaceId: workspace.id,
              name: `test-${upId1}`,
              updatedAt: new Date(),
              definition: {
                type: UserPropertyDefinitionType.Group,
                entry: "0",
                nodes: [
                  {
                    id: "0",
                    type: UserPropertyDefinitionType.AnyOf,
                    children: ["1", "2", "3", "4"],
                  },
                  {
                    id: "1",
                    type: UserPropertyDefinitionType.Performed,
                    event: "test1",
                    path: "path1",
                  },
                  {
                    id: "2",
                    type: UserPropertyDefinitionType.Trait,
                    path: "path2",
                  },
                  {
                    id: "3",
                    type: UserPropertyDefinitionType.Performed,
                    event: "test1",
                    path: "path2",
                  },
                  {
                    id: "4",
                    type: UserPropertyDefinitionType.KeyedPerformed,
                    event: "testKeyed",
                    key: "keyPath",
                    path: "keyValuePath",
                  },
                ],
              } satisfies UserPropertyDefinition,
            },
          ]);

        const actualAssignments1 = await findAllUserPropertyAssignments({
          userId: "userId",
          workspaceId: workspace.id,
          context: [
            {
              path1: 1,
            },
          ],
        });

        expect(actualAssignments1).toEqual({
          [`test-${upId1}`]: 1,
          id: "userId",
        });

        const actualAssignments2 = await findAllUserPropertyAssignments({
          userId: "userId",
          workspaceId: workspace.id,
          context: [
            {
              path2: 2,
            },
          ],
        });

        expect(actualAssignments2).toEqual({
          [`test-${upId1}`]: 2,
          id: "userId",
        });

        const actualAssignments3 = await findAllUserPropertyAssignments({
          userId: "userId",
          workspaceId: workspace.id,
          context: [
            {
              keyPath: "val1",
              keyValuePath: "val2",
            },
          ],
        });

        expect(actualAssignments3).toEqual({
          [`test-${upId1}`]: "val2",
          id: "userId",
        });
      });
    });

    describe("when a user property value is a large number expressed as a string", () => {
      it("it is parsed as a string ", async () => {
        // Create a user property
        const [up] = await db()
          .insert(dbUserProperty)
          .values({
            id: randomUUID(),
            workspaceId: workspace.id,
            name: "largeNumberProp",
            updatedAt: new Date(),
            definition: {
              type: UserPropertyDefinitionType.Trait,
              path: "largeNumber",
            } satisfies UserPropertyDefinition,
          })
          .returning();
        if (!up) {
          throw new Error("Failed to create user property");
        }

        await insertUserPropertyAssignments([
          {
            workspaceId: workspace.id,
            userId: "userId",
            userPropertyId: up.id,
            value: "99999999999999999999999",
          },
        ]);
        const actualAssignments = await findAllUserPropertyAssignments({
          userId: "userId",
          workspaceId: workspace.id,
        });
        expect(typeof actualAssignments.largeNumberProp).toBe("string");
      });
    });
  });

  describe("findAllUserPropertyAssignmentsForWorkspace", () => {
    it("should return the user property assignments for the workspace", async () => {
      const userProperty = unwrap(
        await insert({
          table: dbUserProperty,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: "email",
            updatedAt: new Date(),
            definition: {
              type: UserPropertyDefinitionType.Trait,
              path: "email",
            } satisfies UserPropertyDefinition,
          },
        }),
      );
      await insertUserPropertyAssignments([
        {
          workspaceId: workspace.id,
          userId: "userId1",
          userPropertyId: userProperty.id,
          value: "value1",
        },
        {
          workspaceId: workspace.id,
          userId: "userId2",
          userPropertyId: userProperty.id,
          value: "value2",
        },
      ]);

      const assignments = await findAllUserPropertyAssignmentsForWorkspace({
        workspaceId: workspace.id,
      });

      expect(assignments).toEqual({
        userId1: {
          id: "userId1",
          email: "value1",
        },
        userId2: {
          id: "userId2",
          email: "value2",
        },
      });
    });
  });

  describe("findUserIdByUserPropertyValue", () => {
    let userProperty: UserProperty;
    let userId: string;
    beforeEach(async () => {
      userId = randomUUID();

      userProperty = unwrap(
        await insert({
          table: dbUserProperty,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: "email",
            updatedAt: new Date(),
            definition: {
              type: UserPropertyDefinitionType.Trait,
              path: "email",
            } satisfies UserPropertyDefinition,
          },
        }),
      );
      await insertUserPropertyAssignments([
        {
          workspaceId: workspace.id,
          userId,
          userPropertyId: userProperty.id,
          value: "max@example.com",
        },
      ]);
    });
    it("should return the user id for the user property value", async () => {
      const actual = await findUserIdsByUserPropertyValue({
        workspaceId: workspace.id,
        userPropertyName: userProperty.name,
        value: "max@example.com",
      });

      expect(actual).toEqual([userId]);
    });
  });
  describe("findAllUserPropertyResources", () => {
    describe("when passing ids and names", () => {
      let idUpId: string;
      let nameUpId: string;

      beforeEach(async () => {
        const [idUp, nameUp] = await Promise.all([
          insert({
            table: dbUserProperty,
            values: {
              workspaceId: workspace.id,
              name: "id",
              definition: {
                type: UserPropertyDefinitionType.Trait,
                path: "id",
              } satisfies UserPropertyDefinition,
            },
          }).then(unwrap),
          insert({
            table: dbUserProperty,
            values: {
              workspaceId: workspace.id,
              name: "name",
              definition: {
                type: UserPropertyDefinitionType.Trait,
                path: "name",
              } satisfies UserPropertyDefinition,
            },
          }).then(unwrap),
        ]);
        idUpId = idUp.id;
        nameUpId = nameUp.id;
      });
      it("should return the user property resources which match either id or name", async () => {
        const actual = await findAllUserPropertyResources({
          workspaceId: workspace.id,
          ids: [nameUpId],
          names: ["id"],
        });
        const actualIds = actual.map((up) => up.id);
        expect(actualIds).toContain(idUpId);
        expect(actualIds).toContain(nameUpId);
      });
    });

    describe("when passing names", () => {
      let idUpId: string;
      let nameUpId: string;

      beforeEach(async () => {
        const [idUp, nameUp] = await Promise.all([
          insert({
            table: dbUserProperty,
            values: {
              workspaceId: workspace.id,
              name: "id",
              definition: {
                type: UserPropertyDefinitionType.Trait,
                path: "id",
              } satisfies UserPropertyDefinition,
            },
          }).then(unwrap),
          insert({
            table: dbUserProperty,
            values: {
              workspaceId: workspace.id,
              name: "name",
              definition: {
                type: UserPropertyDefinitionType.Trait,
                path: "name",
              } satisfies UserPropertyDefinition,
            },
          }).then(unwrap),
        ]);
        idUpId = idUp.id;
        nameUpId = nameUp.id;
      });
      it("should return the user property resources which match either id or name", async () => {
        const actual = await findAllUserPropertyResources({
          workspaceId: workspace.id,
          names: ["id", "name"],
        });
        const actualIds = actual.map((up) => up.id);
        expect(actualIds).toContain(idUpId);
        expect(actualIds).toContain(nameUpId);
      });
    });
  });
});
