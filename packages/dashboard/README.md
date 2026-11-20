# Dashboard

This project is the internal dashboard used operate Dittofeed.

It depends upon Dittofeed's API, which also utilizes shared packages.

## Retained, hidden Push functionality

Push Notifications are hidden in the dashboard, regardless of
`enableMobilePush`. `src/lib/channelVisibility.ts` owns this dashboard-only
policy; explicit creation menus also omit Push. Template/group lists, resource
pickers, the command palette, journey editors, broadcasts, and analysis choices
do not expose Push configuration.

The reserved Push template route returns 404 without loading workspace data.
All subscription-group routes, including upload and membership tabs, reject
saved Push groups through their shared server-side loader. Existing Push journey
nodes and broadcasts show a read-only unavailable notice, without converting or
deleting their configuration.

Firebase/provider code, shared Push types, APIs, workers, stored resources, and
historical delivery evidence are retained. UI hiding is not backend authorization
or a claim that inherited Push sending is fully implemented. Future restoration
requires deliberately restoring dashboard entry points, not changing backend
contracts or migrating saved data.

## Retained, hidden HubSpot integration

HubSpot connection, synced-segment controls, and the Integrations navigation
group are not rendered on Settings, including `/settings#hubspot-integration`.
Settings no longer fetches HubSpot integrations or audience segments solely to
populate those controls. Documentation no longer advertises HubSpot onboarding.

`src/lib/oauth.ts`, `/oauth2/callback/hubspot`, integration APIs, saved
configuration, token refresh, and synchronization workers remain intact. The
OAuth callback is a backend continuation endpoint, not a settings screen; hiding
HubSpot must not interrupt an in-flight authorization or existing integrations.
Restoring its dashboard UI is a separate product decision.

## DITTO Email Client branding

The dashboard uses a white/light theme with the supplied logos' burgundy accent
(`#9C1235`). Shared colors and control styling live in `src/themeCustomization`.

The full-width header identifies the product as `DITTO Email Client`. On desktop,
the Ronin wordmark and product name sit above the left navigation column in a
fixed drawer-width section, with the drawer toggle alongside them. Search and
workspace/profile controls occupy the separate content-toolbar section. The
desktop drawer reserves the same toolbar-height space, while its width still
controls the main-content offset. Collapsing the drawer does not shift the brand.
Smaller screens use the compact Ronin mark and name at the left of the header;
the temporary mobile drawer retains its overlay/backdrop behavior.

Search, return navigation, workspace/profile controls, and mobile navigation
remain available. The default sidebar does not repeat the brand card; sign-in
retains the Ronin logo and product name. The default document title and
description are `DITTO Email Client`, with the Ronin favicon.
The first navigation entry is Home (`/home`).

The upstream GitHub shortcut, hard-coded upstream pull-request link, and
Documentation/Contact Us support navigation are not exposed in the shell.
Source-control providers and backend functionality are unchanged.

Brand assets live in `public/branding/ronin/`. `originals/` preserves all four
supplied PNGs; the cropped, resized `ronin-logo.png`, `ronin-mark.png`, and
`ronin-favicon.png` use the transparent burgundy-accent pair without recoloring.
Replace those web assets when updating the brand artwork, keeping their aspect
ratios and transparent backgrounds. The dark-background originals are not used
on the light interface.

White-label document titles, favicons, navigation branding, and navigation-card
opt-outs continue to override the defaults. Valid white-label configurations
retain their custom sidebar/sign-in card and suppress the default header brand,
including when their navigation card is explicitly omitted.

## Home dashboard

`/dashboard` lands on `/dashboard/home`. Home reads the current workspace's
declarative journey/segment counts, non-archived broadcast count, and five most
recent declarative journeys. These are saved-resource counts, not invented
delivery, click, or open statistics. They refresh on page load.

Quick-access links open templates, journeys, broadcasts, and deliveries. Recent
journey links use the existing journey-editor router.

Shared-password sessions show workspace controls rather than a synthetic
Anonymous person; genuine member identities remain visible when available.
Individual accounts are a separately approved follow-up, documented in the
[account-system plan](../docs/ACCOUNT_SYSTEM_PLAN.md).

## Acknowledgements

This dashboard adapts the code from the following open-source projects:

- [leemunroe/responsive-html-email-template](https://github.com/leemunroe/responsive-html-email-template)
- [Mantis Free - React Admin Dashboard Template](https://github.com/codedthemes/mantis-free-react-admin-template)

These projects' licenses can be found in the `licenses` directory.
