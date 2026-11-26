import { createHash, randomBytes, randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Role } from "isomorphic-lib/src/types";

import {
  AccountError,
  ApiKeyAccountPrincipal,
  getApiKeyAccountContext,
  logoutApiKeyAccount,
  completeGoogleSignIn,
  consumeAccountRateLimit,
  consumeGoogleFlow,
  createAccountSession,
  createGoogleFlow,
  createWorkspaceInvitation,
  getAccountProfile,
  getAccountTeam,
  getGoogleRequestContext,
  GoogleAccountPrincipal,
  listAccountSessions,
  previewWorkspaceInvitation,
  removeAccountMember,
  requireWorkspaceRole,
  resolveAccountSession,
  revokeAccountSession,
  revokeOtherAccountSessions,
  revokeWorkspaceInvitation,
  selectAccountWorkspace,
  setAccountDisabled,
  updateAccountMemberRole,
  updateAccountProfile,
  VerifiedGoogleProfile,
} from "./accounts";
import { createAdminApiKey, provisionOwnerAdminApiKey } from "./adminApiKeys";
import { API_OPERATION_SCOPES } from "isomorphic-lib/src/apiOperations";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import config from "./config";
import { createPublisher } from "./newsletters";
import { db } from "./db";
import {
  accountRateLimit,
  accountSession,
  googleAccount,
  googleOAuthFlow,
  workspace,
  workspaceInvitation,
  workspaceMembeAccount,
  workspaceMember,
  workspaceMemberRole,
} from "./db/schema";

const workspaces: string[] = [];
const members: string[] = [];
const flowIds: string[] = [];
const rateKeys: string[] = [];
let originalBootstrapEmail: string | undefined;
let originalBootstrapWorkspace: string | undefined;
let originalBootstrapSubject: string | undefined;

interface AccountFixture {
  token: string;
  principal: GoogleAccountPrincipal;
  email: string;
  subject: string;
  memberId: string;
}

async function makeWorkspace() {
  const [row] = await db()
    .insert(workspace)
    .values({ name: `account-test-${randomUUID()}`, domain: "example.com" })
    .returning();
  if (!row) throw new Error("Workspace fixture was not inserted");
  workspaces.push(row.id);
  return row;
}

async function makeAccount(
  workspaceId: string,
  role: Role = "Admin",
  isInstanceAdmin = false,
): Promise<AccountFixture> {
  const email = `${randomUUID()}@example.com`;
  const subject = randomUUID();
  const [member] = await db()
    .insert(workspaceMember)
    .values({
      email,
      emailVerified: true,
      name: "Owned name",
      lastWorkspaceId: workspaceId,
    })
    .returning();
  if (!member) throw new Error("Member fixture was not inserted");
  members.push(member.id);
  await db().insert(googleAccount).values({
    memberId: member.id,
    googleSubject: subject,
    normalizedEmail: email,
    isInstanceAdmin,
  });
  await db()
    .insert(workspaceMemberRole)
    .values({ workspaceId, workspaceMemberId: member.id, role });
  const session = await createAccountSession({
    memberId: member.id,
    userAgent: "account test",
  });
  return { ...session, email, subject, memberId: member.id };
}

async function signIn(profile: VerifiedGoogleProfile, invitationId?: string) {
  const result = await completeGoogleSignIn({ profile, invitationId });
  if (!members.includes(result.memberId)) members.push(result.memberId);
  return result;
}

async function invitationFlow(invitationToken: string) {
  const state = randomBytes(32).toString("base64url");
  const flow = await createGoogleFlow({ state, invitationToken });
  flowIds.push(flow.id);
  return consumeGoogleFlow({ id: flow.id, state });
}

beforeEach(() => {
  originalBootstrapEmail = config().googleBootstrapAdminEmail;
  originalBootstrapWorkspace = config().googleBootstrapWorkspaceId;
  originalBootstrapSubject = config().googleBootstrapAdminSubject;
  config().googleBootstrapAdminEmail = undefined;
  config().googleBootstrapWorkspaceId = undefined;
  config().googleBootstrapAdminSubject = undefined;
});

afterEach(async () => {
  config().googleBootstrapAdminEmail = originalBootstrapEmail;
  config().googleBootstrapWorkspaceId = originalBootstrapWorkspace;
  config().googleBootstrapAdminSubject = originalBootstrapSubject;
  if (flowIds.length)
    await db()
      .delete(googleOAuthFlow)
      .where(inArray(googleOAuthFlow.id, flowIds));
  if (workspaces.length) {
    const invitations = await db()
      .select({ id: workspaceInvitation.id })
      .from(workspaceInvitation)
      .where(inArray(workspaceInvitation.workspaceId, workspaces));
    if (invitations.length)
      await db()
        .delete(googleOAuthFlow)
        .where(
          inArray(
            googleOAuthFlow.invitationId,
            invitations.map((row) => row.id),
          ),
        );
    await db()
      .delete(workspaceInvitation)
      .where(inArray(workspaceInvitation.workspaceId, workspaces));
  }
  if (members.length) {
    await db()
      .delete(accountSession)
      .where(inArray(accountSession.memberId, members));
    await db()
      .delete(googleAccount)
      .where(inArray(googleAccount.memberId, members));
    await db()
      .delete(workspaceMember)
      .where(inArray(workspaceMember.id, members));
  }
  if (workspaces.length)
    await db().delete(workspace).where(inArray(workspace.id, workspaces));
  if (rateKeys.length)
    await db()
      .delete(accountRateLimit)
      .where(inArray(accountRateLimit.key, rateKeys));
  workspaces.length = 0;
  members.length = 0;
  flowIds.length = 0;
  rateKeys.length = 0;
});

describe("Google admission and initial owner", () => {
  it("rejects public signup even for a matching workspace domain", async () => {
    await makeWorkspace();
    await expect(
      signIn({
        subject: randomUUID(),
        email: "uninvited@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "not_invited" });
  });

  it("requires an exact verified bootstrap email and an existing active workspace", async () => {
    const initial = await makeWorkspace();
    config().googleBootstrapAdminEmail = "owner@example.com";
    config().googleBootstrapWorkspaceId = initial.id;
    await expect(
      signIn({
        subject: randomUUID(),
        email: "other@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "not_invited" });
    await expect(
      signIn({
        subject: randomUUID(),
        email: "owner@example.com",
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    await db()
      .update(workspace)
      .set({ status: "Paused" })
      .where(eq(workspace.id, initial.id));
    await expect(
      signIn({
        subject: randomUUID(),
        email: "owner@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      }),
    ).rejects.toMatchObject({ code: "not_invited" });
    config().googleBootstrapWorkspaceId = randomUUID();
    await expect(
      signIn({
        subject: randomUUID(),
        email: "owner@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      }),
    ).rejects.toMatchObject({ code: "not_invited" });
  });

  it("serializes bootstrap and never reassigns an admitted email to another Google subject", async () => {
    const initial = await makeWorkspace();
    config().googleBootstrapAdminEmail = "Owner@Example.com";
    config().googleBootstrapWorkspaceId = initial.id;
    const outcomes = await Promise.allSettled([
      signIn({
        subject: randomUUID(),
        email: "owner@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      }),
      signIn({
        subject: randomUUID(),
        email: "OWNER@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const accounts = await db()
      .select()
      .from(googleAccount)
      .where(inArray(googleAccount.memberId, members));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      normalizedEmail: "owner@example.com",
      isInstanceAdmin: true,
    });
    config().googleBootstrapAdminEmail = "second@example.com";
    await expect(
      signIn({
        subject: randomUUID(),
        email: "second@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "not_invited" });
    const [role] = await db()
      .select()
      .from(workspaceMemberRole)
      .where(eq(workspaceMemberRole.workspaceMemberId, members[0] ?? ""));
    expect(role?.role).toBe("Admin");
  });

  it.each([
    ["owner@gmail.com", undefined],
    ["owner@example.com", "example.com"],
  ] as const)(
    "allows Google-authoritative first-owner email %s without a subject pin",
    async (email, hostedDomain) => {
      const initial = await makeWorkspace();
      config().googleBootstrapAdminEmail = email;
      config().googleBootstrapWorkspaceId = initial.id;
      const result = await signIn({
        subject: randomUUID(),
        email,
        emailVerified: true,
        hostedDomain,
      });
      const [account] = await db()
        .select()
        .from(googleAccount)
        .where(eq(googleAccount.memberId, result.memberId));
      expect(account?.isInstanceAdmin).toBe(true);
    },
  );

  it.each([undefined, "unrelated.example"])(
    "requires an exact subject pin for non-authoritative consumer email (hd=%s)",
    async (hostedDomain) => {
      const initial = await makeWorkspace();
      const subject = randomUUID();
      const profile: VerifiedGoogleProfile = {
        subject,
        email: "owner@example.com",
        emailVerified: true,
        hostedDomain,
      };
      config().googleBootstrapAdminEmail = profile.email;
      config().googleBootstrapWorkspaceId = initial.id;
      await expect(signIn(profile)).rejects.toMatchObject({
        code: "bootstrap_subject_required",
        statusCode: 403,
      });
      config().googleBootstrapAdminSubject = randomUUID();
      await expect(signIn(profile)).rejects.toMatchObject({
        code: "bootstrap_subject_required",
      });
      config().googleBootstrapAdminSubject = subject;
      const admitted = await signIn(profile);
      config().googleBootstrapAdminSubject = undefined;
      // Admission is now anchored to the immutable subject, not bootstrap email or hd.
      expect(
        await signIn({
          ...profile,
          email: "renamed@other.example",
          hostedDomain: undefined,
        }),
      ).toEqual(admitted);
      const [account] = await db()
        .select()
        .from(googleAccount)
        .where(eq(googleAccount.memberId, admitted.memberId));
      expect(account).toMatchObject({
        googleSubject: subject,
        normalizedEmail: "renamed@other.example",
        isInstanceAdmin: true,
      });
    },
  );
});

describe("owned workspace accounts", () => {
  let workspaceId: string;
  let otherWorkspaceId: string;
  let owner: AccountFixture;
  let manager: AccountFixture;
  let viewer: AccountFixture;

  beforeEach(async () => {
    workspaceId = (await makeWorkspace()).id;
    otherWorkspaceId = (await makeWorkspace()).id;
    owner = await makeAccount(workspaceId, "Admin", true);
    manager = await makeAccount(workspaceId, "WorkspaceManager");
    viewer = await makeAccount(workspaceId, "Viewer");
  });

  it("enforces cross-workspace boundaries and refuses forged principal privilege flags", async () => {
    const outsider = await makeAccount(otherWorkspaceId);
    await expect(
      getAccountTeam(owner.principal, otherWorkspaceId),
    ).rejects.toMatchObject({ code: "no_access" });
    await expect(
      updateAccountMemberRole(owner.principal, {
        workspaceId: otherWorkspaceId,
        memberId: outsider.memberId,
        role: "Viewer",
      }),
    ).rejects.toMatchObject({ code: "no_access" });
    await expect(
      removeAccountMember(owner.principal, {
        workspaceId,
        memberId: outsider.memberId,
      }),
    ).rejects.toMatchObject({ code: "no_access" });
    await expect(
      selectAccountWorkspace(viewer.principal, otherWorkspaceId),
    ).rejects.toMatchObject({ code: "no_access" });
    await expect(
      setAccountDisabled(
        { ...viewer.principal, isInstanceAdmin: true },
        { memberId: manager.memberId, disabled: true },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      getAccountProfile({
        ...owner.principal,
        sessionId: outsider.principal.sessionId,
      }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    await expect(
      revokeAccountSession(owner.principal, outsider.principal.sessionId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows managers to manage only Authors and Viewers without self-escalation", async () => {
    await expect(
      getAccountTeam(viewer.principal, workspaceId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      requireWorkspaceRole(viewer.principal, workspaceId, "Author"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      updateAccountMemberRole(manager.principal, {
        workspaceId,
        memberId: manager.memberId,
        role: "Admin",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      updateAccountMemberRole(manager.principal, {
        workspaceId,
        memberId: viewer.memberId,
        role: "WorkspaceManager",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      removeAccountMember(manager.principal, {
        workspaceId,
        memberId: owner.memberId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createWorkspaceInvitation(manager.principal, {
        workspaceId,
        email: "admin@example.com",
        role: "Admin",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await updateAccountMemberRole(manager.principal, {
      workspaceId,
      memberId: viewer.memberId,
      role: "Author",
    });
    const team = await getAccountTeam(manager.principal, workspaceId);
    expect(
      team.members.find((member) => member.member.id === viewer.memberId)?.role,
    ).toBe("Author");
    expect(team.canManageInstanceAccounts).toBe(false);
    await removeAccountMember(manager.principal, {
      workspaceId,
      memberId: viewer.memberId,
    });
    expect(await getAccountProfile(viewer.principal)).toMatchObject({
      member: { id: viewer.memberId },
      memberships: [],
    });
  });

  it("protects the last enabled Google-linked Admin even when historical non-Google admins exist", async () => {
    const [historical] = await db()
      .insert(workspaceMember)
      .values({ email: `${randomUUID()}@example.com` })
      .returning();
    if (!historical) throw new Error("Historical member was not inserted");
    members.push(historical.id);
    await db()
      .insert(workspaceMemberRole)
      .values({ workspaceId, workspaceMemberId: historical.id, role: "Admin" });
    await expect(
      updateAccountMemberRole(owner.principal, {
        workspaceId,
        memberId: owner.memberId,
        role: "Viewer",
      }),
    ).rejects.toMatchObject({ code: "last_administrator", statusCode: 409 });
    await expect(
      removeAccountMember(owner.principal, {
        workspaceId,
        memberId: owner.memberId,
      }),
    ).rejects.toMatchObject({ code: "last_administrator" });
  });

  it("serializes concurrent admin demotions so one enabled linked Admin survives", async () => {
    const second = await makeAccount(workspaceId);
    const results = await Promise.allSettled([
      updateAccountMemberRole(owner.principal, {
        workspaceId,
        memberId: owner.memberId,
        role: "Author",
      }),
      updateAccountMemberRole(second.principal, {
        workspaceId,
        memberId: second.memberId,
        role: "Author",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.reason).toBeInstanceOf(AccountError);
    if (!(failure?.reason instanceof AccountError)) {
      throw new Error(
        "Expected the competing administrator change to be rejected",
      );
    }
    expect(failure.reason.code).toBe("last_administrator");
    const admins = await db()
      .select()
      .from(workspaceMemberRole)
      .where(
        and(
          eq(workspaceMemberRole.workspaceId, workspaceId),
          eq(workspaceMemberRole.role, "Admin"),
        ),
      );
    expect(admins).toHaveLength(1);
  });

  it("prevents stranding another workspace or disabling the last instance administrator", async () => {
    await expect(
      setAccountDisabled(owner.principal, {
        memberId: owner.memberId,
        disabled: true,
      }),
    ).rejects.toMatchObject({ code: "last_instance_administrator" });
    const second = await makeAccount(workspaceId, "Admin", true);
    await db().insert(workspaceMemberRole).values({
      workspaceId: otherWorkspaceId,
      workspaceMemberId: second.memberId,
      role: "Admin",
    });
    await expect(
      setAccountDisabled(owner.principal, {
        memberId: second.memberId,
        disabled: true,
      }),
    ).rejects.toMatchObject({ code: "last_administrator" });
    const third = await makeAccount(otherWorkspaceId);
    await setAccountDisabled(owner.principal, {
      memberId: second.memberId,
      disabled: true,
    });
    expect(await resolveAccountSession(second.token)).toBeNull();
    await setAccountDisabled(owner.principal, {
      memberId: second.memberId,
      disabled: false,
    });
    expect(await resolveAccountSession(second.token)).toBeNull();
    expect(
      (await createAccountSession({ memberId: second.memberId })).principal
        .memberId,
    ).toBe(second.memberId);
    expect(third.memberId).not.toBe(second.memberId);
  });

  it("serializes concurrent instance-admin disable operations", async () => {
    const second = await makeAccount(workspaceId, "Admin", true);
    const results = await Promise.allSettled([
      setAccountDisabled(owner.principal, {
        memberId: owner.memberId,
        disabled: true,
      }),
      setAccountDisabled(second.principal, {
        memberId: second.memberId,
        disabled: true,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const enabled = await db()
      .select()
      .from(googleAccount)
      .where(
        and(
          inArray(googleAccount.memberId, [owner.memberId, second.memberId]),
          eq(googleAccount.isInstanceAdmin, true),
          sql`${googleAccount.disabledAt} is null`,
        ),
      );
    expect(enabled).toHaveLength(1);
  });

  it("uses only explicit active memberships, remembers selection and never grants domain or parent access", async () => {
    await db()
      .update(workspace)
      .set({ type: "Parent" })
      .where(eq(workspace.id, workspaceId));
    await db()
      .update(workspace)
      .set({ type: "Child", parentWorkspaceId: workspaceId })
      .where(eq(workspace.id, otherWorkspaceId));
    const before = await getGoogleRequestContext(owner.principal);
    expect(
      before.isOk() && before.value.memberRoles.map((role) => role.workspaceId),
    ).toEqual([workspaceId]);
    await db().insert(workspaceMemberRole).values({
      workspaceId: otherWorkspaceId,
      workspaceMemberId: owner.memberId,
      role: "Viewer",
    });
    await selectAccountWorkspace(owner.principal, otherWorkspaceId);
    const selected = await getGoogleRequestContext(owner.principal);
    expect(selected.isOk() && selected.value.workspace.id).toBe(
      otherWorkspaceId,
    );
    await db()
      .update(workspace)
      .set({ status: "Paused" })
      .where(eq(workspace.id, otherWorkspaceId));
    const fallback = await getGoogleRequestContext(owner.principal);
    expect(fallback.isOk() && fallback.value.workspace.id).toBe(workspaceId);
    await removeAccountMember(owner.principal, {
      workspaceId,
      memberId: viewer.memberId,
    });
    const missing = await getGoogleRequestContext(viewer.principal);
    expect(missing.isErr() && missing.error.type).toBe("NotOnboarded");
  });

  it("keeps owned names and immutable subjects while safely refreshing canonical verified email", async () => {
    await updateAccountProfile(viewer.principal, {
      name: " Updated owned name ",
    });
    await signIn({
      subject: viewer.subject,
      email: `NEW-${viewer.email}`.toUpperCase(),
      emailVerified: true,
      name: "Provider overwrite",
    });
    expect(await getAccountProfile(viewer.principal)).toMatchObject({
      member: { name: "Updated owned name", email: `new-${viewer.email}` },
    });
    await expect(
      signIn({
        subject: randomUUID(),
        email: `new-${viewer.email}`,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(
      signIn({
        subject: viewer.subject,
        email: owner.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(
      updateAccountProfile(viewer.principal, { name: "  " }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    const [stored] = await db()
      .select()
      .from(googleAccount)
      .where(eq(googleAccount.memberId, viewer.memberId));
    expect(stored?.googleSubject).toBe(viewer.subject);
  });

  it("refuses case-insensitive historical email collisions rather than merging records", async () => {
    const email = `${randomUUID()}@example.com`;
    const [historical] = await db()
      .insert(workspaceMember)
      .values({ email: email.toUpperCase() })
      .returning();
    if (!historical) throw new Error("Historical member was not inserted");
    members.push(historical.id);
    const invite = await createWorkspaceInvitation(owner.principal, {
      workspaceId,
      email,
      role: "Viewer",
    });
    await invitationFlow(invite.token);
    await expect(
      signIn(
        { subject: randomUUID(), email, emailVerified: true },
        invite.invitation.id,
      ),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(
      signIn({ subject: viewer.subject, email, emailVerified: true }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(
      await db()
        .select()
        .from(googleAccount)
        .where(eq(googleAccount.memberId, historical.id)),
    ).toHaveLength(0);
  });

  it("refuses an existing legacy Google-subject binding to another historical member", async () => {
    await db().insert(workspaceMembeAccount).values({
      workspaceMemberId: owner.memberId,
      provider: "google",
      providerAccountId: viewer.subject,
    });
    await expect(
      signIn({
        subject: viewer.subject,
        email: viewer.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("stores only hashed session tokens and enforces expiry, revocation and disabled state everywhere", async () => {
    const second = await createAccountSession({ memberId: viewer.memberId });
    const [stored] = await db()
      .select()
      .from(accountSession)
      .where(eq(accountSession.id, second.principal.sessionId));
    expect(stored?.tokenHash).toBe(
      createHash("sha256").update(second.token).digest("hex"),
    );
    expect(stored?.tokenHash).not.toBe(second.token);
    expect(
      (await listAccountSessions(viewer.principal)).filter(
        (session) => session.current,
      ),
    ).toHaveLength(1);
    await revokeOtherAccountSessions(viewer.principal);
    expect(await resolveAccountSession(second.token)).toBeNull();
    await db()
      .update(accountSession)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(accountSession.id, viewer.principal.sessionId));
    expect(await resolveAccountSession(viewer.token)).toBeNull();
    await expect(
      updateAccountProfile(viewer.principal, { name: "Expired" }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    const live = await createAccountSession({ memberId: viewer.memberId });
    await setAccountDisabled(owner.principal, {
      memberId: viewer.memberId,
      disabled: true,
    });
    expect(await resolveAccountSession(live.token)).toBeNull();
    await expect(
      createAccountSession({ memberId: viewer.memberId }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    await expect(
      signIn({
        subject: viewer.subject,
        email: viewer.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(getAccountProfile(live.principal)).rejects.toMatchObject({
      code: "not_authenticated",
    });
    await setAccountDisabled(owner.principal, {
      memberId: viewer.memberId,
      disabled: false,
    });
    const revived = await createAccountSession({ memberId: viewer.memberId });
    await revokeAccountSession(revived.principal, revived.principal.sessionId);
    expect(await resolveAccountSession(revived.token)).toBeNull();
  });

  it("admits only the invited verified email once and stores invitation/state hashes only", async () => {
    const email = `${randomUUID()}@example.com`;
    const invite = await createWorkspaceInvitation(owner.principal, {
      workspaceId,
      email: email.toUpperCase(),
      role: "Author",
    });
    await expect(
      signIn(
        { subject: randomUUID(), email, emailVerified: true },
        invite.invitation.id,
      ),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
    const state = randomBytes(32).toString("base64url");
    const flow = await createGoogleFlow({
      state,
      invitationToken: invite.token,
    });
    flowIds.push(flow.id);
    const [storedFlow] = await db()
      .select()
      .from(googleOAuthFlow)
      .where(eq(googleOAuthFlow.id, flow.id));
    const [storedInvite] = await db()
      .select()
      .from(workspaceInvitation)
      .where(eq(workspaceInvitation.id, invite.invitation.id));
    expect(storedFlow?.stateHash).toBe(
      createHash("sha256").update(state).digest("hex"),
    );
    expect(storedInvite?.tokenHash).toBe(
      createHash("sha256").update(invite.token).digest("hex"),
    );
    await expect(
      consumeGoogleFlow({ id: flow.id, state: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    expect(await consumeGoogleFlow({ id: flow.id, state })).toEqual({
      invitationId: invite.invitation.id,
    });
    await expect(
      consumeGoogleFlow({ id: flow.id, state }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    await expect(
      signIn(
        { subject: randomUUID(), email: `wrong-${email}`, emailVerified: true },
        invite.invitation.id,
      ),
    ).rejects.toMatchObject({
      code: "invitation_email_mismatch",
      statusCode: 400,
    });
    expect((await previewWorkspaceInvitation(invite.token)).status).toBe(
      "pending",
    );
    await invitationFlow(invite.token);
    const accepted = await signIn(
      { subject: randomUUID(), email, emailVerified: true },
      invite.invitation.id,
    );
    const [role] = await db()
      .select()
      .from(workspaceMemberRole)
      .where(eq(workspaceMemberRole.workspaceMemberId, accepted.memberId));
    expect(role?.role).toBe("Author");
    await expect(
      previewWorkspaceInvitation(invite.token),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
    await expect(
      signIn(
        { subject: randomUUID(), email, emailVerified: true },
        invite.invitation.id,
      ),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("rejects expired flows and expired/revoked invitations", async () => {
    const invite = await createWorkspaceInvitation(owner.principal, {
      workspaceId,
      email: `${randomUUID()}@example.com`,
      role: "Viewer",
    });
    const state = randomBytes(32).toString("base64url");
    const flow = await createGoogleFlow({
      state,
      invitationToken: invite.token,
    });
    flowIds.push(flow.id);
    await db()
      .update(googleOAuthFlow)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(googleOAuthFlow.id, flow.id));
    await expect(
      consumeGoogleFlow({ id: flow.id, state }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    await db()
      .update(workspaceInvitation)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(workspaceInvitation.id, invite.invitation.id));
    await expect(
      previewWorkspaceInvitation(invite.token),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
    const replacement = await createWorkspaceInvitation(owner.principal, {
      workspaceId,
      email: `${randomUUID()}@example.com`,
      role: "Viewer",
    });
    await invitationFlow(replacement.token);
    await revokeWorkspaceInvitation(owner.principal, {
      workspaceId,
      invitationId: replacement.invitation.id,
    });
    await expect(
      signIn(
        {
          subject: randomUUID(),
          email: replacement.invitation.email,
          emailVerified: true,
        },
        replacement.invitation.id,
      ),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
  });

  it.each(["demoted", "removed", "disabled"] as const)(
    "revalidates a %s invitation issuer at redemption",
    async (change) => {
      const invite = await createWorkspaceInvitation(manager.principal, {
        workspaceId,
        email: `${randomUUID()}@example.com`,
        role: "Author",
      });
      await invitationFlow(invite.token);
      if (change === "demoted")
        await updateAccountMemberRole(owner.principal, {
          workspaceId,
          memberId: manager.memberId,
          role: "Viewer",
        });
      if (change === "removed")
        await removeAccountMember(owner.principal, {
          workspaceId,
          memberId: manager.memberId,
        });
      if (change === "disabled")
        await setAccountDisabled(owner.principal, {
          memberId: manager.memberId,
          disabled: true,
        });
      await expect(
        signIn(
          {
            subject: randomUUID(),
            email: invite.invitation.email,
            emailVerified: true,
          },
          invite.invitation.id,
        ),
      ).rejects.toMatchObject({ code: "invalid_invitation" });
    },
  );

  it("revalidates the issuer's authority for the specific grant after Admin-to-Manager demotion", async () => {
    const second = await makeAccount(workspaceId);
    const invite = await createWorkspaceInvitation(second.principal, {
      workspaceId,
      email: `${randomUUID()}@example.com`,
      role: "Admin",
    });
    await invitationFlow(invite.token);
    await updateAccountMemberRole(owner.principal, {
      workspaceId,
      memberId: second.memberId,
      role: "WorkspaceManager",
    });
    await expect(
      signIn(
        {
          subject: randomUUID(),
          email: invite.invitation.email,
          emailVerified: true,
        },
        invite.invitation.id,
      ),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
  });

  it("does not let a manager revoke or replace Admin grants or mutate another workspace's invitation", async () => {
    const invite = await createWorkspaceInvitation(owner.principal, {
      workspaceId,
      email: `${randomUUID()}@example.com`,
      role: "Admin",
    });
    await expect(
      revokeWorkspaceInvitation(manager.principal, {
        workspaceId,
        invitationId: invite.invitation.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createWorkspaceInvitation(manager.principal, {
        workspaceId,
        email: invite.invitation.email,
        role: "Viewer",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      revokeWorkspaceInvitation(owner.principal, {
        workspaceId: otherWorkspaceId,
        invitationId: invite.invitation.id,
      }),
    ).rejects.toMatchObject({ code: "no_access" });
    expect((await previewWorkspaceInvitation(invite.token)).status).toBe(
      "pending",
    );
  });

  it("allows an existing linked identity to accept a new workspace invitation without merging or granting global admin", async () => {
    const otherAdmin = await makeAccount(otherWorkspaceId);
    const invite = await createWorkspaceInvitation(otherAdmin.principal, {
      workspaceId: otherWorkspaceId,
      email: viewer.email,
      role: "Admin",
    });
    await invitationFlow(invite.token);
    expect(
      await signIn(
        { subject: viewer.subject, email: viewer.email, emailVerified: true },
        invite.invitation.id,
      ),
    ).toEqual({ memberId: viewer.memberId });
    const profile = await getAccountProfile(viewer.principal);
    expect(profile.memberships.map((role) => role.workspaceId).sort()).toEqual(
      [workspaceId, otherWorkspaceId].sort(),
    );
    expect(profile.isInstanceAdmin).toBe(false);
    await expect(
      createWorkspaceInvitation(otherAdmin.principal, {
        workspaceId: otherWorkspaceId,
        email: viewer.email,
        role: "Viewer",
      }),
    ).rejects.toMatchObject({ code: "already_member" });
  });
});

describe("database account rate limiting", () => {
  it("atomically bounds concurrent requests, retains rejects, and resets using clock expiry", async () => {
    const key = randomUUID();
    rateKeys.push(key);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        consumeAccountRateLimit({ key, maxAttempts: 3, windowSeconds: 60 }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(3);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(5);
    await expect(
      consumeAccountRateLimit({ key, maxAttempts: 3, windowSeconds: 60 }),
    ).rejects.toMatchObject({ code: "rate_limited", statusCode: 429 });
    const [limited] = await db()
      .select()
      .from(accountRateLimit)
      .where(eq(accountRateLimit.key, key));
    expect(limited?.attempts).toBe(4);
    await db()
      .update(accountRateLimit)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accountRateLimit.key, key));
    await consumeAccountRateLimit({ key, maxAttempts: 3, windowSeconds: 60 });
    const [reset] = await db()
      .select()
      .from(accountRateLimit)
      .where(eq(accountRateLimit.key, key));
    expect(reset?.attempts).toBe(1);
  });

  it("cleans at most one bounded batch of stale rows per request", async () => {
    const prefix = randomUUID();
    const stale = Array.from(
      { length: 205 },
      (_, index) => `${prefix}-${index}`,
    );
    rateKeys.push(...stale, prefix);
    await db()
      .insert(accountRateLimit)
      .values(
        stale.map((key) => ({
          key,
          attempts: 1,
          expiresAt: new Date(Date.now() - 60000),
        })),
      );
    await consumeAccountRateLimit({
      key: prefix,
      maxAttempts: 3,
      windowSeconds: 60,
    });
    const remaining = await db()
      .select()
      .from(accountRateLimit)
      .where(inArray(accountRateLimit.key, stale));
    expect(remaining.length).toBeGreaterThanOrEqual(105);
    expect(remaining.length).toBeLessThan(205);
  });
});

describe("owner-delegated machine accounts", () => {
  let workspaceId: string;
  let owner: AccountFixture;
  let viewer: AccountFixture;
  let machine: ApiKeyAccountPrincipal;

  async function delegated(account: AccountFixture, scopes = [...API_OPERATION_SCOPES]) {
    const key = unwrap(await createAdminApiKey({ workspaceId, name: randomUUID(), scopes }, account.principal));
    return {
      kind: "apiKey" as const,
      keyId: key.id,
      memberId: account.memberId,
      ownerMemberId: account.memberId,
      workspaceId,
    };
  }

  beforeEach(async () => {
    workspaceId = (await makeWorkspace()).id;
    owner = await makeAccount(workspaceId, "Admin", true);
    viewer = await makeAccount(workspaceId, "Viewer");
    machine = await delegated(owner);
  });

  it("derives ownership only from authenticated context and inherits it without rebinding", async () => {
    const request = {
      workspaceId, name: randomUUID(), scopes: [...API_OPERATION_SCOPES],
      ownerMemberId: viewer.memberId,
    };
    const child = unwrap(await createAdminApiKey(request, machine));
    const childPrincipal = { ...machine, keyId: child.id };
    expect(await getAccountProfile(childPrincipal)).toMatchObject({
      member: { id: owner.memberId }, currentKeyId: child.id,
    });
    await expect(getAccountProfile({ ...childPrincipal, ownerMemberId: viewer.memberId, memberId: viewer.memberId }))
      .rejects.toMatchObject({ code: "not_authenticated" });
    const unowned = unwrap(await createAdminApiKey({ ...request, name: randomUUID() }));
    await expect(getAccountProfile({ ...machine, keyId: unowned.id }))
      .rejects.toMatchObject({ code: "not_authenticated" });
    await expect(getAccountProfile({ ...machine, memberId: viewer.memberId }))
      .rejects.toMatchObject({ code: "not_authenticated" });
  });

  it("allows operator enrollment only for the exact enabled instance-admin workspace owner", async () => {
    const key = unwrap(await provisionOwnerAdminApiKey({
      workspaceId, name: randomUUID(), scopes: [...API_OPERATION_SCOPES],
    }, owner.memberId));
    expect(await getAccountProfile({ ...machine, keyId: key.id })).toMatchObject({
      member: { id: owner.memberId },
    });
    await expect(provisionOwnerAdminApiKey({ workspaceId, name: randomUUID() }, viewer.memberId))
      .rejects.toMatchObject({ code: "forbidden" });
    const foreign = await makeAccount((await makeWorkspace()).id, "Admin", true);
    await expect(provisionOwnerAdminApiKey({ workspaceId, name: randomUUID() }, foreign.memberId))
      .rejects.toMatchObject({ code: "forbidden" });
    await db().update(googleAccount).set({ disabledAt: new Date() }).where(eq(googleAccount.memberId, owner.memberId));
    await expect(provisionOwnerAdminApiKey({ workspaceId, name: randomUUID() }, owner.memberId))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires every scope for account controls and rechecks persisted scopes", async () => {
    for (const missing of API_OPERATION_SCOPES) {
      const limited = await delegated(owner, API_OPERATION_SCOPES.filter((scope) => scope !== missing));
      await expect(updateAccountProfile(limited, { name: "Forbidden" }))
        .rejects.toMatchObject({ code: "forbidden" });
      await expect(createAdminApiKey({ workspaceId, name: randomUUID() }, limited))
        .rejects.toMatchObject({ code: "forbidden" });
    }
    const read = await delegated(owner, ["read"]);
    expect(await getApiKeyAccountContext(read, "Viewer", ["read"])).toMatchObject({
      member: { id: owner.memberId },
    });
    await expect(getApiKeyAccountContext(read, "Author", ["write"]))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("represents no current browser session and revokes all browser sessions without killing the key", async () => {
    const second = await createAccountSession({ memberId: owner.memberId });
    const sessions = await listAccountSessions(machine);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => !session.current)).toBe(true);
    expect(await getAccountProfile(machine)).not.toHaveProperty("currentSessionId");
    await expect(revokeAccountSession(machine, viewer.principal.sessionId))
      .rejects.toMatchObject({ code: "forbidden" });
    await revokeOtherAccountSessions(machine);
    expect(await resolveAccountSession(owner.token)).toBeNull();
    expect(await resolveAccountSession(second.token)).toBeNull();
    expect(await getAccountProfile(machine)).toHaveProperty("currentKeyId", machine.keyId);
    const browser = await createAccountSession({ memberId: owner.memberId });
    await logoutApiKeyAccount(machine);
    await expect(updateAccountProfile(machine, { name: "Revoked" }))
      .rejects.toMatchObject({ code: "not_authenticated" });
    expect(await resolveAccountSession(browser.token)).not.toBeNull();
  });

  it("freshly rejects demoted, removed and disabled owners instead of trusting captured role flags", async () => {
    const second = await makeAccount(workspaceId, "Admin", true);
    await updateAccountMemberRole(second.principal, { workspaceId, memberId: owner.memberId, role: "Viewer" });
    await expect(createWorkspaceInvitation(machine, { workspaceId, email: "denied@example.com", role: "Viewer" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(createAdminApiKey({ workspaceId, name: randomUUID() }, machine))
      .rejects.toMatchObject({ code: "forbidden" });
    await updateAccountMemberRole(second.principal, { workspaceId, memberId: owner.memberId, role: "Admin" });
    await setAccountDisabled(second.principal, { memberId: owner.memberId, disabled: true });
    await expect(getAccountProfile(machine)).rejects.toMatchObject({ code: "not_authenticated" });
    await setAccountDisabled(second.principal, { memberId: owner.memberId, disabled: false });
    await removeAccountMember(second.principal, { workspaceId, memberId: owner.memberId });
    await expect(getAccountProfile(machine)).rejects.toMatchObject({ code: "no_access" });
  });

  it("keeps scope binding and global disablement from touching foreign or shared accounts", async () => {
    const foreignWorkspaceId = (await makeWorkspace()).id;
    const foreign = await makeAccount(foreignWorkspaceId);
    await db().insert(workspaceMemberRole).values({
      workspaceId: foreignWorkspaceId, workspaceMemberId: owner.memberId, role: "Admin",
    });
    await expect(getAccountTeam(machine, foreignWorkspaceId)).rejects.toMatchObject({ code: "no_access" });
    await expect(selectAccountWorkspace(machine, foreignWorkspaceId)).rejects.toMatchObject({ code: "no_access" });
    await expect(updateAccountMemberRole(machine, { workspaceId, memberId: foreign.memberId, role: "Viewer" }))
      .rejects.toMatchObject({ code: "no_access" });
    await expect(setAccountDisabled(machine, { memberId: foreign.memberId, disabled: true }))
      .rejects.toMatchObject({ code: "no_access" });
    await db().insert(workspaceMemberRole).values({
      workspaceId, workspaceMemberId: foreign.memberId, role: "Viewer",
    });
    await expect(setAccountDisabled(machine, { memberId: foreign.memberId, disabled: false }))
      .rejects.toMatchObject({ code: "no_access" });
    const profile = await getAccountProfile(machine);
    expect(profile.memberships.map((role) => role.workspaceId)).toEqual([workspaceId]);
    await setAccountDisabled(machine, { memberId: viewer.memberId, disabled: true });
    expect(await resolveAccountSession(viewer.token)).toBeNull();
  });

  it("retains last-administrator protection and serializes competing machine demotions", async () => {
    await expect(updateAccountMemberRole(machine, { workspaceId, memberId: owner.memberId, role: "Viewer" }))
      .rejects.toMatchObject({ code: "last_administrator" });
    await expect(removeAccountMember(machine, { workspaceId, memberId: owner.memberId }))
      .rejects.toMatchObject({ code: "last_administrator" });
    const second = await makeAccount(workspaceId, "Admin", true);
    const secondMachine = await delegated(second);
    const outcomes = await Promise.allSettled([
      updateAccountMemberRole(machine, { workspaceId, memberId: owner.memberId, role: "Viewer" }),
      updateAccountMemberRole(secondMachine, { workspaceId, memberId: second.memberId, role: "Viewer" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });
});

describe("delegated workspace creation authorization", () => {
  it("rechecks the owner and current key inside the publisher transaction", async () => {
    const workspaceId = (await makeWorkspace()).id;
    const owner = await makeAccount(workspaceId, "Admin", true);
    const key = unwrap(await provisionOwnerAdminApiKey({
      workspaceId, name: randomUUID(), scopes: [...API_OPERATION_SCOPES],
    }, owner.memberId));
    const principal: ApiKeyAccountPrincipal = {
      kind: "apiKey", workspaceId, keyId: key.id,
      memberId: owner.memberId, ownerMemberId: owner.memberId,
    };
    const name = `revoked-machine-workspace-${randomUUID()}`;
    await logoutApiKeyAccount(principal);
    await expect(createPublisher({
      workspaceId, name, createNewWorkspace: true, principal,
    })).rejects.toMatchObject({ code: "not_authenticated" });
    expect(await db().query.workspace.findFirst({ where: eq(workspace.name, name) })).toBeUndefined();
  });
});
