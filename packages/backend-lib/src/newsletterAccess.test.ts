import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";

import {
  createAccountSession,
  getGoogleRequestContext,
  requireWorkspaceRole,
  selectAccountWorkspace,
} from "./accounts";
import { db } from "./db";
import {
  googleAccount,
  workspace,
  workspaceMember,
  workspaceMemberRole,
} from "./db/schema";
import { createNewsletter, createPublisher } from "./newsletters";

const workspaceIds: string[] = [];
const memberIds: string[] = [];
afterEach(async () => {
  if (memberIds.length)
    await db()
      .delete(workspaceMember)
      .where(inArray(workspaceMember.id, memberIds.splice(0)));
  if (workspaceIds.length)
    await db()
      .delete(workspace)
      .where(inArray(workspace.id, workspaceIds.splice(0)));
});

async function fixture(role: "Admin" | "Viewer") {
  const parent = await createPublisher({
    name: `publisher-access-${randomUUID()}`,
  });
  workspaceIds.push(parent.id);
  const child = await createNewsletter({
    publisherId: parent.id,
    name: "Independent publication",
    slug: "independent",
  });
  workspaceIds.push(child.workspaceId);
  const email = `${randomUUID()}@example.com`;
  const [member] = await db()
    .insert(workspaceMember)
    .values({ email, emailVerified: true, lastWorkspaceId: parent.id })
    .returning();
  if (!member) throw new Error("Member fixture missing");
  memberIds.push(member.id);
  await db()
    .insert(googleAccount)
    .values({
      memberId: member.id,
      googleSubject: randomUUID(),
      normalizedEmail: email,
    });
  await db()
    .insert(workspaceMemberRole)
    .values({ workspaceId: parent.id, workspaceMemberId: member.id, role });
  const { principal } = await createAccountSession({
    memberId: member.id,
    userAgent: "newsletter-access-test",
  });
  return { parent, child, member, principal };
}

describe("publisher team access to independent newsletters", () => {
  it("inherits access and selection without copying a child membership", async () => {
    const { parent, child, member, principal } = await fixture("Admin");
    await requireWorkspaceRole(
      principal,
      child.workspaceId,
      "WorkspaceManager",
    );
    await selectAccountWorkspace(principal, child.workspaceId);
    const context = await getGoogleRequestContext(principal);
    expect(context.isOk()).toBe(true);
    if (context.isErr()) throw context.error;
    expect(context.value.workspace.id).toBe(child.workspaceId);
    expect(context.value.workspace.parentWorkspaceId).toBe(parent.id);
    expect(context.value.memberRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: child.workspaceId,
          role: "Admin",
        }),
      ]),
    );
    const direct = await db()
      .select()
      .from(workspaceMemberRole)
      .where(eq(workspaceMemberRole.workspaceMemberId, member.id));
    expect(direct.map((row) => row.workspaceId)).toEqual([parent.id]);
  });

  it("does not elevate a viewer or cross into another publisher", async () => {
    const { child, principal } = await fixture("Viewer");
    await expect(
      requireWorkspaceRole(principal, child.workspaceId, "Author"),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    const foreign = await createPublisher({ name: `foreign-${randomUUID()}` });
    workspaceIds.push(foreign.id);
    const foreignChild = await createNewsletter({
      publisherId: foreign.id,
      name: "Foreign publication",
      slug: "foreign",
    });
    workspaceIds.push(foreignChild.workspaceId);
    await expect(
      selectAccountWorkspace(principal, foreignChild.workspaceId),
    ).rejects.toMatchObject({ code: "no_access" });
  });

  it("revokes inherited access immediately when the publisher membership is removed", async () => {
    const { parent, child, member, principal } = await fixture("Admin");
    await selectAccountWorkspace(principal, child.workspaceId);
    await db()
      .delete(workspaceMemberRole)
      .where(eq(workspaceMemberRole.workspaceMemberId, member.id));
    await expect(
      requireWorkspaceRole(principal, child.workspaceId, "Viewer"),
    ).rejects.toMatchObject({ code: "no_access" });
    const context = await getGoogleRequestContext(principal);
    expect(context.isErr()).toBe(true);
    const memberships = await db()
      .select()
      .from(workspaceMemberRole)
      .where(eq(workspaceMemberRole.workspaceId, parent.id));
    expect(memberships).toEqual([]);
  });
});
