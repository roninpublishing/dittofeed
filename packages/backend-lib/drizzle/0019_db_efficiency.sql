-- Storage efficiency for the newsletter send path.
-- * One shared content snapshot per template version instead of a body per send.
-- * The connection's API key is no longer copied onto every send row; the pinned
--   connection revision already guarantees the connection holds the same key.
-- * Queue indexes cover only pending rows so they stay small as history grows.
CREATE TABLE "NewsletterContentSnapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"templateId" uuid,
	"contentHash" text NOT NULL,
	"content" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "NewsletterContentSnapshot_workspaceId_contentHash_unique" UNIQUE("workspaceId","contentHash")
);
--> statement-breakpoint
ALTER TABLE "NewsletterContentSnapshot" ADD CONSTRAINT "NewsletterContentSnapshot_workspaceId_Newsletter_workspaceId_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterContentSnapshot" ADD CONSTRAINT "NewsletterContentSnapshot_templateId_MessageTemplate_id_fk" FOREIGN KEY ("templateId") REFERENCES "public"."MessageTemplate"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD COLUMN "contentSnapshotId" uuid;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_contentSnapshotId_NewsletterContentSnapshot_id_fk" FOREIGN KEY ("contentSnapshotId") REFERENCES "public"."NewsletterContentSnapshot"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" DROP COLUMN "encryptedCredential";
--> statement-breakpoint
CREATE INDEX "NewsletterSend_contentSnapshotId_index" ON "NewsletterSend" USING btree ("contentSnapshotId");
--> statement-breakpoint
CREATE INDEX "NewsletterSend_accepted_unprojected_idx" ON "NewsletterSend" USING btree ("id") WHERE "NewsletterSend"."state" = 'accepted' and "NewsletterSend"."acceptedEventAt" is null;
--> statement-breakpoint
DROP INDEX "NewsletterWebhookReceipt_nextAttemptAt_index";
--> statement-breakpoint
CREATE INDEX "NewsletterWebhookReceipt_pending_idx" ON "NewsletterWebhookReceipt" USING btree ("nextAttemptAt") WHERE "NewsletterWebhookReceipt"."processedAt" is null;
--> statement-breakpoint
CREATE INDEX "NewsletterWebhookReceipt_processedAt_index" ON "NewsletterWebhookReceipt" USING btree ("processedAt");
--> statement-breakpoint
DROP INDEX "PublicationAutomationEvent_nextAttemptAt_index";
--> statement-breakpoint
CREATE INDEX "PublicationAutomationEvent_pending_idx" ON "PublicationAutomationEvent" USING btree ("nextAttemptAt") WHERE "PublicationAutomationEvent"."processedAt" is null;
--> statement-breakpoint
CREATE INDEX "PublicationAutomationEvent_processedAt_index" ON "PublicationAutomationEvent" USING btree ("processedAt");
