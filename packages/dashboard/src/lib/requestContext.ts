import { DittofeedSdk } from "@dittofeed/sdk-node";
import {
  requiredGoogleApiRole,
  requiredGoogleDashboardRole,
  requireGoogleOrigin,
} from "backend-lib/src/accountAuthorization";
import { AccountError, requireWorkspaceRole } from "backend-lib/src/accounts";
import backendConfigFromLib from "backend-lib/src/config";
import { getFeatures } from "backend-lib/src/features";
import { resolveGoogleRequestPrincipal } from "backend-lib/src/googleSessions";
import backendLogger from "backend-lib/src/logger";
import { getRequestContext as getRequestContextFromLib } from "backend-lib/src/requestContext";
import {
  DFRequestContext,
  OpenIdProfile,
  RequestContextErrorType as BackendRequestContextErrorType,
} from "backend-lib/src/types";
import {
  SINGLE_TENANT_LOGIN_PAGE,
  UNAUTHORIZED_PAGE,
} from "isomorphic-lib/src/constants";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import { err, ok, Result } from "neverthrow";
import { GetServerSideProps, NextApiRequest } from "next";

import { GetDFServerSideProps, PropsWithInitialState } from "./types";

const backendConfig = backendConfigFromLib;
const logger = backendLogger;
const getRequestContext = getRequestContextFromLib;

export const requestContext: <T>(
  gssp: GetDFServerSideProps<PropsWithInitialState<T>>,
) => GetServerSideProps<PropsWithInitialState<T>> =
  (gssp) => async (context) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const { profile } = context.req as { profile?: OpenIdProfile };
    const googleAccountPrincipal = await resolveGoogleRequestPrincipal(
      context.req,
    );
    const rc = await getRequestContext(
      context.req.headers,
      profile,
      googleAccountPrincipal,
    );
    const onboardingUrl =
      backendConfig().authMode === "google"
        ? "/dashboard/auth/no-access"
        : backendConfig().onboardingUrl;
    if (rc.isErr()) {
      const { error } = rc;
      switch (error.type) {
        case BackendRequestContextErrorType.EmailNotVerified:
          logger().info(
            {
              onboardingUrl,
              email: error.email,
            },
            "email not verified",
          );
          return {
            redirect: {
              destination: onboardingUrl,
              basePath: false,
              permanent: false,
            },
          };
        case BackendRequestContextErrorType.NotOnboarded:
          logger().info(
            {
              contextErrorMsg: error.message,
            },
            "user not onboarded",
          );
          return {
            redirect: {
              destination: onboardingUrl,
              permanent: false,
              basePath: false,
            },
          };
        case BackendRequestContextErrorType.Unauthorized: {
          logger().info(
            {
              contextErrorMsg: error.message,
            },
            "user unauthorized",
          );

          return {
            redirect: {
              destination: error.action.url,
              permanent: false,
              basePath: false,
            },
          };
        }
        case BackendRequestContextErrorType.ApplicationError:
          throw new Error(error.message);
        case BackendRequestContextErrorType.NotAuthenticated:
          if (backendConfig().authMode === "google") {
            return {
              redirect: { destination: "/auth/google", permanent: false },
            };
          }
          if (backendConfig().authMode === "single-tenant") {
            return {
              redirect: {
                destination: SINGLE_TENANT_LOGIN_PAGE,
                permanent: false,
              },
            };
          }
          return {
            redirect: {
              destination: UNAUTHORIZED_PAGE,
              permanent: false,
            },
          };
        case BackendRequestContextErrorType.WorkspaceInactive:
          logger().info(
            {
              contextErrorMsg: error.message,
              workspace: error.workspace,
            },
            "workspace inactive",
          );
          return {
            redirect: { destination: UNAUTHORIZED_PAGE, permanent: false },
          };
        default:
          assertUnreachable(error);
      }
    }

    const { dashboardWriteKey, trackDashboard } = backendConfig();

    if (dashboardWriteKey && trackDashboard) {
      await DittofeedSdk.init({
        writeKey: dashboardWriteKey,
        host: backendConfig().apiBase,
      });
    }

    const dfContext = rc.value;
    if (backendConfig().authMode === "google") {
      if (!googleAccountPrincipal) {
        return {
          redirect: { destination: "/auth/google", permanent: false },
        };
      }
      try {
        await requireWorkspaceRole(
          googleAccountPrincipal,
          dfContext.workspace.id,
          requiredGoogleDashboardRole(context.resolvedUrl),
        );
      } catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return {
          redirect: { destination: UNAUTHORIZED_PAGE, permanent: false },
        };
      }
    }
    const features = await getFeatures({
      workspaceId: dfContext.workspace.id,
    });

    DittofeedSdk.identify({
      userId: dfContext.member.id,
      traits: {
        workspaceId: dfContext.workspace.id,
        email: dfContext.member.email,
        firstName: dfContext.member.name,
        nickname: dfContext.member.nickname,
        createdAt: dfContext.member.createdAt,
        emailVerified: dfContext.member.emailVerified,
      },
    });

    return gssp(context, { ...dfContext, features });
  };

export interface ApiRequestContextError {
  message: string;
  status: number;
}

export async function apiAuth(
  req: NextApiRequest,
): Promise<Result<DFRequestContext, ApiRequestContextError>> {
  const googleAccountPrincipal = await resolveGoogleRequestPrincipal(req);
  const rc = await getRequestContext(
    req.headers,
    undefined,
    googleAccountPrincipal,
  );

  if (rc.isOk()) {
    if (backendConfig().authMode === "google") {
      if (!googleAccountPrincipal) {
        return err({ message: "Authentication required.", status: 401 });
      }
      try {
        requireGoogleOrigin(req.headers.origin, req.method ?? "GET");
        await requireWorkspaceRole(
          googleAccountPrincipal,
          rc.value.workspace.id,
          requiredGoogleApiRole(req.method ?? "GET", req.url ?? ""),
        );
      } catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return err({ message: error.code, status: error.statusCode });
      }
    }
    return ok(rc.value);
  }

  const { error } = rc;
  logger().info({ backendError: error }, "API Auth Error from backend-lib");

  switch (error.type) {
    case BackendRequestContextErrorType.NotAuthenticated:
      return err({
        message: "Authentication required.",
        status: 401,
      });
    case BackendRequestContextErrorType.Unauthorized:
      return err({
        message: error.message || "Unauthorized",
        status: 401,
      });
    case BackendRequestContextErrorType.EmailNotVerified:
      return err({
        message: `Email not verified: ${error.email}`,
        status: 403,
      });
    case BackendRequestContextErrorType.NotOnboarded:
      return err({
        message: error.message || "User not onboarded.",
        status: 403,
      });
    case BackendRequestContextErrorType.WorkspaceInactive:
      return err({
        message: error.message || "Workspace is inactive.",
        status: 403,
      });
    case BackendRequestContextErrorType.ApplicationError:
      return err({
        message: error.message || "Internal Server Error.",
        status: 500,
      });
    default:
      assertUnreachable(error);
      return err({
        message: "An unexpected authentication error occurred.",
        status: 500,
      });
  }
}
