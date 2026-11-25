# Open classification and queued capture

## Boundary

Opens only; no send-path changes, click redirects, provider changes or deployments.
Reference: `yuriyward/mail-tracker` at `51ea4e7551564f6ddb55b60a34754863400e9133`.
The separate Open tracking source-doc tab was not supplied. Rules below derive
from that repository; assumptions and operational inputs are recorded here.

## Classifier and networks

Pure classifier and IPv4/IPv6 published-network lookup live in
`isomorphic-lib/src/tracking/`, shared by backend and Worker. Preserve reference
rule order, Gmail proxy and delivery-prefetch rules and 10-second click,
3-second burst, 30-second open/duplicate windows. `isbot` supplements scanner UA
matching. Output is `{ class, reason, counted, rulesVersion }`; classes are
`human`, `apple_proxy`, `gmail_proxy`, `prefetch`, `scanner`, `self`, `unknown`.
These are heuristic labels, never verified humanity. Opens only provide no
cross-link burst evidence. Missing delivery time is unknown, not time zero.
Self classification requires an explicit `OPEN_TRACKING_SELF_IPS` list (up to
256 comma-separated IPv4/IPv6 addresses); no trusted owner identity, seed-inbox
or test-send signal is invented.

Weekly Worker refresh fetches the reference Apple, Google, Microsoft and Mimecast
sources. Proofpoint Essentials retains the reference's pinned published US/EU
ranges because its source requires sign-in; operators must review that list
manually. KV stores immutable versioned sets and an active pointer.
Reject failed, empty, invalid or >20%-smaller source sets, preserving the previous
active set and raising an error without request evidence. Missing initial data
is explicit in the evidence; it does not invent network matches. The committed
reference ranges can bootstrap local fixtures, not pretend a successful refresh.

## Envelope v2 and queue

One queue message is `{ v: 2, eventId, hostname, token, method, query, headers,
edge: { receivedAt, remoteAddress?, httpVersion?, tlsVersion?, asOrganization?,
asn?, country?, networkSetVersion?: string | null, network?: { id, version } } }`.
`networkSetVersion: null` distinguishes missing KV data from an unmatched IP in
an active set. `eventId` is a random UUID stable
across retries. Header/query bounds and token/hostname/path checks remain. Edge
values come from Cloudflare metadata, never forwarded origin request headers.
No Cookie, Authorization, Referer or full URL enters the envelope. No raw request
or capability is logged.

For enabled, correctly configured branded GET/HEAD pixels, return no-store GIF
without waiting for network lookup, queue enqueue or backend acknowledgement;
`ctx.waitUntil` handles enrichment/enqueue. This deliberately means unknown but
well-formed tokens receive a GIF. Invalid routing remains closed. Cloudflare
Queues retries failed consumers; enqueue failure remains an observable failed
background task, not a false durable-receipt claim.

Consumer batches POST `{ v: 2, events: [...] }` (1–50 events, <= 1 MiB) to
`/api/public/email/open/batch`. Sign exact body bytes using the existing
`HMAC-SHA256(secret, timestamp + '.' + body)` scheme and headers, five-minute
signature window. A 204 means every recognized token has durable encrypted
Postgres receipt storage (unknown/deleted tokens are dropped). Retry the batch
on any other status; stable receipt UUIDs make partial-write retries idempotent.
Redirects are never followed. Backend verifies each hostname/newsletter/token
binding, bounds metadata and applies retention to event-time evidence.

## Backend projection

Backend is the only database writer. Extend the existing encrypted receipt
outbox, not the send path or token format. Receipt IDs deduplicate queue retries.
Legacy relay v1 and direct pixel routes stay supported. GET receipts still emit
observed-unqualified `DFEmailOpened`; HEAD receives classification but never a
native open. Classify during outbox drain with workspace erasure barriers held.
Look up earliest correlated provider delivery time where available, using native
`DFEmailDelivered` and persisted newsletter provider receipts; never infer delivery
from send acceptance. Actor history is scoped to workspace/send + IP + UA,
ordered by occurrence time, excluding this receipt and future hits. Persist
classifications in bounded ClickHouse inserts. Original encrypted evidence
remains available under existing scoped access and retention.

## ClickHouse and privacy

`trackingEvent`: receipt `eventId`, `workspaceId`, internal `messageId`, `userId`,
nullable native `newsletterId`, `kind = 'open'`, UTC `occurredAt`, nullable `ip`
and `userAgent`, `asnOrg`, nullable `asn`, `country`, `method`, nullable
`secondsSinceDelivery`, `class`, `reason`, `counted`, `rulesVersion`, network ID
and version. Monthly partitions; `ReplacingMergeTree` keyed by tenant, contact,
occurrence and receipt ID makes crash retries logically deduplicated (queries
use FINAL). No exactly-once physical-write claim.

Column TTLs null IP and UA after 30 days; inserts already older than that contain
nulls. Merge-time TTL is eventual, so reads requiring strict privacy use the
30-day cutoff. Erasure synchronously deletes these rows under the existing
exclusive workspace lock before releasing it; hash-only barriers still prevent
queued retries resurrecting erased contacts. Raw encrypted receipt retention
remains independently configurable and bounded.

## Compatibility and decisions

Keep `DFEmailOpened` / protected `last_opened` as **observed**, including scanner
GETs. Proposal: retain these semantics permanently; future qualified metrics use
classified counted rows under explicitly versioned policy. Do not silently change
existing segment/property semantics. Gmail on-open proxies can count under the
ported policy; Apple MPP, prefetch, scanners, self, unknown and duplicates do not.
Stateless tokens are not needed for this slice: they complicate revocation,
erasure and old-origin correlation; reevaluate only with a separately approved
send-path migration.

## Operator inputs and hand-off

No credentials or public resources are needed for local development. Before any
separately authorized deployment: RONIN-scoped authentication; a Queue plus DLQ;
a KV namespace and weekly cron; backend HTTPS origin; matching private 32-byte
base64 relay secret; existing private SECRET_KEY; verified newsletter dt. domain;
backend worker/global cron and ClickHouse table setup. Enable capture only after
queue/consumer/backend readiness and operational alerting. Failed refreshes must
alert an operator and retain the active set. No provider tracking settings change
is included. Send-path owners may later supply explicit seed/test-send metadata;
this slice never guesses it or edits their files.

Assumptions pending source-doc review: reference proxy reasons map to the requested
expanded classes; reference on-open proxy counting remains; duplicates are
non-counted within 30 seconds for the same send/method/IP/UA; no staff IPs by default;
no late-provider-delivery reclassification or human-rate denominator is invented.
