# DITTO Email Client account system

Status: implemented and locally verified; Google Cloud configuration and real
Google browser verification are required before cutover. Google OIDC is the
selected identity provider. Ronin
owns accounts, memberships, roles, invitations, profile names, and revocable
sessions. Google owns passwords, MFA, and Google-account recovery.

## Existing behavior and boundaries

The legacy local mode uses a shared administrator password and synthetic
`anonymous` member. It remains a separately configured mode, never a fallback
inside `AUTH_MODE=google`. Existing shared cookies and decoded bearer profiles
cannot authenticate in Google mode.

Reuse the existing `workspaceMember`, workspace membership/role, and provider
account records where their contracts fit. Preserve workspace IDs, contact/event
data, configuration, delivery history, and migrations. Do not enable
`multi-tenant` mode as an authentication shortcut: the inherited profile decoder
is not a signature-verifying authenticator, and documented EE login handling is
not implemented by the local Lite server.

## Implemented requirements

- Provision the first owner through an operator-controlled bootstrap; do not
  expose unrestricted administrator signup or automatically promote matching
  email domains to Admin.
- Create durable application accounts and explicitly scoped workspace
  memberships. Authentication identifies a person; the application authorizes
  their workspace access and role on every protected operation.
- Use strict, expiring, revocable, single-use invitations bound to the intended
  email, workspace, and role. Store token hashes, not reusable plaintext tokens.
- Enforce permission management on the server. Viewer/Author users cannot grant
  roles or self-promote; removal or demotion cannot strand a workspace without
  an administrator. Decide parent/child membership inheritance explicitly.
- Link external identities by verified issuer/subject, not by an unverified
  email or a decoded token alone. Normalize email consistently and require a
  deliberate, verified account-linking flow.
- Google OIDC uses authorization code + PKCE, state, nonce, and the Google SDK's
  signature, issuer, audience, and expiry verification. Only `openid email
  profile` is requested. Google access/refresh tokens are not application sessions.
  Native passwords are not implemented.
- Carry a real member identity in revocable sessions. Rotate on sign-in, expire
  sessions, and invalidate them on sign-out, explicit revocation, and account
  disablement. Google credential changes require separate app-session revocation.
  Use HttpOnly/Secure cookies and explicit SameSite/CSRF protections
  suitable for the chosen login flow.
- Add account/profile, sign-in/sign-out, invitation acceptance, recovery, and
  administrative membership screens. Preserve the workspace picker and verify
  every requested workspace against the signed-in member's grants.
- Plan an explicit shared-session cutover. Do not retain the synthetic member or
  a shared-password bypass as a hidden fallback after individual accounts launch.

## Selected admission and deployment policy

- The first owner is operator-configured by exact verified email and existing
  workspace ID, only before any Google account exists. Google must be the email
  authority (Gmail or matching verified Workspace `hd`); third-party consumer
  emails additionally need an operator-pinned immutable Google subject.
- Later accounts require an expiring private invitation link, deliberately
  handed off by an administrator. Links carry the secret in a URL fragment,
  not query strings. Email delivery is not claimed.
- Memberships are explicit. Parent/child workspaces do not inherit access.
  Managers can manage Authors/Viewers; Admins manage workspace roles. Removing,
  demoting, or disabling the last enabled administrator is rejected.
- The additive `0015_google_accounts` migration preserves workspace IDs,
  contact/event history, historical provider tables, and earlier migrations.
- Lite passes a server-owned principal to Next. Standalone Next verifies the
  same encrypted account cookie with the same plugin/key and checks the database;
  it never accepts an identity from a header. Split deployments need a
  same-public-origin reverse proxy for dashboard and API.
- Account, sessions, and Team & access screens implement profile editing,
  invitation acceptance, role changes, session revocation, and account disable.

See [Google SSO operations](guide/google-sso.mdx) for setup, deployment,
cutover, and operator recovery.

## Release acceptance

Verify login and logout, rejected forged/expired identities, invitation expiry
and replay rejection, session revocation, account disablement, cross-workspace
isolation, role enforcement, last-administrator protection, and workspace
switching. Exercise the actual browser and API flows; a renamed profile label or
UI-only role check is not proof of an account system.

Update the operator and recovery guides in the same release. Keep credentials,
authentication tokens, cookies, and private identity payloads out of general logs.

## Local implementation proof and launch prerequisites

106 focused account, protocol, permission, invitation, session, privacy, and
signing-key cases passed across six suites against isolated test resources.
Google protocol cases used local signing keys/certificate transport doubles
while executing the real SDK verification and database logic; this is not a
claim of a real Google login. Package builds and scoped zero-warning lint passed.

An isolated real Google-mode API/Next runtime rendered the Ronin-branded sign-in
and invitation screens, fit a 390-pixel viewport without horizontal overflow,
redirected an unauthenticated Home request to sign-in, returned 401 for protected
template data, and returned a safe `not_configured` 503 for unconfigured sign-in.
The deployment-target regression also verifies account-error identity under the
repository's ES5 compilation target.

The initial RONIN owner is configured locally, but the Google client ID/secret
are not yet configured. The existing shared-login instance was not switched off.
Real Google consent, login, private invitation acceptance, and authenticated
account/team browser verification remain launch prerequisites.

The account migration and its snapshot extend the other agent's currently
uncommitted `0011`–`0014` migration chain. Account changes are isolated on their
own PR branch. Keep that PR draft until the earlier history lands, then integrate
and verify the complete chain before merge/deployment. Do not mix unrelated
provider/tracking/admin implementation into the account-only commit or reorder
already-applied migrations.

See [the complete handoff](../../GOOGLE_SSO_HANDOFF.md) for completed work,
operator steps, and release blockers.
