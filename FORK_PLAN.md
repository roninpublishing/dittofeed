# MCP publication scope

This draft PR contains only the API/MCP task's changes, replayed onto remote
`main` in an isolated worktree. It intentionally does not publish other agents'
uncommitted Telnyx, tracking, Google-account, editor, or dashboard features, nor
the shared local main branch's eleven unpublished commits.

The verification and local-credential statements below describe the integrated
development checkout, not production or a clean checkout of this draft PR.
Tracking-specific API regressions require the tracking prerequisite changes.
The Google callback initialization fix remains in its owning agent's unpublished
file; the PR description records that small fix without copying their feature.
Do not merge or deploy this draft before those prerequisite changes are reviewed.

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
authorization server. Production deployment/credentials and Google Cloud OAuth
client provisioning were not performed. API keys do not secure a deployment whose
browser authentication is left anonymous. See [MCP setup](packages/docs/guide/mcp.mdx) and
[API/code coverage](packages/docs/guide/api-coverage.mdx). Retained tracking,
provider, retention, erasure and unqualified-engagement semantics are unchanged.
