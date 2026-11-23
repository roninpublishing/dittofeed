CREATE TABLE "GoogleAccount" (
  "memberId" uuid PRIMARY KEY NOT NULL REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE,
  "googleSubject" text NOT NULL,
  "normalizedEmail" text NOT NULL,
  "isInstanceAdmin" boolean DEFAULT false NOT NULL,
  "disabledAt" timestamp(3) with time zone,
  "createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "GoogleAccount_googleSubject_key" ON "GoogleAccount" ("googleSubject");
--> statement-breakpoint
CREATE UNIQUE INDEX "GoogleAccount_normalizedEmail_key" ON "GoogleAccount" ("normalizedEmail");
--> statement-breakpoint
CREATE TABLE "AccountSession" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memberId" uuid NOT NULL REFERENCES "GoogleAccount"("memberId") ON DELETE CASCADE,
  "tokenHash" text NOT NULL,
  "userAgent" text,
  "createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "expiresAt" timestamp(3) with time zone NOT NULL,
  "revokedAt" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "AccountSession_tokenHash_key" ON "AccountSession" ("tokenHash");
--> statement-breakpoint
CREATE INDEX "AccountSession_memberId_idx" ON "AccountSession" ("memberId");
--> statement-breakpoint
CREATE TABLE "WorkspaceInvitation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspaceId" uuid NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "normalizedEmail" text NOT NULL,
  "role" "DBRoleType" NOT NULL,
  "tokenHash" text NOT NULL,
  "createdByMemberId" uuid NOT NULL REFERENCES "GoogleAccount"("memberId"),
  "acceptedByMemberId" uuid REFERENCES "GoogleAccount"("memberId"),
  "createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "expiresAt" timestamp(3) with time zone NOT NULL,
  "acceptedAt" timestamp(3) with time zone,
  "revokedAt" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation" ("tokenHash");
--> statement-breakpoint
CREATE INDEX "WorkspaceInvitation_workspaceId_idx" ON "WorkspaceInvitation" ("workspaceId");
--> statement-breakpoint
CREATE TABLE "GoogleOAuthFlow" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stateHash" text NOT NULL,
  "invitationId" uuid REFERENCES "WorkspaceInvitation"("id") ON DELETE CASCADE,
  "createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "expiresAt" timestamp(3) with time zone NOT NULL,
  "consumedAt" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "GoogleOAuthFlow_stateHash_key" ON "GoogleOAuthFlow" ("stateHash");
--> statement-breakpoint
CREATE TABLE "AccountRateLimit" (
  "key" text PRIMARY KEY NOT NULL,
  "attempts" integer NOT NULL,
  "expiresAt" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "AccountRateLimit_expiresAt_idx" ON "AccountRateLimit" ("expiresAt");
