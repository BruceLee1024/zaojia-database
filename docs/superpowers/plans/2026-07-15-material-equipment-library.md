# Material and Equipment Library Implementation Plan

**Goal:** Add unified material/equipment master data, price history, evidence attachments, quota composition, project equipment pricing, imports, search, and complete backups without mutating historical price snapshots.

**Global constraints:** Pure frontend ES modules; two-space indentation; no build step; no runtime CDN; preserve old data and JSON backups; prices are append-only snapshots; attachments support PDF/JPG/JPEG/PNG/XLS/XLSX up to 20MB each; ZIP imports up to 500MB; existing tests must remain green.

### Task 1: Domain repositories and services

Add the four stores and repositories for resource items, prices, quota usages, and attachment metadata. Implement resource identity/validation/reference protection, append-only price records and current-price selection, quota composition calculations and application, and equipment-package project insertion with atomic rollback. Extend tests for all pure/service behaviors and legacy breakdown compatibility.

### Task 2: Resource workbench, imports, navigation, and search

Add separate Materials and Equipment navigation entries backed by one shared resource view. Implement CRUD, filters, detail inspector, price history, preferred-price selection, use locations, equipment-to-project flow, Excel templates, resource import preview/commit/reporting, import-hub entries, and global-search groups. Add tests for import identity/deduplication and search results.

### Task 3: Attachment binary storage and UI

Implement attachment Blob persistence in IndexedDB and mirrored local-folder files under attachments/<resourceId>/. Add signature/MIME/extension/size validation, SHA-256 deduplication, metadata/file compensation, missing-file degradation, upload/open/delete UI, and tests using memory storage handles.

### Task 4: Complete ZIP backups and backward compatibility

Vendor a pinned ZIP library locally. Extract backup logic from settings, retain legacy JSON import/export, add ZIP export/import with backup.json, manifest.json and original attachments, validate schema/hash/type/20MB per file/500MB archive before replacement, and ensure failed restore leaves current data untouched. Extend clearing and local-folder manifest behavior. Add backup tests.

### Task 5: Quota composition and BOQ audit integration

Add the Equipment breakdown key and resource-composition editor to quota UI. Show snapshot/latest differences and require confirmation before refreshing/applying composition. Add project equipment reference display and BOQ audit issues for invalid resource references, expired price, missing basis, and duplicate installation. Verify version snapshots preserve resource fields.

### Task 6: Dashboard, documentation, regression, and polish

Add dashboard entry points for missing resource prices, expired prices, missing quote evidence, and pending quota updates. Update README for /app/, price-basis semantics, attachment/storage layout, and JSON versus ZIP backups. Normalize module cache versions, run the complete automated suite, and manually smoke-test the served app for console/render errors.

