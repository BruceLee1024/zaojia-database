# Task 6 Report: Dashboard, documentation, regression, and polish

## Status

Implemented and verified Task 6.

## Delivered

- Added `resourceHealthService` with one repository read and one pure aggregation boundary.
  - Active resources with no current price.
  - Expired current or manually preferred price using the browser-local calendar date.
  - Supplier-quote price snapshots without an available attachment linked by `priceId`.
  - Quota usages whose saved resource type, selected price, price value, basis, source, supplier, date/validity, tax, region or installation scope differs from the current resource/price.
  - Every issue returns total/material/equipment counts plus affected resource, type-specific resource, price, usage and quota IDs.
- Reused and exposed Task 1/5 helpers instead of duplicating price selection or quota snapshot comparison.
  - `selectCurrentResourcePrice()` now also fixes the previous UTC-date selection edge by using `localDateKey()`.
  - `getUsageComparisonReasons()` remains the single comparison contract used by quota detail and dashboard health.
- Added an accessible Dashboard “Resource Health” section with four issue rows, counts, material/equipment entry points, and a quota-update entry point.
  - Material/equipment routes prefilter the shared workbench by affected IDs and expose a clear-filter status.
  - Pending quota updates route to the first affected quota and show an explanatory status message; refresh remains explicit.
- Fixed the deferred Task 2 report-tone issue: rolled-back metrics are amber, partial-recovery metrics are red, and success metrics remain teal.
- Added a 320px compact application shell so the page has no horizontal overflow while retaining icon navigation.
- Normalized this change set's module cache chain to `v=6.0`, including parent imports of modified child modules. The root landing page was not changed.
- Updated README with `/app/` versus `/`, price-basis semantics, accepted 20MB attachment formats, IndexedDB and folder attachment layout, legacy JSON versus complete ZIP and 500MB limits, vendored/pinned fflate rationale, backup sensitivity, and expanded manual checks.

## TDD evidence

1. RED: `node tests/run.mjs` failed with `ERR_MODULE_NOT_FOUND` for the wished-for `resourceHealthService.js`.
2. GREEN: added shared price/comparison exports and the focused health aggregation service; full suite passed.
3. RED: dashboard contract failed with `TypeError: resourceHealthSection is not a function`.
4. GREEN: added the dashboard section, route entry points, resource prefilter and quota explanatory state; full suite passed.
5. RED: Task 2 tone test failed because `resourceImport.js` did not export `renderImportReportMetric`.
6. GREEN: metrics now use the report's success/warning/danger tone; full suite passed.
7. RED: quota metadata test expected `['resourceType']` but received `[]`.
8. GREEN: the shared comparison helper now reports a saved/current resource-type mismatch; full suite passed.
9. Browser RED: Chromium measured 320px `documentScrollWidth = 427` for `clientWidth = 320`.
10. Browser GREEN: after the compact shell change, Chromium measured `documentScrollWidth = clientWidth = 320`.

Focused coverage is in `tests/resourceHealth.mjs` and the failure-report assertion in `tests/resourceWorkbench.mjs`; both run from `tests/run.mjs`.

## Automated verification

- `node tests/run.mjs` -> `All tests passed` (exit 0).
- `node --check` passed for every new/modified JavaScript module.
- `git diff --check` passed.

## Real browser evidence

Served with `python3 -m http.server 8026` and tested in isolated fresh browser storage with Chromium `140.0.7339.16` through Playwright `1.55.0` installed under `/tmp` only. No cookies, localStorage values, tokens or API keys were read.

- `/app/` booted to the import hub with zero console errors/warnings, zero page errors, zero failed requests and zero HTTP responses at or above 400.
- Material workbench opened; an isolated test material and supplier-quote price were created successfully.
- Attachment panel rejected a fake PDF by signature with “文件内容与扩展名不匹配”.
- Equipment navigation opened the shared equipment workbench.
- Import hub visibly contained both “导入材料库” and “导入设备库”.
- New quota dialog exposed exactly seven breakdown inputs and the resource-composition shell.
- BOQ quote audit visibly rendered all four groups: resource reference invalid, resource price expired, missing resource price basis and duplicate equipment installation.
- Settings backup tab visibly rendered “恢复备份”, “导出完整 ZIP” and “导出兼容 JSON”.
- Dashboard resource health was visible; the enabled material control had the accessible name “材料 1”, accepted focus, and navigated to the prefiltered material workbench.
- Page-level width checks:
  - 1440: `scrollWidth = clientWidth = 1440`
  - 1024: `scrollWidth = clientWidth = 1024`
  - 768: `scrollWidth = clientWidth = 768`
  - 320: `scrollWidth = clientWidth = 320`

Screenshots were not captured because DOM, interaction, console/network and exact dimension evidence were sufficient; no `output/material-equipment-smoke/` artifacts were added.

## Documentation and self-review

- Confirmed root `index.html` remains the landing page and was not modified.
- Confirmed inactive resources do not generate price/evidence health work; quota usages still report missing/inactive resource references through the shared comparison contract.
- Confirmed a preferred price remains the current price even when expired, so it appears in the explicit expired bucket instead of being misreported as missing.
- Confirmed only attachments with `status: available` and the same `priceId` satisfy supplier quote evidence.
- Confirmed dashboard aggregation is read-only and quota snapshot refresh remains an explicit user action.
- Confirmed route filters use affected IDs rather than reimplementing health rules in views.
- Confirmed failure-report attempted metrics no longer use success coloring.
- Confirmed no secret, token, user backup, screenshot or browser test dependency was committed.

## Remaining concerns

- “Missing quote evidence” intentionally evaluates every supplier-quote snapshot for active resources, including historical snapshots, because each supplier quote is an immutable evidence-bearing record. If the product later wants only the current quote governed, that should be an explicit policy change with a migration/test update.
- The repository still has no committed end-to-end browser harness; this task used a reproducible isolated Chromium smoke run without adding package-manager files to the pure frontend project.

## Review follow-up

All Task 6 review findings were addressed with focused RED/GREEN tests before implementation.

### Fixes

- Split health classification price selection from the operational current-price policy without duplicating ordering logic.
  - Operational selection still prefers a valid preferred reference, then the latest non-expired price.
  - Health classification prefers a valid preferred reference, otherwise the latest price record regardless of expiry.
  - A newer expired ordinary price is therefore classified as expired even when an older price remains operationally valid.
- Added `resourceInactive` to the shared quota usage comparison helper. Inactive referenced resources now enter pending health and the composition UI explains: “资源已停用，请替换或确认处理”.
- Pending quota updates now count unique affected quota IDs for total/material/equipment. Multiple stale usages in one quota retain every usage/resource/price ID but contribute one quota to the total; a mixed material/equipment quota contributes once to each applicable type breakdown.
- Replaced click-only navigation `<div>` elements with native buttons. Every visible navigation control has an accessible name, title and native keyboard behavior; the selected page exposes `aria-current="page"`.
- Health route state is now transient. Explicit health navigation applies affected IDs and the actual labels “缺参考价”, “价格已过期” or “询价缺附件”; ordinary same-library navigation clears only health IDs/label while retaining keyword/category/status/selection filters.
- Advanced the complete modified module chain to cache version `v6.1`.

### Follow-up TDD evidence

1. RED: inactive comparison view-model assertion failed because no visible inactive-resource explanation existed.
2. GREEN: shared comparison emits `resourceInactive`; composition details render the explicit explanation.
3. RED: health helper/module/navigation contracts were absent and route lifecycle retained stale health state.
4. GREEN: added classification option, unique-quota summarizer, route parameter helper/lifecycle and pure native navigation renderer.
5. RED: stricter price case failed with `older !== latest` when an older valid price and newer expired price coexisted.
6. GREEN: `latestRegardlessOfValidity` now selects the newer record for health only while operational selection remains on the older valid price.
7. `node tests/run.mjs` -> `All tests passed`.

### Follow-up Chromium evidence

Served `/app/` at an isolated localhost port and reran Chromium `140.0.7339.16` with fresh storage:

- At 320px the first Tab focused the native “我的概览：继续最近工作” button; Enter navigated to Dashboard and updated `aria-current="page"`.
- All 11 visible navigation entries were native buttons with non-empty `aria-label` and `title`; no click-only `[data-go]` element remained.
- At 320px and 1024px, `documentScrollWidth === documentClientWidth`.
- A real supplier-quote health item navigated to Materials with visible “询价缺附件”; clicking the normal Materials navigation cleared the health status/filter.
- Console errors/warnings, page errors, failed requests and HTTP responses >= 400: all zero.

### Follow-up concerns

- No new unresolved concern was found. Historical supplier-quote evidence policy remains the documented product-policy question from the original report.

## Final review follow-up

- Corrected health price classification to a strict two-stage policy:
  1. use the exact record returned by the operational current-price selector, including its preferred-price behavior;
  2. only when operational selection returns no record, fall back to the newest historical record regardless of expiry.
- Consequently, a newer expired record does not override an older still-valid operational current price; a resource with only expired history is classified as expired; an expired preferred record remains classified as expired. Missing price is reserved for resources with no price record at all.
- Completed the `v6.1` cache chain for the two stale parent edges found in final review: `resources -> resourceAttachments` and `quota -> quotaResourceComposition`.
- Added a focused static import-graph assertion covering app parents, dashboard health, resource attachments/pricing, quota composition panel and health/quota service dependencies. Any reintroduction of the stale versions now fails the automated suite.

### Final RED/GREEN evidence

- RED: the newer-expired/older-valid test failed with `latest !== older`, proving health bypassed the operational selector.
- GREEN: health now calls `selectCurrentResourcePrice()` first and only invokes the unrestricted latest-record option after a null result.
- The cache graph assertion would fail on the reviewed `v6.0` and `v4.2` parent edges; both now resolve to `v6.1`.
- `node tests/run.mjs` -> `All tests passed`; syntax checks and `git diff --check` passed.

### Warm-cache Chromium evidence

- Chromium `140.0.7339.16`, one persistent isolated browser context.
- Warmed Materials and Quota once, reloaded `/app/`, then exercised both routes again.
- Performance resource entries contained all nine expected `v6.1` URLs for app/resource/quota/health dependencies; missing URLs: 0, stale-version URLs: 0.
- Console errors/warnings, page errors, failed requests and HTTP responses >= 400: all zero.
