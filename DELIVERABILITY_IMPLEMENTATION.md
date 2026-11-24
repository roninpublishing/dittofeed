# Deliverability health: implementation brief

Audience: the Claude Code agent implementing this. Read [AGENTS.md](AGENTS.md),
[FORK_PLAN.md](FORK_PLAN.md) and [DELIVERABILITY_PLAN.md](DELIVERABILITY_PLAN.md)
(research and vendor comparison) first. This brief is the final decision and
the build spec; where the two differ, this one wins.

## Decision

Build our own modular deliverability section. Buy only what can't be built.

| Signal | How | Cost |
|---|---|---|
| Asset registry (IPs, domains, providers, dedicated/shared, newsletter associations) | Build | — |
| First-party delivery rates per IP and newsletter | Build on the existing `getPublisherDeliveryHealth` | — |
| DNS posture (SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI, PTR/forward-confirmed rDNS) | Build | Free |
| Google Postmaster Tools API **v2** (domain stats and compliance status) | Build | Free |
| Microsoft SNDS (per dedicated IP) | Build | Free |
| IP and domain blocklists | **HetrixTools** Blacklist Monitor API (v2) | ~$10/mo |
| Alerts | Build (Temporal job, sent to Better Stack and email) | — |
| DMARC aggregate (`rua`) reports | **Deferred** (phase 6) | — |
| Spam traps, inbox placement seed tests | **Not built.** These need a vendor (GlockApps or Mailgun Optimize) and may be added later as another source. | — |

Mailgun Optimize remains a possible future source (its API covers all of the
above), but isn't used now because monitoring beyond 1 IP and 1 domain is
quote-only.

## Hard rules

These come from AGENTS.md and the current operating state. Don't break them.

- **No production changes.** Don't deploy, migrate production, edit
  `/etc/dittofeed/runtime.env`, or touch the production droplet
  (`129.212.198.152`). Another session owns production rollout. Ship code to a
  branch and a PR or merge, and leave deployment to the operator.
- **Read-only toward providers.** No SendGrid, Telnyx, SES, Cloudflare, Google or
  Microsoft writes. No IP purchase, reassignment or warm-up changes. No email
  sends or test sends. Inventory sync is GET only.
- **Default off.** Every signal source is disabled per publisher until
  explicitly enabled. Missing configuration shows **unknown**, never healthy.
- **Secrets.** Store source credentials encrypted with
  `encryptNewsletterSecret` / `decryptNewsletterSecret`
  (`packages/backend-lib/src/newsletterSecrets.ts`). Never return them in API
  responses, and never log them. Local config goes in the single root `.env`
  (no side env files).
- **Isolation.** Work in your own git worktree off `origin/main`. Another
  session works in the main checkout and pushes to `main`; don't edit its files
  or reuse its branches.
- **Tests drop databases.** Jest teardown runs `DROP DATABASE` on the
  configured ClickHouse and PostgreSQL databases. Before any test run, export
  `NODE_ENV=test`, `CLICKHOUSE_DATABASE=dittofeed_test_<something>` and a
  `DATABASE_URL` pointing at a throwaway database. Never run tests against
  `dittofeed`, `dittofeed_dev` or the preview database. Local test Postgres is
  the Colima Docker instance on `127.0.0.1:15432`. For ClickHouse, use the Cloud
  admin credentials in `.env` with a throwaway database name.
- **Removals and unknowns.** Don't infer health from absence. Label every status
  with its source and observation time. A vendor "score" is that vendor's
  opinion. Google no longer provides reputation scores; don't invent one.
- New backend `Error` subclasses must restore their prototype (AGENTS.md).

## Existing code to build on

- `packages/backend-lib/src/db/publisherSchema.ts`: `publisher`, `newsletter`,
  `newsletterTrackingDomain`, `publisherSendgridAccount`, `sendingConnection`
  (`senderDomains`), `sendingIp` (address, status, limits, warm-up schedule),
  `sendingPool`, `sendingPoolIp`, `sendingPoolBinding`, `newsletterRoute`
  (newsletter → connection + pool), `newsletterSend` (`ipId` used per send),
  `sendingIpBudget`.
- `packages/backend-lib/src/newsletterInfrastructure.ts`: SendGrid client
  (`clientFor`, around line 196) already reads `/ips?subuser=`, `/ips/pools`
  and `/whitelabel/domains` (including `whitelabeled` = rDNS verified). Reuse it
  for inventory sync.
- `packages/backend-lib/src/newsletterReporting.ts`:
  `getPublisherDeliveryHealth`, first-party per-IP and per-newsletter event counts
  from ClickHouse. Mounted at `/delivery-health` in
  `packages/api/src/controllers/publicationsController.ts`.
- Migrations: `packages/backend-lib/drizzle/`, latest `0017_newsletter_tracking_domains`.
  Yours start at `0018`. Additive only.
- ClickHouse tables: created in `createUserEventsTables`
  (`packages/backend-lib/src/userEvents/clickhouse.ts`). Add yours the same
  idempotent way. Production ClickHouse is self-hosted today, and Cloud converts
  engines to Shared* automatically, so use plain MergeTree-family DDL.
- Temporal: workflows are exported from
  `packages/backend-lib/src/temporal/workflows.ts` and activities from
  `temporal/activities.ts`. `globalCronWorkflow` and `startGlobalCron`
  (`computedProperties/computePropertiesWorkflow/lifecycle.ts`) show the
  scheduling pattern.
- API: product controllers are registered once in
  `packages/api/src/buildApp/router.ts` (`registerProductControllers`) for both
  browser and workspace-bearer APIs. MCP tools and `/api/admin/operations` are
  generated from that registration, so new read endpoints become read-only MCP
  tools automatically. Check the scope mapping in `apiOperations`.
- Dashboard: publisher navigation is
  `packages/dashboard/src/components/menuItems/publisher.ts`; opened-newsletter
  navigation is `menuItems/main.ts`; publisher views live in
  `components/publications/management.tsx` and `pages/publications.page.tsx`
  (sections are selected by `?view=`).

## Data model (migration 0018, additive)

1. **`DeliverabilitySource`**: per publisher, per source.
   `id, publisherId, kind (dns_posture | hetrix_blocklist | google_postmaster |
   microsoft_snds | sendgrid_inventory), enabled (default false),
   encryptedCredentials, config jsonb, lastRunAt, lastSuccessAt, lastError,
   createdAt, updatedAt`. Unique `(publisherId, kind)`.
2. **`SendingIp` additions** (nullable, non-breaking): `provider`
   (`sendgrid | telnyx | ses | smtp | unknown`), `providerAccountRef`,
   `kind` (`dedicated | shared | unknown`, default `unknown`), `ptrHostname`,
   `ptrVerified` (bool), `inventorySource` (`synced | manual`), `lastSeenAt`.
   Don't change existing columns or routing behavior.
3. **`DeliverabilityDomain`**: `id, publisherId, domain, roles text[]`
   (`from | return_path | dkim | tracking | link`), `postmasterVerified`,
   `createdAt, updatedAt`. Unique `(publisherId, domain)`. Populate from
   `sendingConnection.senderDomains`, `newsletterTrackingDomain.domain`/`hostname`,
   and SendGrid authenticated-domain details (return-path and DKIM hosts).
4. **`DeliverabilityHealth`**: latest per asset per source.
   `publisherId, assetType (ip | domain), assetId, source, status (good |
   warning | critical | unknown), metrics jsonb, reason text, observedAt,
   staleAfter`. Primary key `(assetType, assetId, source)`.
5. **ClickHouse `deliverability_observations`** (append-only history):
   `publisher_id, asset_type, asset_id, asset_key (IP or domain), source,
   metric, value Float64, status, observed_at DateTime64(3), inserted_at`.
   Partition by month, order by `(publisher_id, asset_type, asset_key, source, metric, observed_at)`.

Newsletter associations are **derived, not stored**:
- IPs: `newsletterRoute.poolId` → `sendingPoolIp`, plus distinct
  `newsletterSend.ipId` from the last 30 days (historical use).
- Domains: the newsletter's `sendingConnection.senderDomains`, its tracking
  domain, and registry domains linked through those.

## Source adapters

`packages/backend-lib/src/deliverability/sources/`, all implementing:

```ts
interface HealthSource {
  kind: DeliverabilitySourceKind;
  covers: ("ip" | "domain")[];
  configSchema: TSchema;            // TypeBox; validates config and credentials
  cadenceSeconds: number;
  collect(ctx: SourceContext): Promise<SourceResult>; // read-only
}
interface SourceResult {
  observations: Observation[];      // to ClickHouse
  health: HealthUpsert[];           // latest status per asset
}
```

1. **`sendgridInventory`** (daily, plus on demand): for each connection,
   `GET /ips?subuser=`, `/ips/pools` and `/whitelabel/domains`. Upsert
   `SendingIp` provider fields: `kind = dedicated` for IPs assigned to our
   subuser or account, otherwise shared or unknown. Set `ptrVerified` from
   `whitelabeled` and fill `DeliverabilityDomain` roles. Never create or modify
   provider resources. A missing SendGrid API key means the source is
   unconfigured, not an error.
2. **`dnsPosture`** (hourly, plus on demand), using Node `dns/promises`:
   - SPF: present, valid syntax, under 10 lookups, includes the provider.
   - DKIM: the provider's selectors resolve.
   - DMARC: present; policy (`none` is a warning, `quarantine`/`reject` is
     good); `rua` present.
   - MTA-STS and TLS-RPT: present (info only).
   - BIMI: optional, info only.
   - IPs: PTR exists and forward-confirms.
   - Tracking domain: CNAME as expected.
   Record the reason for every non-good result.
3. **`hetrixBlocklist`** (hourly sync of results; HetrixTools checks on its own
   schedule): with the HetrixTools v2 API key, ensure a blacklist monitor exists
   for each registry IP and domain. This is the only external write allowed, it
   goes to HetrixTools only, and it's idempotent. Read the listing status. Any
   listing is critical; record which lists. If HetrixTools is unconfigured,
   status is unknown. Docs: <https://docs.hetrixtools.com/tag/blacklist-monitor-api>.
4. **`googlePostmaster`** (daily):
   - Postmaster Tools API **v2 only**, because v1 `trafficStats` is being
     retired. `domains.domainStats.query` for the last 7 days, plus
     `domains.getComplianceStatus`.
   - OAuth 2.0 with scope `postmaster.traffic.readonly`. Store the refresh
     token encrypted. Add an operator "Connect Google Postmaster" flow, separate
     from the app's Google sign-in client.
   - Thresholds: spam rate ≥ 0.1% is a warning, ≥ 0.3% is critical. Any
     compliance requirement at `NEEDS_WORK` is a warning.
   - Domains not verified in Postmaster, or with no data (under 50 Gmail
     recipients a day), are **unknown** with that reason.
   - There's no reputation field in v2. Don't add one.
   - Docs: <https://developers.google.com/workspace/gmail/postmaster/guides/migration-v2>.
5. **`microsoftSnds`** (daily): fetch the operator-supplied automated-access
   data URL from the **new** SNDS portal (old URLs were deprecated June 2026).
   Parse the CSV: IP, date range, filter result (green, yellow, red), complaint
   rate, message counts. Green is good, yellow a warning, red critical. IPs
   absent from the feed are unknown (shared or low volume). Trap counts were
   removed in July 2026, so don't expect them.
6. **`firstParty`** (on read, no external calls): wrap
   `getPublisherDeliveryHealth` per IP and per newsletter over 7 days. Configurable
   thresholds, starting at: hard-bounce rate ≥ 2% warning, ≥ 5% critical;
   spam-report rate ≥ 0.1% warning, ≥ 0.3% critical; minimum volume before
   judging is 500 sends, otherwise unknown.

Thresholds live in `deliverability/thresholds.ts` as versioned config.

**Roll-up**: an asset's overall status is the worst non-stale source status.
Stale data (past `staleAfter`) becomes unknown. When nothing is configured, the
asset is unknown. Expose the driving source and reason.

## Scheduling

One `deliverabilitySourceWorkflow` per enabled `(publisherId, kind)`, started
or stopped when a source is enabled or disabled, looping on `cadenceSeconds`
with `continueAsNew`, plus a `runDeliverabilitySourceNow` signal for on-demand
runs. Activities do the I/O, with bounded retries and timeouts. Disabling a source stops
its workflow; existing health rows stay but go stale and become unknown.
Workers must be enabled for this to run. Production workers are currently off
during a rollout, and that isn't yours to change.

## Alerts

When an asset's overall status worsens, or a source fails 3 times in a row,
emit an alert record and send it to configured channels: email to operator
addresses (through the existing non-newsletter transactional path only if one
exists; otherwise log-only for now) and a Better Stack outgoing webhook URL
stored encrypted on the publisher. Deduplicate by
`(asset, source, status)` per 24 hours. Recovery sends a single
"resolved" notice. **Don't send email as part of tests.**

## API (read endpoints become MCP tools automatically)

Under the publications controller (or a new `deliverabilityController`
registered in `registerProductControllers`), scoped to the publisher workspace:

- `GET /deliverability/overview`: counts by provider and dedicated/shared;
  health counts by status for IPs and domains; recent status changes.
- `GET /deliverability/ips`: IP, provider, dedicated/shared, pools, newsletters
  (current and 30-day historical), warm-up stage, PTR, per-source status,
  first-party 7-day rates, overall status and reason.
- `GET /deliverability/domains`: domain, roles, newsletters, DNS posture,
  Postmaster spam rate and compliance, blocklist status, overall.
- `GET /deliverability/assets/{type}/{id}/history?days=`: from ClickHouse.
- `GET /deliverability/sources`: per source: enabled, configured (boolean,
  never secrets), last run, last success, last error, freshness.
- `PUT /deliverability/sources/{kind}` (write scope): enable or disable, set
  config and credentials.
- `POST /deliverability/sources/{kind}/run` (write scope): run now.
- Newsletter-scoped: the same IP and domain endpoints with `newsletterId`,
  filtered to that newsletter's derived associations.

## UI

**Publisher level**: add **Deliverability** to
`menuItems/publisher.ts` (between Reports and Publisher settings), routed as
`/publications?view=deliverability`, with tabs:
1. **Overview**: cards for IPs by provider × dedicated/shared, status counts,
   domains by status, recent changes, and source freshness warnings.
2. **IPs**: sortable table matching the API fields. Status chips show the source
   and observation time on hover. Shared IPs are visibly marked, with fewer signals.
3. **Domains**: sortable table.
4. **Sources**: enable, configure and run each source. Credentials are
   write-only fields. Google Postmaster has a Connect button.

Link to the existing Publisher settings **IP pools** and **Tracking domains**
tabs instead of duplicating management.

**Newsletter level**: add **Deliverability** to the opened-newsletter navigation
(`menuItems/main.ts`, under Reporting). It's a read-only view of that
newsletter's IPs and domains and its own first-party rates.

Match the existing compact Ronin UI density and component patterns.

## Phases and acceptance

Do these in order. Each ends with passing checks and a commit.

1. **Registry, schema and inventory**: migration 0018, `sendgridInventory`, domain
   derivation, overview/IPs/domains endpoints using first-party data only,
   publisher and newsletter views. *Accept*: fresh-database migration plus an
   idempotent reapply; inventory sync against a mocked SendGrid; association
   derivation tests (route pools plus historical sends); unknown shown when
   nothing is configured; dashboard builds.
2. **DNS posture**. *Accept*: resolver mocked in tests covering good, warning
   and critical for each check; roll-up tests including stale data becoming unknown.
3. **HetrixTools blocklists**. *Accept*: mocked API tests for idempotent monitor
   creation and listing parsing; unconfigured shows unknown.
4. **Google Postmaster v2**. *Accept*: OAuth connect flow with the token stored
   encrypted; mocked `domainStats.query` and `getComplianceStatus`; threshold
   tests; an unverified or no-data domain shows unknown.
5. **Microsoft SNDS**. *Accept*: CSV parsing fixtures (green, yellow, red,
   missing IP); unknown for IPs absent from the feed.
6. **Alerts**, then optionally **DMARC `rua`** (Cloudflare Email Routing to a
   Worker to an authenticated ingest endpoint; gzip/zip XML parsing). *Accept*:
   deduplication and recovery tests; no sends in tests.

For every phase: `yarn workspace backend-lib check`, the API and dashboard type
checks, lint on changed files, focused Jest suites on throwaway databases, and
a real browser check of the views in the local Lite preview. Record what was
verified in FORK_PLAN.md under a new "Deliverability" section; check items off
only when verified.

## Operator setup (Carson, not the agent)

Each source works as soon as its piece exists; until then, statuses show unknown.
- HetrixTools account and API key.
- Verify sending domains in Google Postmaster Tools; connect through the
  Sources tab.
- Register dedicated IPs in SNDS (new portal) and paste the automated-access
  data URL.
- List the current IPs per provider and whether each is dedicated, to check
  against the inventory sync.

## Out of scope

Warm-up execution, delisting, IP purchasing or reassignment, provider
writes other than HetrixTools monitor creation, spam traps, inbox placement,
production deployment, and any email send.
