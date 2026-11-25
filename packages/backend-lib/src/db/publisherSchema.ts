import { sql } from "drizzle-orm";
import { AnyPgColumn, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import type { EspSelection } from "isomorphic-lib/src/publications";
import { broadcast, journey, subscriptionGroup, workspace } from "./schema";

export type NewsletterCiphertext = { iv: string; encryptedData: string; authTag: string };
const createdAt = () => timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull();
const updatedAt = () => createdAt().$onUpdate(() => new Date());
const encrypted = () => jsonb().$type<NewsletterCiphertext>();

export const publisher = pgTable("Publisher", {
  workspaceId: uuid().primaryKey().references(() => workspace.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const newsletter = pgTable("Newsletter", {
  workspaceId: uuid().primaryKey().references(() => workspace.id, { onDelete: "cascade" }),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  slug: text().notNull(),
  subscriptionGroupId: uuid().references(() => subscriptionGroup.id, { onDelete: "restrict" }),
  status: text().$type<"draft" | "active" | "paused">().default("draft").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.publisherId, t.slug), unique().on(t.publisherId, t.workspaceId)]);

export type TrackingDnsRecord = { type: "CNAME" | "TXT"; name: string; value: string };
export const newsletterTrackingDomain = pgTable("NewsletterTrackingDomain", {
  id: uuid().primaryKey().defaultRandom(),
  newsletterId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  domain: text().notNull(),
  hostname: text().notNull().unique(),
  isCurrent: boolean().default(true).notNull(),
  revision: integer().default(1).notNull(),
  status: text().$type<"pending" | "active">().default("pending").notNull(),
  cloudflareStatus: text(),
  sslStatus: text(),
  customHostnameId: text(),
  dnsRecords: jsonb().$type<TrackingDnsRecord[]>().default([]).notNull(),
  cnameVerified: boolean().default(false).notNull(),
  lastCheckedAt: timestamp({ withTimezone: true, mode: "date" }),
  verifiedAt: timestamp({ withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("NewsletterTrackingDomain_current_unique").on(t.newsletterId).where(sql`${t.isCurrent}`),
  check("NewsletterTrackingDomain_status_check", sql`${t.status} in ('pending', 'active')`),
  check("NewsletterTrackingDomain_active_check", sql`${t.status} <> 'active' or coalesce((${t.cnameVerified} and ${t.cloudflareStatus} = 'active' and ${t.sslStatus} = 'active' and ${t.verifiedAt} is not null), false)`),
]);

export const publisherSendgridAccount = pgTable("PublisherSendgridAccount", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  name: text().notNull(),
  provider: text().$type<"SendGrid">().default("SendGrid").notNull(),
  revision: integer().default(1).notNull(),
  createdAt: createdAt(),
  encryptedManagementKey: encrypted(),
  region: text().$type<"global" | "eu">().default("global").notNull(),
  callbackBaseUrl: text(),
  allowProviderWrites: boolean().default(false).notNull(),
  allowIpReassignment: boolean().default(false).notNull(),
  allowRealSends: boolean().default(false).notNull(),
  allTrafficControlled: boolean().default(false).notNull(),
  updatedAt: updatedAt(),
});

export const sendingConnection = pgTable("SendingConnection", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  accountId: uuid().notNull().unique().references(() => publisherSendgridAccount.id, { onDelete: "restrict" }),
  // Historical attribution only; deleting a newsletter never deletes credentials.
  newsletterId: uuid().references(() => newsletter.workspaceId, { onDelete: "set null" }),
  username: text().notNull(),
  administrativeEmail: text().notNull(),
  encryptedApiKey: encrypted(),
  apiKeyId: text(),
  revision: integer().default(1).notNull(),
  senderDomains: jsonb().$type<string[]>().default([]).notNull(),
  senderEmails: jsonb().$type<string[]>().default([]).notNull(),
  webhookKeys: jsonb().$type<{ key: string; validUntil?: string }[]>().default([]).notNull(),
  status: text().$type<"draft" | "provisioning" | "ready" | "error">().default("draft").notNull(),
  provisioning: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sendingIp = pgTable("SendingIp", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  accountId: uuid().notNull().references(() => publisherSendgridAccount.id, { onDelete: "restrict" }),
  // All account-local rows for one physical address share this budget identity.
  canonicalIpId: uuid().notNull().references((): AnyPgColumn => sendingIp.id, { onDelete: "restrict" }),
  address: text().notNull(),
  status: text().$type<"active" | "paused">().default("paused").notNull(),
  providerVerifiedAt: timestamp({ withTimezone: true, mode: "date" }),
  verifiedAccountRevision: integer(),
  hourlyLimit: integer().notNull(),
  dailyLimit: integer().notNull(),
  warmupStartedAt: timestamp({ withTimezone: true, mode: "date" }),
  warmupSchedule: jsonb().$type<{ afterDays: number; hourlyLimit: number; dailyLimit: number }[]>().default([]).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.accountId, t.address), index().on(t.canonicalIpId)]);

export const sendingPool = pgTable("SendingPool", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  accountId: uuid().notNull().references(() => publisherSendgridAccount.id, { onDelete: "restrict" }),
  name: text().notNull(),
  providerPoolName: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.accountId, t.name)]);

export const sendingPoolIp = pgTable("SendingPoolIp", {
  poolId: uuid().notNull().references(() => sendingPool.id, { onDelete: "cascade" }),
  ipId: uuid().notNull().references(() => sendingIp.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.poolId, t.ipId] })]);

export const sendingPoolBinding = pgTable("SendingPoolBinding", {
  id: uuid().primaryKey().defaultRandom(),
  connectionId: uuid().notNull().references(() => sendingConnection.id, { onDelete: "cascade" }),
  poolId: uuid().notNull().references(() => sendingPool.id, { onDelete: "cascade" }),
  providerPoolName: text().notNull(),
}, (t) => [unique().on(t.connectionId, t.poolId)]);

export const newsletterDefault = pgTable("NewsletterDefault", {
  newsletterId: uuid().primaryKey().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  selection: jsonb().$type<EspSelection | null>(),
  updatedAt: updatedAt(),
});

export const publisherSuppression = pgTable("PublisherSuppression", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  mailboxHash: text().notNull(),
  encryptedMailbox: encrypted().notNull(),
  reason: text().$type<"complaint" | "publisher_optout" | "manual" | "invalid_mailbox">().notNull(),
  sourceNewsletterId: uuid().references(() => newsletter.workspaceId, { onDelete: "set null" }),
  sourceEventId: text(),
  active: boolean().default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.publisherId, t.mailboxHash, t.reason)]);

export const newsletterSend = pgTable("NewsletterSend", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  accountId: uuid().notNull().references(() => publisherSendgridAccount.id, { onDelete: "restrict" }),
  accountRevision: integer().notNull(),
  selection: jsonb().$type<EspSelection>().notNull(),
  candidateIpIds: jsonb().$type<string[]>().notNull(),
  actualIp: text(),
  workspaceId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  connectionId: uuid().notNull().references(() => sendingConnection.id, { onDelete: "restrict" }),
  connectionRevision: integer().notNull(),
  ipId: uuid().references(() => sendingIp.id, { onDelete: "restrict" }),
  poolId: uuid().references(() => sendingPool.id, { onDelete: "restrict" }),
  routeVersion: integer(),
  logicalMessageId: text().notNull(),
  broadcastId: uuid().references(() => broadcast.id, { onDelete: "set null" }),
  journeyId: uuid().references(() => journey.id, { onDelete: "set null" }),
  userId: text().notNull(),
  mailboxHash: text().notNull(),
  senderDomain: text(),
  encryptedRecipient: encrypted(),
  encryptedPayload: encrypted(),
  encryptedCredential: encrypted(),
  openTrackingTokenHash: text(),
  encryptedOpenTrackingToken: encrypted(),
  openTrackingOrigin: text(),
  payloadHash: text().notNull(),
  state: text().$type<"queued" | "submitting" | "accepted" | "unknown" | "rejected" | "suppressed">().default("queued").notNull(),
  providerMessageId: text(),
  providerSmtpId: text(),
  error: text(),
  attempts: integer().default(0).notNull(),
  recipientCount: integer().default(1).notNull(),
  reservedAt: timestamp({ withTimezone: true, mode: "date" }),
  expiresAt: timestamp({ withTimezone: true, mode: "date" }).default(sql`now() + interval '24 hours'`).notNull(),
  erasedAt: timestamp({ withTimezone: true, mode: "date" }),
  acceptedEventAt: timestamp({ withTimezone: true, mode: "date" }),
  nextAttemptAt: createdAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.workspaceId, t.logicalMessageId), uniqueIndex("NewsletterSend_openTrackingTokenHash_unique").on(t.openTrackingTokenHash).where(sql`${t.openTrackingTokenHash} is not null`), index().on(t.state, t.nextAttemptAt), index().on(t.workspaceId, t.userId), index().on(t.connectionId, t.providerMessageId), index().on(t.connectionId, t.providerSmtpId), index().on(t.workspaceId, t.broadcastId, t.state), index().on(t.workspaceId, t.journeyId, t.state), index("NewsletterSend_publisher_period_sender_idx").on(t.publisherId, t.createdAt, t.accountId, t.senderDomain)]);

export const sendingIpBudget = pgTable("SendingIpBudget", {
  ipId: uuid().notNull().references(() => sendingIp.id, { onDelete: "cascade" }),
  windowStart: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  windowSeconds: integer().notNull(),
  reserved: integer().default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.ipId, t.windowStart, t.windowSeconds] })]);

export const newsletterWebhookReceipt = pgTable("NewsletterWebhookReceipt", {
  id: uuid().primaryKey().defaultRandom(),
  connectionId: uuid().notNull().references(() => sendingConnection.id, { onDelete: "cascade" }),
  sendId: uuid().references(() => newsletterSend.id, { onDelete: "set null" }),
  eventId: text().notNull(),
  mailboxHash: text(),
  encryptedPayload: encrypted(),
  receivedAt: createdAt(),
  processedAt: timestamp({ withTimezone: true, mode: "date" }),
  attempts: integer().default(0).notNull(),
  nextAttemptAt: createdAt(),
}, (t) => [unique().on(t.connectionId, t.eventId), index().on(t.nextAttemptAt), index().on(t.connectionId, t.mailboxHash)]);

export const publicationAutomation = pgTable("PublicationAutomation", {
  id: uuid().primaryKey().defaultRandom(),
  publisherId: uuid().notNull().references(() => publisher.workspaceId, { onDelete: "cascade" }),
  name: text().notNull(),
  sourceNewsletterId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  destinationNewsletterId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  enabled: boolean().default(false).notNull(),
  definition: jsonb().$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp({ withTimezone: true, mode: "date" }),
});

export const publicationAutomationEvent = pgTable("PublicationAutomationEvent", {
  id: uuid().primaryKey().defaultRandom(),
  sourceNewsletterId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  eventId: text().notNull(),
  sourceUserId: text(),
  encryptedEvent: encrypted().notNull(),
  createdAt: createdAt(),
  processedAt: timestamp({ withTimezone: true, mode: "date" }),
  attempts: integer().default(0).notNull(),
  nextAttemptAt: createdAt(),
}, (t) => [unique().on(t.sourceNewsletterId, t.eventId), index().on(t.nextAttemptAt), index().on(t.sourceNewsletterId, t.sourceUserId)]);

export const publicationAutomationAction = pgTable("PublicationAutomationAction", {
  id: uuid().primaryKey().defaultRandom(),
  ruleId: uuid().notNull().references(() => publicationAutomation.id, { onDelete: "cascade" }),
  sourceEventId: text().notNull(),
  sourceUserId: text().notNull(),
  destinationUserId: text(),
  dedupeKey: text().notNull(),
  disposition: text().$type<"pending" | "completed" | "blocked" | "error">().default("pending").notNull(),
  state: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
  error: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.ruleId, t.dedupeKey)]);

export const newsletterErasure = pgTable("NewsletterErasure", {
  workspaceId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  userHash: text().notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userHash] }), index("NewsletterErasure_userHash_idx").on(t.userHash)]);

export const publicationAutomationIdentity = pgTable("PublicationAutomationIdentity", {
  newsletterId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  mailboxHash: text().notNull(),
  userId: text().notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.newsletterId, t.mailboxHash] })]);

export const newsletterSuppression = pgTable("NewsletterSuppression", {
  newsletterId: uuid().notNull().references(() => newsletter.workspaceId, { onDelete: "cascade" }),
  identityHash: text().notNull(),
  kind: text().$type<"mailbox" | "contact">().default("mailbox").notNull(),
  sourceEventId: text().notNull(),
  occurredAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  active: boolean().default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.newsletterId, t.kind, t.identityHash] })]);
