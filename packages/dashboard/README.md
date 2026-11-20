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

## Ronin branding

The dashboard uses a white/light theme with the supplied logos' burgundy accent
(`#9C1235`). Shared colors and control styling live in `src/themeCustomization`.

Brand assets live in `public/branding/ronin/`. `originals/` preserves all four
supplied PNGs; the cropped, resized `ronin-logo.png`, `ronin-mark.png`, and
`ronin-favicon.png` use the transparent burgundy-accent pair without recoloring.
Replace those web assets when updating the brand artwork, keeping their aspect
ratios and transparent backgrounds. The dark-background originals are not used
on the light interface.

White-label document titles, favicons, navigation branding, and navigation-card
opt-outs continue to override the Ronin defaults.

## Acknowledgements

This dashboard adapts the code from the following open-source projects:

- [leemunroe/responsive-html-email-template](https://github.com/leemunroe/responsive-html-email-template)
- [Mantis Free - React Admin Dashboard Template](https://github.com/codedthemes/mantis-free-react-admin-template)

These projects' licenses can be found in the `licenses` directory.
