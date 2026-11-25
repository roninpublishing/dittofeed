import { SpanStatusCode } from "@opentelemetry/api";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { IncomingHttpHeaders } from "http";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import { err, ok } from "neverthrow";
import { sortBy } from "remeda";

import { getGoogleRequestContext, GoogleAccountPrincipal } from "./accounts";
import { decodeJwtHeader } from "./auth";
import config from "./config";
import { db } from "./db";
import { newsletter } from "./db/publisherSchema";
import {
  workspace as dbWorkspace,
  workspaceMembeAccount as dbWorkspaceMembeAccount,
  workspaceMember as dbWorkspaceMember,
  workspaceMemberRole as dbWorkspaceMemberRole,
} from "./db/schema";
import logger from "./logger";
import { isProfileEmailVerified } from "./openIdProfile";
import { withSpan } from "./openTelemetry";
import { requestContextPostProcessor } from "./requestContextPostProcessor";
import {
  NotOnboardedError,
  OpenIdProfile,
  RequestContextErrorType,
  RequestContextResult,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberResource,
  WorkspaceMemberRole,
  WorkspaceMemberRoleResource,
  WorkspaceResource,
  WorkspaceStatusDb,
  WorkspaceStatusDbEnum,
  WorkspaceTypeApp,
  WorkspaceTypeAppEnum,
} from "./types";
import { isValidWorkspaceDomain } from "./workspaceDomain";

export const SESSION_KEY = "df-session-key";
export const SESSION_WORKSPACE_KEY = "df-session-workspace-id";

interface RolesWithWorkspace {
  workspace:
    | (WorkspaceResource & {
        status: WorkspaceStatusDb;
        type: WorkspaceTypeApp;
        parentWorkspaceId: string | null;
      })
    | null;
  memberRoles: WorkspaceMemberRoleResource[];
}

export async function findAndCreateRoles(
  member: WorkspaceMember,
): Promise<RolesWithWorkspace> {
  const domain = member.email?.split("@")[1];
  // Stored domains may predate validation. Never grant access through a public
  // email provider, but continue honoring explicit workspace memberships.
  const autoJoinDomain =
    domain && isValidWorkspaceDomain(domain) ? domain : undefined;

  const workspaces = await db()
    .select()
    .from(dbWorkspace)
    .leftJoin(
      dbWorkspaceMemberRole,
      and(
        eq(dbWorkspaceMemberRole.workspaceId, dbWorkspace.id),
        eq(dbWorkspaceMemberRole.workspaceMemberId, member.id),
      ),
    )
    .where(
      and(
        eq(dbWorkspace.status, WorkspaceStatusDbEnum.Active),
        or(
          eq(dbWorkspaceMemberRole.workspaceMemberId, member.id),
          autoJoinDomain ? eq(dbWorkspace.domain, autoJoinDomain) : undefined,
        ),
      ),
    );

  const domainWorkspacesWithoutRole = workspaces.filter(
    (w) => w.WorkspaceMemberRole === null,
  );
  let roles = workspaces.flatMap((w) => w.WorkspaceMemberRole ?? []);
  if (domainWorkspacesWithoutRole.length !== 0) {
    const newRoles = (
      await Promise.all(
        domainWorkspacesWithoutRole.map((w) =>
          db()
            .insert(dbWorkspaceMemberRole)
            .values({
              workspaceId: w.Workspace.id,
              workspaceMemberId: member.id,
              role: "Admin",
            })
            .onConflictDoNothing()
            .returning(),
        ),
      )
    ).flat();
    logger().debug(
      {
        newRoles,
      },
      "new roles",
    );
    for (const role of newRoles) {
      roles.push(role);
    }
  }

  const workspaceById = workspaces.reduce((acc, w) => {
    acc.set(w.Workspace.id, w.Workspace);
    return acc;
  }, new Map<string, Workspace>());

  const parentWorkspaces = workspaces.filter(
    (w) => w.Workspace.type === WorkspaceTypeAppEnum.Parent,
  );

  if (parentWorkspaces.length !== 0) {
    const childWorkspaces = await db()
      .select()
      .from(dbWorkspace)
      .where(
        and(
          inArray(
            dbWorkspace.parentWorkspaceId,
            parentWorkspaces.map((w) => w.Workspace.id),
          ),
          eq(dbWorkspace.status, WorkspaceStatusDbEnum.Active),
          eq(dbWorkspace.type, WorkspaceTypeAppEnum.Child),
        ),
      );

    const existingRolesByWorkspaceId = roles.reduce((acc, r) => {
      acc.set(r.workspaceId, r);
      return acc;
    }, new Map<string, WorkspaceMemberRole>());

    for (const childWorkspace of childWorkspaces) {
      if (
        existingRolesByWorkspaceId.has(childWorkspace.id) ||
        !childWorkspace.parentWorkspaceId
      ) {
        continue;
      }
      const parentRole = existingRolesByWorkspaceId.get(
        childWorkspace.parentWorkspaceId,
      );
      if (!parentRole) {
        continue;
      }
      workspaceById.set(childWorkspace.id, childWorkspace);
      roles.push({
        ...parentRole,
        workspaceId: childWorkspace.id,
      });
    }
  }

  const memberRoles = roles.flatMap((r) => {
    const workspace = workspaceById.get(r.workspaceId);
    if (!workspace) {
      return [];
    }

    return {
      workspaceId: r.workspaceId,
      role: r.role,
      workspaceMemberId: member.id,
      workspaceName: workspace.name,
      parentWorkspaceId: workspace.parentWorkspaceId,
    };
  });

  if (member.lastWorkspaceId) {
    const lastWorkspaceRole = roles.find(
      (r) => r.workspaceId === member.lastWorkspaceId,
    );
    const workspace = workspaceById.get(member.lastWorkspaceId);
    if (lastWorkspaceRole && workspace) {
      return { memberRoles, workspace };
    }
  }

  roles = sortBy(roles, (r) => r.createdAt.getTime());
  const role = roles[0];
  if (!role) {
    logger().debug(
      {
        roles,
      },
      "missing role",
    );
    return {
      memberRoles,
      workspace: null,
    };
  }
  const workspace = workspaceById.get(role.workspaceId);

  if (!workspace) {
    logger().debug(
      {
        role,
        workspaces,
      },
      "missing workspace no role found",
    );
    return {
      memberRoles,
      workspace: null,
    };
  }
  return {
    memberRoles,
    workspace,
  };
}

export async function getMultiTenantRequestContext({
  authorizationToken,
  authProvider,
  profile: profileFromContext,
}: {
  authorizationToken: string | null;
  authProvider?: string;
  profile?: OpenIdProfile;
}): Promise<RequestContextResult> {
  if (!authProvider) {
    return err({
      type: RequestContextErrorType.ApplicationError,
      message: "Misconfigured auth provider, missing.",
    });
  }

  let profile: OpenIdProfile;
  if (profileFromContext) {
    profile = profileFromContext;
  } else {
    if (!authorizationToken) {
      return err({
        type: RequestContextErrorType.NotAuthenticated,
        message: "authorizationToken is missing",
      });
    }
    const decodedJwt = decodeJwtHeader(authorizationToken);

    if (!decodedJwt) {
      return err({
        type: RequestContextErrorType.NotAuthenticated,
        message: "Unable to decode jwt",
      });
    }
    profile = decodedJwt;
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { sub, email, picture, name, nickname } = profile;
  const emailVerified = isProfileEmailVerified(profile);

  if (!emailVerified) {
    return err({
      type: RequestContextErrorType.EmailNotVerified,
      email,
    });
  }

  // eslint-disable-next-line prefer-const
  let [existingMember, account] = await Promise.all([
    db().query.workspaceMember.findFirst({
      where: eq(dbWorkspaceMember.email, email),
      with: {
        workspaceMemberRoles: {
          limit: 1,
          with: {
            workspace: true,
          },
        },
      },
    }),
    db().query.workspaceMembeAccount.findFirst({
      where: and(
        eq(dbWorkspaceMembeAccount.provider, authProvider),
        eq(dbWorkspaceMembeAccount.providerAccountId, sub),
      ),
    }),
  ]);

  let member: WorkspaceMember;
  if (
    !existingMember ||
    existingMember.emailVerified !== emailVerified ||
    existingMember.image !== picture
  ) {
    const [updatedMember] = await db()
      .insert(dbWorkspaceMember)
      .values({
        id: existingMember?.id,
        email,
        emailVerified,
        image: picture,
        name,
        nickname,
      })
      .onConflictDoUpdate({
        target: existingMember
          ? [dbWorkspaceMember.id]
          : [dbWorkspaceMember.email],
        set: {
          emailVerified,
          image: picture,
          name,
          nickname,
        },
      })
      .returning();
    if (!updatedMember) {
      logger().error("Failed to update member", {
        email,
        emailVerified,
        picture,
        name,
        nickname,
      });
      return err({
        type: RequestContextErrorType.ApplicationError,
        message: "Failed to update member",
      });
    }
    member = updatedMember;
  } else {
    member = existingMember;
  }

  if (!account) {
    await db()
      .insert(dbWorkspaceMembeAccount)
      .values({
        provider: authProvider,
        providerAccountId: sub,
        workspaceMemberId: member.id,
      })
      .onConflictDoNothing();
  }
  if (!member.email) {
    return err({
      type: RequestContextErrorType.ApplicationError,
      message: "User missing email",
    });
  }

  const { workspace, memberRoles } = await findAndCreateRoles(member);
  if (workspace !== null && workspace.status !== WorkspaceStatusDbEnum.Active) {
    return err({
      type: RequestContextErrorType.WorkspaceInactive,
      message: "Workspace is not active",
      workspace,
    });
  }
  const memberResouce: WorkspaceMemberResource = {
    id: member.id,
    email: member.email,
    emailVerified: member.emailVerified,
    name: member.name ?? undefined,
    nickname: member.nickname ?? undefined,
    picture: member.image ?? undefined,
    createdAt: member.createdAt.toISOString(),
  };

  if (!workspace) {
    return err({
      type: RequestContextErrorType.NotOnboarded,
      message: "User missing role",
      member: memberResouce,
      memberRoles,
    } satisfies NotOnboardedError);
  }

  return ok({
    member: memberResouce,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      type: workspace.type,
      parentWorkspaceId: workspace.parentWorkspaceId ?? undefined,
    },
    memberRoles,
  });
}

async function getAnonymousRequestContext(selectedWorkspaceId?: string): Promise<RequestContextResult> {
  const root = await db().query.workspace.findFirst({
    where: and(
      eq(dbWorkspace.status, "Active"),
      or(eq(dbWorkspace.type, "Root"), eq(dbWorkspace.type, "Parent")),
    ),
    orderBy: [asc(dbWorkspace.createdAt), asc(dbWorkspace.id)],
  });
  const children = root ? await db()
    .select({ workspace: dbWorkspace })
    .from(newsletter)
    .innerJoin(dbWorkspace, eq(newsletter.workspaceId, dbWorkspace.id))
    .where(and(eq(newsletter.publisherId, root.id), eq(dbWorkspace.status, "Active")))
    : [];
  const accessible = root ? [root, ...children.map((row) => row.workspace)] : [];
  const workspace = selectedWorkspaceId
    ? accessible.find((candidate) => candidate.id === selectedWorkspaceId)
    : root;
  if (!workspace) {
    return err({
      type: RequestContextErrorType.ApplicationError,
      message: `Workspace not found`,
    });
  }
  return ok({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      type: workspace.type,
      parentWorkspaceId: workspace.parentWorkspaceId ?? undefined,
    },
    member: {
      id: "anonymous",
      email: "anonymous@email.com",
      emailVerified: true,
      createdAt: new Date().toISOString(),
    },
    memberRoles: accessible.map((candidate) => ({
      workspaceId: candidate.id,
      workspaceName: candidate.name,
      parentWorkspaceId: candidate.parentWorkspaceId,
      workspaceMemberId: "anonymous",
      role: "Admin",
    })),
  });
}

export async function getRequestContext(
  headers: IncomingHttpHeaders,
  profile?: OpenIdProfile,
  googleAccountPrincipal?: GoogleAccountPrincipal,
): Promise<RequestContextResult> {
  return withSpan({ name: "get-request-context" }, async (span) => {
    const { authMode } = config();
    let result: RequestContextResult;
    switch (authMode) {
      case "anonymous": {
        result = await getAnonymousRequestContext(typeof headers[SESSION_WORKSPACE_KEY] === "string" ? headers[SESSION_WORKSPACE_KEY] : undefined);
        break;
      }
      case "single-tenant": {
        if (headers[SESSION_KEY] !== "true") {
          return err({
            type: RequestContextErrorType.NotAuthenticated,
          });
        }
        result = await getAnonymousRequestContext(typeof headers[SESSION_WORKSPACE_KEY] === "string" ? headers[SESSION_WORKSPACE_KEY] : undefined);
        break;
      }
      case "google": {
        if (!googleAccountPrincipal) {
          return err({ type: RequestContextErrorType.NotAuthenticated });
        }
        result = await getGoogleRequestContext(googleAccountPrincipal);
        break;
      }
      case "multi-tenant": {
        const authorizationToken =
          headers.authorization && typeof headers.authorization === "string"
            ? headers.authorization
            : null;

        result = await getMultiTenantRequestContext({
          authorizationToken,
          authProvider: config().authProvider,
          profile,
        });

        result = await requestContextPostProcessor().postProcessor(result);
        break;
      }
    }
    if (result.isOk()) {
      const { id: memberId } = result.value.member;
      const { id: workspaceId } = result.value.workspace;

      const memberRoles = result.value.memberRoles.flatMap((r) =>
        r.workspaceId === workspaceId ? r.role : [],
      );
      span.setAttributes({
        memberId,
        workspaceId,
        memberRoles,
      });
      return result;
    }
    switch (result.error.type) {
      // TODO handle when users can request access to a workspace that they
      // currently are not authorized to access
      case RequestContextErrorType.Unauthorized: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
          memberEmail: result.error.member.email,
          memberId: result.error.member.id,
          workspaceId: result.error.workspace.id,
          workspaceName: result.error.workspace.name,
        });
        break;
      }
      case RequestContextErrorType.NotOnboarded: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
          memberEmail: result.error.member.email,
          memberId: result.error.member.id,
        });
        break;
      }
      case RequestContextErrorType.ApplicationError: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
        });
        break;
      }
      case RequestContextErrorType.EmailNotVerified: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.type,
        });
        span.setAttributes({
          type: result.error.type,
          email: result.error.email,
        });
        break;
      }
      case RequestContextErrorType.NotAuthenticated: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.type,
        });
        span.setAttributes({
          type: result.error.type,
        });
        break;
      }
      case RequestContextErrorType.WorkspaceInactive: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
          workspaceId: result.error.workspace.id,
          workspaceName: result.error.workspace.name,
        });
        break;
      }
      default:
        assertUnreachable(result.error);
    }
    return result;
  });
}
