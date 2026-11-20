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

## Acknowledgements

This dashboard adapts the code from the following open-source projects:

- [leemunroe/responsive-html-email-template](https://github.com/leemunroe/responsive-html-email-template)
- [Mantis Free - React Admin Dashboard Template](https://github.com/codedthemes/mantis-free-react-admin-template)

These projects' licenses can be found in the `licenses` directory.
