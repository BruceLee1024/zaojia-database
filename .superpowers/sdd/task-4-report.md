# Task 4 Report: Complete ZIP backups and backward compatibility

## Status

Implemented complete ZIP backup/restore, preserved legacy JSON compatibility, upgraded local-folder manifests to schema 2, and made restore/clear operations compensating.

## Dependency provenance

- Package: `fflate` 0.8.2 (MIT)
- Registry tarball: `https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz`
- npm integrity: `sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==`
- Downloaded tarball SHA-512: `70f254e3b39a02809b834a41bf3b20a533e19a1a88e5e26387f248bbcb4f8f9abe4fb88bbd6fc901852a984eca381e11d59c8487305a210a50a5aadd045e73f0`
- Vendored files are exact extracts of `package/umd/index.js`, `package/lib/browser.cjs`, and `package/LICENSE` under `assets/vendor/fflate/`.
- Runtime loads only the local pinned UMD file from `app/index.html`; there is no runtime CDN request. The CJS build is used only by Node's dependency-free test runner.

## TDD record

1. Added service tests first; observed `ERR_MODULE_NOT_FOUND` for the wished-for `backupService.js`.
2. Implemented legacy JSON and ZIP service behavior; reached green after correcting fixture digest/length data.
3. Added local-folder manifest assertions first; observed schema `1 !== 2`, then implemented schema 2 attachment tracking and preserved store entries.
4. Added settings import-acceptance assertion first; observed the missing export, then wired JSON/ZIP UI actions and the local ZIP runtime.
5. Added JSON file-size test first; observed missing `parseLegacyJsonBackupFile`, then implemented the 500MB boundary.
6. Added legacy metadata-only policy test first; observed `available !== missing`, then explicitly restored JSON-only attachment metadata as `missing`.
7. Added AI-config failure transaction test first; observed raw callback failure after mutation, then moved safe AI config application into the compensated restore transaction.

## Implemented behavior

- All 16 stores are exported, including `resource_items`, `resource_prices`, `quota_resource_usages`, and `resource_attachments`.
- AI backups contain only safe preference fields; restore always retains the current device API key.
- Old JSON backups restore omitted stores as empty. JSON cannot carry attachment binaries, so imported attachment metadata is explicitly marked `missing`.
- ZIP contains `backup.json`, `manifest.json`, and declared `attachments/<resourceId>/<attachmentId>-<safeFileName>` entries.
- ZIP manifest schema 2 declares path, SHA-256, byte size, and MIME for every included attachment. Metadata already marked `missing` may be omitted; every other missing attachment fails validation.
- Before mutation: validates compressed file size, central-directory uncompressed aggregate, duplicate names, traversal/unexpected entries, required JSON, store shapes, schema, ownership/path, MIME/signature, per-file size, declared/actual size, and declared/actual SHA-256.
- Restore snapshots all stores and referenced blobs. Any store/blob/AI preference failure triggers compensation. Compensation failure is reported as `BACKUP_RECOVERY_PARTIAL`, distinct from a fully compensated `BACKUP_RESTORE_FAILED`.
- Clearing removes store data and attachment blobs with the same compensation distinction.
- Local-folder `manifest.json` is schema 2 and updates attachment entries on add/remove without discarding store entries.
- Settings presents legacy JSON and complete ZIP separately, accepts both formats, explains that only ZIP carries binaries, and warns that backups are sensitive.

## Verification

- `node tests/run.mjs` — all tests passed.
- `node --check assets/services/backupService.js` — passed.
- `node --check assets/views/settings.js` — passed.
- `node --check assets/data/storage.js` — passed.
- `git diff --check` — passed.
- Static-server smoke check returned HTTP 200 for `/app/`, the local fflate UMD file, and `backupService.js`; `app/index.html` references the local fflate file.

Tests cover JSON compatibility and API-key preservation, JSON size limits and metadata-only policy, ZIP roundtrip, schema 2 manifest, missing attachments, malicious paths, hash/size/schema failures, validation-before-mutation, injected restore rollback, partial compensation reporting, missing-file omission policy, and local-folder manifest add/remove behavior.

## Self-review

- Security: no secret values or private backups are committed; archive paths are never written to the filesystem; validation precedes replacement; ZIP64 is rejected rather than ambiguously parsed.
- Data integrity: every mutation path is snapshot-backed and attachment metadata/path/hash/size/type agree before writes begin.
- Compatibility: existing JSON names remain unchanged, missing stores become empty, and device API keys are never imported.
- UI: changes remain confined to the existing backup and danger workflows and reuse the current visual language.

## Concern

The repository has no real-browser automation harness. The service and in-memory folder behavior are automated, and static loading was smoke-tested; final keyboard/download-picker behavior should still be included in the normal Chrome/Edge manual release smoke test.

## Review follow-up

Addressed all Task 4 review findings after commit `4742d97`.

### Focused TDD evidence

1. Added strict-folder tests first and observed the missing `storageSetStrict` export. Implemented a backup-only strict path that snapshots the current store file, manifest, and IDB value; writes folder store + manifest before IDB; restores all three on failure; and propagates `STORAGE_STRICT_WRITE_FAILED` or `STORAGE_STRICT_RECOVERY_PARTIAL`. Normal `storageSet` remains best-effort.
2. Added an integration test that injects a manifest failure while `restoreLegacyJsonBackup` uses the real strict storage adapter. It verifies `BACKUP_RESTORE_FAILED`, unchanged IDB, and unchanged folder JSON, preventing false success/divergence.
3. Added failing wished-for settings helper tests, then implemented distinct clear/partial-recovery messages, destructive-flow orchestration that suppresses reload/demo load after failure, and deterministic object-URL cleanup.
4. Added schema/app and semantic rejection tests before mutation: duplicate IDs in all four new resource stores, missing resource references, missing/cross-resource attachment price references, and missing quota/resource usage references.
5. Added async ZIP adapter and compressed-output-boundary tests. ZIP creation/restoration now prefer fflate `zip`/`unzip` callbacks, retain sync fallback only for deterministic injected adapters, and reject generated archives over 500MB after compression.

### Review-fix behavior

- Settings backup transactions now use `storageSetStrict` for apply and compensation; ordinary CRUD behavior is unchanged.
- ZIP `backup.json` and `manifest.json` both identify `wastewater-cost-db` schema 2; import requires both identities.
- Duplicate IDs are rejected in every ID-bearing store. New resource stores additionally require IDs and validate ownership/reference integrity before mutation.
- Reset-demo clears all 16 stores and all referenced attachment blobs through `clearBackupData` before loading demo records.
- Clear and reset-demo catch and distinguish fully compensated failures from partial recovery, and do not continue to reload/navigation/demo loading after failure.
- Legacy JSON and ZIP downloads both revoke their object URLs.

### Follow-up verification

- `node tests/run.mjs` — all tests passed, including strict store/manifest failure integration and focused review regression cases.
- Syntax checks for `storage.js`, `backupService.js`, and `settings.js` — passed.
- `git diff --check` — passed.
