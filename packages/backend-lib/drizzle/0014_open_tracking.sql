CREATE TABLE "EmailOpenTrackingSend" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL,
  "messageId" text NOT NULL,
  "tokenHash" text NOT NULL,
  "encryptedToken" jsonb NOT NULL,
  "baseUrl" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "EmailOpenTrackingSend_workspaceId_messageId_unique" UNIQUE("workspaceId", "messageId"),
  CONSTRAINT "EmailOpenTrackingSend_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "EmailOpenTrackingReceipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sendId" uuid NOT NULL,
  "encryptedRequest" jsonb NOT NULL,
  "receivedAt" timestamp with time zone NOT NULL,
  "method" text NOT NULL,
  "disposition" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
  "processedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "EmailOpenTrackingTombstone" (
  "workspaceId" uuid NOT NULL,
  "kind" text NOT NULL,
  "identityHash" text NOT NULL,
  CONSTRAINT "EmailOpenTrackingTombstone_workspaceId_kind_identityHash_unique" UNIQUE("workspaceId", "kind", "identityHash")
);
--> statement-breakpoint
ALTER TABLE "EmailOpenTrackingSend" ADD CONSTRAINT "EmailOpenTrackingSend_workspaceId_Workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "EmailOpenTrackingReceipt" ADD CONSTRAINT "EmailOpenTrackingReceipt_sendId_EmailOpenTrackingSend_id_fk" FOREIGN KEY ("sendId") REFERENCES "public"."EmailOpenTrackingSend"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "EmailOpenTrackingTombstone" ADD CONSTRAINT "EmailOpenTrackingTombstone_workspaceId_Workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "EmailOpenTrackingSend_workspaceId_userId_index" ON "EmailOpenTrackingSend" USING btree ("workspaceId", "userId");
--> statement-breakpoint
CREATE INDEX "EmailOpenTrackingReceipt_sendId_receivedAt_index" ON "EmailOpenTrackingReceipt" USING btree ("sendId", "receivedAt");
--> statement-breakpoint
CREATE INDEX "EmailOpenTrackingReceipt_disposition_nextAttemptAt_index" ON "EmailOpenTrackingReceipt" USING btree ("disposition", "nextAttemptAt");
--> statement-breakpoint
CREATE INDEX "EmailOpenTrackingReceipt_receivedAt_index" ON "EmailOpenTrackingReceipt" USING btree ("receivedAt");
