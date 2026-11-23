CREATE TABLE "TelnyxEmailSend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"credentialWorkspaceId" uuid NOT NULL,
	"messageId" text NOT NULL,
	"userId" text NOT NULL,
	"primaryEmail" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"requestHash" text NOT NULL,
	"providerMessageId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "TelnyxEmailSend_workspaceId_messageId_unique" UNIQUE("workspaceId","messageId"),
	CONSTRAINT "TelnyxEmailSend_credentialWorkspaceId_providerMessageId_unique" UNIQUE("credentialWorkspaceId","providerMessageId")
);

--> statement-breakpoint
CREATE TABLE "TelnyxEmailReceipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credentialWorkspaceId" uuid NOT NULL,
	"eventId" text NOT NULL,
	"eventType" text NOT NULL,
	"providerMessageId" text,
	"rawBody" text NOT NULL,
	"evidenceHeaders" jsonb NOT NULL,
	"receivedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"processedAt" timestamp with time zone,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "TelnyxEmailReceipt_credentialWorkspaceId_eventId_unique" UNIQUE("credentialWorkspaceId","eventId")
);

--> statement-breakpoint
CREATE TABLE "TelnyxEmailDeletedSend" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspaceId" uuid NOT NULL,
	"credentialWorkspaceId" uuid NOT NULL,
	"messageIdHash" text NOT NULL,
	"providerMessageId" text,
	CONSTRAINT "TelnyxEmailDeletedSend_workspaceId_messageIdHash_unique" UNIQUE("workspaceId","messageIdHash")
);

--> statement-breakpoint
ALTER TABLE "TelnyxEmailSend" ADD CONSTRAINT "TelnyxEmailSend_workspaceId_Workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "TelnyxEmailSend" ADD CONSTRAINT "TelnyxEmailSend_credentialWorkspaceId_Workspace_id_fk" FOREIGN KEY ("credentialWorkspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "TelnyxEmailReceipt" ADD CONSTRAINT "TelnyxEmailReceipt_credentialWorkspaceId_Workspace_id_fk" FOREIGN KEY ("credentialWorkspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "TelnyxEmailDeletedSend" ADD CONSTRAINT "TelnyxEmailDeletedSend_workspaceId_Workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "TelnyxEmailDeletedSend" ADD CONSTRAINT "TelnyxEmailDeletedSend_credentialWorkspaceId_Workspace_id_fk" FOREIGN KEY ("credentialWorkspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "TelnyxEmailSend_workspaceId_userId_index" ON "TelnyxEmailSend" USING btree ("workspaceId","userId");
--> statement-breakpoint
CREATE INDEX "TelnyxEmailReceipt_disposition_nextAttemptAt_index" ON "TelnyxEmailReceipt" USING btree ("disposition","nextAttemptAt");
--> statement-breakpoint
CREATE INDEX "TelnyxEmailReceipt_credentialWorkspaceId_providerMessageId_index" ON "TelnyxEmailReceipt" USING btree ("credentialWorkspaceId","providerMessageId");
--> statement-breakpoint
CREATE INDEX "TelnyxEmailReceipt_receivedAt_index" ON "TelnyxEmailReceipt" USING btree ("receivedAt");
--> statement-breakpoint
CREATE INDEX "TelnyxEmailDeletedSend_credentialWorkspaceId_providerMessageId_index" ON "TelnyxEmailDeletedSend" USING btree ("credentialWorkspaceId","providerMessageId");
