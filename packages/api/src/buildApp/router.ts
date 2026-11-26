import backendConfig from "backend-lib/src/config";
import logger from "backend-lib/src/logger";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import { FastifyInstance, FastifyRegister } from "fastify";

import analysisController from "../controllers/analysisController";
import accountController from "../controllers/accountController";
import apiKeyController from "../controllers/apiKeyController";
import broadcastsController from "../controllers/broadcastsController";
import componentConfigurationsController from "../controllers/componentConfigurationsController";
import computedPropertiesController from "../controllers/computedPropertiesController";
import contentController from "../controllers/contentController";
import debugController from "../controllers/debugController";
import deliveriesController from "../controllers/deliveriesController";
import eventsController from "../controllers/eventsController";
import groupsController from "../controllers/groupsController";
import indexController from "../controllers/indexController";
import integrationsController from "../controllers/integrationsController";
import journeysController from "../controllers/journeysController";
import openTrackingController from "../controllers/openTrackingController";
import operationsController from "../controllers/operationsController";
import permissionsController from "../controllers/permissionsController";
import publicAppsController from "../controllers/publicAppsController";
import publicationsController from "../controllers/publicationsController";
import resourcesController from "../controllers/resourcesController";
import secretsController from "../controllers/secretsController";
import segmentsController from "../controllers/segmentsController";
import settingsController from "../controllers/settingsController";
import authController from "../controllers/singleTenantController";
import subscriptionGroupsController from "../controllers/subscriptionGroupsController";
import subscriptionManagementController from "../controllers/subscriptionManagementController";
import subscriptionManagementTemplateController from "../controllers/subscriptionManagementTemplateController";
import userPropertiesController from "../controllers/userPropertiesController";
import userPropertyIndexController from "../controllers/userPropertyIndexController";
import usersController from "../controllers/usersController";
import viewInBrowserController from "../controllers/viewInBrowserController";
import webhooksController from "../controllers/webhooksController";
import { BuildAppOpts } from "../types";
import adminAuth from "./adminAuth";
import requestContext from "./requestContext";

// A single registration function keeps browser and bearer product APIs in parity.
async function registerProductControllers(
  f: { register: FastifyRegister<PromiseLike<unknown>> },
  admin = false,
) {
  await Promise.all([
    f.register(analysisController, { prefix: "/analysis" }),
    f.register(contentController, { prefix: "/content" }),
    f.register(eventsController, { prefix: "/events" }),
    f.register(journeysController, { prefix: "/journeys" }),
    f.register(secretsController, { prefix: "/secrets" }),
    f.register(segmentsController, { prefix: "/segments" }),
    f.register(settingsController, { prefix: "/settings" }),
    f.register(integrationsController, { prefix: "/integrations" }),
    backendConfig().authMode === "google"
      ? null
      : f.register(permissionsController, { prefix: "/permissions" }),
    f.register(subscriptionGroupsController, {
      prefix: "/subscription-groups",
    }),
    f.register(subscriptionManagementTemplateController, {
      prefix: "/subscription-management-template",
    }),
    f.register(userPropertiesController, { prefix: "/user-properties" }),
    f.register(userPropertyIndexController, {
      prefix: "/user-property-indices",
    }),
    f.register(broadcastsController, { prefix: "/broadcasts", admin }),
    f.register(deliveriesController, { prefix: "/deliveries" }),
    f.register(apiKeyController, { prefix: "/admin-keys" }),
    f.register(usersController, { prefix: "/users" }),
    f.register(groupsController, { prefix: "/groups" }),
    f.register(resourcesController, { prefix: "/resources" }),
    f.register(computedPropertiesController, {
      prefix: "/computed-properties",
    }),
    f.register(publicationsController, { prefix: "/publications" }),
    f.register(componentConfigurationsController, {
      prefix: "/component-configurations",
    }),
  ]);
}

export default async function router(
  fastify: FastifyInstance,
  opts?: BuildAppOpts,
) {
  await fastify.register(indexController, { prefix: "/api" });
  // Provider signatures authenticate this legacy webhook namespace.
  await fastify.register(webhooksController, { prefix: "/api/webhooks" });

  // endpoints with standard authorization
  await fastify.register(
    async (f: DittofeedFastifyInstance) => {
      if (opts?.registerAuthentication) {
        logger().info("registering authentication");
        await opts.registerAuthentication(f);
      }
      await f.register(requestContext);

      await registerProductControllers(f);
    },
    {
      prefix: "/api",
    },
  );

  // endpoints without standard authorization
  await fastify.register(
    async (f: FastifyInstance) => {
      await Promise.all([
        f.register(subscriptionManagementController, {
          prefix: "/subscription-management",
        }),
        f.register(publicAppsController, { prefix: "/apps" }),
        f.register(webhooksController, { prefix: "/webhooks" }),
        f.register(viewInBrowserController, { prefix: "/view-in-browser" }),
        f.register(openTrackingController),
        ["single-tenant", "anonymous"].includes(backendConfig().authMode)
          ? f.register(authController, { prefix: "/single-tenant" })
          : null,
      ]);
    },
    { prefix: "/api/public" },
  );

  // Machine operations require workspace-bound bearer authentication.
  await fastify.register(
    async (f: FastifyInstance) => {
      await f.register(adminAuth);

      await registerProductControllers(f, true);
      await f.register(publicAppsController, { prefix: "/apps", admin: true });
      await f.register(operationsController);
      await f.register(accountController, { prefix: "/account" });
    },
    { prefix: "/api/admin" },
  );

  await fastify.register(
    async (f: FastifyInstance) =>
      Promise.all([f.register(debugController, { prefix: "/debug" })]),
    { prefix: "/internal-api" },
  );
}
