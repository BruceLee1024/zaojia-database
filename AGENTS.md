# Repository Guidelines

## Project Structure & Module Organization

This is a pure frontend ES module app for a wastewater cost database. The entry points are `index.html` and `app.js`. Feature screens live in `assets/views/` (`dashboard.js`, `quota.js`, `projects.js`, `boq.js`, `indicators.js`, `ai.js`, `settings.js`). Business operations belong in `assets/services/`, persistent storage wrappers in `assets/data/`, AI integrations in `assets/ai/`, and shared helpers in `assets/utils/`. Keep JSON backups or exported data under `data/`; do not commit private API keys or user data.

## Build, Test, and Development Commands

There is no package manager or build step. Run locally with a static server so ES modules and demo data load correctly:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Directly opening `index.html` may fail in some browsers because module/data fetches can be blocked from `file://`.

## Coding Style & Naming Conventions

Use modern JavaScript ES modules with two-space indentation. Prefer small, focused modules matching the existing directories: views render UI, services contain feature logic, repositories own IndexedDB access, and utilities stay framework-free. Use `camelCase` for functions and variables, `UPPER_CASE` for constants only when they represent fixed configuration, and clear domain names such as `quotaItem`, `projectBoq`, or `indicator`.

## Testing Guidelines

No automated test framework is currently configured. Before submitting changes, run the local server and smoke-test the affected workflow in Chrome or Edge. For UI changes, verify navigation, modal behavior, data persistence after refresh, import/export, and the relevant IndexedDB-backed CRUD operations. Name future tests after the module and behavior, for example `quotaService.addItem.test.js`.

## Commit & Pull Request Guidelines

This folder has no Git history, so no existing commit convention can be inferred. Use concise imperative commit messages such as `Add quota import validation` or `Fix project BOQ totals`. Pull requests should include a short summary, changed screens/modules, manual test steps, screenshots for visible UI changes, and notes about data migrations or storage changes.

## Security & Configuration Tips

AI API keys are stored in browser `localStorage`; never hard-code them. Treat exported JSON backups as sensitive business data. When adding external libraries, prefer pinned CDN versions and document why the dependency is needed.
