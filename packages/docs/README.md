# DITTO Email Client documentation

This directory is the version-controlled home for Ronin Publishing's product
documentation. The inherited Mintlify pages are source material, not a claim
that every upstream feature is supported by this fork.

## Maintenance and publication plan

1. Audit inherited guides against the product decisions and running product.
   Remove retired-provider instructions; retain native ingestion, contacts,
   events, audience segmentation, and supported email workflows.
2. Maintain operator guides for workspace setup and switching, user onboarding
   and permissions, templates, journeys, broadcasts, subscriptions, and delivery
   troubleshooting. Describe actual authentication behavior, not placeholder
   identities.
3. Document click/open evidence and attribution with explicit privacy caveats.
   A pixel load or privacy-proxy request is not proof of a human open.
4. Keep API reference pages aligned with the runtime schemas using the existing
   [API documentation workflow](contributing/updating-api-docs.mdx).
5. Review branding, screenshots, links, and security-sensitive examples before
   publishing an owned documentation site. No Ronin documentation domain or
   deployment is configured by this plan.

The author of each behavior change updates the corresponding guide in the same
change; reviewers check the documented steps against the running application.
Keep source and review history here rather than starting an unversioned wiki.

The dashboard does not link to upstream support or documentation. Restore a
documentation entry only after our maintained site has been reviewed and
published at an owned destination.

## Individual accounts

Google OIDC sign-in and application-owned accounts are implemented. The
[account-system plan](ACCOUNT_SYSTEM_PLAN.md) records the security model;
[Google SSO operations](guide/google-sso.mdx) covers setup, cutover, invitations,
sessions, and operator recovery. Real Google client configuration and browser
verification are required before enabling individual-account login.

## Contributing

cd into docs directory

```bash
cd packages/docs
```

Run the mintlify dev server.

```bash
mintlify dev
```
