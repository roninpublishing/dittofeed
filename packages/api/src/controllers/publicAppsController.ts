import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  submitBatchWithTriggers,
  submitGroup,
  submitIdentify,
  submitPage,
  submitScreen,
  submitTrackWithTriggers,
} from "backend-lib/src/apps";
import {
  canWorkspaceReceiveEventsById,
  validateWriteKey,
} from "backend-lib/src/auth";
import logger from "backend-lib/src/logger";
import { FastifyInstance, FastifyRequest } from "fastify";
import {
  BaseMessageResponse,
  BatchAppData,
  EmptyResponse,
  GroupData,
  IdentifyData,
  PageData,
  PublicWriteKey,
  ScreenData,
  TrackData,
} from "isomorphic-lib/src/types";
import { err, ok } from "neverthrow";

import { getWorkspaceId } from "../workspace";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function publicAppsController(
  fastify: FastifyInstance,
  opts: { admin?: boolean },
) {
  // Admin mode is registered only beneath adminAuth. Never reinterpret a bearer
  // key as a public write key or accept a body-selected unauthenticated tenant.
  const authorizedWorkspace = async (request: FastifyRequest) => {
    if (!opts.admin) {
      return validateWriteKey({
        writeKey: request.headers.authorization ?? "",
      });
    }
    const workspace = await getWorkspaceId(request);
    if (workspace.isErr() || !workspace.value) {
      return err("Invalid workspace.");
    }
    if (
      !(await canWorkspaceReceiveEventsById({ workspaceId: workspace.value }))
    ) {
      return err("WorkspaceIneligible");
    }
    return ok(workspace.value);
  };
  const security: Record<string, string[]>[] = opts.admin
    ? [{ bearerAuth: [] }]
    : [{ publicWriteKey: [] }];
  const headers = Type.Object({
    authorization: opts.admin ? Type.String() : PublicWriteKey,
  });
  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/identify",
    {
      schema: {
        security,
        description:
          "The Identify call lets you tie a user to their actions and record traits about them. It includes a unique User ID and any optional traits you know about the user, like their email, name, and more.",
        tags: ["Public Apps"],
        body: IdentifyData,
        headers,
        response: {
          204: EmptyResponse,
          401: BaseMessageResponse,
        },
      },
    },
    async (request, reply) => {
      const workspaceIdFromWriteKey = await authorizedWorkspace(request);

      if (workspaceIdFromWriteKey.isErr()) {
        return reply.status(401).send({
          message: workspaceIdFromWriteKey.error,
        });
      }

      await submitIdentify({
        workspaceId: workspaceIdFromWriteKey.value,
        data: request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/track",
    {
      schema: {
        security,
        description:
          "The Track call is how you record any actions your users perform, along with any properties that describe the action.",
        tags: ["Public Apps"],
        body: TrackData,
        headers,
        response: {
          204: EmptyResponse,
          401: BaseMessageResponse,
        },
      },
    },
    async (request, reply) => {
      const workspaceIdFromWriteKey = await authorizedWorkspace(request);

      if (workspaceIdFromWriteKey.isErr()) {
        return reply.status(401).send({
          message: "Invalid write key.",
        });
      }

      await submitTrackWithTriggers({
        workspaceId: workspaceIdFromWriteKey.value,
        data: request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/page",
    {
      schema: {
        security,
        description:
          "The page call lets you record whenever a user sees a page of your website, along with any optional properties about the page.",
        tags: ["Public Apps"],
        body: PageData,
        headers,
        response: {
          204: EmptyResponse,
          401: BaseMessageResponse,
        },
      },
    },
    async (request, reply) => {
      const workspaceIdFromWriteKey = await authorizedWorkspace(request);

      if (workspaceIdFromWriteKey.isErr()) {
        return reply.status(401).send({
          message: workspaceIdFromWriteKey.error,
        });
      }

      await submitPage({
        workspaceId: workspaceIdFromWriteKey.value,
        data: request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/screen",
    {
      schema: {
        security,
        description:
          "The screen call lets you record whenever a user sees a screen, the mobile equivalent of page, in your mobile app, along with any properties about the screen",
        tags: ["Public Apps"],
        body: ScreenData,
        headers,
        response: {
          204: EmptyResponse,
          401: BaseMessageResponse,
        },
      },
    },
    async (request, reply) => {
      const workspaceIdFromWriteKey = await authorizedWorkspace(request);

      if (workspaceIdFromWriteKey.isErr()) {
        return reply.status(401).send({
          message: workspaceIdFromWriteKey.error,
        });
      }

      await submitScreen({
        workspaceId: workspaceIdFromWriteKey.value,
        data: request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/group",
    {
      schema: {
        security,
        description:
          "The group call lets you assign or unassign a user to a group, along with optionally adding traits to the group.",
        tags: ["Public Apps"],
        body: GroupData,
        headers,
        response: {
          204: EmptyResponse,
          401: BaseMessageResponse,
        },
      },
    },
    async (request, reply) => {
      const workspaceIdFromWriteKey = await authorizedWorkspace(request);

      if (workspaceIdFromWriteKey.isErr()) {
        return reply.status(401).send({
          message: workspaceIdFromWriteKey.error,
        });
      }

      await submitGroup({
        workspaceId: workspaceIdFromWriteKey.value,
        data: request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/batch",
    {
      schema: {
        security,
        description:
          "The batch method lets you send a series of identify, group, track, page and screen requests in a single batch, saving on outbound requests.",
        tags: ["Public Apps"],
        body: BatchAppData,
        headers,
        response: {
          204: EmptyResponse,
          401: BaseMessageResponse,
        },
      },
    },
    async (request, reply) => {
      const workspaceIdFromWriteKey = await authorizedWorkspace(request);

      if (workspaceIdFromWriteKey.isErr()) {
        return reply.status(401).send({
          message: workspaceIdFromWriteKey.error,
        });
      }
      await submitBatchWithTriggers({
        workspaceId: workspaceIdFromWriteKey.value,
        data: request.body,
      });
      return reply.status(204).send();
    },
  );
}
