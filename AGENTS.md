# Agents

## Fork direction

This repository is a stepping stone for Ronin Publishing's own platform, not an
upstream-maintenance project. Substantial deletion and rebuilding are intentional.
Do not preserve unwanted features just for upstream compatibility. Preserve the
MIT license and required copyright notices.

Read [FORK_PLAN.md](FORK_PLAN.md) before changing product scope. It records Carson's
decisions, the initial code map, priorities, and implementation acceptance criteria.
Unchecked items are planned work; checked items must reflect verified changes.

- Current work is infrastructure-only: do not initiate email sends, test email
  deliveries, campaigns, or provider-account/tracking changes without Carson's
  explicit authorization. Verify capture with inbound HTTP fixtures instead.
  Each native newsletter gets `dt.<newsletter-domain>`, using a shared Cloudflare
  Worker and Cloudflare for SaaS CNAME/TLS onboarding. Bind domains to native
  Newsletter.workspaceId, not subscription groups or sending sub-users.
  A CNAME alone is not certificate/ownership verification. Keep capture and
  Cloudflare provisioning default-off, preserve old send origins/domain ownership,
  and never fall back to another newsletter/global host for an unverified newsletter.
  Backend hosting and actual domains remain operator choices. Do not provision
  public resources or change provider accounts without explicit authorization.
  Cloudflare deployments must target RONIN account
  `2c0f822ce2342b56b3998e7981c03332`, never ADVERTISE. Use isolated RONIN
  authentication; do not overwrite another project's Cloudflare login. Carson
  selected a dedicated capture backend, not either existing shared server.

- SMS runtime is removed. Do not reintroduce SMS, Twilio, or SignalWire sending;
  Hermes owns SMS. Preserve historical data/migrations and run the read-only
  cutover preflight in `FORK_PLAN.md` before deploying over an existing instance.
- Segment.io is removed. Do not reintroduce its webhook, SDK, configuration, or
  UI. Preserve audience segmentation, native data ingestion, and the independent
  contact/event registry; historical migrations/data are not teardown targets.
- Postmark and Mailchimp/Mandrill are removed. Keep their SDKs, webhook routes,
  schema variants, secret mappings, and UI out. Preserve historical data;
  unsupported defaults/overrides must fail explicitly, never select a fallback.
- Resend runtime is removed. Do not reintroduce its SDK, webhook routes,
  credential/schema variants, or compatibility shims. Preserve historical rows
  and migrations; unsupported defaults and overrides must fail explicitly.
- Telnyx email uses its native API and Ed25519-signed raw webhooks. Preserve
  durable idempotency and provider-message/contact correlation, including the
  actual credential-owner workspace when credentials are inherited. Never trust
  callback metadata to assign a contact or tenant.
- A Telnyx send `202` means acceptance; a webhook `202` means durable receipt.
  Neither proves delivery or human engagement. Raw callback retention defaults
  to 30 days (`TELNYX_WEBHOOK_RETENTION_DAYS`); the registered worker/global cron
  must run for projection and cleanup. PostgreSQL-to-ClickHouse projection is
  at-least-once across a crash, not exactly-once.
- Retain Push Notifications and HubSpot implementations, but hide their UI entry
  points, including channel pickers, editors, onboarding, and Settings as applicable.
- Preserve other providers and features unless a later product decision removes
  them. RP Edge enrichment is exploratory, not an approved integration.
- `last_clicked` is a protected, event-time maximum of observed `DFEmailClicked`
  events per contact. Preserve independent per-send timestamps/history, stable
  event identity, retry deduplication, and late-event monotonicity. Scanner clicks
  can count; this is not qualified human engagement. Reuse the native registry.
- `last_opened` is also a protected OBSERVED event-time maximum, not a qualified
  human-open property. Preserve per-send history and source identity; never infer
  opens from clicks. Bot/human classification remains planned.
- URL attribution is opt-in: never append or replace `subscriber_email`
  automatically. Reuse Liquid: `{{subscriber_email}}` is the URL-encoded resolved
  single To mailbox (honor custom identifierKey in sends and previews).
  Other fields use `{{ user.field | url_encode }}`; `sha256` / `md5` hash exact
  raw scalar UTF-8 values into lowercase hex, without implicit normalization.
  Preserve strict missing-field rules and explicit defaults; never re-evaluate
  contact values as template code. URLs without tokens stay unchanged.
  Explicit tokens may disclose the primary recipient in shared/forwarded copies;
  hashes are not anonymization, authentication, or verified identity.
- Optional owned open pixels use opaque per-send tokens and encrypted, bounded
  request evidence. Require explicit public origin and private SECRET_KEY; keep
  raw headers/IPs out of native events and general logs. HEAD is raw-only.
  Preserve 30-day default retention, scoped access, and erasure serialization/
  hash-only barriers. Provider callbacks are not original browser requests.
- Never equate a pixel load, Apple privacy-proxy request, or a 10-minute delay with
  a verified human open. Keep raw evidence available for revised classification.
- Tracking data can contain PII. Do not log secrets or blindly dump credentials,
  cookies, or request bodies into general application logs. Support the requested
  `subscriber_email` attribution deliberately; document its URL-leakage risk.
- A removal includes callers, shared types, APIs, workers, settings, dependencies,
  fixtures, examples, and product docs, not just a hidden settings card. Inspect
  persisted resources and running workflows before removing their handlers; never
  delete live contact/event data or migration history as teardown cleanup.

Keep the plan's status accurate as work lands. Preserve the commands below until
the corresponding tooling actually changes.

## UI and copy

- Product hierarchy is **Workspace → Newsletters**. Use "Workspace" for the
  top-level selector/settings and "Newsletter" for its children; never call the
  workspace a publisher. Preserve tenant IDs, memberships and internal API/schema
  identifiers unless an explicit migration is requested.
- Planned sending model: newsletters and ESP accounts are independent workspace
  objects. Allow multiple accounts per provider; IPs/pools are ESP infrastructure,
  never newsletter assignments. Choose the account and supported IP/pool at send
  time; optional newsletter defaults only prefill and remain overridable. Record
  confirmed choices per send/attempt for history and safe retries, not as a
  permanent newsletter lock. The overview graph must not invent binding edges.
  See the approved next ESP-account plan in `FORK_PLAN.md` before implementing.
- The organization-wide UI belongs at `/dashboard/workspace`, with left-sidebar
  sections for Overview, Newsletters, ESP accounts, IPs, IP pools, Subscribers,
  Reports and Settings. Infrastructure inventories span the selected workspace
  while preserving ESP-account ownership. Do not put this system inside newsletter
  settings or rename backend `/api/publications` contracts as part of the UI move.

- Default to no explanatory copy. Each section/area may have at most one
  extremely concise sentence, only when it adds necessary information.
- Prefer clear headings, labels, values and actions. Do not explain obvious
  behavior, narrate the data model, repeat context, or add instructional filler.
- KPI cards show a label and value only; no descriptive captions.
- Keep necessary validation, errors and consequential-action warnings concise.
  Use accurate labels such as "Matched mailboxes" or "Observed opens" rather
  than adding caveat paragraphs or implying verified people/human engagement.
- Put detailed semantics in documentation, not extra subtitles or tooltips.
- Normal settings use named resources, status and contextual actions. Keep raw
  UUID/JSON entry, migration and repair tools in Advanced; do not expose internal
  rollout permissions as a standing checkbox panel or weaken backend safeguards.
- Preserve the compact layout and existing palette. Do not initiate a production
  deployment for UI edits unless explicitly requested.

## Commands

The following are useful commands for the agents:

```bash
# Lint a specific file in the backend-lib package. A similar command can be used for other packages.
yarn workspace backend-lib eslint src/resources.test.ts --fix

# Run tests for a specific file. A similar command can be used for other packages.
yarn jest packages/backend-lib/src/resources.test.ts

# Run tests and pipe output to a timestamped file in .tmp for debugging.
# Prefer this for large tests to avoid inflating context. The output file can be
# searched and explored more efficiently using Read, Grep, etc.
yarn test:file packages/backend-lib/src/resources.test.ts

# Run tests with jest flags (e.g., -t to filter by test name).
yarn test:file packages/backend-lib/src/resources.test.ts -t "specific test name"

# Reduces the log levels before running tests, providing more verbose log output.
LOG_LEVEL=debug yarn jest packages/backend-lib/src/resources.test.ts

# Run type checking for the backend-lib package. A similar command can be used for other packages.
yarn workspace backend-lib check
```

## Key Files and Directories

- packages/backend-lib/src/config.ts: Where the majority of our applications' environment variables and configuration values are resolved.
- .tmp/: this directory can be used output disposable files for debugging purposes
- New backend `Error` subclasses must restore their prototype: the downlevel
  compiled output otherwise breaks `instanceof` and misclassifies failures.
- For the local single-tenant preview, use the existing combined Lite server,
  not standalone Next plus a cross-origin API. See `FORK_PLAN.md` for runtime,
  restart, and session details. Never hide the HTTP cookie warning or enable
  secure cookies without actual TLS.
