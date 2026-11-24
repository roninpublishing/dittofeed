# Ronin Publishing fork: teardown and tracking plan

## Mandate and status

Owner: Carson. This captures his initial product brain dump. Dittofeed is a
stepping stone for our own platform; substantial removal and rebuilding are
intentional. Maintaining upstream feature parity is not a goal. Preserve the MIT
license and required notices; this is not a claim about upstream's maintenance
status.

**Status: initial teardown, native Telnyx replacement, observed `last_clicked` /
`last_opened` per contact/send, owned open-request capture, and opt-in Liquid URL
tokens for recipient/contact values and SHA256/MD5 hashes implemented; Push and
HubSpot UI hiding merged into main.** Human-open qualification and RC-specific receiving integration remain
planned. No existing deployed instance was audited;
local verification is not a production cutover audit. AI implementation rules
live in [AGENTS.md](AGENTS.md); `CLAUDE.md` delegates there.

Newsletter-branded Cloudflare tracking infrastructure is implemented locally,
with one `dt.<newsletter-domain>` hostname per native newsletter. Public
deployment, DNS/TLS activation, capture, and sending remain disabled; local
inbound-only verification is not a production cutover.

Google OIDC and application-owned accounts, explicit workspace memberships,
roles, private invitations, and revocable sessions are implemented. The local
preview now uses a dedicated **DITTO Email Client** Google project under Ronin;
Pepper's OAuth app is unchanged. Real branded owner sign-in, RONIN Admin access,
account/team screens, workspace switching, current-session revocation and fresh
login are verified. One-time bootstrap settings remain removed.
Carson selected External audience and local Testing mode; the owner is its only
configured Google test user. Real second-account acceptance, public homepage/
privacy URLs, production consent publication and origin/deployment remain release
gates. The integration checkpoints migrations `0000`–`0017`. See
[account operations](packages/docs/guide/google-sso.mdx) and
[the setup handoff](GOOGLE_SSO_HANDOFF.md).

## Product decisions

| Area | Decision | Boundary |
| --- | --- | --- |
| SMS | Remove everything, including Twilio and SignalWire. | Hermes owns SMS. No replacement SMS implementation here. |
| Push Notifications | Keep the implementation; hide it from the UI. | Low likelihood of future use, roughly 5–10%; do not delete its backend. |
| Settings → Data Sources → Segment.io | Remove the integration entirely. | Remove both source and destination integration wiring, not audience segmentation. |
| Contact and event registry | Keep an independent database and contact registry. | Preserve direct ingestion and existing contact/history data; do not merge into another system. |
| RP Edge enrichment | Possible future data-source integration. | Undecided; do not build or assume its contract yet. |
| Settings → Message Channels → Postmark | Remove entirely. | Include sender, webhook, configuration, UI, and dependencies. |
| Settings → Message Channels → Mailchimp | Remove entirely. | Include sender, webhook, configuration, UI, and dependencies. |
| Resend → Telnyx email | Remove Resend; implement Telnyx email. | Use Resend as a code-pattern reference, not a protocol or compatibility shim. Telnyx SMS is out of scope. |
| HubSpot | Keep the integration; hide it from the UI. | Low likelihood of future use, roughly 5–10%; preserve backend/workflows. |
| Other inherited features/providers | No removal decision yet. | Do not expand the teardown beyond the decisions above. |
| Sending operations | Not authorized during infrastructure preparation. | No email deliveries, test sends, campaigns, or provider-account changes; validate tracking with inbound HTTP fixtures. |
| Public tracking infrastructure | Separate `dt.<newsletter-domain>` per native newsletter, behind a shared Cloudflare Worker and Cloudflare for SaaS CNAME/TLS onboarding. | Public tracking deployment is authorized only in RONIN Cloudflare account `2c0f822ce2342b56b3998e7981c03332`, with a dedicated capture backend. Sending remains prohibited; the first newsletter domain and concrete hosting destination must be selected. |

## Implementation order and acceptance

### 1. Initial teardown: establish the starting point

- [x] Remove all SMS: provider adapters, send execution, templates/editors/previews,
  journey/channel choices, settings, APIs, shared types/events, configuration,
  dependencies, seeds/fixtures, examples, and relevant product docs.
- [x] Remove Segment.io source and destination integrations. Preserve native
  identify/track/batch ingestion, contact registry, segments, and segmentation UI.
- [x] Remove Postmark and Mailchimp end to end.
- [x] Replace Resend with Telnyx email end to end: credentials/settings, sender,
  provider selection, send-result identity, verified webhook processing, event
  normalization, examples/docs, and targeted verification. Resend code, SDK,
  types, webhook routes, and active credential handling are removed; historical
  rows remain preserved.
- [x] Hide Push Notifications everywhere users can select, create, configure, or
  navigate to them, including direct UI routes; retain backend functionality.
- [x] Hide HubSpot configuration, onboarding, and other UI entry points, including
  direct UI routes; retain integration code and workers.
- [x] Keep the separate contact/event database and direct ingestion functional.

Before removing handlers or schemas, inspect saved templates, journeys, provider
configuration, historical events, and running Temporal workflows. Define explicit
migration/rejection behavior for removed feature resources so workflows do not
silently break. Do not delete contact/event history or old database migrations.
Hiding retained UI is not authorization and must not accidentally disable its
backend. Verify the actual dashboard surfaces and remaining email/ingestion paths.

#### SMS cutover and verification

Removed SMS sending/provisioning, Twilio/SignalWire adapters and SDKs, public and
admin provider settings endpoints, Twilio SMS callbacks, shared channel/provider
types, editor routes, selectors, seeds/fixtures, product docs, and obsolete
screenshots. Existing email, Push, Webhook, HubSpot, native ingestion, phone
contact traits, and audience segmentation remain in scope. SendGrid's
`x-twilio-email-event-webhook-*` headers remain because they authenticate email
events, not SMS.

Legacy saved SMS definitions are excluded from active template/journey
collections with warnings; legacy workflow definitions fail explicitly rather
than being treated as email. No contact/event records or historical migrations
were deleted. Physical historical SMS provider tables and the old database enum
value remain in existing databases; active Drizzle exports no longer expose
them. Do not generate/apply destructive cleanup migrations from that schema
difference.

Before replacing API/worker code on an existing deployment:

```bash
# Requires DATABASE_URL and TEMPORAL_ADDRESS; TEMPORAL_NAMESPACE is optional.
yarn workspace backend-lib sms-cutover-preflight
```

The script performs read-only saved-resource and running-workflow inspection,
logging identifiers rather than bodies/secrets. Exit 0 means no legacy SMS
resources/workflow inputs were found; 1 means findings; 2 means inspection was
incomplete. Resolve findings and drain/cancel affected running workflows using
the existing deployment before replacing workers; do not bypass the preflight
or delete contact/event history. No automated destructive migration or workflow
cancellation is included.

Local proof:

- TypeScript checks passed for isomorphic-lib, backend-lib, API, dashboard, and
  admin-cli after building the required emailo exports.
- 24 runtime schema scenarios passed: SMS rejected for templates/test sends/
  batch sends/journeys/broadcasts; retained channels and native identify/track/
  batch ingestion remain valid, including phone traits and historical event names.
- 11 real Fastify requests passed: removed SMS settings/callback endpoints return
  404; retired template payloads return 400; native ingestion and SendGrid email
  verification continue to require their authentication headers.
- Three isolated API regressions passed for retired template create/reset/test
  requests. Invalid create/reset requests now serialize as 400 instead of 500.
- The removed `/dashboard/templates/sms/removed` route visibly returned 404 in
  a local Next.js browser session.
- Preflight returned exit 2 with both database and Temporal inspection incomplete,
  as required without deployment configuration. No live send, database-backed
  integration test, or Temporal workflow regression was run; those require the
  deployment services. Settings/other authenticated screens were not visually
  exercised against a live workspace.

#### Segment.io removal and native data boundary

Removed the signed `/api/webhooks/segment` and `/api/public/webhooks/segment`
endpoints, GET/PUT/DELETE `/api/settings/data-sources` and admin equivalents,
Segment-only configuration contracts and active Drizzle relations, Settings
navigation/card/state, SDK scripts, sample event generator, obsolete integration
fixtures, SDK dependencies, docs/OpenAPI paths, and Segment-only screenshots.
The destination integration was only advertised as “Coming Soon”; that product
entry was removed rather than replaced with a new outbound integration.

Preserved native `/api/public/apps/{identify,track,batch,page,screen,group}`,
workspace write keys, contact/user-property APIs and tables, ClickHouse event
history, discovery of event/trait names, audience segment APIs/editors, computed
properties, manual segments, journeys, and broadcasts. Generic phone traits and
manual-segment ingestion metadata remain. Existing event/trait tests now use
native identify events rather than the removed Segment sample generator.

Historical `SegmentIOConfiguration` tables/rows and migration snapshots remain
untouched; no destructive schema migration is included. Do not generate/apply
automatic table-drop migrations from the narrowed active Drizzle schema. Before
upgrading an existing deployment, inventory configured Segment webhook
destinations and redirect/disable upstream delivery deliberately: removed
endpoints now return 404 and no longer accept upstream events. No Segment-owned
workflow implementation was found in the source; ordinary segment/journey/
computed-property workflows are independent and remain.

Fresh local infrastructure and its workspace are separate from any existing
deployment. Inspecting that empty configuration does not certify a production
cutover. Do not print historical shared secrets while inventorying configuration.

Local removal proof: five affected packages type-check after a clean rebuild;
18 real HTTP requests against the local API confirm removed Segment webhook/
settings endpoints return 404 while native ingestion/contact/event/property/
segment endpoints retain validation. Native batch normalization preserves
identify/track identities, event times, traits (including phone), properties,
and context. Generated OpenAPI/docs JSON is valid and retains registry and
audience segment APIs without Segment.io paths/contracts.

The historical configuration table is preserved, not used as an active
integration. Old Segment write keys/shared secrets do not authorize native
ingestion; upstream producers must deliberately adopt native workspace write
keys and endpoints before cutover.

Additional data-path proof: 13 audience-segment tests passed against isolated
Postgres/ClickHouse test databases; all 10 native event/trait registry tests
passed in a separate Jest process. The initial combined in-band run hit a
closed-pool teardown error in its second suite; no registry assertions were
removed or weakened. The isolated test databases were distinct from the preview
workspace.

#### Postmark and Mailchimp/Mandrill removal

Removed both provider send adapters and provider-only tests, webhook routes
under both `/api/webhooks` and `/api/public/webhooks`, signature/authentication
helpers, SDKs/typings, provider/secret/success/failure schema variants and mappings,
Settings forms/options, broadcast overrides, analytics choices, docs/OpenAPI
contracts, and obsolete screenshots. Resend remains until the Telnyx cutover;
SendGrid, SES, SMTP, Test, Gmail, shared email/unsubscribe handling, and native
contact/event/segmentation functionality remain.

The supported provider catalog is now the provisioning source of truth.
Historical provider rows are excluded from listings without loading their
credentials or recreating removed providers. Unsupported saved defaults/overrides
fail explicitly; an invalid local default must not silently fall back to a parent.
The default-provider API rejects historical IDs and names for removed providers,
and the UI shows an unavailable selection rather than substituting a supported
provider. Full journey validation rejects unsupported definitions before earlier
email nodes can send.

Read-only local inventory before removal found one unconfigured row for each
provider, no removed-provider defaults, no saved journey/template/broadcast
references, and no removed-provider references in the two running workflows
inspected. Historical provider/secret rows, raw contact/event data, and migrations
were not deleted. This is local preview evidence only.

Before upgrading an existing deployment, inventory configured providers/defaults,
saved provider overrides, upstream callbacks, and in-flight workflows. Explicitly
reconfigure affected defaults and retire/drain affected resources/workflows before
replacing handlers. Removed callbacks return 404. The SMS-specific preflight is
not an email-provider audit; no production migration or credential deletion was
performed here.

Verification: affected TypeScript packages and the combined Lite server build
passed. Isolated suites passed 26 messaging tests, 2 provider-catalog/update tests,
4 Temporal journey tests, and 5 default-provider API tests (37 total), including
retired defaults/overrides, history preservation, and no sends before invalid
journey definitions fail. Blob storage was disabled; no external email-provider
delivery was attempted. Thirteen live HTTP requests verified removed callbacks/
configuration/test-send requests are rejected while retained webhooks and native
ingestion still validate. The current authenticated Settings page offers
SendGrid, Amazon SES, Telnyx, SMTP, and Test, with no retired forms/options.

#### Working local preview

The fresh local workspace is available at `http://localhost:3000/dashboard`.
Its password and generated session/database credentials live in ignored `.env`;
do not commit or log them. No production credentials or existing deployment
data were imported. The preview starts empty rather than presenting seeded
contacts or segments as real data.

Use the repository's existing **Lite** server for single-tenant development:
it serves API and dashboard on the same origin and forwards verified session
state to Next.js. A standalone Next server plus a separate API login origin can
return login success without establishing a usable dashboard session. Verified
in a real browser: login succeeds, authenticated Settings survives reload,
Segment.io/Data Sources navigation is absent, and Users and audience Segments
pages render. No authentication bypass or cookie/state injection was used.

This is loopback-only HTTP. The insecure-cookie banner remains informational;
do not set `SESSION_COOKIE_SECURE=true` unless the preview is actually served
over TLS. No warning was hidden and no CA trust settings were changed.

Runtime state is isolated under
`$HOME/.local/share/dittofeed-preview/runtime`: native Colima/Lima, Docker client,
and Compose, with a 4-CPU/8-GB/30-GB VM named `dittofeed`. Postgres, ClickHouse,
and Temporal use the repository's Lite Compose services, with
`.tmp/local-preview-compose.yaml` overriding ports/healthchecks so exposed
services bind only to loopback. Persistent volumes use project `ronin-preview`.

Restart infrastructure from the repository root:

```bash
R="$HOME/.local/share/dittofeed-preview/runtime"
export PATH="$R/bin:$PATH"
export DOCKER_CONFIG="$R/docker-config"
export COLIMA_HOME="$R/colima"
colima start --profile dittofeed
docker compose --env-file .env -p ronin-preview \
  -f docker-compose.lite.yaml -f .tmp/local-preview-compose.yaml \
  up -d --wait postgres clickhouse-server temporal
```

Then run the existing combined source server:

```bash
node .yarn/releases/yarn-4.1.1.cjs workspace lite dev
```

Dashboard hot reload is active. Rebuild affected TypeScript packages and restart
Lite after backend/worker changes because their workspace exports use compiled
output. The worker reached `RUNNING`; the inherited Temporal image reports that
SDK worker heartbeats are unsupported, but this did not block startup. To stop
the VM without deleting preview data, use `colima stop --profile dittofeed`.

### 2. First post-teardown feature: `last_clicked`

- [x] Provide a contact-level `last_clicked` property and per-send click history
  with workspace, stable contact ID, internal send/message ID, provider message
  ID, link identity/destination, and event identity. A contact aggregate alone is
  insufficient for per-send attribution.
- [x] Make the property available wherever contacts are queried, segmented, and
  used to personalize messages. Reuse existing computed-property machinery if it
  meets the update and retrieval requirements; avoid a second contact store.
- [x] Add opt-in downstream URL attribution using explicit Liquid tokens such as
  `?subscriber_email={{subscriber_email}}`, other contact fields, and SHA256/MD5
  hashes. Never append or overwrite attribution automatically. Preserve literal
  URLs, contact/send IDs, and provider correlation. RC-specific receiving APIs
  are not part of this generic URL contract.
- [x] Capture available native click evidence from rollout; expose observations
  explicitly as unqualified, including provider/event/send identifiers and URLs.
- [ ] Classify suspected bots versus qualified human engagement. Scanner clicks
  currently count toward `last_clicked`; no timing heuristic establishes humanity.

Timestamp contract: maximum observed UTC click event time across sends for the
contact; each send retains its own timestamp/count/history. Retry deduplication
uses event ID, occurrence time, and URL, not processing time. Older arrivals
cannot move the aggregate backward. Legacy callbacks lacking a provider event
ID can collapse same-second/same-URL observations; lost identity is unrecoverable.
Use durable send correlation, not email address alone, because addresses change.

Implementation reuses the native registry, ClickHouse events, and computed-property
engine with `Performed` / `EventTime`. Data-only migration `0012_last_clicked`
provisions existing workspaces, and workspace creation provisions new ones.
Conflicting same-name custom definitions fail explicitly, never overwrite.
The protected property cannot be edited, paused, renamed, or deleted. Contact
assignment remains eventually consistent and requires the existing worker.

Contact detail, shared delivery tables/history, delivery API/CSV, native contact
filters, Liquid templates, and the Last clicked segment preset expose the feature.
`POST /api/admin/deliveries/clicks` (also `/api/deliveries/clicks`) is scoped to
workspace/contact/internal send, with bounded live keyset pagination. Native
client ingestion retains its existing trust model; provider labels are not proof.
See [Click tracking](packages/docs/guide/click-tracking.mdx) for the full contract.

Verification: affected TypeScript package builds passed; 198 targeted tests
passed in isolated databases. A temporary local Test-transport contact with two
sends proved late/duplicate handling, contact maximum, per-send independence,
contact filtering, CSV, and actual template rendering without external email.
Browser verification covered the contact timestamp, send history, and Last
clicked/no-click segment controls.
The temporary contact/template and draft segment were removed after verification.
The local Lite preview remains running with the feature migration applied.

#### Explicit URL contact tokens: implemented

Carson corrected the earlier automatic-append behavior: attribution must be
explicitly authored in the URL. The automatic HTML rewriter, exclusions, opt-out
attribute machinery, and its direct HTML-parser dependency have been removed.
Literal URLs, including pre-existing subscriber_email parameters and signed or
subscription links, are not rewritten.

Reuse the existing single-pass Liquid engine:
- `{{subscriber_email}}` emits the URL-encoded resolved single To mailbox,
  including a custom template `identifierKey`; display names are excluded.
- `{{ user.firstName | url_encode }}` emits another scalar contact field.
- `{{ subscriber_email | sha256 }}` / `{{ user.id | md5 }}` emit lowercase
  hexadecimal hashes of exact raw UTF-8 scalar values. Recipient convenience
  aliases `subscriber_email_sha256` and `subscriber_email_md5` are also available.
- Normalize only through explicit filters (`strip | downcase | sha256`).
  Required missing/ambiguous values fail rendering; optional values use Liquid
  defaults. Hashing objects/arrays fails rather than dumping JSON or PII.

Recipient output expressions are encoded before MJML compilation, after their
filters, using Liquid's tokenizer. Contact data is never parsed as Liquid a
second time. Other `user.*` expressions keep their existing text semantics and
choose `url_encode` explicitly for URL components. The email editor's URL-token
helper exposes field/value/hash expressions; visual link editing accepts spaced
Liquid output/filter syntax and saves it literally. Render previews honor the
same custom To field as actual sends, including test sends. Delivery HTML and
view-in-browser content retain the rendered tokens.

**Attribution privacy:** tokens are deliberate disclosure to their destination.
Raw values and hashes can identify contacts; hashes are not anonymization.
URLs may leak via logs, history, analytics, referrers, forwarding, and HTTP.
Explicit primary-To tokens also appear in shared CC/BCC copies. Editable URL
parameters prove neither identity nor human engagement. No owned click redirect
or RC-specific receiving endpoint/SDK was invented; provider tracking remains
separately configured. Previously delivered historical mail is not rewritten.

Verification: immutable dependency installation and affected package builds
passed; 109 targeted rendering, secret-isolation, send, preview, and visual-link
regressions passed (one existing skipped test). Actual loopback SMTP HTML and
MJML messages, including a test send, delivered raw mailbox, field, and hash
tokens to a local landing endpoint with exact decoded values. Literal signed
and unsubscribe links remained unchanged.
Browser verification covered copying recipient SHA256 and spaced-field MD5
expressions, correct custom-To preview URLs, exact visual-link href/new-tab
preservation, and native template publication. Existing linked-text selections
now expose the editing toolbar instead of being excluded as custom nodes.
Temporary transport/UI resources were removed; the local preview stays running.

### 3. Observed `last_opened` and raw request capture: implemented

Carson's current decision is to expose `last_opened` now as an **observed** open,
while collecting evidence to design bot filtering. It is not a human-engagement
claim. Provider callbacks describe provider observations, not the recipient's
original HTTP request; an optional owned pixel supplies request-level evidence.

- [x] Provision protected `last_opened` on existing/new workspaces using the same
  native EventTime computation as clicks. UTC maximum, late-event monotonicity,
  no epoch for never-opened contacts, explicit same-name conflicts, no overwrite.
- [x] Preserve per-send open timestamps/counts/history independently of the latest
  status. Contact UI, delivery API/CSV, filters, Liquid templates, and Last opened
  segment conditions expose observed semantics. Native/provider event identity
  remains distinct from internal send identity.
- [x] Capture valid owned-pixel GET/HEAD requests in encrypted PostgreSQL evidence:
  receipt time, method, redacted route, permitted cache-buster query, bounded
  allowlisted headers/user-agent, observed socket address/HTTP/TLS, and separately
  untrusted proxy hints. HEAD remains raw-only. No Cookie/Authorization/Referer,
  literal token URL, arbitrary query/body dump, or raw IP/header copy in native
  events/general logs. Verified Telnyx raw callbacks remain separate provider
  evidence under their existing retention, not browser evidence.
- [x] Use opaque 256-bit per-send tokens with stable retry mapping; inject only
  into transport HTML, not previews/native stored HTML/view-in-browser. Skip
  CC/BCC shared copies. Unknown/deleted tokens do not create observations; a
  persistence failure returns 503. Token possession never proves a person's identity.
- [x] Retain owned raw evidence for 30 days by default (1–365 configurable),
  hide expired evidence immediately, and run bounded cleanup/projection through
  the worker/global cron. Explicit scoped authenticated raw retrieval is available
  from per-send History. Contact erasure serializes with capture/native insertion,
  removes encrypted receipts/mappings, and retains hash-only retry/contact barriers.
- [ ] Develop a defensible bot/proxy/human classifier with policy version/reasons.
  Preserve observations for replay instead of silently reclassifying timestamps.
- [ ] Analyze real user-agents/proxy behavior and send-to-event timing. Evaluate
  Carson's suggested ten-minute window only as a candidate heuristic; early
  requests are captured now, not discarded.

Current infrastructure boundary: Carson wants infrastructure prepared, not
sending operations started. He chose a separate `dt.<newsletter-domain>` for
each native newsletter, served by a shared Cloudflare Worker with CNAME
onboarding. Newsletter identity is the native Newsletter child workspace, not a
subscription group or sending sub-user. Cloudflare for SaaS provisions each
custom hostname/certificate; DNS-only CNAME and active hostname/TLS states must
all be verified before a new branded origin becomes eligible.

Preserve old domain ownership and every send's original origin. Historical
pixels and accepted-send retries must not silently switch to a new hostname.
Registered newsletters without verified current tracking domains fail closed
when capture is enabled; legacy non-newsletter workspaces can retain the
instance-wide `OPEN_TRACKING_BASE_URL`. Backend hosting and actual domains remain
undecided. No public deployment, DNS/certificate/provider-account changes, or
email sends are authorized as part of preparation.

Capture remains explicitly gated by `ENABLE_OPEN_TRACKING`; a stable private
32-byte base64 `SECRET_KEY` is required. Newsletter-only origins use a separate
32-byte base64 `OPEN_TRACKING_RELAY_SECRET` for Worker authentication rather
than requiring an invented global hostname. Raw retention is separately bounded
by `OPEN_TRACKING_RETENTION_DAYS`. The local infrastructure preview runs with
sender workers/capture disabled; inbound-only test fixtures exercise collection.
Provider profile tracking remains separately configured. See
[Open tracking](packages/docs/guide/open-tracking.mdx).

Owned request receipts use AES-256-GCM storage; the request's `encrypted`
field describes socket TLS, not at-rest protection. Evidence retrieval is scoped
to workspace/contact/internal send/receipt. Existing native event retention is
separate. PG/native projection remains at-least-once across a crash; per-send
counts deduplicate event ID + occurrence time, not unique people. Known-correlation
workspace erasure does not disable all future ingestion/sends. Hash-only erasure
barriers are pseudonymous and retained indefinitely; erased contact IDs cannot
silently re-enable owned tracking. Protect the encryption key and external
ingress/CDN access logs as well as application storage.

Apple privacy proxies can prefetch images and conceal client identity; image
blocking also hides real reads. A pixel load, user-agent string, click, or ten-
minute delay alone never verifies a human open. No Apple workaround is claimed.

Verification: affected package typechecks and 306 targeted regressions passed
across 18 isolated suites. Real local pixel GET/HEAD, durable native projection,
late/duplicate events, two-send aggregation, raw redaction/retrieval, contact
filtering, and Liquid rendering were exercised without external email. Browser
proof covered contact timestamps, per-send history/raw JSON, and Last opened
segment controls. Temporary contacts/templates/draft segment were removed.
An actual loopback SMTP send also proved that outbound HTML contains the owned
pixel while stored/preview HTML remains untracked; no external delivery occurred.

#### Per-newsletter Cloudflare tracking: implemented locally, not deployed

Migration `0017_newsletter_tracking_domains` adds immutable newsletter-owned
hostnames, explicit pending/active state, and retained domain history. Newsletter
send mappings keep their original pixel origin. New mappings fail closed until
the newsletter's current hostname, Cloudflare certificate, and DNS-only CNAME
are verified; they never silently use the legacy global origin.

Newsletters → Tracking domains exposes local pending configuration, DNS/TXT
instructions, disabled-by-default provisioning, and explicit read-only
verification. Saving a domain does not contact Cloudflare or send email.
`packages/tracking-worker` serves only the branded GET/HEAD pixel path and
relays bounded evidence with a timestamped HMAC to the authenticated capture
API. It requires durable receipt acceptance before returning the pixel, never
forwards cookies or authorization, and disables caching and request logs.

Verification: 145 targeted Jest tests passed in isolated PostgreSQL/ClickHouse
databases; the native workerd suite passed 10 tests and Wrangler dry-run passed.
Production TypeScript builds passed for backend, API, and dashboard. Separate
newsletter-test typing failures were subsequently fixed; the consolidated
integration passed all nine test-inclusive workspace checks.
An inbound-only native Worker → real HTTP API → encrypted PostgreSQL scenario
proved GET/HEAD capture, hostname isolation, and forbidden-data redaction.
The actual browser UI saved two independent pending newsletter domains in
disposable databases, with provider actions disabled. Those databases and all
owned synthetic preview rows were removed; the original local preview was
restored with workers and capture disabled. This verification did not send
email, deploy a Worker, provision provider resources, or change public DNS.

An earlier request authorized public tracking deployment without sending. The
current integration request explicitly prohibits deployment; release gates remain
closed. The Worker is pinned to RONIN and its disabled dry-run passes.
The current legacy CLI login belongs to ADVERTISE and cannot access RONIN.
The separate macOS profile has an expired, unrefreshable login, and a fresh
isolated OAuth attempt timed out before authorization. Live rollout therefore
still requires fresh RONIN authentication, the first newsletter's actual base
domain, and dedicated hosting access/budget. No public resources were created
and neither existing shared server was changed.

## Telnyx replacement: implemented and locally verified

Resend sending, callback routes, SDK, Svix verification, shared schema variants,
settings, selectors, fixtures, product docs/assets, and its obsolete provider
repair command are removed. Historical provider/secret rows and migration history
were not deleted or converted into Telnyx credentials.

The official [sending guide](https://developers.telnyx.com/docs/messaging/email/send-email)
defines the implemented native `POST https://api.telnyx.com/v2/email_messages`
contract: bearer authentication, `html_body`, recipient arrays, `reply_to`,
metadata, attachments with content types, and optional sandbox mode. HTTP `202`
records the provider message UUID as acceptance, not delivery.

Each logical send has a persisted UUID `Idempotency-Key`, request hash, contact,
sender workspace, and credential-owner workspace. Retries reuse accepted IDs
without another send. Conflicting identities or unresolved acceptance beyond
Telnyx's 24-hour replay window fail closed and require reconciliation; do not
silently mint a new send ID.

The official [webhook guide](https://developers.telnyx.com/docs/messaging/email/webhooks-events)
defines Ed25519 signatures over `{timestamp}|{raw_json_body}` using
`telnyx-signature-ed25519` and `telnyx-timestamp`. Verification uses the account's
base64 public key and a five-minute replay window in either direction.
Configure `/api/public/webhooks/telnyx?workspaceId=<credential-owner-workspace-UUID>`
on a publicly reachable HTTPS host. Localhost is not reachable by Telnyx.
Parent-owned credentials use the parent's callback URL; durable mappings, not
callback tags or metadata, determine the originating contact/workspace.

Webhook `202` acknowledges an immutable PostgreSQL receipt, including raw body
and allowlisted evidence headers, not completed analytics projection. Early
callbacks remain pending until provider-message correlation is saved. Native
event identity and occurrence time are preserved. Only the matching primary
`to` recipient updates its contact; CC/BCC, deferred, unknown, and ambiguous
payloads remain raw evidence without guessed engagement or terminal failure.
Provider unsubscribes emit a native subscription change only for a known group
in the sending workspace; otherwise provider suppression/raw evidence remains.

Additive migration `0011_telnyx_email_inbox` adds send correlation, raw receipts,
and erased-send tombstones. Its snapshot extends `0010` without dropping retired
tables or changing historical migrations. Contact deletion removes associated
raw evidence and correlation before native event deletion; tombstones retain
opaque send/provider IDs and hashed logical IDs, not addresses or contact IDs,
to prevent retry resurrection. Local deletion cannot recall accepted external mail.

The registered, version-gated global-cron activity drains bounded receipt batches
after existing global signals, using the database clock for eligibility/backoff.
Run workers/global cron for both projection and cleanup. Raw receipts default
to 30-day retention, configurable with positive `TELNYX_WEBHOOK_RETENTION_DAYS`;
receipt deduplication lasts that retention window. Correlation remains for late
callbacks until contact deletion. Restrict database access and encrypt production
storage/backups: raw provider payloads can contain PII. No public evidence-read
API or general-log body dump was added.

PostgreSQL evidence is authoritative. The ClickHouse projection is at-least-once
across a crash between its insert and the PostgreSQL completion mark; deterministic
event IDs are not a claim of exactly-once storage. Ordinary duplicate webhook
deliveries do not create a second receipt/projection.

Open/click tracking is off by default at Telnyx and configured on its sending
profile via the domain API; profile changes can affect other domains. This fork
does not silently change those account settings. Native unsubscribe headers are
retained. Pixel opens and scanner clicks remain observed/unqualified; raw provider
callbacks are not original browser requests. Observed `last_clicked` and
`last_opened` now build on this foundation, with an optional owned open pixel.
Human-open qualification, owned click redirects, and RC-specific receiving integration remain planned; ordinary outbound subscriber_email attribution is implemented.

Before deployment, inventory Resend credentials/defaults, saved overrides,
callbacks, and running workflows on the existing instance. Drain or explicitly
reconfigure affected work using the old deployment before replacing handlers;
retired defaults/overrides fail rather than falling back. Local read-only inventory
found one unconfigured Resend row, no defaults/saved references, and no Resend
references in two running workflows. This does not audit production.

Verification: affected TypeScript packages and the combined Lite server build
passed; 113 targeted tests passed across native requests/idempotency, signatures/
replay, durable correlation/retries/deduplication, recipient/tenant boundaries,
retention/deletion races, retained messaging, settings, and Temporal journeys.
Fresh isolated test databases exercised the additive migration. The authenticated
local Settings UI and sandbox true/false persistence were browser-verified;
four live requests checked both removed Resend routes and Telnyx validation/auth
rejection. OpenAPI/navigation JSON parsed and the lockfile has no Resend/Svix SDK
entries. Blob storage was disabled; no external Telnyx send/delivery was attempted.
Configure API key, account public key, verified sending domain, and public HTTPS
callbacks before real use. Setup details: `packages/docs/integrations/channels/telnyx.mdx`.

## Workspace API and MCP: implemented and locally verified

Carson approved exposing supported workspace product operations, not arbitrary
internal function execution. Login/OAuth, personal profiles/sessions, team
invitations/roles/account disabling remain human-authenticated HTTP operations.
Legacy permissions and Gmail authorization status are also excluded from the
machine surface. No synthetic member identity or browser-cookie bypass was added.

- [x] Share product controller registration across browser and workspace bearer
  APIs; add missing machine operations and native identify/track/page/screen/
  group/batch ingestion without weakening public write-key authentication.
- [x] Publish authenticated live `/api/admin/openapi.json` and `/api/admin/operations`,
  with matching bearer security in Swagger and the regenerated API reference.
- [x] Generate typed stdio MCP tools from the running API, with a fixed operator-
  configured origin, workspace and key. New processes default to read-only tools;
  writes, destructive actions and sensitive evidence require explicit grants.
- [x] Store new API keys as SHA-256 digests, compare in constant time, return raw
  keys only at creation, revoke permanently, and prevent partial-scope credential
  escalation. Legacy persisted unscoped keys retain broad authority and should be
  rotated deliberately; existing parent/child authorization rules remain intact.
- [x] Keep master subscription signing material out of template-visible variables
  while preserving signed recipient links and synchronous layout rendering.
  Scope CSV segment and property-index references to their authorized workspace.
- [x] Document setup, permissions, privacy, HTTP/MCP contracts and exclusions;
  generate a reproducible function inventory with locations, parameters, declared
  return types and existing JSDoc rather than inventing helper APIs.

Local verification: 80 targeted tests passed, with one inherited file-inline test
skipped. The real API and spawned stdio MCP process exposed 95 machine operations
(33 read-only), and exercised create/list/delete, native identify, missing/foreign
authorization, read-key write denial, raw-evidence denial, human-only permission
exclusion, Swagger authentication declarations, and immediate key revocation.
Tests used disposable PostgreSQL/ClickHouse databases; no external email was sent
and no existing preview contact data was changed. MCP and backend TypeScript
checks passed. Subsequent API/MCP TypeScript checks are clean; the prior Google
flow/reply/session typing failures are resolved. Initializing replacement sessions
with their token data also fixes successful Google callbacks that previously
failed at runtime. All 47 focused Google-account/authorization regressions pass.

The local `RONIN` workspace now has a dedicated read-only OMP key named
`omp-local-reader-20261120`. Its hashed database credential is paired with an
ignored owner-only (`0600`) `.env.mcp.local`; ignored `.omp/mcp.json` contains the
launch configuration without the key. The exact configured launch completed MCP
initialization, discovered 33 read-only tools/95 API operations, and read the live
manifest; direct API probes denied writes, raw evidence and a foreign workspace.
No campaign or contact mutation was performed during client provisioning.

This is a local-process MCP transport, not a public remote `/mcp` listener or OAuth
authorization server. Production deployment and credential provisioning were not
performed. Local operator-supplied Google credentials and owner sign-in were
verified separately. API keys do not secure an anonymously authenticated browser
deployment. See [MCP setup](packages/docs/guide/mcp.mdx) and
[API/code coverage](packages/docs/guide/api-coverage.mdx). Retained tracking,
provider, retention, erasure and unqualified-engagement semantics are unchanged.

## Open decisions, not permission to invent features

- RP Edge enrichment interface and ownership: undecided.
- RC-specific receiving endpoint/API and support for opaque tokens remain
  unspecified. Generic URL attribution is implemented through explicitly authored
  recipient/contact Liquid tokens, not automatic query appending.
- First-party tracking evidence storage/retention policy, bot classification
  criteria, and qualified `last_opened` semantics: choose from collected data and
  deployment constraints. Telnyx callback retention is defined above.
- Hermes integration: not requested; Hermes ownership means removing local SMS,
  not creating a new integration automatically.

## Source map and remaining implementation gaps

Teardown paths below reflect the current fork. Preserve the independent registry
and the distinction between raw provider evidence and original browser requests.

### Tracking and the independent registry

| Surface | Current implementation / consequence |
| --- | --- |
| `packages/api/src/controllers/publicAppsController.ts` | Direct identify/track/page/screen/group/batch ingestion is independent of Segment.io; preserve it. |
| `packages/backend-lib/src/apps/track.ts`, `apps/batch.ts`, `userEvents.ts` | Normalize and ingest events; they do not automatically persist the original HTTP request. |
| `packages/backend-lib/src/userEvents/clickhouse.ts` | Stores event history and extracts internal send attribution. Its `message_raw` is event JSON, not raw recipient HTTP evidence. |
| `packages/backend-lib/src/db/schema.ts` | Workspace-scoped user-property definitions and per-user property assignments; preserve the registry. |
| `packages/docs/guide/internal-events.mdx` | `DFEmailClicked` / `DFEmailOpened` are source-labeled, unqualified observations; owned raw request evidence is separate. |
| `packages/backend-lib/src/messaging/telnyxEvents.ts` | Preserves verified raw callbacks, then projects provider identity, occurrence time, link observations, and send/contact attribution. |
| `packages/backend-lib/src/messaging/telnyxState.ts`, `messaging.ts` | Durable send idempotency/correlation retains accepted provider IDs, including inherited account ownership. |
| `packages/backend-lib/src/computedProperties/computePropertiesIncremental.ts` | `Performed` and LastPerformed conditions support `EventTime`; protected `last_clicked` / `last_opened` use actual occurrence time, not mutable payload fields. |
| `packages/backend-lib/src/builtinUserProperties.ts`, `deliveries.ts` | Provision protected contact aggregates and query independent per-send deduplicated summaries/history. |
| `packages/backend-lib/src/messaging/openTracking.ts`, `packages/api/src/controllers/openTrackingController.ts` | Owned opaque pixel, encrypted request/outbox, scoped retrieval, retention, and serialized erasure. |
| `packages/backend-lib/src/liquid.ts`, `messaging.ts` | Explicit recipient/contact URL tokens and exact scalar SHA256/MD5 filters, shared by previews, sends, delivery HTML, and view-in-browser rendering; no automatic href rewriting. |

Observed `last_clicked` / `last_opened` and explicit URL contact/hash tokens
are implemented. Human-open filtering and RC-specific receiving integration are
not. The owned open pixel is optional; no click redirect was added. Provider
tracking requires external configuration; local proof used no external delivery.

Tracking invariants:

- A normalized webhook's top-level `messageId` identifies the event;
  `properties.messageId` identifies the outbound send. Do not conflate them.
- Property assignments remain user-keyed; per-send summaries/history query native
  click evidence independently. Do not erase send attribution with the aggregate.
- The primary event tables do not declare a TTL in their definitions. Telnyx raw
  receipt retention is separate from native contact/event-history retention.

### Teardown wiring and retained UI

| Scope | Main sources | Cutover concern |
| --- | --- | --- |
| SMS (removed) | `packages/backend-lib/scripts/smsCutoverPreflight.ts`; `packages/backend-lib/src/smsCutover.ts` | Only read-only cutover detection and legacy-resource rejection remain; no sender/provider implementation. |
| Segment.io (removed) | Historical `SegmentIOConfiguration` migration artifacts only | Active webhook/configuration/UI/SDK integration removed; old tables/rows preserved without a drop migration. |
| Postmark/Mailchimp (removed) | Historical provider/secret rows only | Sender, webhook, SDK, shared contracts, provisioning, UI, and docs removed. Unsupported defaults/overrides fail explicitly without provider fallback. |
| Telnyx / Resend replacement (implemented) | `destinations/telnyx.ts`; `messaging/telnyxState.ts`, `telnyxEvents.ts`; settings and webhook controllers | Native account-scoped signatures, durable identity, and explicit retired-provider rejection; no Resend compatibility path. |
| Push | `packages/backend-lib/src/destinations/fcm.ts`, `config.ts`, `messaging.ts` | Preserve inherited Firebase code. Current shared MobilePush send dispatch throws “not implemented”; retention is not a claim that end-to-end push already works. |
| HubSpot | `packages/backend-lib/src/integrations/hubspotWorkflow.ts`, `hubspotUserWorkflow.ts`, `hubspot/activities.ts`; `packages/dashboard/src/lib/oauth.ts` | Retain OAuth, refresh/synchronization workflows, Temporal registrations, and computed-property callers. |
| Shared contracts | `packages/isomorphic-lib/src/types.ts`, `constants.ts`, `email.ts`; `packages/backend-lib/src/types.ts` | SMS types removed; retain the remaining channel/provider unions and historical event data. |
| Dependencies | `packages/backend-lib/package.json`, `packages/api/package.json`, `yarn.lock` | Removed obsolete provider SDKs/typings, Svix, and Segment sample tooling. Firebase and other retained dependencies remain. |
| Historical coupling | `packages/admin-cli/src/upgrades.ts`, `commandDefinitions.ts` | Obsolete provider-repair handler/command removed; historical SQL migrations, snapshots, and database rows preserved. |
| API mounts | `packages/api/src/buildApp/router.ts` | Webhooks and settings are mounted under multiple namespaces; removing one route registration surface alone is insufficient. |

Dashboard UI inventory:

- `packages/dashboard/src/pages/settings.page.tsx`: data sources, retained channel
  provider settings, HubSpot Connect, and section/navigation composition.
- `packages/dashboard/src/components/messages/templatesTable.tsx` and
  `components/templateEditor.tsx`: channel creation and provider/editor choices.
- `packages/dashboard/src/pages/templates/mobile-push/[id].page.tsx`: retained
  direct editor route; the SMS route has been deleted.
- `packages/dashboard/src/components/journeys/nodeEditor.tsx` and
  `components/channelProviderAutocomplete.tsx`: channel/provider choices and
  overrides. A disabled Push option is still visible and does not satisfy hiding.
- `packages/dashboard/src/components/broadcasts/configuration.tsx` and
  `pages/broadcasts/template/[id].page.tsx`: broadcast channel/template selection.
- `packages/dashboard/src/pages/subscription-groups/[id].page.tsx` and
  `components/analysisChart/analysisChartFilters.tsx`: additional channel choices.

Treat this as a starting map, not an exhaustive deletion manifest. Include
fixtures, seed data, examples, generated API docs, docs navigation, and relevant
screenshots when each removal lands. Verify retained providers and native
ingestion with focused checks; do not equate fewer menu items with full teardown.

## Ronin multi-newsletter operating model

Carson approved one Ronin publisher management workspace above independent native
child workspaces presented as newsletters/publications. This supersedes the
earlier shared-contact proposal: profiles, fields, subscriptions, consent,
acquisition history, engagement, segments, templates, campaigns, journeys and
send history remain publication-local. No automatic contact merging or separate
physical table/database per newsletter. Publisher access covers its newsletters;
existing role levels and immediate revocation remain enforced.

The management view is newsletter-first: a simple list with newsletter name,
subscriber count, status and Open. Creation asks for a name and derives the
sending ID, with optional customization before creation. Publisher navigation
contains Newsletters, Subscribers, Reports and Publisher settings; native
campaign/journey navigation appears inside an opened newsletter instead.
Infrastructure, cross-publication rules, suppression, tracking, migration and
diagnostics remain in Publisher settings with administrative forms collapsed.
Cross-publication search and reporting have separate views. Matched mailboxes
are not verified unique people; publication subscriptions must not be conflated
with either measure.

Explicit cross-publication rules may match source events/links/conditions, map
fields, find/create an independent destination subscriber, subscribe and enter
its native welcome journey. This is audited coordination, not synchronization.
Stable event/per-subscriber action identity, persisted progress and native
workflow IDs prevent duplicate subscriptions/restarts. Existing destination
opt-outs and publisher blocks remain effective.

Sending connections contain a newsletter's `{slug}-ditto` subuser,
`{slug}@roninpublishing.com` administrative email, restricted sending key,
authenticated sender/domain and signed callback settings. Management credentials
are separate, encrypted and never returned by ordinary registry responses.
Physical IPs, pools and route assignments remain separate resources; multiple
newsletters can share one dedicated IP and move routes without rebuilding
campaigns. All actual send paths use a durable shared-IP admission budget;
external traffic outside Ditto precludes a hard aggregate-limit claim.

Ordinary unsubscribes are newsletter-specific. Spam complaints block marketing
publisher-wide; explicit publisher opt-outs/manual blocks and genuinely permanent
invalid mailboxes have central controls. Temporary/policy failures must not
become permanent invalid-address blocks. Connection-specific raw signature
verification and durable send correlation, not callback metadata, assign events.
Queued mail is not sent; unknown acceptance never authorizes blind retries.
Current explicit Liquid contact/hash URL tokens and observed engagement semantics
remain unchanged.

Implementation acceptance (local verification complete; live cutover gated):

- [x] Prove independent contact updates/imports and newsletter-only unsubscribes.
- [x] Prove A-to-B automation, mapped-field isolation and once-only native welcome entry.
- [x] Prove publisher suppression and concurrent physical-IP admission across newsletters.
- [x] Prove route changes preserve campaigns and pinned attempts.
- [x] Prove signed callback attribution/deduplication across connections and credential changes.
- [x] Verify the real management UI, shared HTTP API and publisher-bound MCP operations.

Local verification passed 136 focused backend/API Jest tests and 10 MCP tests,
including actual Temporal journey progression. The production TypeScript build
passed for isomorphic-lib, backend-lib, API, dashboard, MCP and Lite; backend-lib
was rebuilt after the final database-clock scheduling fix. Browser verification
used an isolated combined Lite-style server/database: newsletter creation,
newsletter-scoped native home, return to management and local sending-connection
registration worked through real controls. A real publisher-bound stdio MCP
process discovered 133 tools, created a newsletter, ingested a native event and
verified that event was absent from another newsletter. No preview/production
deployment, live-contact migration, provider mutation, IP reassignment, purchase
or real email send was performed. These checks do not certify the live SendGrid
account, its dedicated IPs, DNS or administrative group.

UI simplification verification: the dashboard production TypeScript build passed.
Real browser controls proved name-only newsletter creation with a derived sending
ID, opening the independent newsletter and returning to management, separate
reporting measures, collapsed publisher actions and comma-separated domain entry
persisted into a local draft connection. The publisher home redirect no longer
adds the dashboard base path twice. Verification used only the isolated fixture
database; no provider operation or email send occurred.

AI Stock News is the first controlled adoption: its existing `aistocknews-ditto`
subuser, restricted key, authenticated domains and administrative group must be
inspected and adopted, never recreated. The read-only local inventory found only
the RONIN preview workspace and no configured SendGrid API/webhook key. This is
not a live account audit or an actual AI Stock News migration.

The read-only preflight against the isolated proof registry exited 2 (incomplete):
the SendGrid management account/runtime credentials were not configured and
external administrative-group metadata was unavailable. It reported
`read_only_no_resources_mutated`. Live resource inspection/adoption remains a
release prerequisite, not a completed migration.

Deployment, live-contact migration, provider changes, IP reassignment, purchases
and real campaign sends remain separate explicit release gates. Provider-write,
IP-reassignment and real-send flags default closed; no IP purchasing operation
is automatic. Run the read-only `newsletter-cutover-preflight` before release.
See [newsletter operations](packages/docs/guide/newsletters.mdx) for the approved
structure, operations, worker requirements, safety boundaries and cutover steps.

## Consolidated source integration: verified, not deployed

The complete source integrates the previously unpublished teardown/UI commits,
Google accounts, scoped API/MCP, Telnyx, engagement/owned tracking, explicit URL
tokens, newsletters and the branded tracking Worker. PRs #1 and #2 are merged;
the final integration preserves the concurrently reconciled main history rather
than replacing its authorization, context, schema or fixture changes.

Integration regressions closed generic-secret credential escalation,
legacy-workspace contact erasure, asynchronous Telnyx projection crossing erasure
locks, retargeted automation erasure, and late CC/BCC receipts recreating erased
evidence. Real-controller regressions also cover schema-compatible authorization
denials preserving public `no_access` / `forbidden` codes for lost membership,
foreign Origin and insufficient role. An unreachable duplicate Google-context
case was removed. API/dashboard CI repairs preserve optional middleware guards,
protected event-time properties and per-send history; click/open cell renderers
now have stable React identities.

Observed local verification on 2026-11-23:

- All nine test-inclusive workspace checks passed, including the reconciled
  main candidate. Production editor/dashboard builds and the configured API,
  dashboard, isomorphic-lib, admin-cli and worker lint gates passed. Non-blocking
  lint/dependency/framework warnings remain; they are not claimed resolved.
- 765 Jest cases passed across 58 affected/integration suites; 10 MCP cases and
  10 native workerd cases passed: 785 passing cases total. Two existing skips
  remain: journey re-entry after pause and inline file rendering. Resource-bounded
  recycling workers completed the run after initial Jest heap exhaustion.
  Reconciled-main checks passed 121 assertions; all 12 Google authorization
  cases passed after the final real-controller error-contract repair.
- Fresh disposable PostgreSQL applied all 18 ordered migrations through `0017`
  and verified an idempotent reapply. No existing instance was migrated.
- Actual HTTP plus spawned stdio MCP proved 133 tools, including 47 read-only
  tools, native ingestion, newsletter creation, direct-child/foreign-tenant
  isolation, write denial and immediate API-key revocation.
- The production combined Lite UI, using an isolated shared-login fixture,
  proved creation/open/return, reports, pending-only tracking and local draft
  connection registration. Comma-separated domains persisted and key responses
  remained redacted. This is not authenticated real Google-team acceptance.
- The Google-mode checked-in schema/navigation documents all 301 registered
  HTTP operations. The reproducible code inventory records 6,422 function-like
  nodes across 688 package sources. Obsolete generated endpoint pages were
  removed; handwritten guides remain.

Owned proof databases, credentials, containers, browser tab and servers were
removed/stopped. The existing Google preview, its sessions/data and its private
client configuration were left unchanged. Its observed ClickHouse memory
pressure was isolated from verification, not hidden by restarting or retuning
that instance.

No deployment, release/image publication, production migration, provider write,
DNS/TLS change, IP purchase/reassignment, live-contact migration or external
email occurred. Production provider inventory/adoption, public origin/hosting
and real second-account Google/team acceptance remain explicit release gates.

## Production runtime: Temporal Cloud, ClickHouse Cloud and Neon

Production runs on droplet `129.212.198.152` as the app-only Compose project
`dittofeed-production` (see [scripts/deploy/README.md](scripts/deploy/README.md)),
with Neon PostgreSQL and Temporal Cloud. ClickHouse Cloud is provisioned and
verified as the target, but **production has not been switched to it**: its
runtime env still points at its current ClickHouse, and moving it requires copying
existing data before changing `/etc/dittofeed/runtime.env`.

- Temporal Cloud: optional `TEMPORAL_API_KEY` enables TLS and API-key authentication
  for the client, the native connection and the worker. Without it, the connection
  options are unchanged. A read-only check against namespace `ditto.lrwcc`
  succeeded on 2026-11-24. That namespace already runs workflows, so a local worker
  pointed at it shares production work; use a separate dev namespace for local work.
- ClickHouse Cloud: service `ditto-email`, AWS us-east-1, Mini tier (1 replica)
  with managed backups. Databases `dittofeed` (production target, empty) and
  `dittofeed_dev` (local development).
  Users: `dittofeed_prod` (production only), `dittofeed_dev` (dev only), and agent
  users `claude` and `pepper` (full dev, read-only production). Boundaries were
  verified with real reads/writes. Cloud's `default` cannot `GRANT ALL`; grants use
  `GRANT CURRENT GRANTS ON <db>.*`. Select the database with `CLICKHOUSE_DATABASE`.
- Verified on 2026-11-24: app bootstrap created all 23 tables in `dittofeed_dev`
  (Cloud converts engines to Shared*), and 102 ClickHouse-backed Jest cases passed
  against Cloud, including all 75 `computePropertiesIncremental` cases.
- Test teardown drops the configured ClickHouse and PostgreSQL databases. Point
  `NODE_ENV=test`, `CLICKHOUSE_DATABASE` and `DATABASE_URL` at disposable databases
  before running tests; never at `dittofeed`, `dittofeed_dev` or the preview database.
- `docker-compose.lite.yaml` publishes no ClickHouse host ports and requires a
  non-empty `CLICKHOUSE_PASSWORD`; the local preview keeps loopback ports through
  `.tmp/local-preview-compose.yaml` (`!override`). The self-hosted backup runner
  in [deploy/clickhouse](deploy/clickhouse/README.md) stays until production's
  current ClickHouse is retired.
- [ ] Inventory production's current ClickHouse (location, size, backups) read-only.
- [ ] Copy production ClickHouse data to Cloud `dittofeed`, verify row counts, then
  switch `/etc/dittofeed/runtime.env` to `dittofeed_prod`. Copy base tables before
  materialized-view targets so views do not double-count.
- [ ] Upgrade ClickHouse Cloud to a multi-replica tier before live sending.
- [ ] Restrict the ClickHouse Cloud IP access list to the production host at launch.
- [ ] Remove the local ClickHouse service from the production Compose deployment.
- [ ] Rotate the ClickHouse `default` password and keep it out of runtime env files.
