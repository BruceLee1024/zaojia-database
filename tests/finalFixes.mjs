import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLatestCoordinator, createLatestWorkspaceCoordinator, createSerializedKeyCoordinator, createWorkspaceRoot } from '../assets/utils/requestCoordinator.js?v=6.15';
import { buildEquipmentPackageDialog, createAtomicResourceRefresh, createLatestResourceSelection, resourceRowHtml } from '../assets/views/resources.js?v=6.15';
import { quotaResourceChoiceHtml } from '../assets/views/quotaResourceCompositionPanel.js?v=6.15';

export async function testFinalFixes() {
  await testLatestCoordinator();
  await testSerializedCoordinator();
  await testLatestWorkspaceCoordinator();
  testWorkspaceRootIsolation();
  await testActiveWorkspaceInvalidation();
  await testAtomicResourceRefreshRace();
  await testRouteRenderersAcceptWorkspace();
  await testCoherentModuleVersionGraph();
  await testNoInlineUntrustedIdInterpolation();
  testMaliciousIdRendering();
  testEquipmentDialogSafetyAndWithdrawal();
}

async function testLatestWorkspaceCoordinator() {
  const workspace = { content: '' };
  const roots = [];
  const coordinator = createLatestWorkspaceCoordinator({
    createRoot: () => {
      const root = { content: '' };
      roots.push(root);
      return root;
    },
    commit: root => { workspace.content = root.content; },
  });
  let releaseA;
  const slowA = coordinator.run(async root => {
    await new Promise(resolve => { releaseA = resolve; });
    root.content = 'A';
  });
  await Promise.resolve();
  const fastB = coordinator.run(async root => { root.content = 'B'; });
  assert.notEqual(await Promise.race([fastB.then(() => 'B-done'), new Promise(resolve => setTimeout(() => resolve('blocked'), 10))]), 'blocked');
  assert.equal(workspace.content, 'B');

  let releaseC;
  const latestC = coordinator.run(async root => {
    root.content = 'C-shell';
    await new Promise(resolve => { releaseC = resolve; });
    root.content = 'C-final';
  });
  await Promise.resolve();
  assert.equal(workspace.content, 'B');
  releaseA();
  assert.equal(await slowA, false);
  assert.equal(workspace.content, 'B');
  releaseC();
  assert.equal(await latestC, true);
  assert.equal(workspace.content, 'C-final');
  assert.equal(new Set(roots).size, 3);
}

function testWorkspaceRootIsolation() {
  const element = name => ({
    name,
    duplicate: { owner: name, onclick: null },
    innerHTML: '',
    childNodes: [],
    removed: false,
    querySelector(selector) { this.duplicate.selector = selector; return this.duplicate; },
    querySelectorAll(selector) { return [{ owner: name, selector }]; },
    remove() { this.removed = true; },
  });
  const oldNode = element('old');
  const newNode = element('new');
  const realNode = element('real');
  const oldRoot = createWorkspaceRoot(oldNode);
  const newRoot = createWorkspaceRoot(newNode);
  assert.equal(oldRoot.querySelector('#duplicate').owner, 'old');
  assert.equal(newRoot.querySelector('#duplicate').owner, 'new');
  newRoot.querySelector('#duplicate').onclick = () => 'new-handler';
  realNode.duplicate = newNode.duplicate;
  newRoot.activate(realNode);
  oldRoot.querySelector('#duplicate').onclick = () => 'old-handler';
  assert.equal(newRoot.querySelector('#duplicate').onclick(), 'new-handler');
  assert.equal(oldNode.duplicate.onclick(), 'old-handler');
  assert.equal(newRoot.querySelector('#duplicate').owner, 'new');
  assert.equal(oldRoot.querySelector('#duplicate').owner, 'old');
  oldRoot.remove();
  assert.equal(oldNode.removed, true);
  assert.equal(newNode.removed, false);

  const revokedNode = element('revoked');
  const firstLive = element('first-live');
  const secondLive = element('second-live');
  const revokedRoot = createWorkspaceRoot(revokedNode);
  revokedRoot.activate(firstLive);
  revokedRoot.invalidate();
  revokedRoot.activate(secondLive);
  revokedRoot.innerHTML = 'stale-only';
  assert.equal(revokedNode.innerHTML, 'stale-only');
  assert.equal(firstLive.innerHTML, '');
  assert.equal(secondLive.innerHTML, '');
}

async function testActiveWorkspaceInvalidation() {
  const node = () => ({
    innerHTML: '',
    childNodes: [],
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
  });
  const live = node();
  const roots = [];
  const coordinator = createLatestWorkspaceCoordinator({
    createRoot: () => {
      const root = createWorkspaceRoot(node());
      roots.push(root);
      return root;
    },
    commit: root => {
      live.innerHTML = root.innerHTML;
      root.activate(live);
    },
  });

  await coordinator.run(async root => { root.innerHTML = 'old'; });
  assert.equal(live.innerHTML, 'old');

  let releaseNew;
  const next = coordinator.run(async root => {
    root.innerHTML = 'new-shell';
    await new Promise(resolve => { releaseNew = resolve; });
    root.innerHTML = 'new-final';
  });
  await Promise.resolve();
  assert.equal(roots[0].isInvalidated, true);
  let currentView = 'new-view';
  if (!roots[0].isInvalidated) currentView = 'old-view';
  assert.equal(currentView, 'new-view');
  roots[0].innerHTML = 'old-pending-pollution';
  assert.equal(live.innerHTML, 'old');

  releaseNew();
  assert.equal(await next, true);
  assert.equal(live.innerHTML, 'new-final');
  roots[0].innerHTML = 'old-after-commit-pollution';
  assert.equal(live.innerHTML, 'new-final');
}

async function testAtomicResourceRefreshRace() {
  let releaseMaterials;
  const shared = {};
  const refresh = createAtomicResourceRefresh({
    list: ({ resourceType }) => resourceType === 'material'
      ? new Promise(resolve => { releaseMaterials = () => resolve([{ id: 'mat-1', resourceType: 'material' }]); })
      : Promise.resolve([{ id: 'eq-1', resourceType: 'equipment' }]),
    currentPrice: item => Promise.resolve({ id: `price-${item.id}`, resourceId: item.id }),
    usage: id => Promise.resolve({ resourceId: id, total: 1 }),
    isCurrent: snapshot => !snapshot.context.invalidated,
    commit: result => Object.assign(shared, result),
  });
  const materialContext = { invalidated: false };
  const slowMaterials = refresh({ resourceType: 'material', keyword: '', category: '', status: '', selectedId: '', resourceIds: [], context: materialContext });
  await Promise.resolve();
  materialContext.invalidated = true;
  const fastEquipment = refresh({ resourceType: 'equipment', keyword: '', category: '', status: '', selectedId: '', resourceIds: [], context: { invalidated: false } });
  assert.equal(await fastEquipment, true);
  assert.equal(shared.resourceType, 'equipment');
  assert.equal(shared.selectedId, '');
  assert.equal(shared.prices.get('eq-1').resourceId, 'eq-1');
  assert.equal(shared.usage, null);
  releaseMaterials();
  assert.equal(await slowMaterials, false);
  assert.equal(shared.resourceType, 'equipment');
  assert.deepEqual(shared.rows.map(item => item.id), ['eq-1']);
  const clicked = shared.rows[0];
  assert.equal(clicked?.resourceType, 'equipment');
  const select = createLatestResourceSelection({
    setSelectedId: id => { shared.selectedId = id; },
    getSelectedId: () => shared.selectedId,
    loadUsage: id => Promise.resolve({ resourceId: id, total: 2 }),
    isCurrent: context => !context.invalidated,
    commit: ({ usage }) => { shared.usage = usage; },
  });
  assert.equal(await select(clicked.id, { invalidated: false }), true);
  assert.equal(shared.selectedId, 'eq-1');
  assert.equal(shared.usage.resourceId, 'eq-1');
}

async function testRouteRenderersAcceptWorkspace() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const views = ['dashboard', 'importer', 'quota', 'projects', 'boq', 'costEstimation', 'indicators', 'experience', 'settings', 'resources', 'resourceImport', 'boqLibrary', 'aiImportWizard'];
  for (const view of views) {
    const source = await readFile(join(root, 'assets', 'views', `${view}.js`), 'utf8');
    assert.match(source, /export async function render\(workspace\b/, `${view} must accept an isolated workspace root`);
  }
  const contracts = {
    dashboard: [/bindResourceHealthActions\([^;]*workspace\)/, /drawCharts\([^;]*workspace\)/],
    importer: [/exposeImporterActions\(workspace\)/, /bindUploadEvents\(workspace\)/],
    quota: [/await renderList\(workspace\)/, /scopedDom\(workspace\)/],
    projects: [/const document = scopedDom\(workspace\)/],
    boq: [/const document = scopedDom\(workspace\)/],
    costEstimation: [/const document = scopedDom\(workspace\)/],
    indicators: [/expose\(workspace\)/, /drawCharts\(workspace\)/],
    experience: [/bindExperiencePage\(projects, document\)/, /bindReviewWorkspace\([^;]*document\)/],
    settings: [/bindSettingsEvents\(document\)/, /bindTabEvents\(document\)/],
    resources: [/exposeActions\(workspace, generation\)/, /await refresh\(workspace, generation\)/, /loadPriceHistory\([^;]*workspace[^;]*\)/, /document: scopedDom\(workspace\)/],
    resourceImport: [/exposeActions\(workspace\)/, /await paint\(workspace\)/],
    boqLibrary: [/await renderRows\(workspace\)/, /renderDetail\(workspace,/],
    aiImportWizard: [/expose\(workspace\)/, /await paint\(workspace\)/, /bindUpload\(workspace\)/],
  };
  for (const [view, patterns] of Object.entries(contracts)) {
    const source = await readFile(join(root, 'assets', 'views', `${view}.js`), 'utf8');
    patterns.forEach(pattern => assert.match(source, pattern, `${view} must keep its initial DOM chain workspace-scoped`));
  }
  const app = await readFile(join(root, 'app.js'), 'utf8');
  assert.equal(app.includes('snapshotWorkspace'), false);
  assert.equal(app.includes('restoreWorkspace'), false);
  assert.match(app, /await r\.render\(workspace\)/);
  assert.equal((app.match(/state\.currentView\s*=(?!=)/g) || []).length, 1, 'only go() may mutate currentView');

  const resourceImport = await readFile(join(root, 'assets/views/resourceImport.js'), 'utf8');
  assert.match(resourceImport, /exposeActions\(workspace\);[\s\S]*await paint\(workspace\);/);
  const aiImport = await readFile(join(root, 'assets/views/aiImportWizard.js'), 'utf8');
  assert.match(aiImport, /expose\(workspace\);[\s\S]*await paint\(workspace\);/);
  const resources = await readFile(join(root, 'assets/views/resources.js'), 'utf8');
  assert.doesNotMatch(resources, /state\.(?:rows|prices|usage|selectedId)\s*=\s*await/, 'resource async results must remain local until atomic commit');
  assert.match(resources, /Object\.assign\(state, result\)/);
}

function testEquipmentDialogSafetyAndWithdrawal() {
  const hostile = 'x\" onclick=\"alert(1)<script>';
  const dialog = buildEquipmentPackageDialog({
    projects: [{ id: hostile, name: '<img src=x>' }],
    prices: [{ id: 'withdrawn', status: 'withdrawn', unitPrice: 1 }, { id: hostile, status: 'active', priceBasis: 'delivered', unitPrice: 2 }],
    quotas: [{ id: hostile, name: '<svg onload=alert(1)>' }],
  });
  assert.equal(dialog.hasActivePrices, true);
  assert.equal(dialog.body.includes('value="withdrawn"'), false);
  assert.equal(dialog.body.includes('<script>'), false);
  assert.equal(dialog.body.includes('onclick="alert'), false);
  assert.equal(dialog.body.includes('&quot;'), true);
  const empty = buildEquipmentPackageDialog({ projects: [{ id: 'p1', name: 'P' }], prices: [{ id: 'w1', status: 'withdrawn' }], quotas: [] });
  assert.equal(empty.hasActivePrices, false);
  assert.equal(empty.footer.includes('disabled'), true);
  assert.equal(empty.body.includes('没有可用的未撤回价格'), true);
}

function testMaliciousIdRendering() {
  const hostile = 'x\" onclick=\"alert(1)<script>';
  const resourceHtml = resourceRowHtml({ id: hostile, name: '<img src=x>', unit: 'm', status: 'active' }, null, false);
  const quotaHtml = quotaResourceChoiceHtml({ id: hostile, name: '<svg onload=alert(1)>', resourceType: 'material' }, false);
  for (const html of [resourceHtml, quotaHtml]) {
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('onclick="alert'), false);
    assert.equal(html.includes('&quot;'), true);
  }
}

async function testLatestCoordinator() {
  const coordinator = createLatestCoordinator();
  let resolveOlder;
  const committed = [];
  const older = coordinator.run(() => new Promise(resolve => { resolveOlder = resolve; }), value => committed.push(value));
  const newer = coordinator.run(async () => 'B', value => committed.push(value));
  await newer;
  resolveOlder('A');
  assert.equal(await older, false);
  assert.deepEqual(committed, ['B']);

  const failedOlder = coordinator.run(async () => { throw new Error('late A'); }, null, () => committed.push('old-error'));
  await coordinator.run(async () => 'C', value => committed.push(value));
  assert.equal(await failedOlder, false);
  assert.deepEqual(committed, ['B', 'C']);
}

async function testSerializedCoordinator() {
  const coordinator = createSerializedKeyCoordinator();
  const order = [];
  let release;
  const first = coordinator.run('project-1', async () => {
    order.push('first-start');
    await new Promise(resolve => { release = resolve; });
    order.push('first-end');
  });
  const second = coordinator.run('project-1', async () => order.push('second'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
}

async function testCoherentModuleVersionGraph() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = await sourceFiles(root);
  const violations = [];
  const edge = /(?:from\s*|import\s*\()(['"])([^'"]+\.js(?:\?[^'"]*)?)\1|<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/g;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(edge)) {
      const specifier = match[2] || match[3];
      if (/^(?:\.|\/)/.test(specifier)) {
        const version = new URL(specifier, 'https://local.invalid/').searchParams.get('v');
        if (version !== '6.15') violations.push(`${file}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
}

async function testNoInlineUntrustedIdInterpolation() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const relative of ['assets/views/resources.js', 'assets/views/quotaResourceCompositionPanel.js']) {
    const source = await readFile(join(root, relative), 'utf8');
    assert.equal(/on(?:click|change|input)=["'][^"']*\$\{[^}]*\b(?:id|resourceId|priceId|usageId)\b/.test(source), false, relative);
  }
}

async function sourceFiles(root) {
  const result = [join(root, 'app.js'), join(root, 'app/index.html')];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (extname(entry.name) === '.js') result.push(path);
    }
  }
  await visit(join(root, 'assets'));
  return result.filter(path => !path.includes('/vendor/'));
}
