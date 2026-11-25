import { Static, Type } from "@sinclair/typebox";

const Id = Type.String({ format: "uuid" });
const Mailbox = Type.String({ format: "email", maxLength: 320 });
const FieldSource = Type.Union([Type.Literal("traits"), Type.Literal("event")]);
const FieldPath = Type.String({ minLength: 1, maxLength: 512 });

/** Deliberate cross-publication coordination, never implicit profile synchronization. */
export const PublicationAutomationDefinition = Type.Object({
  source: Type.Object({
    eventType: Type.Union(["identify", "track", "page", "screen", "group"].map((value) => Type.Literal(value))),
    event: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    link: Type.Optional(Type.Object({ path: FieldPath, equals: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false })),
    conditions: Type.Optional(Type.Array(Type.Object({
      source: FieldSource,
      path: FieldPath,
      operator: Type.Union([Type.Literal("equals"), Type.Literal("exists")]),
      value: Type.Optional(Type.Unknown()),
    }, { additionalProperties: false }), { maxItems: 32 })),
  }, { additionalProperties: false }),
  destination: Type.Object({
    match: Type.Object({ field: Type.Literal("email"), source: FieldSource, path: FieldPath }, { additionalProperties: false }),
    createIfMissing: Type.Boolean(),
    fieldMappings: Type.Optional(Type.Array(Type.Object({
      source: FieldSource,
      path: FieldPath,
      destination: FieldPath,
      overwrite: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), { maxItems: 64 })),
    subscribe: Type.Boolean(),
    welcomeJourneyId: Type.Optional(Id),
  }, { additionalProperties: false }),
  oncePerSubscriber: Type.Optional(Type.Boolean({ default: true })),
  consent: Type.Optional(Type.Object({
    type: Type.Literal("explicit"),
    source: Type.Literal("event"),
    path: FieldPath,
    equals: Type.Literal(true),
    authorization: Type.String({ minLength: 1, maxLength: 2048 }),
    allowResubscribe: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type PublicationAutomationDefinition = Static<typeof PublicationAutomationDefinition>;

export const PublisherQuery = Type.Object({ workspaceId: Id }, { additionalProperties: false });
export const PublicationResponse = Type.Object({ data: Type.Unknown() });
export const PublicationErrorResponse = Type.Object({ code: Type.Optional(Type.String()), message: Type.String() });
export const CreatePublisherRequest = Type.Object({ workspaceId: Id, name: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false });
export const CreateNewsletterRequest = Type.Object({ workspaceId: Id, name: Type.String({ minLength: 1, maxLength: 256 }), slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 48 }) }, { additionalProperties: false });
export const AdoptNewsletterRequest = Type.Object({ workspaceId: Id, newsletterId: Id, slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 48 }) }, { additionalProperties: false });
export const PublicationSearchRequest = Type.Object({
  workspaceId: Id,
  newsletterIds: Type.Optional(Type.Array(Id, { maxItems: 100, uniqueItems: true })),
  searchTerm: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
}, { additionalProperties: false });
export const PublicationContactOperationRequest = Type.Object({
  workspaceId: Id,
  newsletterIds: Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true }),
  userIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 1000 })),
  contacts: Type.Optional(Type.Array(Type.Object({ newsletterId: Id, userId: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 1000 })),
  operation: Type.Union([Type.Literal("subscribe"), Type.Literal("unsubscribe")]),
  consent: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false });
// Runtime Value.Check and HTTP AJV must validate this nested send snapshot alike.
const SelectionId = Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
export const EspSelection = Type.Union([
  // Declare every mode's keys so AJV's removeAdditional cannot delete valid IDs
  // while considering another union branch; wrong-mode keys remain forbidden.
  Type.Object({ accountId: SelectionId, mode: Type.Literal("automatic"), poolId: Type.Optional(Type.Never()), ipId: Type.Optional(Type.Never()) }, { additionalProperties: false }),
  Type.Object({ accountId: SelectionId, mode: Type.Literal("pool"), poolId: SelectionId, ipId: Type.Optional(Type.Never()) }, { additionalProperties: false }),
  Type.Object({ accountId: SelectionId, mode: Type.Literal("ip"), ipId: SelectionId, poolId: Type.Optional(Type.Never()) }, { additionalProperties: false }),
]);
export type EspSelection = Static<typeof EspSelection>;
export const ConfigureSendgridAccountRequest = Type.Object({
  workspaceId: Id, id: Type.Optional(Id), name: Type.String({ minLength: 1, maxLength: 256 }), provider: Type.Literal("SendGrid"),
  managementApiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512, writeOnly: true })),
  apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512, writeOnly: true })),
  username: Type.Optional(Type.String({ maxLength: 64, pattern: "^[a-zA-Z0-9_-]*$" })),
  region: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("eu")])),
  callbackBaseUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  senderDomains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 100 })),
  senderEmails: Type.Optional(Type.Array(Mailbox, { maxItems: 100 })),
}, { additionalProperties: false });
export const ConnectionOperationRequest = Type.Object({ workspaceId: Id, connectionId: Id }, { additionalProperties: false });
export const InspectSendgridAccountRequest = Type.Object({ workspaceId: Id, accountId: Id }, { additionalProperties: false });
export const NewsletterDefaultRequest = Type.Object({ workspaceId: Id, newsletterId: Id, selection: Type.Union([EspSelection, Type.Null()]) }, { additionalProperties: false });
export const SendingOptionsQuery = PublisherQuery;
export const DeliveryHealthQuery = Type.Object({ workspaceId: Id, accountId: Type.Optional(Id) }, { additionalProperties: false });
export const SendgridDomainRequest = Type.Object({
  workspaceId: Id, connectionId: Id, domain: Type.String({ minLength: 1, maxLength: 253 }),
  subdomain: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })), validate: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const SendgridSenderRequest = Type.Object({
  workspaceId: Id, connectionId: Id, nickname: Type.String({ minLength: 1, maxLength: 256 }), fromEmail: Mailbox, replyTo: Mailbox,
  fromName: Type.Optional(Type.String({ maxLength: 256 })), address: Type.Optional(Type.String({ maxLength: 256 })),
  city: Type.Optional(Type.String({ maxLength: 128 })), state: Type.Optional(Type.String({ maxLength: 128 })),
  zip: Type.Optional(Type.String({ maxLength: 32 })), country: Type.Optional(Type.String({ maxLength: 128 })),
  sendVerificationEmail: Type.Literal(true),
}, { additionalProperties: false });
export const SendingIpRequest = Type.Object({
  workspaceId: Id, id: Type.Optional(Id), accountId: Type.Optional(Id), address: Type.String({ minLength: 3, maxLength: 45 }),
  status: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
  hourlyLimit: Type.Integer({ minimum: 1, maximum: 100000000 }), dailyLimit: Type.Integer({ minimum: 1, maximum: 1000000000 }),
  warmupStartedAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
  warmupSchedule: Type.Optional(Type.Array(Type.Object({ afterDays: Type.Integer({ minimum: 0 }), hourlyLimit: Type.Integer({ minimum: 1 }), dailyLimit: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 366 })),
}, { additionalProperties: false });
export const SendingPoolRequest = Type.Object({ workspaceId: Id, id: Type.Optional(Id), accountId: Type.Optional(Id), name: Type.String({ minLength: 1, maxLength: 64 }), providerPoolName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), ipIds: Type.Array(Id, { maxItems: 100, uniqueItems: true }) }, { additionalProperties: false });
export const PoolBindingRequest = Type.Object({ workspaceId: Id, connectionId: Id, poolId: Id, providerPoolName: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
export const ReassignSendgridIpsRequest = Type.Object({ workspaceId: Id, connectionId: Id, ipIds: Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true }), confirm: Type.Literal(true) }, { additionalProperties: false });
export const PublisherSuppressionRequest = Type.Object({
  workspaceId: Id, email: Mailbox,
  reason: Type.Union([Type.Literal("complaint"), Type.Literal("publisher_optout"), Type.Literal("manual"), Type.Literal("invalid_mailbox")]),
  sourceNewsletterId: Type.Optional(Id), sourceEventId: Type.Optional(Type.String({ maxLength: 512 })),
}, { additionalProperties: false });
export const DeactivatePublisherSuppressionRequest = Type.Object({ workspaceId: Id, suppressionId: Id }, { additionalProperties: false });
export const PublicationAutomationRequest = Type.Object({
  workspaceId: Id, id: Type.Optional(Id), name: Type.String({ minLength: 1, maxLength: 256 }),
  sourceNewsletterId: Id, destinationNewsletterId: Id, enabled: Type.Boolean(), definition: PublicationAutomationDefinition,
}, { additionalProperties: false });
export const DeletePublicationAutomationRequest = Type.Object({ workspaceId: Id, id: Id }, { additionalProperties: false });
export const PublicationHistoryQuery = Type.Object({ workspaceId: Id, newsletterId: Type.Optional(Id), accountId: Type.Optional(Id), ruleId: Type.Optional(Id), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })) }, { additionalProperties: false });

export const NewsletterTrackingQuery = Type.Object({
  workspaceId: Id, newsletterId: Type.Optional(Id),
}, { additionalProperties: false });
export const NewsletterTrackingOperationRequest = Type.Object({
  workspaceId: Id, newsletterId: Id,
}, { additionalProperties: false });
export const ConfigureNewsletterTrackingRequest = Type.Object({
  workspaceId: Id, newsletterId: Id, domain: Type.String({ minLength: 1, maxLength: 253 }),
}, { additionalProperties: false });
export const NewsletterTrackingDnsRecord = Type.Object({
  type: Type.Union([Type.Literal("CNAME"), Type.Literal("TXT")]),
  name: Type.String({ maxLength: 253 }), value: Type.String({ maxLength: 2048 }),
}, { additionalProperties: false });
export const NewsletterTrackingDomain = Type.Object({
  id: Id, newsletterId: Id, domain: Type.String(), hostname: Type.String(),
  isCurrent: Type.Boolean(), status: Type.Union([Type.Literal("pending"), Type.Literal("active")]),
  cloudflareStatus: Type.Union([Type.String(), Type.Null()]),
  sslStatus: Type.Union([Type.String(), Type.Null()]), cnameVerified: Type.Boolean(),
  dnsRecords: Type.Array(NewsletterTrackingDnsRecord, { maxItems: 20 }),
  lastCheckedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  verifiedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }), updatedAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });
export const NewsletterTrackingResponse = Type.Object({
  data: Type.Object({
    domains: Type.Array(NewsletterTrackingDomain),
    cnameTarget: Type.Union([Type.String(), Type.Null()]),
    provisioningEnabled: Type.Boolean(), configured: Type.Boolean(),
  }, { additionalProperties: false }),
});
export type NewsletterTrackingDomain = Static<typeof NewsletterTrackingDomain>;
export type NewsletterTrackingResponse = Static<typeof NewsletterTrackingResponse>;

export const PublisherSuppressionQuery = Type.Object({
  workspaceId: Id,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000, default: 0 })),
}, { additionalProperties: false });
export const PublisherSuppressionSearchRequest = Type.Object({
  workspaceId: Id,
  email: Mailbox,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000, default: 0 })),
}, { additionalProperties: false });
