# Google SSO and owned accounts handoff

## Earlier session work already completed

- Hidden Push Notifications and HubSpot UI entry points while preserving their backend implementations.
- Removed active SMS delivery and Segment.io integration end to end; retained historical migrations, contact/event data, native ingestion, and audience segmentation.
- Removed Postmark and Mailchimp integrations and obsolete product documentation/assets.
- Organized the Ronin logo assets and applied a light Ronin theme, left-navigation branding, the exact DITTO Email Client name, and the new favicon/metadata.
- Removed GitHub, upstream support/documentation/contact links, and the old Dittofeed footer branding from the product navigation.
- Added a real Home dashboard with saved-resource counts, recent journeys, and shortcuts. Renamed the existing local workspace RONIN without replacing its data.
- Committed the earlier UI/removal/warning fixes on local main. Those commits are part of the isolated PR's history relative to GitHub main.

The full-platform integration checkpoints the Telnyx, tracking, publisher/newsletter, admin/MCP, and account implementations together. The earlier account-only PR remains useful history, but its intentionally omitted platform code must not replace the newer integrated implementation.

## Completed implementation

- Google OIDC authorization-code sign-in with PKCE, state, nonce, Google signature/issuer/audience/expiry verification, and verified-email checks. No Google passwords or reusable Google access/refresh tokens are stored.
- Application-owned accounts linked by immutable Google subject; explicit workspace memberships and server-enforced Viewer, Author, Workspace Manager, and Admin roles.
- Controlled first-owner bootstrap into an existing workspace. No unrestricted signup, domain-wide administrator admission, parent-workspace inheritance, shared-password fallback, or decoded-bearer fallback in Google mode.
- Expiring, single-use, revocable invitations bound to an email, workspace, and role. Administrators hand off private fragment links; automatic invitation email delivery is not claimed.
- Opaque hashed database sessions, encrypted HttpOnly cookies, logout, session listing/revocation, account disable/enable, and last-administrator race protection.
- Ronin-branded sign-in/invitation/no-access screens, profile and session settings, team administration, confirmations, and authorized workspace switching.
- Google-only cookie verification works in Lite and standalone Next. Cookies require HTTPS outside loopback, reject the public development signing key, and use every byte of the configured random secret.
- Sensitive OAuth URLs are suppressed from ordinary access logs/traces; configured secrets are redacted from flat and nested application logs.
- Additive account migration, schema/snapshot metadata, operator/recovery documentation, and focused security regressions. No contact/event data or historical migration is deleted.

## Verification already observed

The implementation in the shared local checkout passed 106 distinct focused cases across six suites, TypeScript package builds, and scoped zero-warning lint. Protocol tests use local signing keys and certificate transport doubles but execute the real Google SDK verification and database/session logic. They are not a real Google login.

A real isolated Google-mode API/Next runtime rendered the sign-in and invitation screens, redirected unauthenticated Home to sign-in, rejected protected template reads with 401, and returned a safe `not_configured` 503 when Google credentials were absent. Desktop and 390-pixel layouts were checked. Deployment-target tests cover the repository's ES5 Error-subclass behavior. Temporary verification services and scripts were removed; the normal localhost:3000 shared-login instance was left running.

The isolated pull-request branch also passed all 106 tests across six suites, the email editor/shared/backend/API/dashboard/Lite builds, scoped zero-warning lint, and its own browser/HTTP smoke checks. Viewer access to secret-bearing template rendering is explicitly rejected. Other agents' uncommitted provider, tracking, and MCP/admin implementation is excluded from the account-only commit.

## Local activation and remaining release work

### 1. Google Cloud configuration — local credentials supplied

The local preview now uses the dedicated **DITTO Email Client** Google project `caramel-vim-515718-j5`, owned by the `roninpublishing.com` organization. Its Web application client is named `DITTO Email Client — Local development`; credentials are stored only in ignored owner-only `.env`. The consent screen uses `support@roninpublishing.com`, with only `openid`, email and profile scopes; no sensitive, restricted or Gmail scopes are configured. Pepper's existing OAuth app was not renamed, rotated or deleted.

Authorized local redirect URI:

```text
http://localhost:3000/api/public/auth/google/callback
```

Set these in ignored local `.env` / production secret storage, never in chat or Git:

```dotenv
GOOGLE_CLIENT_ID=your-web-client.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

The initial owner is already provisioned in the existing local RONIN workspace, and the one-time local bootstrap settings have been removed. A new deployment needs `GOOGLE_BOOTSTRAP_ADMIN_EMAIL`, `GOOGLE_BOOTSTRAP_WORKSPACE_ID`, and its own random `SECRET_KEY` until its initial owner is provisioned. Gmail or a matching verified Workspace hosted domain is authoritative; a non-Google-hosted consumer email additionally needs an independently verified `GOOGLE_BOOTSTRAP_ADMIN_SUBJECT` pin.

### 2. Complete migration history — integrated and locally verified

The full-platform checkpoint includes the complete ordered migration history `0000`–`0017`, including Telnyx, click/open evidence, Google accounts, publishers/newsletters, and newsletter tracking domains. Account migration `0015_google_accounts` retains its original predecessor chain. No applied migration was renumbered, historical migration removed, or contact/event data deleted.

Disposable PostgreSQL verification applied all 18 migrations and proved an idempotent reapply. The integration preserves the newer platform implementation while reconciling the account-only branch. Production rollout still requires database backup, deployment inventory, migration application, and acceptance checks below; local success is not a production cutover audit.

### 3. Live cutover and real-browser acceptance

The existing local database already contained the complete migration history through `0017_newsletter_tracking_domains`, including all five account tables. The bootstrap workspace resolved to the existing RONIN workspace; no migration, workspace replacement, or contact/event data change was required for this cutover.

Local Lite now runs on `http://localhost:3000` with `AUTH_MODE=google`. The live status endpoint returned `enabled: true`, `configured: true`, and the exact callback URI above with `Cache-Control: no-store`; unauthenticated account access returned 401 and Home redirected to sign-in. The actual branded page's Continue with Google link reached Google's sign-in screen. The user's browser was opened at the local sign-in page.

**Dedicated-client acceptance verified on 2026-11-24.** A real Google account-selection/consent flow displayed **DITTO Email Client**, returned through the exact local callback, and signed the existing owner into the application without re-bootstrap or duplicate accounts. Actual browser controls verified Account/session listing, Team & access showing the existing RONIN Admin and instance-administrator authority, newsletter/publisher workspace switching, current-session revocation, and a fresh Google login. PostgreSQL confirmed one Google account, one enabled instance administrator, and the revoked proof session; the owner's older browser session was left active. No cookies were copied or injected.

Carson selected **External** audience and explicitly chose to finish local development in **Testing** mode. The owner is the only configured Google test user. Add intended testers to Google's test-user list before their acceptance checks. Production consent publication remains gated on valid public app-homepage/privacy-policy URLs and production callback/HTTPS configuration. A second controlled Google account was not supplied, so real invitation redemption, wrong-account recovery and second-account role/disable acceptance remain unverified.

The existing combined Lite preview was restarted with Google mode preserved and process overrides `ENABLE_WORKER=false`, `BOOTSTRAP_WORKER=false`, `BOOTSTRAP=false`, `BOOTSTRAP_EVENTS=false`, `ENABLE_OPEN_TRACKING=false`, and `LOG_CONFIG=false`. These overrides do not rewrite the corresponding `.env` defaults; retain them when restarting an infrastructure-only preview. No email or provider operation was performed.

For a deployment/release, complete the following checklist:

1. Back up the intended database. Preserve the existing RONIN workspace ID and all contact/event data.
2. Build the required packages and apply the complete normal additive migration chain, currently through `0017_newsletter_tracking_domains`.
3. Use one public origin for API and dashboard; split deployments need a same-origin reverse proxy and matching database/session secret.
4. Set `AUTH_MODE=google` on API/dashboard and restart together. Do not expose shared login as a fallback.
5. Sign in with the configured owner through real Google consent and verify RONIN data, profile editing, sessions, logout, and fresh login.
6. Hand a private invitation to a second real Google account. Verify correct-account admission, wrong-account recovery, role restrictions, workspace switching, revocation, and disable behavior.
7. Remove bootstrap settings after successful owner provisioning. Review production HTTPS, audience/test-user settings, and recovery access before release.

Production Google consent and authenticated team/second-account acceptance remain operator release items. The local owner sign-in recorded above was real; protocol tests and local fixtures do not replace production acceptance. Never inject cookies or simulate a provider result to claim a real sign-in.

## Operations and safety

- Full setup/recovery guide: `packages/docs/guide/google-sso.mdx`.
- Account design/status: `packages/docs/ACCOUNT_SYSTEM_PLAN.md`.
- Google owns password/MFA/recovery. The application owns membership and session revocation; a Google password change is not automatically an app-session revocation signal.
- Never run the inherited Jest global setup/teardown against live PostgreSQL/ClickHouse databases or a live blob bucket: teardown drops/empties configured resources. Use isolated test resources.
- The deliberate local cutover is now `AUTH_MODE=google`; do not reintroduce shared login as a fallback. Never log `.env`, credentials, cookies, authorization codes, invitation tokens, or identity payloads.
