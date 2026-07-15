import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLatestCoordinator, createSerializedKeyCoordinator } from '../assets/utils/requestCoordinator.js?v=6.2';
import { resourceRowHtml } from '../assets/views/resources.js?v=6.2';
import { quotaResourceChoiceHtml } from '../assets/views/quotaResourceCompositionPanel.js?v=6.2';

export async function testFinalFixes() {
  await testLatestCoordinator();
  await testSerializedCoordinator();
  await testCoherentModuleVersionGraph();
  await testNoInlineUntrustedIdInterpolation();
  testMaliciousIdRendering();
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
      if (/^(?:\.|\/)/.test(specifier) && !specifier.endsWith('?v=6.2')) violations.push(`${file}: ${specifier}`);
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
