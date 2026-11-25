# Open classification and queued capture

## Boundary and approved development cutover

Opens only; no click redirects, provider changes, real sends or deployments.
Reference: `yuriyward/mail-tracker` at `51ea4e7551564f6ddb55b60a34754863400e9133`.
The separate Open tracking source-doc tab was not supplied. Rules below derive
from that repository; assumptions and operator inputs are recorded here.

Carson confirmed nothing has shipped and approved retiring the initial separate
mapping/receipt/outbox design. Historical migrations remain; migration
`0019_send_open_tracking` refuses nonempty legacy tables before dropping their
empty development schema. No legacy token compatibility or global-origin
fallback is retained.

## Canonical recipient-send identity

`NewsletterSend` owns `openTrackingTokenHash`, `encryptedOpenTrackingToken` and
`openTrackingOrigin`. Token metadata and tracked transport HTML are created
atomically with that existing row, not a second mapping row. Logical send retries
reuse the original token, origin and payload.

Every actual outbound email must take this tracked recipient-send path. Generic
direct dispatch and shared CC/BCC/multiple-To payloads fail before queuing.
Previews, stored native delivery HTML and view-in-browser remain untracked.
Queueing and submission require valid tracking metadata and capture readiness;
sending/capture gates remain default-off.

## Respond-first Worker and Queue

For enabled, correctly configured branded GET/HEAD pixels, return a no-store GIF
without waiting for KV, enqueue or backend acknowledgement. `ctx.waitUntil`
enriches and enqueues. Unknown well-formed tokens also get a GIF; invalid routing
stays closed. Failed enqueue can lose that hit and must alert an operator.

One message is `{ v: 2, eventId, hostname, token, method, query, headers,
edge: { receivedAt, remoteAddress?, httpVersion?, tlsVersion?, asOrganization?,
asn?, country?, networkSetVersion?: string | null, network?: { id, version } } }`.
Each image request gets a fresh UUID; retries retain that UUID. Selected headers,
queries and all field sizes are bounded. Cloudflare supplies edge metadata;
forwarded origin headers are not actor identity. Cookie, Authorization, Referer,
full URLs, raw evidence and capabilities never enter general logs.

Consumer batches POST `{ v: 2, events: [...] }` (1–50 events, <= 1 MiB) to
`/api/public/email/open/batch`, signing exact body bytes with
`HMAC-SHA256(secret, timestamp + '.' + body)` and a five-minute timestamp window.
No redirects. Any status except 204 retries, eventually reaching the DLQ.
The backend v1 relay and direct pixel bypass are removed.

## Backend persistence and recovery

The backend resolves token hashes against the canonical send and verifies its
original hostname/newsletter. The exclusive workspace erasure lock covers
ClickHouse writes and observed GET projection. PostgreSQL stores no per-hit row
or outbox state: only existing send metadata and newsletter erasure controls.

Every valid GET/HEAD request persists as its own `trackingEvent`, including
repeat loads, proxies and scanners. Classification/count filtering never drops
the row. Unknown/erased tokens are discarded. HEAD is classified but never emits
a native open; every valid GET remains an observed `DFEmailOpened`.

A 204 acknowledges ClickHouse classification and native projection completion.
Partial failure is not acknowledged. On retry, reuse the first durable
classification/evidence, reject conflicting payloads for the same UUID, and
project only missing native GET events. `FINAL` and stable native event identity
provide logical deduplication, not exactly-once physical writes.

## Classifier and published networks

Pure classifier and IPv4/IPv6 lookup live in `isomorphic-lib/src/tracking/`,
shared by backend and Worker. Preserve reference order, Gmail/delivery-prefetch
rules and 10-second click, 3-second burst, 30-second open/duplicate windows.
`isbot` supplements scanner UA matching. Output is
`{ class, reason, counted, rulesVersion }`; classes are `human`, `apple_proxy`,
`gmail_proxy`, `prefetch`, `scanner`, `self`, `unknown`. These are heuristics.

Actor history comes from ClickHouse plus earlier current-batch observations,
scoped to workspace/send/method/IP/UA and ordered by occurrence, excluding self
and future events. Only actual native/provider delivery receipts supply delivery
time; acceptance is not delivery and missing delivery is unknown, not zero.
Opens provide no cross-link burst evidence. Self requires explicit
`OPEN_TRACKING_SELF_IPS` (up to 256 IPv4/IPv6 addresses), with no invented staff,
seed-inbox or test-send identity.

Weekly refresh fetches reference Apple, Google, Microsoft and Mimecast sources.
Proofpoint Essentials uses reference-pinned US/EU ranges requiring manual review
because its source requires sign-in. KV stores immutable versioned sets and an
active pointer. Reject failed, empty, invalid or >20%-smaller sets and retain the
previous active set. `networkSetVersion: null` explicitly records missing initial
data; committed reference ranges may bootstrap fixtures, not a fake refresh.

## ClickHouse privacy and erasure

`trackingEvent` contains event/workspace/message/contact/newsletter identity,
`kind`, occurrence time, bounded network metadata, method, delivery offset,
classification/reason/count/rules version, network version, immutable request
hash, encrypted request evidence and raw expiry. Monthly partitions and
`ReplacingMergeTree` retain logical event history; reads use `FINAL`.

Raw evidence retention defaults to 30 days, configurable 1–365. IP/UA have a
separate fixed 30-day cutoff. Read-time expiry is immediate; column TTL nulling
is eventual. A delayed Queue event still records classification/native history
after raw expiry, without retaining expired raw evidence.

Scoped evidence retrieval requires workspace/contact/message/event identity.
Erasure uses the same exclusive workspace lock, clears canonical send tokens and
synchronously deletes classified/raw rows. Existing hash-only newsletter barriers
prevent queued retries from recreating erased contacts; no new tombstone table.
Native history erasure follows its existing flow. No owned-capture cron remains.

## Observed semantics and operator inputs

Protected `last_opened` stays observed, including scanner GETs; never infer it
from clicks. Future qualified metrics must use an explicitly versioned policy.
Gmail on-open proxies can count under the ported policy; Apple MPP, prefetch,
scanners, self, unknown and duplicate loads do not. No late-delivery
reclassification or verified-human denominator is invented.

No credentials or public resources are needed locally. Before separately
authorized deployment: isolated RONIN authentication, Queue/DLQ, KV/weekly cron,
current application server's HTTPS origin, matching private 32-byte base64 relay
key, private SECRET_KEY, verified newsletter `dt.` hostname, migrations and
ClickHouse setup. Capture shares the existing PostgreSQL/ClickHouse databases;
no separate backend hosting is required. This supersedes the earlier isolation
plan, without authorizing provisioning or deployment.
The existing computed-property worker still materializes `last_opened`.
Enable capture only after consumer readiness and failure/backlog alerting.
Failed network refresh must alert and preserve the active set.

Pending source-doc review: reference proxy reasons map to expanded classes;
on-open proxy counting remains; duplicate identity uses send/method/IP/UA within
30 seconds; staff IPs default empty. No provider-account changes are included.
