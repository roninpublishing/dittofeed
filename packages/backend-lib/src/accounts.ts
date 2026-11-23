import { createHash, randomBytes } from "crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  AccountProfile,
  AccountSessionResource,
  AccountTeamResponse,
  containsAccountControlCharacters,
  CreateAccountInvitationRequest,
  WorkspaceInvitationResource,
} from "isomorphic-lib/src/accounts";
import { Role, WorkspaceMemberResource } from "isomorphic-lib/src/types";
import { err, ok } from "neverthrow";

import config from "./config";
import { Db, db } from "./db";
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
import { newsletter, publisher } from "./db/publisherSchema";
import { alias } from "drizzle-orm/pg-core";
import { RequestContextErrorType, RequestContextResult } from "./types";

export interface GoogleAccountPrincipal {
  memberId: string;
  sessionId: string;
  isInstanceAdmin: boolean;
}

export interface VerifiedGoogleProfile {
  subject: string;
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;
  name?: string;
  picture?: string;
}

export class AccountError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
    // Preserve instanceof when TypeScript emits the repository's ES5 target.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "AccountError";
  }
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Member = typeof workspaceMember.$inferSelect;
type Invitation = typeof workspaceInvitation.$inferSelect;
const FLOW_MS = 10 * 60 * 1000;
const INVITATION_MS = 72 * 60 * 60 * 1000;
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const ROLE_RANK: Record<Role, number> = {
  Viewer: 0,
  Author: 1,
  WorkspaceManager: 2,
  Admin: 3,
};

function fail(code: string, statusCode = 403): never {
  throw new AccountError(code, statusCode);
}

// Every identity, session, invitation and membership mutation shares this lock.
// READ COMMITTED is deliberate: reads after waiting observe the prior holder's commit.
function authTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db().transaction(
    async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(1684632175, 1735357043)`,
      );
      return work(tx);
    },
    { isolationLevel: "read committed" },
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function normalizedEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    containsAccountControlCharacters(normalized) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    fail("invalid_profile", 400);
  }
  return normalized;
}

function validRole(role: Role): void {
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, role)) fail("forbidden");
}

function memberResource(member: Member): WorkspaceMemberResource {
  return {
    id: member.id,
    email: member.email ?? "",
    emailVerified: member.emailVerified,
    picture: member.image ?? undefined,
    name: member.name ?? undefined,
    nickname: member.nickname ?? undefined,
    createdAt: member.createdAt.toISOString(),
  };
}

async function authenticated(
  tx: Transaction,
  principal: GoogleAccountPrincipal,
) {
  const [row] = await tx
    .select({ account: googleAccount, member: workspaceMember })
    .from(accountSession)
    .innerJoin(
      googleAccount,
      eq(accountSession.memberId, googleAccount.memberId),
    )
    .innerJoin(workspaceMember, eq(googleAccount.memberId, workspaceMember.id))
    .where(
      and(
        eq(accountSession.id, principal.sessionId),
        eq(accountSession.memberId, principal.memberId),
        isNull(accountSession.revokedAt),
        gt(accountSession.expiresAt, new Date()),
        isNull(googleAccount.disabledAt),
      ),
    );
  if (!row) fail("not_authenticated", 401);
  return row;
}

const publisherWorkspace = alias(workspace, "newsletterPublisherWorkspace");

async function effectiveMemberships(
  tx: Transaction,
  memberId: string,
  workspaceId?: string,
) {
  const direct = await tx
    .select({ role: workspaceMemberRole.role, workspace })
    .from(workspaceMemberRole)
    .innerJoin(workspace, eq(workspaceMemberRole.workspaceId, workspace.id))
    .where(and(
      eq(workspaceMemberRole.workspaceMemberId, memberId),
      eq(workspace.status, "Active"),
      workspaceId ? eq(workspace.id, workspaceId) : undefined,
    ));
  const inherited = await tx
    .select({ role: workspaceMemberRole.role, workspace })
    .from(newsletter)
    .innerJoin(publisher, eq(newsletter.publisherId, publisher.workspaceId))
    .innerJoin(publisherWorkspace, eq(publisher.workspaceId, publisherWorkspace.id))
    .innerJoin(workspace, eq(newsletter.workspaceId, workspace.id))
    .innerJoin(workspaceMemberRole, eq(workspaceMemberRole.workspaceId, publisher.workspaceId))
    .where(and(
      eq(workspaceMemberRole.workspaceMemberId, memberId),
      eq(workspace.status, "Active"),
      eq(publisherWorkspace.status, "Active"),
      workspaceId ? eq(workspace.id, workspaceId) : undefined,
    ));
  const effective = new Map(direct.map((row) => [row.workspace.id, row]));
  for (const row of inherited) {
    const existing = effective.get(row.workspace.id);
    if (!existing || ROLE_RANK[row.role] > ROLE_RANK[existing.role]) {
      effective.set(row.workspace.id, row);
    }
  }
  return Array.from(effective.values()).sort((a, b) => a.workspace.id.localeCompare(b.workspace.id));
}

async function membership(
  tx: Transaction,
  memberId: string,
  workspaceId: string,
) {
  const row = (await effectiveMemberships(tx, memberId, workspaceId))[0];
  if (!row) fail("no_access");
  return row;
}

async function authorized(
  tx: Transaction,
  principal: GoogleAccountPrincipal,
  workspaceId: string,
  requiredRole: Role,
) {
  validRole(requiredRole);
  const identity = await authenticated(tx, principal);
  const access = await membership(tx, principal.memberId, workspaceId);
  if (ROLE_RANK[access.role] < ROLE_RANK[requiredRole]) fail("forbidden");
  return { ...identity, ...access };
}

function mayManage(actorRole: Role, requestedRole: Role): void {
  validRole(requestedRole);
  if (
    actorRole !== "Admin" &&
    !(
      actorRole === "WorkspaceManager" &&
      ROLE_RANK[requestedRole] < ROLE_RANK.WorkspaceManager
    )
  ) {
    fail("forbidden");
  }
}

async function protectWorkspaceAdmin(
  tx: Transaction,
  workspaceId: string,
  memberId: string,
): Promise<void> {
  const admins = await tx
    .select({ memberId: googleAccount.memberId })
    .from(workspaceMemberRole)
    .innerJoin(
      googleAccount,
      eq(workspaceMemberRole.workspaceMemberId, googleAccount.memberId),
    )
    .where(
      and(
        eq(workspaceMemberRole.workspaceId, workspaceId),
        eq(workspaceMemberRole.role, "Admin"),
        isNull(googleAccount.disabledAt),
      ),
    );
  if (admins.some((a) => a.memberId === memberId) && admins.length === 1)
    fail("last_administrator", 409);
}

function invitationResource(
  invitation: Invitation,
  workspaceName: string,
): WorkspaceInvitationResource {
  let status: WorkspaceInvitationResource["status"] = "pending";
  if (invitation.acceptedAt) status = "accepted";
  else if (invitation.revokedAt) status = "revoked";
  else if (invitation.expiresAt.getTime() <= Date.now()) status = "expired";
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    workspaceName,
    email: invitation.normalizedEmail,
    role: invitation.role,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    status,
  };
}

async function liveInvitation(
  tx: Transaction,
  selector: { token?: string; id?: string },
) {
  if (
    selector.token !== undefined &&
    !/^[A-Za-z0-9_-]{43}$/.test(selector.token)
  )
    fail("invalid_invitation", 400);
  const [row] = await tx
    .select({ invitation: workspaceInvitation, workspaceName: workspace.name })
    .from(workspaceInvitation)
    .innerJoin(workspace, eq(workspaceInvitation.workspaceId, workspace.id))
    .where(
      and(
        selector.token !== undefined
          ? eq(workspaceInvitation.tokenHash, hash(selector.token))
          : eq(
              workspaceInvitation.id,
              selector.id ?? "00000000-0000-0000-0000-000000000000",
            ),
        isNull(workspaceInvitation.acceptedAt),
        isNull(workspaceInvitation.revokedAt),
        gt(workspaceInvitation.expiresAt, new Date()),
        eq(workspace.status, "Active"),
      ),
    );
  if (!row) fail("invalid_invitation", 400);
  const [issuerAccount] = await tx
    .select({ memberId: googleAccount.memberId })
    .from(googleAccount)
    .where(and(
      eq(googleAccount.memberId, row.invitation.createdByMemberId),
      isNull(googleAccount.disabledAt),
    ));
  const issuer = issuerAccount
    ? (await effectiveMemberships(tx, issuerAccount.memberId, row.invitation.workspaceId))[0]
    : undefined;
  if (
    !issuer ||
    (issuer.role !== "Admin" &&
      !(
        issuer.role === "WorkspaceManager" &&
        ROLE_RANK[row.invitation.role] < ROLE_RANK.WorkspaceManager
      ))
  ) {
    fail("invalid_invitation", 400);
  }
  return row;
}

export async function createGoogleFlow({
  state,
  invitationToken,
}: {
  state: string;
  invitationToken?: string;
}): Promise<{ id: string; expiresAt: number }> {
  if (state.length < 32 || state.length > 512) fail("invalid_profile", 400);
  return authTransaction(async (tx) => {
    const invitation =
      invitationToken === undefined
        ? undefined
        : await liveInvitation(tx, { token: invitationToken });
    const expiresAt = new Date(Date.now() + FLOW_MS);
    const [flow] = await tx
      .insert(googleOAuthFlow)
      .values({
        stateHash: hash(state),
        invitationId: invitation?.invitation.id,
        expiresAt,
      })
      .returning();
    if (!flow) fail("not_authenticated", 401);
    return { id: flow.id, expiresAt: expiresAt.getTime() };
  });
}

export async function consumeGoogleFlow({
  id,
  state,
}: {
  id: string;
  state: string;
}): Promise<{ invitationId: string | null }> {
  return authTransaction(async (tx) => {
    const [flow] = await tx
      .update(googleOAuthFlow)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(googleOAuthFlow.id, id),
          eq(googleOAuthFlow.stateHash, hash(state)),
          isNull(googleOAuthFlow.consumedAt),
          gt(googleOAuthFlow.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!flow) fail("not_authenticated", 401);
    return { invitationId: flow.invitationId };
  });
}

async function rejectEmailCollision(
  tx: Transaction,
  email: string,
  memberId?: string,
): Promise<void> {
  const [member] = await tx
    .select({ id: workspaceMember.id })
    .from(workspaceMember)
    .where(
      and(
        sql`lower(btrim(${workspaceMember.email})) = ${email}`,
        memberId ? ne(workspaceMember.id, memberId) : undefined,
      ),
    )
    .limit(1);
  const [account] = await tx
    .select({ id: googleAccount.memberId })
    .from(googleAccount)
    .where(
      and(
        eq(googleAccount.normalizedEmail, email),
        memberId ? ne(googleAccount.memberId, memberId) : undefined,
      ),
    )
    .limit(1);
  if (member || account) fail("identity_conflict", 409);
}

export async function completeGoogleSignIn({
  profile,
  invitationId,
}: {
  profile: VerifiedGoogleProfile;
  invitationId?: string | null;
}): Promise<{ memberId: string }> {
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- Enforce exact true at the runtime identity boundary.
    profile.emailVerified !== true ||
    !profile.subject ||
    profile.subject.length > 255
  )
    fail("invalid_profile", 400);
  const email = normalizedEmail(profile.email);
  return authTransaction(async (tx) => {
    let [account] = await tx
      .select()
      .from(googleAccount)
      .where(eq(googleAccount.googleSubject, profile.subject));
    if (account?.disabledAt) fail("forbidden");
    await rejectEmailCollision(tx, email, account?.memberId);
    const [legacy] = await tx
      .select()
      .from(workspaceMembeAccount)
      .where(
        and(
          eq(workspaceMembeAccount.provider, "google"),
          eq(workspaceMembeAccount.providerAccountId, profile.subject),
        ),
      )
      .limit(1);
    if (legacy && legacy.workspaceMemberId !== account?.memberId)
      fail("identity_conflict", 409);

    const invitation = invitationId
      ? await liveInvitation(tx, { id: invitationId })
      : undefined;
    if (invitation) {
      if (invitation.invitation.normalizedEmail !== email)
        fail("invitation_email_mismatch", 400);
      // Invitation admission must come through a state-token-bound, consumed OAuth flow.
      const [flow] = await tx
        .select({ id: googleOAuthFlow.id })
        .from(googleOAuthFlow)
        .where(
          and(
            eq(googleOAuthFlow.invitationId, invitation.invitation.id),
            sql`${googleOAuthFlow.consumedAt} is not null`,
            gt(googleOAuthFlow.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!flow) fail("invalid_invitation", 400);
      if (account) {
        const [existingRole] = await tx
          .select()
          .from(workspaceMemberRole)
          .where(
            and(
              eq(workspaceMemberRole.workspaceMemberId, account.memberId),
              eq(
                workspaceMemberRole.workspaceId,
                invitation.invitation.workspaceId,
              ),
            ),
          );
        if (existingRole) fail("already_member", 409);
      }
    }

    let bootstrapWorkspaceId: string | undefined;
    if (!account && !invitation) {
      const settings = config();
      const [anyAccount] = await tx
        .select({ memberId: googleAccount.memberId })
        .from(googleAccount)
        .limit(1);
      if (
        anyAccount ||
        !settings.googleBootstrapAdminEmail ||
        !settings.googleBootstrapWorkspaceId ||
        normalizedEmail(settings.googleBootstrapAdminEmail) !== email
      )
        fail("not_invited");
      const emailDomain = email.slice(email.lastIndexOf("@") + 1);
      const googleOwnsEmail =
        emailDomain === "gmail.com" ||
        profile.hostedDomain?.toLowerCase() === emailDomain;
      // Verified third-party consumer email is not current Google-owned mailbox authority.
      // First-owner admission needs an explicit subject pin in that case, never email alone.
      if (
        !googleOwnsEmail &&
        settings.googleBootstrapAdminSubject !== profile.subject
      )
        fail("bootstrap_subject_required");
      const [initialWorkspace] = await tx
        .select({ id: workspace.id })
        .from(workspace)
        .where(
          and(
            eq(workspace.id, settings.googleBootstrapWorkspaceId),
            eq(workspace.status, "Active"),
          ),
        );
      if (!initialWorkspace) fail("not_invited");
      bootstrapWorkspaceId = initialWorkspace.id;
    }

    if (!account) {
      const name = profile.name?.trim().slice(0, 120) ?? "";
      const [member] = await tx
        .insert(workspaceMember)
        .values({
          email,
          emailVerified: true,
          name: name.length > 0 ? name : null,
          image: profile.picture,
          lastWorkspaceId:
            invitation?.invitation.workspaceId ?? bootstrapWorkspaceId,
        })
        .returning();
      if (!member) fail("not_authenticated", 401);
      const [createdAccount] = await tx
        .insert(googleAccount)
        .values({
          memberId: member.id,
          googleSubject: profile.subject,
          normalizedEmail: email,
          isInstanceAdmin: bootstrapWorkspaceId !== undefined,
        })
        .returning();
      if (!createdAccount) fail("not_authenticated", 401);
      account = createdAccount;
    } else {
      // Subject is never changed and Google's display name never overwrites the owned name.
      await tx
        .update(googleAccount)
        .set({ normalizedEmail: email })
        .where(eq(googleAccount.memberId, account.memberId));
      await tx
        .update(workspaceMember)
        .set({ email, emailVerified: true, image: profile.picture })
        .where(eq(workspaceMember.id, account.memberId));
    }
    const workspaceId =
      invitation?.invitation.workspaceId ?? bootstrapWorkspaceId;
    if (workspaceId) {
      await tx.insert(workspaceMemberRole).values({
        workspaceId,
        workspaceMemberId: account.memberId,
        role: invitation?.invitation.role ?? "Admin",
      });
      await tx
        .update(workspaceMember)
        .set({ lastWorkspaceId: workspaceId })
        .where(eq(workspaceMember.id, account.memberId));
    }
    if (invitation) {
      await tx
        .update(workspaceInvitation)
        .set({ acceptedAt: new Date(), acceptedByMemberId: account.memberId })
        .where(eq(workspaceInvitation.id, invitation.invitation.id));
    }
    return { memberId: account.memberId };
  });
}

export async function createAccountSession({
  memberId,
  userAgent,
}: {
  memberId: string;
  userAgent?: string;
}): Promise<{ token: string; principal: GoogleAccountPrincipal }> {
  return authTransaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(googleAccount)
      .where(
        and(
          eq(googleAccount.memberId, memberId),
          isNull(googleAccount.disabledAt),
        ),
      );
    if (!account) fail("not_authenticated", 401);
    const rawToken = token();
    const [session] = await tx
      .insert(accountSession)
      .values({
        memberId,
        tokenHash: hash(rawToken),
        userAgent: userAgent?.slice(0, 512),
        expiresAt: new Date(Date.now() + SESSION_MS),
      })
      .returning();
    if (!session) fail("not_authenticated", 401);
    return {
      token: rawToken,
      principal: {
        memberId,
        sessionId: session.id,
        isInstanceAdmin: account.isInstanceAdmin,
      },
    };
  });
}

export async function resolveAccountSession(
  rawToken: string,
): Promise<GoogleAccountPrincipal | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
  const [row] = await db()
    .select({
      memberId: googleAccount.memberId,
      sessionId: accountSession.id,
      isInstanceAdmin: googleAccount.isInstanceAdmin,
    })
    .from(accountSession)
    .innerJoin(
      googleAccount,
      eq(accountSession.memberId, googleAccount.memberId),
    )
    .where(
      and(
        eq(accountSession.tokenHash, hash(rawToken)),
        isNull(accountSession.revokedAt),
        gt(accountSession.expiresAt, new Date()),
        isNull(googleAccount.disabledAt),
      ),
    );
  return row ?? null;
}

export async function listAccountSessions(
  principal: GoogleAccountPrincipal,
): Promise<AccountSessionResource[]> {
  return authTransaction(async (tx) => {
    await authenticated(tx, principal);
    const sessions = await tx
      .select()
      .from(accountSession)
      .where(
        and(
          eq(accountSession.memberId, principal.memberId),
          isNull(accountSession.revokedAt),
          gt(accountSession.expiresAt, new Date()),
        ),
      )
      .orderBy(accountSession.createdAt);
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === principal.sessionId,
      userAgent: session.userAgent ?? undefined,
    }));
  });
}

export async function revokeAccountSession(
  principal: GoogleAccountPrincipal,
  sessionId: string,
): Promise<void> {
  await authTransaction(async (tx) => {
    await authenticated(tx, principal);
    const [session] = await tx
      .update(accountSession)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(accountSession.id, sessionId),
          eq(accountSession.memberId, principal.memberId),
        ),
      )
      .returning({ id: accountSession.id });
    if (!session) fail("forbidden");
  });
}

export async function revokeOtherAccountSessions(
  principal: GoogleAccountPrincipal,
): Promise<void> {
  await authTransaction(async (tx) => {
    await authenticated(tx, principal);
    await tx
      .update(accountSession)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(accountSession.memberId, principal.memberId),
          ne(accountSession.id, principal.sessionId),
          isNull(accountSession.revokedAt),
        ),
      );
  });
}

async function profileInTransaction(
  tx: Transaction,
  principal: GoogleAccountPrincipal,
): Promise<AccountProfile> {
  const { member, account } = await authenticated(tx, principal);
  const memberships = await tx
    .select({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceMemberId: workspaceMemberRole.workspaceMemberId,
      role: workspaceMemberRole.role,
    })
    .from(workspaceMemberRole)
    .innerJoin(workspace, eq(workspaceMemberRole.workspaceId, workspace.id))
    .where(
      and(
        eq(workspaceMemberRole.workspaceMemberId, principal.memberId),
        eq(workspace.status, "Active"),
      ),
    )
    .orderBy(workspace.id);
  return {
    member: memberResource(member),
    isInstanceAdmin: account.isInstanceAdmin,
    memberships,
    currentSessionId: principal.sessionId,
  };
}

export async function getAccountProfile(
  principal: GoogleAccountPrincipal,
): Promise<AccountProfile> {
  return authTransaction((tx) => profileInTransaction(tx, principal));
}

export async function updateAccountProfile(
  principal: GoogleAccountPrincipal,
  { name }: { name: string },
): Promise<AccountProfile> {
  const normalizedName = name.trim();
  if (
    !normalizedName ||
    normalizedName.length > 120 ||
    containsAccountControlCharacters(normalizedName)
  )
    fail("invalid_profile", 400);
  return authTransaction(async (tx) => {
    await authenticated(tx, principal);
    await tx
      .update(workspaceMember)
      .set({ name: normalizedName })
      .where(eq(workspaceMember.id, principal.memberId));
    return profileInTransaction(tx, principal);
  });
}

export async function getAccountTeam(
  principal: GoogleAccountPrincipal,
  workspaceId: string,
): Promise<AccountTeamResponse> {
  return authTransaction(async (tx) => {
    const actor = await authorized(
      tx,
      principal,
      workspaceId,
      "WorkspaceManager",
    );
    const rows = await tx
      .select({
        member: workspaceMember,
        role: workspaceMemberRole.role,
        account: googleAccount,
      })
      .from(workspaceMemberRole)
      .innerJoin(
        workspaceMember,
        eq(workspaceMemberRole.workspaceMemberId, workspaceMember.id),
      )
      .leftJoin(googleAccount, eq(workspaceMember.id, googleAccount.memberId))
      .where(eq(workspaceMemberRole.workspaceId, workspaceId))
      .orderBy(workspaceMember.createdAt);
    const invitations = await tx
      .select()
      .from(workspaceInvitation)
      .where(eq(workspaceInvitation.workspaceId, workspaceId))
      .orderBy(workspaceInvitation.createdAt);
    return {
      members: rows.map((row) => ({
        member: memberResource(row.member),
        role: row.role,
        googleLinked: row.account !== null,
        disabled: row.account?.disabledAt != null,
        isInstanceAdmin: row.account?.isInstanceAdmin ?? false,
      })),
      invitations: invitations.map((invitation) =>
        invitationResource(invitation, actor.workspace.name),
      ),
      currentRole: actor.role,
      canManageInstanceAccounts: actor.account.isInstanceAdmin,
    };
  });
}

export async function createWorkspaceInvitation(
  principal: GoogleAccountPrincipal,
  input: CreateAccountInvitationRequest,
): Promise<{ invitation: WorkspaceInvitationResource; token: string }> {
  const email = normalizedEmail(input.email);
  return authTransaction(async (tx) => {
    const actor = await authorized(
      tx,
      principal,
      input.workspaceId,
      "WorkspaceManager",
    );
    mayManage(actor.role, input.role);
    const [existing] = await tx
      .select({ memberId: googleAccount.memberId })
      .from(googleAccount)
      .innerJoin(
        workspaceMemberRole,
        eq(googleAccount.memberId, workspaceMemberRole.workspaceMemberId),
      )
      .where(
        and(
          eq(googleAccount.normalizedEmail, email),
          eq(workspaceMemberRole.workspaceId, input.workspaceId),
        ),
      );
    if (existing) fail("already_member", 409);
    const pending = await tx
      .select({ role: workspaceInvitation.role })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, input.workspaceId),
          eq(workspaceInvitation.normalizedEmail, email),
          isNull(workspaceInvitation.acceptedAt),
          isNull(workspaceInvitation.revokedAt),
          gt(workspaceInvitation.expiresAt, new Date()),
        ),
      );
    for (const invitation of pending) mayManage(actor.role, invitation.role);
    // Reissuing a link revokes earlier pending links instead of leaving parallel bearer grants.
    await tx
      .update(workspaceInvitation)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(workspaceInvitation.workspaceId, input.workspaceId),
          eq(workspaceInvitation.normalizedEmail, email),
          isNull(workspaceInvitation.acceptedAt),
          isNull(workspaceInvitation.revokedAt),
        ),
      );
    const rawToken = token();
    const [invitation] = await tx
      .insert(workspaceInvitation)
      .values({
        workspaceId: input.workspaceId,
        normalizedEmail: email,
        role: input.role,
        tokenHash: hash(rawToken),
        createdByMemberId: principal.memberId,
        expiresAt: new Date(Date.now() + INVITATION_MS),
      })
      .returning();
    if (!invitation) fail("invalid_invitation", 400);
    return {
      invitation: invitationResource(invitation, actor.workspace.name),
      token: rawToken,
    };
  });
}

export async function previewWorkspaceInvitation(
  rawToken: string,
): Promise<WorkspaceInvitationResource> {
  return authTransaction(async (tx) => {
    const row = await liveInvitation(tx, { token: rawToken });
    return invitationResource(row.invitation, row.workspaceName);
  });
}

export async function revokeWorkspaceInvitation(
  principal: GoogleAccountPrincipal,
  { workspaceId, invitationId }: { workspaceId: string; invitationId: string },
): Promise<void> {
  await authTransaction(async (tx) => {
    const actor = await authorized(
      tx,
      principal,
      workspaceId,
      "WorkspaceManager",
    );
    const [invitation] = await tx
      .select()
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.id, invitationId),
          eq(workspaceInvitation.workspaceId, workspaceId),
        ),
      );
    if (!invitation) fail("invalid_invitation", 400);
    mayManage(actor.role, invitation.role);
    if (invitation.acceptedAt) fail("invalid_invitation", 400);
    await tx
      .update(workspaceInvitation)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceInvitation.id, invitationId));
  });
}

async function targetRole(
  tx: Transaction,
  workspaceId: string,
  memberId: string,
): Promise<Role> {
  const [row] = await tx
    .select()
    .from(workspaceMemberRole)
    .where(
      and(
        eq(workspaceMemberRole.workspaceId, workspaceId),
        eq(workspaceMemberRole.workspaceMemberId, memberId),
      ),
    );
  if (!row) fail("no_access");
  return row.role;
}

export async function updateAccountMemberRole(
  principal: GoogleAccountPrincipal,
  {
    workspaceId,
    memberId,
    role,
  }: { workspaceId: string; memberId: string; role: Role },
): Promise<void> {
  await authTransaction(async (tx) => {
    const actor = await authorized(
      tx,
      principal,
      workspaceId,
      "WorkspaceManager",
    );
    const previousRole = await targetRole(tx, workspaceId, memberId);
    mayManage(actor.role, previousRole);
    mayManage(actor.role, role);
    if (previousRole === "Admin" && role !== "Admin")
      await protectWorkspaceAdmin(tx, workspaceId, memberId);
    await tx
      .update(workspaceMemberRole)
      .set({ role })
      .where(
        and(
          eq(workspaceMemberRole.workspaceId, workspaceId),
          eq(workspaceMemberRole.workspaceMemberId, memberId),
        ),
      );
  });
}

export async function removeAccountMember(
  principal: GoogleAccountPrincipal,
  { workspaceId, memberId }: { workspaceId: string; memberId: string },
): Promise<void> {
  await authTransaction(async (tx) => {
    const actor = await authorized(
      tx,
      principal,
      workspaceId,
      "WorkspaceManager",
    );
    const previousRole = await targetRole(tx, workspaceId, memberId);
    mayManage(actor.role, previousRole);
    if (previousRole === "Admin")
      await protectWorkspaceAdmin(tx, workspaceId, memberId);
    // Remove access only. Account, resources, authored history and other memberships remain.
    await tx
      .delete(workspaceMemberRole)
      .where(
        and(
          eq(workspaceMemberRole.workspaceId, workspaceId),
          eq(workspaceMemberRole.workspaceMemberId, memberId),
        ),
      );
    await tx
      .update(workspaceMember)
      .set({ lastWorkspaceId: null })
      .where(
        and(
          eq(workspaceMember.id, memberId),
          eq(workspaceMember.lastWorkspaceId, workspaceId),
        ),
      );
  });
}

export async function setAccountDisabled(
  principal: GoogleAccountPrincipal,
  { memberId, disabled }: { memberId: string; disabled: boolean },
): Promise<void> {
  await authTransaction(async (tx) => {
    const actor = await authenticated(tx, principal);
    if (!actor.account.isInstanceAdmin) fail("forbidden");
    const [target] = await tx
      .select()
      .from(googleAccount)
      .where(eq(googleAccount.memberId, memberId));
    if (!target) fail("no_access");
    if (disabled && !target.disabledAt) {
      if (target.isInstanceAdmin) {
        const admins = await tx
          .select({ memberId: googleAccount.memberId })
          .from(googleAccount)
          .where(
            and(
              eq(googleAccount.isInstanceAdmin, true),
              isNull(googleAccount.disabledAt),
            ),
          );
        if (admins.length === 1) fail("last_instance_administrator", 409);
      }
      const roles = await tx
        .select()
        .from(workspaceMemberRole)
        .where(
          and(
            eq(workspaceMemberRole.workspaceMemberId, memberId),
            eq(workspaceMemberRole.role, "Admin"),
          ),
        );
      for (const role of roles) {
        // eslint-disable-next-line no-await-in-loop -- Keep checks on the same locked transaction.
        await protectWorkspaceAdmin(tx, role.workspaceId, memberId);
      }
    }
    await tx
      .update(googleAccount)
      .set({ disabledAt: disabled ? target.disabledAt ?? new Date() : null })
      .where(eq(googleAccount.memberId, memberId));
    if (disabled)
      await tx
        .update(accountSession)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(accountSession.memberId, memberId),
            isNull(accountSession.revokedAt),
          ),
        );
  });
}

export async function getGoogleRequestContext(
  principal: GoogleAccountPrincipal,
): Promise<RequestContextResult> {
  try {
    return await authTransaction<RequestContextResult>(async (tx) => {
      const { member } = await authenticated(tx, principal);
      const rows = await effectiveMemberships(tx, principal.memberId);
      const memberRoles = rows.map((row) => ({
        workspaceId: row.workspace.id,
        workspaceName: row.workspace.name,
        workspaceMemberId: principal.memberId,
        role: row.role,
      }));
      const selected =
        rows.find((row) => row.workspace.id === member.lastWorkspaceId) ??
        rows[0];
      if (!selected)
        return err({
          type: RequestContextErrorType.NotOnboarded,
          message: "No active workspace membership",
          member: memberResource(member),
          memberRoles,
        });
      return ok({
        member: memberResource(member),
        memberRoles,
        workspace: {
          id: selected.workspace.id,
          name: selected.workspace.name,
          type: selected.workspace.type,
          parentWorkspaceId: selected.workspace.parentWorkspaceId ?? undefined,
        },
      });
    });
  } catch (error) {
    if (error instanceof AccountError && error.code === "not_authenticated")
      return err({ type: RequestContextErrorType.NotAuthenticated });
    throw error;
  }
}

export async function selectAccountWorkspace(
  principal: GoogleAccountPrincipal,
  workspaceId: string,
): Promise<void> {
  await authTransaction(async (tx) => {
    await authenticated(tx, principal);
    await membership(tx, principal.memberId, workspaceId);
    await tx
      .update(workspaceMember)
      .set({ lastWorkspaceId: workspaceId })
      .where(eq(workspaceMember.id, principal.memberId));
  });
}

export async function requireWorkspaceRole(
  principal: GoogleAccountPrincipal,
  workspaceId: string,
  requiredRole: Role,
): Promise<void> {
  await authTransaction(async (tx) => {
    await authorized(tx, principal, workspaceId, requiredRole);
  });
}

export async function consumeAccountRateLimit({
  key,
  maxAttempts,
  windowSeconds,
}: {
  key: string;
  maxAttempts: number;
  windowSeconds: number;
}): Promise<void> {
  if (
    !key ||
    key.length > 256 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10000 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86400
  )
    fail("invalid_profile", 400);
  const allowed = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(accountRateLimit)
      .values({
        key,
        attempts: 1,
        expiresAt: sql`clock_timestamp() + ${windowSeconds} * interval '1 second'`,
      })
      .onConflictDoUpdate({
        target: accountRateLimit.key,
        set: {
          attempts: sql`case when ${accountRateLimit.expiresAt} <= clock_timestamp() then 1 else least(${accountRateLimit.attempts} + 1, ${maxAttempts + 1}) end`,
          expiresAt: sql`case when ${accountRateLimit.expiresAt} <= clock_timestamp() then clock_timestamp() + ${windowSeconds} * interval '1 second' else ${accountRateLimit.expiresAt} end`,
        },
      })
      .returning({ attempts: accountRateLimit.attempts });
    // Take the current key first; cleanup skips other transactions' keys to avoid lock cycles.
    await tx.execute(
      sql`delete from ${accountRateLimit} where ${accountRateLimit.key} in (select ${accountRateLimit.key} from ${accountRateLimit} where ${accountRateLimit.expiresAt} <= clock_timestamp() order by ${accountRateLimit.expiresAt} limit 100 for update skip locked)`,
    );
    return row !== undefined && row.attempts <= maxAttempts;
  });
  // Throw after commit so rejected attempts and stale cleanup are retained.
  if (!allowed) fail("rate_limited", 429);
}
