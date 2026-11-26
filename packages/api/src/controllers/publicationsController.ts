import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  deactivatePublisherSuppression,
  listNewsletterSends,
  listPublisherSuppressions,
  upsertPublisherSuppression,
} from "backend-lib/src/newsletterDelivery";
import {
  configureSendgridAccount,
  createSendgridSenderIdentity,
  getNewsletterSendingOptions,
  getSendingInfrastructure,
  inspectSendgridAccount,
  inspectSendgridConnection,
  reassignSendgridIps,
  reconcileSendgridDomain,
  reconcileSendgridPool,
  reconcileSendgridWebhook,
  upsertNewsletterDefault,
  upsertPoolBinding,
  upsertSendingIp,
  upsertSendingPool,
} from "backend-lib/src/newsletterInfrastructure";
import {
  getPublisherDeliveryHealth,
  getPublisherDeliverySummary,
} from "backend-lib/src/newsletterReporting";
import {
  adoptNewsletter,
  createNewsletter,
  createPublisher,
  getPublisherForWorkspace,
  getPublisherOverview,
  listNewsletters,
  operatePublicationContacts,
  requirePublisherAccess,
  searchPublicationContacts,
  updateNewsletter,
} from "backend-lib/src/newsletters";
import {
  configureNewsletterTrackingDomain,
  getNewsletterTrackingDomains,
  NewsletterTrackingError,
  provisionNewsletterTrackingDomain,
  verifyNewsletterTrackingDomain,
} from "backend-lib/src/newsletterTracking";
import {
  deletePublicationAutomation,
  listPublicationAutomationActions,
  listPublicationAutomationOptions,
  listPublicationAutomations,
  upsertPublicationAutomation,
} from "backend-lib/src/publicationAutomations";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as contracts from "isomorphic-lib/src/publications";

async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return reply.send({ data: await action() });
  } catch (error) {
    if (error instanceof NewsletterTrackingError && error.statusCode === 502) {
      return reply.status(502).send({
        code: "tracking_provider_failed",
        message: "tracking provider failed",
      });
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const code =
        "code" in error &&
        typeof error.code === "string" &&
        /^[a-zA-Z0-9_]+$/.test(error.code)
          ? error.code
          : "publication_operation_rejected";
      return reply
        .status(error.statusCode)
        .send({ code, message: code.replace(/_/g, " ") });
    }
    // Provider errors can contain credentials, recipient data, or raw request bodies.
    return reply.status(500).send({
      code: "publication_operation_failed",
      message: "Publication operation failed",
    });
  }
}

const response = {
  200: contracts.PublicationResponse,
  400: contracts.PublicationErrorResponse,
  403: contracts.PublicationErrorResponse,
  404: contracts.PublicationErrorResponse,
  409: contracts.PublicationErrorResponse,
  422: contracts.PublicationErrorResponse,
  500: contracts.PublicationErrorResponse,
};
const base = { tags: ["Publications"], response };
async function publisher(workspaceId: string) {
  await requirePublisherAccess(workspaceId, workspaceId);
  return workspaceId;
}

async function trackingPublisher(
  request: FastifyRequest,
  workspaceId: string,
  mutation = false,
) {
  const { requestContext }: Partial<Pick<FastifyRequest, "requestContext">> =
    request;
  const context = requestContext.get("workspace");
  if (context && context.id !== workspaceId)
    throw new NewsletterTrackingError(403, "publisher_access_required");
  // Bearer callers pass the shared workspace/scopes preHandler; browser sessions
  // additionally carry member roles from the authenticated request context.
  if (mutation && requestContext.get("member")) {
    const roles = requestContext.get("memberRoles") ?? [];
    if (
      !roles.some(
        (role) =>
          role.workspaceId === workspaceId &&
          ["Admin", "WorkspaceManager"].includes(role.role),
      )
    ) {
      throw new NewsletterTrackingError(403, "publisher_management_required");
    }
  }
  return publisher(workspaceId);
}

/** Registered identically for browser sessions and scoped workspace bearer keys. */
// Fastify requires the async plugin contract even when registration is synchronous.
// eslint-disable-next-line @typescript-eslint/require-await
export default async function publicationsController(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<TypeBoxTypeProvider>();
  f.get(
    "/context",
    {
      schema: {
        ...base,
        description:
          "Resolve the current workspace's publisher without exposing sibling records.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () => ({
        publisherId: await getPublisherForWorkspace(request.query.workspaceId),
        workspaceId: request.query.workspaceId,
      })),
  );
  const trackingBase = {
    ...base,
    response: {
      ...response,
      200: contracts.NewsletterTrackingResponse,
      502: contracts.PublicationErrorResponse,
    },
  };
  f.get(
    "/tracking-domains",
    {
      schema: {
        ...trackingBase,
        description:
          "Read per-newsletter current and historical branded tracking hosts. Never returns provider credentials.",
        querystring: contracts.NewsletterTrackingQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        getNewsletterTrackingDomains(
          await trackingPublisher(request, request.query.workspaceId),
          request.query.newsletterId,
        ),
      ),
  );
  f.put(
    "/tracking-domains",
    {
      schema: {
        ...trackingBase,
        description:
          "Select dt.<newsletter-domain> locally as pending. Does not call Cloudflare or DNS.",
        body: contracts.ConfigureNewsletterTrackingRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return configureNewsletterTrackingDomain({
          ...body,
          publisherId: await trackingPublisher(request, workspaceId, true),
        });
      }),
  );
  f.post(
    "/tracking-domains/provision",
    {
      schema: {
        ...trackingBase,
        description:
          "Explicitly adopt or create an exact Cloudflare for SaaS custom hostname behind the default-closed provisioning gate. TXT validation only; no email.",
        body: contracts.NewsletterTrackingOperationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return provisionNewsletterTrackingDomain({
          ...body,
          publisherId: await trackingPublisher(request, workspaceId, true),
        });
      }),
  );
  f.post(
    "/tracking-domains/verify",
    {
      schema: {
        ...trackingBase,
        description:
          "Read-only Cloudflare and DNS inspection. Requires active hostname, active TLS, and a direct DNS-only CNAME. Proxied or flattened DNS cannot verify as a direct CNAME.",
        body: contracts.NewsletterTrackingOperationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return verifyNewsletterTrackingDomain({
          ...body,
          publisherId: await trackingPublisher(request, workspaceId, true),
        });
      }),
  );
  f.post(
    "/publisher",
    {
      schema: {
        ...base,
        description:
          "Create a separate workspace for a signed-in manager, or explicitly opt an eligible existing workspace into management. Never migrates contacts or calls providers.",
        body: contracts.CreatePublisherRequest,
      },
    },
    async (request, reply) =>
      respond(reply, () =>
        createPublisher({
          ...request.body,
          memberId: request.requestContext.get("member")?.id,
        }),
      ),
  );
  f.get(
    "/",
    {
      schema: {
        ...base,
        description:
          "List independent publications belonging to this publisher.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        listNewsletters(await publisher(request.query.workspaceId)),
      ),
  );
  f.post(
    "/",
    {
      schema: {
        ...base,
        description:
          "Create an independent newsletter child workspace and native subscription group. Does not provision or send externally.",
        body: contracts.CreateNewsletterRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return createNewsletter({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/adopt",
    {
      schema: {
        ...base,
        description:
          "Explicitly adopt an existing workspace as a newsletter. Live-contact migration is a release gate; no contacts are copied or merged.",
        body: Type.Composite([
          contracts.AdoptNewsletterRequest,
          Type.Object({
            subscriptionGroupId: Type.Optional(Type.String({ format: "uuid" })),
          }),
        ]),
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, newsletterId, ...body } = request.body;
        return adoptNewsletter({
          ...body,
          workspaceId: newsletterId,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.patch(
    "/",
    {
      schema: {
        ...base,
        description:
          "Update a newsletter's name or pause/activate it without changing its subscriber identity or sending route.",
        body: Type.Object(
          {
            workspaceId: Type.String({ format: "uuid" }),
            newsletterId: Type.String({ format: "uuid" }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            status: Type.Optional(
              Type.Union([
                Type.Literal("draft"),
                Type.Literal("active"),
                Type.Literal("paused"),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return updateNewsletter({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/overview",
    {
      schema: {
        ...base,
        description:
          "Combined publication reporting. Subscription records and matched mailboxes are not unique-person counts.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        getPublisherOverview(await publisher(request.query.workspaceId)),
      ),
  );
  f.post(
    "/contacts/search",
    {
      schema: {
        ...base,
        description:
          "Search independent newsletter contacts with publication/contact composite identities; never merge profiles.",
        body: contracts.PublicationSearchRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return searchPublicationContacts({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/contacts/operations",
    {
      schema: {
        ...base,
        description:
          "Perform an explicit subscription operation across selected publication contacts. Does not synchronize profiles or clear publisher suppression.",
        body: contracts.PublicationContactOperationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return operatePublicationContacts({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/sending-options",
    {
      schema: {
        ...base,
        querystring: contracts.SendingOptionsQuery,
        description:
          "Read redacted send-time ESP choices and optional defaults for the authorized newsletter.",
      },
    },
    async (request, reply) =>
      respond(reply, () =>
        getNewsletterSendingOptions(request.query.workspaceId),
      ),
  );
  f.get(
    "/infrastructure",
    {
      schema: {
        ...base,
        description:
          "Read independent ESP accounts, their resources and optional newsletter defaults. Never returns stored keys.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        getSendingInfrastructure(await publisher(request.query.workspaceId)),
      ),
  );
  f.put(
    "/infrastructure/accounts",
    {
      schema: {
        ...base,
        description:
          "Register or edit one independent ESP account locally. Keys are write-only; no subuser or provider resource is provisioned.",
        body: contracts.ConfigureSendgridAccountRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return configureSendgridAccount({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/accounts/inspect",
    {
      schema: {
        ...base,
        description:
          "Read-only account-scoped provider inspection; persist verified sender, credential and signed-webhook readiness.",
        body: contracts.InspectSendgridAccountRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return inspectSendgridAccount({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/connections/inspect",
    {
      schema: {
        ...base,
        description:
          "Read-only inspection and reconciliation of a connection's existing subuser, keys, domains, webhooks, and pool assignments.",
        body: contracts.ConnectionOperationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return inspectSendgridConnection({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/domains",
    {
      schema: {
        ...base,
        description:
          "Reconcile authenticated domain and DNS status; create missing authentication only behind the provider-write gate.",
        body: contracts.SendgridDomainRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return reconcileSendgridDomain({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/senders",
    {
      schema: {
        ...base,
        description:
          "Reconcile a verified sender identity. Sending a verification email requires this explicit action and the provider-write gate.",
        body: contracts.SendgridSenderRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return createSendgridSenderIdentity({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/webhooks",
    {
      schema: {
        ...base,
        description:
          "Reconcile the connection-specific signed webhook and verification keys, retaining keys needed for in-flight sends.",
        body: contracts.ConnectionOperationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return reconcileSendgridWebhook({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.put(
    "/infrastructure/ips",
    {
      schema: {
        ...base,
        description:
          "Register an existing physical IP and configure the shared admission/warm-up budget. Does not purchase or assign provider IPs.",
        body: contracts.SendingIpRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return upsertSendingIp({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.put(
    "/infrastructure/pools",
    {
      schema: {
        ...base,
        description:
          "Manage a logical pool of registered physical IPs independently of newsletter identity.",
        body: contracts.SendingPoolRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return upsertSendingPool({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.put(
    "/infrastructure/pool-bindings",
    {
      schema: {
        ...base,
        description:
          "Register an account-specific SendGrid pool binding; validate its concrete IP membership before use.",
        body: contracts.PoolBindingRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return upsertPoolBinding({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/pool-bindings/reconcile",
    {
      schema: {
        ...base,
        description:
          "Reconcile the provider pool behind its release gate without silently changing newsletter identity.",
        body: contracts.PoolBindingRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return reconcileSendgridPool({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.put(
    "/infrastructure/defaults",
    {
      schema: {
        ...base,
        description:
          "Save or clear an optional newsletter send prefill. Explicit per-send choices override it; existing attempts are immutable.",
        body: contracts.NewsletterDefaultRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return upsertNewsletterDefault({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/infrastructure/ip-reassignment",
    {
      schema: {
        ...base,
        description:
          "Explicitly reassign provider IPs. Requires provider-write and IP-reassignment release gates plus confirm=true; never purchases capacity.",
        body: contracts.ReassignSendgridIpsRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return reassignSendgridIps({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/suppressions",
    {
      schema: {
        ...base,
        description:
          "Read a bounded page of publisher suppression controls without exposing a master subscriber profile.",
        querystring: contracts.PublisherSuppressionQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...options } = request.query;
        return listPublisherSuppressions(await publisher(workspaceId), options);
      }),
  );
  f.post(
    "/suppressions/search",
    {
      schema: {
        ...base,
        description:
          "Find publisher blocks for a mailbox without placing its email in a URL. Does not modify suppression.",
        body: contracts.PublisherSuppressionSearchRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...options } = request.body;
        return listPublisherSuppressions(await publisher(workspaceId), options);
      }),
  );
  f.put(
    "/suppressions",
    {
      schema: {
        ...base,
        description:
          "Block a mailbox publisher-wide with an audited reason. Newsletter unsubscribe remains independent.",
        body: contracts.PublisherSuppressionRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return upsertPublisherSuppression({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.post(
    "/suppressions/deactivate",
    {
      schema: {
        ...base,
        description:
          "Explicitly deactivate a publisher suppression. Newsletter resubscription never performs this operation implicitly.",
        body: contracts.DeactivatePublisherSuppressionRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return deactivatePublisherSuppression({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/automations",
    {
      schema: {
        ...base,
        description:
          "List explicit cross-publication rules, not implicit profile synchronization.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        listPublicationAutomations(await publisher(request.query.workspaceId)),
      ),
  );
  f.get(
    "/automations/options",
    {
      schema: {
        ...base,
        description:
          "Read eligible native welcome journeys for owned newsletter automation actions.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        listPublicationAutomationOptions(
          await publisher(request.query.workspaceId),
        ),
      ),
  );
  f.put(
    "/automations",
    {
      schema: {
        ...base,
        description:
          "Configure source events/link/conditions, field mappings, destination subscriber creation, consent-aware subscription, and welcome-journey entry. Once-per-subscriber is the default.",
        body: contracts.PublicationAutomationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return upsertPublicationAutomation({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.delete(
    "/automations",
    {
      schema: {
        ...base,
        description:
          "Retire a cross-publication rule while retaining its action history.",
        body: contracts.DeletePublicationAutomationRequest,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ...body } = request.body;
        return deletePublicationAutomation({
          ...body,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/automations/actions",
    {
      schema: {
        ...base,
        description:
          "Read auditable source/result actions and deduplication outcomes for publication automations.",
        querystring: contracts.PublicationHistoryQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const {
          workspaceId,
          newsletterId: _newsletterId,
          ...query
        } = request.query;
        return listPublicationAutomationActions({
          ...query,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/sends",
    {
      schema: {
        ...base,
        description:
          "Inspect queued/accepted/unknown/rejected sends with their pinned newsletter and route. Unknown acceptance requires reconciliation, never blind resend.",
        querystring: contracts.PublicationHistoryQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const { workspaceId, ruleId: _ruleId, ...query } = request.query;
        return listNewsletterSends({
          ...query,
          publisherId: await publisher(workspaceId),
        });
      }),
  );
  f.get(
    "/delivery-summary",
    {
      schema: {
        ...base,
        description:
          "Read lightweight workspace delivery totals without infrastructure or cohort details.",
        querystring: contracts.PublisherQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        getPublisherDeliverySummary(request.query.workspaceId),
      ),
  );
  f.get(
    "/delivery-health",
    {
      schema: {
        ...base,
        description:
          "Inspect scoped historical delivery observations and conservative shared-IP admission budgets.",
        querystring: contracts.DeliveryHealthQuery,
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        getPublisherDeliveryHealth(
          await publisher(request.query.workspaceId),
          request.query.accountId,
        ),
      ),
  );
}
