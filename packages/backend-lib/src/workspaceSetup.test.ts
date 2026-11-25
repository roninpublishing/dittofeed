import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";

import { db } from "./db";
import { publisher } from "./db/publisherSchema";
import {
  broadcast,
  journey,
  workspace,
  workspaceMember,
  workspaceMemberRole,
} from "./db/schema";
import { createPublisher } from "./newsletters";

const workspaceIds: string[] = [];
const memberIds: string[] = [];
afterEach(async () => {
  if (workspaceIds.length) {
    await db()
      .delete(broadcast)
      .where(inArray(broadcast.workspaceId, workspaceIds));
    await db()
      .delete(workspaceMemberRole)
      .where(inArray(workspaceMemberRole.workspaceId, workspaceIds));
    await db()
      .delete(workspace)
      .where(inArray(workspace.id, workspaceIds.splice(0)));
  }
  if (memberIds.length)
    await db()
      .delete(workspaceMember)
      .where(inArray(workspaceMember.id, memberIds.splice(0)));
});

async function legacyWorkspace(role: "Admin" | "Viewer" = "Admin") {
  const [source] = await db()
    .insert(workspace)
    .values({ name: `legacy-${randomUUID()}` })
    .returning();
  const [member] = await db()
    .insert(workspaceMember)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (!source || !member) throw new Error("Missing fixture");
  workspaceIds.push(source.id);
  memberIds.push(member.id);
  await db()
    .insert(workspaceMemberRole)
    .values({ workspaceId: source.id, workspaceMemberId: member.id, role });
  return { source, member };
}

it("creates a separate workspace while preserving the legacy workspace and its campaigns", async () => {
  const { source, member } = await legacyWorkspace();
  const [savedJourney] = await db()
    .insert(journey)
    .values({ workspaceId: source.id, name: "Existing journey" })
    .returning();
  const [savedBroadcast] = await db()
    .insert(broadcast)
    .values({ workspaceId: source.id, name: "Existing broadcast" })
    .returning();
  if (!savedJourney || !savedBroadcast)
    throw new Error("Missing campaign fixtures");
  await expect(
    createPublisher({
      workspaceId: source.id,
      name: source.name,
      memberId: member.id,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: "workspace_contains_campaigns",
  });
  const created = await createPublisher({
    workspaceId: source.id,
    name: `new-${randomUUID()}`,
    memberId: member.id,
    createNewWorkspace: true,
  });
  workspaceIds.push(created.workspaceId);
  expect(created.workspaceId).not.toBe(source.id);
  expect(created.type).toBe("Parent");
  expect(
    await db().select().from(workspace).where(eq(workspace.id, source.id)),
  ).toEqual([source]);
  expect(
    await db().select().from(journey).where(eq(journey.id, savedJourney.id)),
  ).toEqual([savedJourney]);
  expect(
    await db()
      .select()
      .from(broadcast)
      .where(eq(broadcast.id, savedBroadcast.id)),
  ).toEqual([savedBroadcast]);
  expect(
    await db()
      .select()
      .from(publisher)
      .where(eq(publisher.workspaceId, source.id)),
  ).toEqual([]);
  expect(
    await db()
      .select()
      .from(workspaceMemberRole)
      .where(eq(workspaceMemberRole.workspaceId, created.workspaceId)),
  ).toEqual([
    expect.objectContaining({
      workspaceId: created.workspaceId,
      workspaceMemberId: member.id,
      role: "Admin",
    }),
  ]);
});

it("does not grant a viewer or a caller without an account a new workspace", async () => {
  const { source, member } = await legacyWorkspace("Viewer");
  const name = `denied-${randomUUID()}`;
  await expect(
    createPublisher({
      workspaceId: source.id,
      name,
      memberId: member.id,
      createNewWorkspace: true,
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    createPublisher({ workspaceId: source.id, name, createNewWorkspace: true }),
  ).rejects.toMatchObject({
    statusCode: 403,
    code: "workspace_creation_requires_session",
  });
  expect(
    await db().select().from(workspace).where(eq(workspace.name, name)),
  ).toEqual([]);
});

it("does not adopt or rename an existing same-name workspace during new-workspace creation", async () => {
  const { source, member } = await legacyWorkspace();
  await expect(
    createPublisher({
      workspaceId: source.id,
      name: source.name,
      memberId: member.id,
      createNewWorkspace: true,
    }),
  ).rejects.toMatchObject({ statusCode: 409, code: "workspace_name_taken" });
  expect(
    await db().select().from(workspace).where(eq(workspace.id, source.id)),
  ).toEqual([source]);
  expect(
    await db()
      .select()
      .from(publisher)
      .where(eq(publisher.workspaceId, source.id)),
  ).toEqual([]);
});
