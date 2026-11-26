import {
  requiredGoogleApiRole,
  requireGoogleOrigin,
} from "backend-lib/src/accountAuthorization";
import { AccountError, requireWorkspaceRole } from "backend-lib/src/accounts";
import backendConfig from "backend-lib/src/config";
import logger from "backend-lib/src/logger";
import {
  getRequestContext,
  SESSION_KEY,
  SESSION_WORKSPACE_KEY,
} from "backend-lib/src/requestContext";
import {
  DBWorkspaceOccupantType,
  EmbeddedSession,
  OpenIdProfile,
  RequestContextErrorType,
} from "backend-lib/src/types";
import { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { getWorkspaceIdFromReq } from "../workspace";

export function requestToSessionValue(request: FastifyRequest):
  | {
      [SESSION_KEY]: "true" | "false";
      [SESSION_WORKSPACE_KEY]: string;
    }
  | undefined {
  if (!["single-tenant", "anonymous"].includes(backendConfig().authMode)) {
    return undefined;
  }

  const hasSession = request.session.get(SESSION_KEY) === true;
  const selectedWorkspace: unknown = request.session.get(SESSION_WORKSPACE_KEY);
  return {
    [SESSION_KEY]: hasSession ? "true" : "false",
    [SESSION_WORKSPACE_KEY]:
      typeof selectedWorkspace === "string" ? selectedWorkspace : "",
  };
}

export function getRequestContextFastify(request: FastifyRequest) {
  const headers = {
    ...request.headers,
    ...requestToSessionValue(request),
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const { user: profile } = request as { user?: OpenIdProfile };
  return getRequestContext(headers, profile, request.googleAccountPrincipal);
}

// eslint-disable-next-line @typescript-eslint/require-await
const requestContext = fp(async (fastify: FastifyInstance) => {
  fastify.addHook("preHandler", async (request, reply) => {
    if (
      backendConfig().authMode === "google" &&
      request.googleAccountPrincipal
    ) {
      try {
        requireGoogleOrigin(request.headers.origin, request.method);
      } catch {
        return reply
          .status(403)
          .send({ code: "forbidden", message: "Forbidden" });
      }
    }
    const rc = await getRequestContextFastify(request);

    if (rc.isErr()) {
      switch (rc.error.type) {
        case RequestContextErrorType.ApplicationError:
          throw new Error(rc.error.message);
        case RequestContextErrorType.NotAuthenticated:
          logger().debug({ rc: rc.error }, "Not authenticated");
          return reply.status(401).send();
        case RequestContextErrorType.Unauthorized:
          return reply.redirect(rc.error.action.url);
        case RequestContextErrorType.WorkspaceInactive:
          logger().info(
            {
              contextErrorMsg: rc.error.message,
              workspace: rc.error.workspace,
            },
            "workspace inactive",
          );
          return reply.status(403).send();
        case RequestContextErrorType.NotOnboarded:
        case RequestContextErrorType.EmailNotVerified:
          return reply
            .status(403)
            .send({ code: "no_access", message: "No workspace access" });
        default:
          logger().error(
            {
              err: rc.error,
            },
            "unknown request context error",
          );
          return reply.status(403).send();
      }
    }

    const requestWorkspaceIdResult = getWorkspaceIdFromReq(request);
    if (requestWorkspaceIdResult.isErr()) {
      return reply.status(400).send();
    }

    const { workspace, member, memberRoles } = rc.value;
    const workspaceId = requestWorkspaceIdResult.value ?? workspace.id;
    if (workspaceId !== workspace.id) {
      logger().error(
        {
          workspaceId,
          workspaceIdFromRequest: workspace.id,
        },
        "workspace id does not match",
      );
      return reply.status(403).send();
    }
    if (backendConfig().authMode === "google") {
      if (!request.googleAccountPrincipal) {
        return reply.status(401).send({
          code: "not_authenticated",
          message: "Authentication required",
        });
      }
      try {
        await requireWorkspaceRole(
          request.googleAccountPrincipal,
          workspace.id,
          requiredGoogleApiRole(request.method, request.routeOptions.url),
        );
      } catch (error) {
        if (error instanceof AccountError) {
          return reply
            .status(error.statusCode)
            .send({ code: error.code, message: "Workspace access denied" });
        }
        logger().error(
          { requestId: request.id },
          "Google workspace authorization failed",
        );
        return reply.status(500).send({
          code: "authorization_failed",
          message: "Authorization failed",
        });
      }
    }

    request.requestContext.set("workspace", workspace);
    request.requestContext.set("member", member);
    request.requestContext.set("memberRoles", memberRoles);
    return null;
  });
});

export default requestContext;

export function getOccupantFromRequest(request: FastifyRequest): {
  workspaceOccupantId: string;
  workspaceOccupantType: DBWorkspaceOccupantType;
} | null {
  const delegated = request.apiKeyAccountPrincipal;
  if (delegated) {
    return {
      workspaceOccupantId: delegated.ownerMemberId,
      workspaceOccupantType: "WorkspaceMember",
    };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const { embeddedSession } = request.raw as {
    embeddedSession?: EmbeddedSession;
  };
  if (backendConfig().authMode === "anonymous") {
    return {
      workspaceOccupantId: "anonymous",
      workspaceOccupantType: "WorkspaceMember",
    };
  }

  if (embeddedSession?.occupantId) {
    return {
      workspaceOccupantId: embeddedSession.occupantId,
      workspaceOccupantType: "ChildWorkspaceOccupant",
    };
  }

  const member = request.requestContext.get("member");
  if (member) {
    return {
      workspaceOccupantId: member.id,
      workspaceOccupantType: "WorkspaceMember",
    };
  }
  return null;
}
