# Task 5 Report: Quota composition and BOQ audit integration

## Status

Implemented Task 5. Dashboard work was intentionally left out.

## Delivered

- Standardized quota breakdown writes and new/demo defaults to `{人工,材料,设备,机械,管理费,利润,风险}`.
  - Legacy records are normalized only in view/draft calculations and are not mutated merely by reading.
  - Saving or applying composition persists the canonical shape with legacy `设备 = 0`.
- Added focused quota resource usage APIs:
  - `removeUsage(usageId)`
  - `compareUsage(usageId)` / `compareUsages(quotaItemId)`
  - `refreshUsageSnapshot(usageId)`
  - Comparison is read-only; refresh is explicit and never automatic.
- Expanded quota usage price snapshots with source type, supplier, validity dates, installation scope and tax/region fields.
- Added a split resource-composition UI module for quota edit/detail:
  - searches active materials/equipment and selects a specific price;
  - captures unit quantity and loss rate;
  - shows snapshot/current unit-price and calculated-cost deltas plus stale state;
  - confirms removal, explicit snapshot refresh, and composition application;
  - previews old/new seven-part breakdown and total delta;
  - warns when an `installed_composite` equipment price coexists with non-zero labor/mechanical cost.
- Composition application only replaces material/equipment, preserves the other canonical breakdown values, recalculates total and enables `useBreakdown`.
- Extended `boqService.audit()` with:
  - `invalidResourceReference`
  - `expiredResourcePrice`
  - `missingResourcePriceBasis`
  - `duplicateEquipmentInstallation`
  - Existing issue keys remain unchanged; new issues add bounded penalties to the existing score model.
- Added project BOQ resource snapshot display:
  - missing/expired/missing-basis badges in line risk display;
  - resource identity, snapshot unit price, source, basis, price date and validity in the inspector.
- Extended version snapshot/restore fields to preserve direct and linked resource references, resource/price snapshots and missing-reference metadata.

## TDD evidence

1. RED: `node tests/run.mjs` failed with `ERR_MODULE_NOT_FOUND` for the wished-for pure quota composition module.
2. GREEN: added normalization, preview, warning and comparison view-model functions.
3. RED: suite failed because `quotaResourceService.compareUsage` did not exist.
4. GREEN: added read-only comparison, explicit refresh, list comparison and usage removal APIs.
5. RED: suite failed because `audit.issues.invalidResourceReference` did not exist.
6. GREEN: added all four resource audit issue groups and score contributions.
7. RED: suite failed because version snapshots omitted `resourceItemId`.
8. GREEN: extended snapshot/restore fields and deep-cloned resource snapshots.
9. RED: suite failed because the pure UI shell and BOQ resource renderer exports did not exist.
10. GREEN: added tested empty/saved composition shells and resource snapshot renderer.

Focused coverage is in `tests/quotaBoqIntegration.mjs`; it also runs from the full regression runner.

## Verification

- `node tests/run.mjs` → `All tests passed` (exit 0).
- `node --check` passed for modified quota/BOQ/version services and quota/BOQ UI modules.
- `git diff --check` passed.
- Real Chromium smoke test at `http://127.0.0.1:8015/app/`:
  - quota page loaded;
  - new quota modal rendered seven breakdown inputs including equipment;
  - unsaved quota rendered the save-first resource-composition state;
  - console contained zero errors or warnings.

## Self-review

- Confirmed comparisons do not write usage records and only explicit refresh changes the selected price/snapshot.
- Confirmed composition application retains labor, mechanical, management, profit and risk values.
- Confirmed legacy read normalization does not mutate the source object.
- Confirmed resource audit fallbacks use a stored price snapshot first and current price record second.
- Confirmed BOQ table no longer truncates the new resource badges behind the previous two-badge limit.
- Confirmed version creation and restore both retain resource fields and deep-clone nested snapshots.
- Kept the stateful composition controller separate from pure formatting/preview logic so `quota.js` does not absorb the feature.

## Remaining concerns

- This repository still has no dedicated browser test harness; the UI verification is a repeatable manual/headless smoke test rather than a committed end-to-end suite.
- Existing `resourcePriceService.getCurrentPrice()` honors a preferred price even if it is expired. Task 5 reports expiry in BOQ audit/display but does not change that established price-selection policy.

## Review follow-up

All Task 5 review findings were addressed with focused regression tests before implementation:

- Composition application now receives the live, unsaved seven-part quota breakdown and preserves its labor, machinery, management, profit and risk values. Incomplete, negative or non-finite caller-supplied breakdowns are rejected.
- The visible quote-audit action now calls `boqService.audit()` and renders its health score plus all four resource issue groups alongside the AI review.
- Duplicate installation detection now pairs installation rows through `linkedEquipmentLineId`. Legacy unscoped rows are evaluated only when the resource maps to exactly one equipment row, preventing delivered-package and multi-instance false positives.
- Composition rendering, search and selection use latest-request-wins guards. Mutations reject overlapping clicks, expose busy/disabled state and surface current-request failures through the existing toast path.
- BOQ filters and badges include duplicate installation issues without truncation. Resource display falls back to the live price record when a line has only `resourcePriceId`, using the same audit annotation source as the table.
- Comparison details now expose price basis, source type, supplier, price date/validity, tax, region and installation scope.

### Follow-up TDD evidence

- RED assertions captured stale unsaved breakdown replacement, over-broad duplicate matching, broken-link fallback, absent visible audit helpers, missing fallback metadata, missing comparison details, out-of-order async commits and overlapping/error mutation behavior.
- GREEN coverage was added to `tests/quotaBoqIntegration.mjs` for each case, including exact-link multi-instance pairing, ambiguous legacy rows, delivered-package pricing, audit button data loading through a pure helper and current/stale async error semantics.

### Follow-up browser smoke

- Real Chromium at `http://127.0.0.1:8015/app/` loaded three demo projects and a ten-row BOQ with no console errors.
- Clicking the quote-audit button displayed the health score and the four visible groups: resource reference invalid, resource price expired, missing resource price basis and duplicate equipment installation.
- The quota edit composition panel rendered all seven breakdown inputs, search controls and idle `aria-busy=false` state with a clean console.
- At a 1024 px viewport the panel had no horizontal overflow (`scrollWidth = clientWidth = 820`).

### Follow-up concerns

- No new unresolved Task 5 concern was found. The pre-existing preferred-expired-price selection policy remains intentionally unchanged and is now made visible by audit and UI warnings.
