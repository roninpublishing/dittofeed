CREATE TABLE "Publisher" (
	"workspaceId" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "Newsletter" (
	"workspaceId" uuid PRIMARY KEY NOT NULL,
	"publisherId" uuid NOT NULL,
	"slug" text NOT NULL,
	"subscriptionGroupId" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Newsletter_publisherId_slug_unique" UNIQUE("publisherId","slug"),
	CONSTRAINT "Newsletter_publisherId_workspaceId_unique" UNIQUE("publisherId","workspaceId")
);

--> statement-breakpoint
CREATE TABLE "PublisherSendgridAccount" (
	"publisherId" uuid PRIMARY KEY NOT NULL,
	"encryptedManagementKey" jsonb,
	"region" text DEFAULT 'global' NOT NULL,
	"callbackBaseUrl" text,
	"allowProviderWrites" boolean DEFAULT false NOT NULL,
	"allowIpReassignment" boolean DEFAULT false NOT NULL,
	"allowRealSends" boolean DEFAULT false NOT NULL,
	"allTrafficControlled" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "SendingConnection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisherId" uuid NOT NULL,
	"newsletterId" uuid NOT NULL,
	"username" text NOT NULL,
	"administrativeEmail" text NOT NULL,
	"encryptedApiKey" jsonb,
	"apiKeyId" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"senderDomains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"senderEmails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"webhookKeys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provisioning" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "SendingConnection_newsletterId_unique" UNIQUE("newsletterId")
);

--> statement-breakpoint
CREATE TABLE "SendingIp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisherId" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"hourlyLimit" integer NOT NULL,
	"dailyLimit" integer NOT NULL,
	"warmupStartedAt" timestamp with time zone,
	"warmupSchedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "SendingIp_publisherId_address_unique" UNIQUE("publisherId","address")
);

--> statement-breakpoint
CREATE TABLE "SendingPool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisherId" uuid NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "SendingPool_publisherId_name_unique" UNIQUE("publisherId","name")
);

--> statement-breakpoint
CREATE TABLE "SendingPoolIp" (
	"poolId" uuid NOT NULL,
	"ipId" uuid NOT NULL,
	CONSTRAINT "SendingPoolIp_poolId_ipId_pk" PRIMARY KEY("poolId","ipId")
);

--> statement-breakpoint
CREATE TABLE "SendingPoolBinding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"poolId" uuid NOT NULL,
	"providerPoolName" text NOT NULL,
	CONSTRAINT "SendingPoolBinding_connectionId_poolId_unique" UNIQUE("connectionId","poolId")
);

--> statement-breakpoint
CREATE TABLE "NewsletterRoute" (
	"newsletterId" uuid PRIMARY KEY NOT NULL,
	"connectionId" uuid NOT NULL,
	"poolId" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "PublisherSuppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisherId" uuid NOT NULL,
	"mailboxHash" text NOT NULL,
	"encryptedMailbox" jsonb NOT NULL,
	"reason" text NOT NULL,
	"sourceNewsletterId" uuid,
	"sourceEventId" text,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "PublisherSuppression_publisherId_mailboxHash_reason_unique" UNIQUE("publisherId","mailboxHash","reason")
);

--> statement-breakpoint
CREATE TABLE "NewsletterSend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisherId" uuid NOT NULL,
	"workspaceId" uuid NOT NULL,
	"connectionId" uuid NOT NULL,
	"connectionRevision" integer NOT NULL,
	"ipId" uuid NOT NULL,
	"poolId" uuid NOT NULL,
	"routeVersion" integer NOT NULL,
	"logicalMessageId" text NOT NULL,
	"broadcastId" uuid,
	"journeyId" uuid,
	"userId" text NOT NULL,
	"mailboxHash" text NOT NULL,
	"encryptedRecipient" jsonb,
	"encryptedPayload" jsonb,
	"encryptedCredential" jsonb,
	"payloadHash" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"providerMessageId" text,
	"providerSmtpId" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"recipientCount" integer DEFAULT 1 NOT NULL,
	"reservedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"erasedAt" timestamp with time zone,
	"acceptedEventAt" timestamp with time zone,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "NewsletterSend_workspaceId_logicalMessageId_unique" UNIQUE("workspaceId","logicalMessageId")
);

--> statement-breakpoint
CREATE TABLE "SendingIpBudget" (
	"ipId" uuid NOT NULL,
	"windowStart" timestamp with time zone NOT NULL,
	"windowSeconds" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "SendingIpBudget_ipId_windowStart_windowSeconds_pk" PRIMARY KEY("ipId","windowStart","windowSeconds")
);

--> statement-breakpoint
CREATE TABLE "NewsletterWebhookReceipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"sendId" uuid,
	"eventId" text NOT NULL,
	"mailboxHash" text,
	"encryptedPayload" jsonb,
	"receivedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"processedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "NewsletterWebhookReceipt_connectionId_eventId_unique" UNIQUE("connectionId","eventId")
);

--> statement-breakpoint
CREATE TABLE "PublicationAutomation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisherId" uuid NOT NULL,
	"name" text NOT NULL,
	"sourceNewsletterId" uuid NOT NULL,
	"destinationNewsletterId" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"definition" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone
);

--> statement-breakpoint
CREATE TABLE "PublicationAutomationEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceNewsletterId" uuid NOT NULL,
	"eventId" text NOT NULL,
	"sourceUserId" text,
	"encryptedEvent" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"processedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "PublicationAutomationEvent_sourceNewsletterId_eventId_unique" UNIQUE("sourceNewsletterId","eventId")
);

--> statement-breakpoint
CREATE TABLE "PublicationAutomationAction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ruleId" uuid NOT NULL,
	"sourceEventId" text NOT NULL,
	"sourceUserId" text NOT NULL,
	"destinationUserId" text,
	"dedupeKey" text NOT NULL,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "PublicationAutomationAction_ruleId_dedupeKey_unique" UNIQUE("ruleId","dedupeKey")
);

--> statement-breakpoint
CREATE TABLE "NewsletterErasure" (
	"workspaceId" uuid NOT NULL,
	"userHash" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "NewsletterErasure_workspaceId_userHash_pk" PRIMARY KEY("workspaceId","userHash")
);

--> statement-breakpoint
CREATE TABLE "PublicationAutomationIdentity" (
	"newsletterId" uuid NOT NULL,
	"mailboxHash" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "PublicationAutomationIdentity_newsletterId_mailboxHash_pk" PRIMARY KEY("newsletterId","mailboxHash")
);

--> statement-breakpoint
ALTER TABLE "Publisher" ADD CONSTRAINT "Publisher_workspaceId_Workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "Newsletter" ADD CONSTRAINT "Newsletter_workspaceId_Workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "Newsletter" ADD CONSTRAINT "Newsletter_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "Newsletter" ADD CONSTRAINT "Newsletter_subscriptionGroupId_SubscriptionGroup_id_fk" FOREIGN KEY ("subscriptionGroupId") REFERENCES "public"."SubscriptionGroup"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublisherSendgridAccount" ADD CONSTRAINT "PublisherSendgridAccount_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingConnection" ADD CONSTRAINT "SendingConnection_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingConnection" ADD CONSTRAINT "SendingConnection_newsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("newsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingIp" ADD CONSTRAINT "SendingIp_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingPool" ADD CONSTRAINT "SendingPool_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingPoolIp" ADD CONSTRAINT "SendingPoolIp_poolId_SendingPool_id_fk" FOREIGN KEY ("poolId") REFERENCES "public"."SendingPool"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingPoolIp" ADD CONSTRAINT "SendingPoolIp_ipId_SendingIp_id_fk" FOREIGN KEY ("ipId") REFERENCES "public"."SendingIp"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingPoolBinding" ADD CONSTRAINT "SendingPoolBinding_connectionId_SendingConnection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."SendingConnection"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingPoolBinding" ADD CONSTRAINT "SendingPoolBinding_poolId_SendingPool_id_fk" FOREIGN KEY ("poolId") REFERENCES "public"."SendingPool"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterRoute" ADD CONSTRAINT "NewsletterRoute_newsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("newsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterRoute" ADD CONSTRAINT "NewsletterRoute_connectionId_SendingConnection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."SendingConnection"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterRoute" ADD CONSTRAINT "NewsletterRoute_poolId_SendingPool_id_fk" FOREIGN KEY ("poolId") REFERENCES "public"."SendingPool"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublisherSuppression" ADD CONSTRAINT "PublisherSuppression_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublisherSuppression" ADD CONSTRAINT "PublisherSuppression_sourceNewsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("sourceNewsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_workspaceId_Newsletter_workspaceId_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_connectionId_SendingConnection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."SendingConnection"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_ipId_SendingIp_id_fk" FOREIGN KEY ("ipId") REFERENCES "public"."SendingIp"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_poolId_SendingPool_id_fk" FOREIGN KEY ("poolId") REFERENCES "public"."SendingPool"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_broadcastId_Broadcast_id_fk" FOREIGN KEY ("broadcastId") REFERENCES "public"."Broadcast"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_journeyId_Journey_id_fk" FOREIGN KEY ("journeyId") REFERENCES "public"."Journey"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "SendingIpBudget" ADD CONSTRAINT "SendingIpBudget_ipId_SendingIp_id_fk" FOREIGN KEY ("ipId") REFERENCES "public"."SendingIp"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterWebhookReceipt" ADD CONSTRAINT "NewsletterWebhookReceipt_connectionId_SendingConnection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."SendingConnection"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterWebhookReceipt" ADD CONSTRAINT "NewsletterWebhookReceipt_sendId_NewsletterSend_id_fk" FOREIGN KEY ("sendId") REFERENCES "public"."NewsletterSend"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublicationAutomation" ADD CONSTRAINT "PublicationAutomation_publisherId_Publisher_workspaceId_fk" FOREIGN KEY ("publisherId") REFERENCES "public"."Publisher"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublicationAutomation" ADD CONSTRAINT "PublicationAutomation_sourceNewsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("sourceNewsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublicationAutomation" ADD CONSTRAINT "PublicationAutomation_destinationNewsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("destinationNewsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublicationAutomationEvent" ADD CONSTRAINT "PublicationAutomationEvent_sourceNewsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("sourceNewsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublicationAutomationAction" ADD CONSTRAINT "PublicationAutomationAction_ruleId_PublicationAutomation_id_fk" FOREIGN KEY ("ruleId") REFERENCES "public"."PublicationAutomation"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterErasure" ADD CONSTRAINT "NewsletterErasure_workspaceId_Newsletter_workspaceId_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "PublicationAutomationIdentity" ADD CONSTRAINT "PublicationAutomationIdentity_newsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("newsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "NewsletterSend_state_nextAttemptAt_index" ON "NewsletterSend" USING btree ("state","nextAttemptAt");
--> statement-breakpoint
CREATE INDEX "NewsletterSend_workspaceId_userId_index" ON "NewsletterSend" USING btree ("workspaceId","userId");
--> statement-breakpoint
CREATE INDEX "NewsletterSend_connectionId_providerMessageId_index" ON "NewsletterSend" USING btree ("connectionId","providerMessageId");
--> statement-breakpoint
CREATE INDEX "NewsletterSend_connectionId_providerSmtpId_index" ON "NewsletterSend" USING btree ("connectionId","providerSmtpId");
--> statement-breakpoint
CREATE INDEX "NewsletterSend_workspaceId_broadcastId_state_index" ON "NewsletterSend" USING btree ("workspaceId","broadcastId","state");
--> statement-breakpoint
CREATE INDEX "NewsletterSend_workspaceId_journeyId_state_index" ON "NewsletterSend" USING btree ("workspaceId","journeyId","state");
--> statement-breakpoint
CREATE INDEX "NewsletterWebhookReceipt_nextAttemptAt_index" ON "NewsletterWebhookReceipt" USING btree ("nextAttemptAt");
--> statement-breakpoint
CREATE INDEX "NewsletterWebhookReceipt_connectionId_mailboxHash_index" ON "NewsletterWebhookReceipt" USING btree ("connectionId","mailboxHash");
--> statement-breakpoint
CREATE INDEX "PublicationAutomationEvent_nextAttemptAt_index" ON "PublicationAutomationEvent" USING btree ("nextAttemptAt");
--> statement-breakpoint
CREATE INDEX "PublicationAutomationEvent_sourceNewsletterId_sourceUserId_index" ON "PublicationAutomationEvent" USING btree ("sourceNewsletterId","sourceUserId");
--> statement-breakpoint
CREATE TABLE "NewsletterSuppression" (
	"newsletterId" uuid NOT NULL,
	"identityHash" text NOT NULL,
	"kind" text DEFAULT 'mailbox' NOT NULL,
	"sourceEventId" text NOT NULL,
	"occurredAt" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "NewsletterSuppression_newsletterId_kind_identityHash_pk" PRIMARY KEY("newsletterId","kind","identityHash"),
	CONSTRAINT "NewsletterSuppression_newsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("newsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action
);
