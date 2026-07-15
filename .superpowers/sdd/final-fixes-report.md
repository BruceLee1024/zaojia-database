# Final fixes report

## Scope completed

- Normalized every application ES-module edge, including dynamic imports and the HTML entry, to `v=6.2`; added a recursive static graph assertion and updated the README version text/badge.
- Replaced destructive price deletion with append-only withdrawal. Withdrawn records retain immutable price fields and attachment foreign keys, are excluded from current/preferred/selection paths, and clear an existing preference.
- Expanded resource usage to prices, attachments, quota usages, project rows, and duplicate-install aliases. Referenced resources become inactive tombstones under force; only completely unused resources are physically removed.
- Added canonical ID/reference validation before backup export/restore mutation and ownership validation for usage-selected prices. Resource/quota UI IDs now use escaped data attributes and listeners instead of interpolated inline JavaScript.
- Added latest-only search and route-generation/serialized workspace coordination.
- Serialized equipment-package insertion per project and added distinct fully rolled-back versus partial-recovery errors with original and rollback causes.
- Added `installationResourceItemId` and `manualInstallationResourceId` to version snapshots/restores.

## RED evidence

- `node tests/run.mjs` -> `ERR_MODULE_NOT_FOUND` for the wished-for `assets/utils/requestCoordinator.js`.
- Lifecycle test -> expected usage total 4/5, received 2/4 before prices, attachments, and alias refs were counted.
- Concurrent equipment insertion -> expected 6 project lines, received 4.
- Backup hostile selected-price reference -> `Missing expected rejection`.
- Malicious renderer contract -> missing `quotaResourceChoiceHtml` export.
- Alias-only project reference -> expected usage total 5, received 4.
- Withdrawn preferred/equipment/quota selection tests -> `Missing expected rejection` before service-boundary checks.

## GREEN evidence

- `node tests/run.mjs` -> `All tests passed`.
- `git diff --check` -> passed with no output.
- `node --check` passed for the entry point, coordinator, changed services, and changed resource/composition views.
- Static module graph assertion traverses `app.js`, `app/index.html`, and all non-vendor `assets/**/*.js`; every local module edge is exactly `?v=6.2`.
- JSON and ZIP lifecycle roundtrips preserve inactive tombstones and withdrawn prices. Tests also preserve price attachments and immutable price values.
- Malicious IDs containing quotes, script markup, traversal, and overlength payloads are rejected before restore/export mutation; renderer tests prove quote/script payloads remain encoded data.

## HTTP / browser evidence

- Local server: `python3 -m http.server 8765`.
- Two complete HTTP passes over `/app/`, `/app.js?v=6.2`, and every non-vendor application module URL succeeded.
- `HEAD /app.js?v=6.2` -> HTTP 200, `Content-type: text/javascript`.
- Real Chromium smoke/warm-cache/route-race automation was not executable: no Chrome, Chromium, Edge, Playwright, Puppeteer, or Chrome DevTools tool/runtime was installed. The pure coordinator race tests and two-pass HTTP graph verification ran instead; this environment limitation is the only remaining manual verification item.

## Self-review

- Verified resource force removal does not delete quota usages or rewrite valid BOQ foreign keys as missing.
- Verified project-reference accounting includes direct, linked, installation, and manual-installation aliases.
- Verified withdrawn prices cannot be preferred, linked into quota composition, or inserted into a project package.
- Verified rollback queues recover after failures and partial recovery reports the failed rollback causes.
- Secret-pattern scan found no newly embedded credential.

## Second final review fixes

### RED

- Equipment dialog contract failed at module instantiation because `buildEquipmentPackageDialog` did not exist; the pre-fix popup also rendered withdrawn prices and raw project/price/quota option values.
- Latest workspace contract failed at module instantiation because `createLatestWorkspaceCoordinator` did not exist; the prior per-route serialized queue made fast B wait for slow A.
- Cross-project equipment tests reproduced whole-table lost updates and proved a failed project transaction could roll back over another project's successful insertion while queues were keyed per project.
- Backup semantic cases initially accepted hostile `projects.id`, hostile `quota_items.id`, hostile `project_boq.projectId`, and preferred prices that were missing, belonged to another resource, or were withdrawn.
- Price lifecycle contract initially had no public `withdraw(id)` method.

### GREEN

- Equipment package `replaceAll` transactions now share one global `project_boq` queue. Tests cover concurrent success across two projects and a failed A whose full rollback completes before successful B, without overwriting B.
- Latest workspace renders now start concurrently. Fast B settles without waiting for slow A; a late A is rejected and the latest committed workspace nodes are atomically reattached, preserving B's DOM event listeners and route chrome.
- Every business-store record now requires a canonical ID. Known scalar/array foreign keys, including nested version lines, use the same grammar and length boundary before export/restore mutation.
- Backup validation rejects missing, cross-resource, and withdrawn preferred prices.
- Equipment project popup escapes project, price, and quota option values, excludes withdrawn prices, and renders an accessible disabled state when none remain.
- `resourcePriceService.withdraw(id)` is the primary lifecycle API; `remove(id)` remains only as a deprecated compatibility alias, and UI actions call `withdraw`.
- Final verification after the second review: `node tests/run.mjs` -> `All tests passed`; `git diff --check` and changed-file `node --check` passed.
