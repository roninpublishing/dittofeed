# DITTO Email Client account system

Status: planned, not implemented. Carson approved a dedicated follow-up for
individual accounts. Ronin will own the application account and workspace model;
Google OAuth/OIDC is a possible sign-in method, not a selected dependency.

## Existing behavior and boundaries

The local instance uses a shared administrator password. Its session resolves to
a synthetic `anonymous` member; it is not an individual account. The dashboard
must present this as workspace access, not invent a person's identity.

Reuse the existing `workspaceMember`, workspace membership/role, and provider
account records where their contracts fit. Preserve workspace IDs, contact/event
data, configuration, delivery history, and migrations. Do not enable
`multi-tenant` mode as an authentication shortcut: the inherited profile decoder
is not a signature-verifying authenticator, and documented EE login handling is
not implemented by the local Lite server.

## Implementation requirements

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
- If Google sign-in is selected, implement the OIDC authorization-code flow with
  PKCE, state, nonce, and issuer/audience/signature/expiry validation. Keep client
  secrets server-side and permit only configured redirect destinations.
- If local passwords are selected instead, add an appropriate salted password
  KDF, secure enrollment/change/recovery, anti-enumeration responses, and abuse
  protection. Do not store plaintext passwords or repurpose the shared instance
  password as everyone's credential.
- Carry a real member identity in revocable sessions. Rotate on sign-in, expire
  sessions, and invalidate them on sign-out, credential reset, and account
  disablement. Use HttpOnly/Secure cookies and explicit SameSite/CSRF protections
  suitable for the chosen login flow.
- Add account/profile, sign-in/sign-out, invitation acceptance, recovery, and
  administrative membership screens. Preserve the workspace picker and verify
  every requested workspace against the signed-in member's grants.
- Plan an explicit shared-session cutover. Do not retain the synthetic member or
  a shared-password bypass as a hidden fallback after individual accounts launch.

## Decisions before implementation

1. Choose Google OIDC versus native credentials; retain ownership of application
   accounts and authorization in either case.
2. Choose owner provisioning and invitation/recovery delivery or controlled
   handoff, with recovery ownership documented.
3. Define strict invitation admission and any parent/child workspace inheritance.
4. Review migration, rollout, and rollback steps against persisted workspaces and
   the existing API/SSR session bridge.

## Release acceptance

Verify login and logout, rejected forged/expired identities, invitation expiry
and replay rejection, session revocation, account disablement, cross-workspace
isolation, role enforcement, last-administrator protection, and workspace
switching. Exercise the actual browser and API flows; a renamed profile label or
UI-only role check is not proof of an account system.

Update the operator and recovery guides in the same release. Keep credentials,
authentication tokens, cookies, and private identity payloads out of general logs.
