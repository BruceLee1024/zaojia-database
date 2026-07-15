# Task 3 Report: Attachment binary storage and UI

## Status

Complete. Resource attachments now persist as private IndexedDB blobs, mirror to authorized local folders, retain canonical metadata, validate uploads, deduplicate by SHA-256, compensate failed writes/removals, degrade missing files without removing metadata, and expose an accessible upload/list/open/delete panel in the resource inspector.

## Files changed

- `assets/data/storage.js`
  - Exports the exact `storageSetAttachment(meta, blob)`, `storageGetAttachment(meta)`, and `storageRemoveAttachment(meta)` APIs.
  - Uses private IndexedDB keys and mirrors folder-mode blobs to `attachments/<resourceId>/<attachmentId>-<safeFileName>`.
  - Reads the folder copy first and falls back to IndexedDB; folder deletion tolerates an already-missing mirror.
- `assets/services/resourceAttachmentService.js`
  - Adds `add({ resourceId, priceId, file })`, `listByResource(resourceId)`, `open(id)`, and `remove(id)`.
  - Validates resource/price ownership, size, extension, MIME, and magic bytes for PDF/JPG/JPEG/PNG/XLS/XLSX.
  - Enforces `0 < size <= 20MB`, SHA-256 resource-level deduplication, safe physical names, and compensating binary/metadata operations.
  - Persists canonical fields `id`, `resourceId`, `priceId`, `fileName`, `mimeType`, `size`, `sha256`, `storagePath`, `status`, and `createdAt`; optional `safeFileName`, `extension`, and `updatedAt` support physical storage and recovery.
- `assets/views/resourceAttachments.js`
  - Adds the focused attachment panel, optional price association, loading/empty/missing states, keyboard-accessible native controls, safe text rendering, open/download behavior, and controlled error toasts.
- `assets/views/resources.js`
  - Replaces the Task 2 placeholder and loads the attachment panel with the selected resource.
- `tests/resourceAttachments.mjs`, `tests/run.mjs`
  - Adds attachment storage/service/UI-helper coverage with memory IndexedDB and File System Access handles.

## TDD evidence

1. RED — storage/service contract
   - Command: `node tests/run.mjs`
   - Expected failure: `ERR_MODULE_NOT_FOUND` for `assets/services/resourceAttachmentService.js`.
   - GREEN: implemented storage and service APIs; validation, boundary, dedupe, compensation, folder, and missing-file tests passed.
2. RED — safe attachment list UI
   - Command: `node tests/run.mjs`
   - Expected failure: `ERR_MODULE_NOT_FOUND` for `assets/views/resourceAttachments.js`.
   - GREEN: added the focused panel and safe escaped list renderer.
3. RED — canonical metadata schema
   - Command: `node tests/run.mjs`
   - Expected failure: canonical `fileName` expected the original name but received the sanitized name.
   - GREEN: canonical `fileName` now remains original/user-facing; `safeFileName` is only used for physical storage.
4. RED — open versus download behavior
   - Command: `node tests/run.mjs`
   - Expected failure: missing `shouldDownloadAttachment` export.
   - GREEN: PDF/images open in a new tab; spreadsheets receive a download filename.
5. RED — traversal-adjacent dotted names
   - Command: `node tests/run.mjs`
   - Expected failure: `quote..final.pdf` retained consecutive dots in `safeFileName`.
   - GREEN: consecutive dots are replaced in the physical filename while canonical `fileName` remains unchanged.

## Exact verification

- `node tests/run.mjs` -> `All tests passed`
  - Covers exact storage function arities, extension/MIME spoofing, invalid magic, empty files, exact 20MB acceptance, over-20MB rejection, all six allowed extensions/signatures, SHA-256 dedupe, resource/price ownership, add and remove compensation, canonical/safe names, folder mirror paths, IndexedDB fallback, missing status/error degradation, UI escaping, and open/download selection.
- `git diff --check` -> passed with no whitespace errors.
- `node --check assets/data/storage.js` -> passed.
- `node --check assets/services/resourceAttachmentService.js` -> passed.
- `node --check assets/views/resourceAttachments.js` -> passed.
- `node --check assets/views/resources.js` -> passed.
- Static server smoke:
  - `python3 -m http.server 8765`
  - `GET /`, `GET /assets/views/resourceAttachments.js`, and `GET /assets/services/resourceAttachmentService.js` all returned HTTP 200.
- Sensitive-value scan across changed attachment implementation/test files returned no matches.

## Concerns

- XLSX validation confirms its ZIP magic bytes plus extension/MIME, but does not unzip and structurally inspect workbook entries; Task 4's pinned ZIP work can add archive-entry validation during backup/import.
- A real Chrome/Edge upload interaction and File System Access permission prompt were not available in this environment; browser-facing logic is covered with memory handles and static-server smoke checks.

## Review fixes

- Folder-mode attachment writes and deletes now preflight the saved directory handle and granted `readwrite` permission before any binary mutation. Missing/revoked permission throws `ATTACHMENT_FOLDER_PERMISSION`; add does not commit metadata/Blob, and delete preserves the folder copy, IndexedDB Blob, and metadata.
- File System Access failures named `NotAllowedError` or `SecurityError` are normalized to the same controlled attachment permission error. IndexedDB mode retains its previous behavior.
- Resource attachment adds are serialized per resource, so concurrent equal SHA-256 uploads deterministically produce one success and one `ATTACHMENT_DUPLICATE` result.
- Attachment panel shells carry escaped resource and render-generation data attributes. Every post-await render, binding, loading-state mutation, upload completion, and reload validates the same connected root/resource/generation.
- Initial attachment loading catches service failures, always clears `aria-busy`, renders an accessible `role="alert"` with retry, and returns `false` instead of rejecting through resource selection.
- Memory directory handles now honor `{ create: false }` with `NotFoundError` and expose revocable permission state.

### Review-fix TDD evidence

1. RED — revoked folder permission
   - Command: `node tests/run.mjs`
   - Expected failure: `Missing expected rejection` because folder-mode add silently succeeded with denied `readwrite` permission.
   - GREEN: controlled permission rejection; tests verify no new metadata/Blob on add and no folder/Blob/metadata removal on delete.
2. RED — stale panel and load rejection
   - Command: `node tests/run.mjs`
   - Expected failure: `ReferenceError: document is not defined` from the unscoped loader, after permission behavior was green.
   - GREEN: dependency-scoped loader with root/resource/generation guards; delayed A cannot mutate/bind after B renders, and rejected loads settle into a retry state.
3. GREEN — concurrent duplicate regression
   - Two simultaneous identical uploads now assert exactly one fulfilled result, one `ATTACHMENT_DUPLICATE`, and one metadata row.

### Review-fix verification

- `node tests/run.mjs` -> `All tests passed`.
- `git diff --check` -> passed.
- `node --check` for `storage.js`, `resourceAttachmentService.js`, `resourceAttachments.js`, and `resources.js` -> passed.
- Static server returned HTTP 200 for `/`, the attachment UI module, and the attachment service module after review fixes.
