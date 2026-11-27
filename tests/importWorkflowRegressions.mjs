import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { exportImportTemplate, parseImportFile } from '../assets/data/excel.js?v=6.15';
import { buildHeaderTree, detectImportRegions } from '../assets/data/importEngine.js?v=6.15';
import { boqLibraryQuotaRelationRepo, boqLibraryRepo, boqRepo, projectRepo, quotaRepo, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js?v=6.15';
import { getImportSchema } from '../assets/services/importSchemaService.js?v=6.15';
import { analyzeImport, commitImport, reviewResourceImport } from '../assets/services/importWorkflowService.js?v=6.15';

let sheetJs;

async function withImportEnvironment(run) {
  if (!sheetJs) {
    const context = vm.createContext({ ArrayBuffer, Uint8Array, DataView, TextEncoder, TextDecoder });
    const source = readFileSync(new URL('../assets/vendor/xlsx/xlsx.full.min.js', import.meta.url), 'utf8');
    vm.runInContext(source, context);
    sheetJs = context.XLSX;
  }
  const indexedDb = new Map();
  const local = new Map();
  const globals = {
    XLSX: sheetJs,
    window: { idbKeyval: {
      get: async key => structuredClone(indexedDb.get(key)),
      set: async (key, value) => indexedDb.set(key, structuredClone(value)),
    } },
    localStorage: {
      getItem: key => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, String(value)),
    },
  };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    return await run();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function workbookFromSheets(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return workbook;
}

function xlsxFile(workbook, name = '回归测试.xlsx') {
  const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
  return new File([bytes], name);
}

async function previewFile(file, targetType, options = {}) {
  const keepPercentFormat = targetType === 'material' || targetType === 'equipment';
  const workbook = await parseImportFile(file, { keepPercentFormat });
  const regions = detectImportRegions(workbook, { schema: getImportSchema(targetType) });
  return analyzeImport(regions, { targetType, ...options });
}

async function bundleParentBoundaries() {
  const header = ['层级', '编码', '名称', '单位', '工程量', '综合单价'];
  const workbook = workbookFromSheets({
    组合一: [header,
      ['清单', 'A', '池壁混凝土', 'm³', 2, 30],
      ['定额', 'QA', '池壁定额', 'm³', 4, 15],
      ['清单', 'B', '池底混凝土', '', 3, 60],
      ['定额', 'QB', '池底定额', 'm³', 3, 60],
    ],
    组合二: [header, ['定额', 'QC', '另一张表的定额', 'm³', 1, 90]],
  });
  const preview = await previewFile(xlsxFile(workbook), 'boq_quota_bundle');
  const report = await commitImport(preview);
  const [library, quotas, relations] = await Promise.all([
    boqLibraryRepo.all(), quotaRepo.all(), boqLibraryQuotaRelationRepo.all(),
  ]);
  assert.deepEqual({
    invalidRows: preview.rows.filter(row => !row.importable).map(row => [row.sheetName, row.sourceRowNumber]),
    committed: report.counts.committed,
    libraryCodes: library.map(row => row.code),
    quotaCodes: quotas.map(row => row.code),
    links: relations.map(row => [library.find(item => item.id === row.boqLibraryItemId)?.code, row.quotaSnapshot.code]),
  }, {
    invalidRows: [['组合一', 4], ['组合一', 5], ['组合二', 2]],
    committed: 2,
    libraryCodes: ['A'],
    quotaCodes: ['QA'],
    links: [['A', 'QA']],
  });
}

async function conflictingMaterialCode() {
  const workbook = workbookFromSheets({ 材料: [
    ['材料编码', '材料名称', '规格型号', '单位', '单价', '价格日期', '省'],
    ['SAME', '水泥', 'P.O 42.5', 't', 101, '2026-07-01', '四川'],
    ['SAME', '钢筋', 'HRB400', 't', 919, '2026-07-01', '四川'],
    ['OK', '河砂', '中砂', 't', 180, '2026-07-01', '四川'],
    ['OK', '河砂', '中砂', 't', 210, '2026-07-01', '四川'],
  ] });
  const preview = await reviewResourceImport(await previewFile(xlsxFile(workbook), 'material'));
  await commitImport(preview);
  const [resources, prices] = await Promise.all([resourceRepo.all(), resourcePriceRepo.all()]);
  const quoteOwners = new Map([[101, '水泥'], [919, '钢筋']]);
  const rejected = preview.rows.filter(row => row.data.code === 'SAME' && !row.importable);
  assert.deepEqual({
    hasConflict: rejected.some(row => row.issues.some(issue => issue.severity === 'error')),
    rejectedQuotes: prices.filter(price => rejected.some(row => row.data.unitPrice === price.unitPrice)).map(price => price.unitPrice),
    misplacedQuotes: prices.filter(price => quoteOwners.has(price.unitPrice)
      && resources.find(row => row.id === price.resourceId)?.name !== quoteOwners.get(price.unitPrice)).map(price => price.unitPrice),
    sandQuotes: prices.filter(price => resources.find(row => row.id === price.resourceId)?.code === 'OK').map(price => price.unitPrice).sort((a, b) => a - b),
  }, { hasConflict: true, rejectedQuotes: [], misplacedQuotes: [], sandQuotes: [180, 210] });
}

async function preserveExistingLibraryLinks() {
  const libraryItems = [
    { id: 'omitted', code: 'A01', name: '池壁混凝土', unit: 'm³', quotaItemIds: ['original'] },
    { id: 'unknown', code: 'A02', name: '池底混凝土', unit: 'm³', quotaItemIds: ['original'] },
  ];
  const originalQuota = { id: 'original', code: 'Q01', name: '混凝土定额', unit: 'm³', priceTotal: 42 };
  const relations = libraryItems.map(item => ({
    id: `link-${item.id}`, boqLibraryItemId: item.id, quotaItemId: 'original',
    quantityBasis: 'per_unit', quantityValue: 2.5, quotaSnapshot: { ...originalQuota, priceTotal: 38 },
  }));
  await boqLibraryRepo.replaceAll(libraryItems);
  await boqLibraryQuotaRelationRepo.replaceAll(relations);
  await quotaRepo.replaceAll([originalQuota, { id: 'other', code: 'Q02', name: '其他定额', unit: 'm³', priceTotal: 55 }]);
  const workbook = workbookFromSheets({
    未提供关联: [['清单编码', '清单名称', '单位'], ['A01', '池壁混凝土更新', 'm³']],
    未匹配定额: [['清单编码', '清单名称', '单位', '关联定额编码'], ['A02', '池底混凝土更新', 'm³', 'Q02,UNKNOWN-Q']],
  });
  const preview = await previewFile(xlsxFile(workbook), 'boq_library');
  const report = await commitImport(preview);
  const visibleIssues = [
    ...report.warnings,
    ...preview.issues.map(issue => issue.message),
    ...report.rows.flatMap(row => row.issues.map(issue => issue.message)),
  ];
  const savedRelations = await Promise.all(libraryItems.map(item => boqLibraryQuotaRelationRepo.byBoqLibraryItem(item.id)));
  assert.deepEqual({
    updatedName: (await boqLibraryRepo.findById('omitted'))?.name,
    quotaIds: (await Promise.all(libraryItems.map(item => boqLibraryRepo.findById(item.id)))).map(item => item.quotaItemIds),
    keptRelations: savedRelations.map(rows => rows.map(row => [row.id, row.quotaItemId, row.quantityValue, row.quotaSnapshot.priceTotal])),
    unknownRefVisible: visibleIssues.some(message => message.includes('UNKNOWN-Q')),
  }, {
    updatedName: '池壁混凝土更新',
    quotaIds: [['original'], ['original']],
    keptRelations: [[['link-omitted', 'original', 2.5, 38]], [['link-unknown', 'original', 2.5, 38]]],
    unknownRefVisible: true,
  });
}

async function explicitZeroProjectAmount() {
  await projectRepo.replaceAll([{ id: 'test-project', name: '项目金额测试', totalCost: 0 }]);
  const workbook = workbookFromSheets({ 清单: [
    ['清单编码', '项目名称', '单位', '工程量', '综合单价', '合价'],
    ['A01', '池壁混凝土', 'm³', 2, 30, 0],
    ['A02', '池底混凝土', 'm³', 3, 50, ''],
  ] });
  const preview = await previewFile(xlsxFile(workbook), 'project_boq', { amountRule: 'sourceAmount' });
  const report = await commitImport(preview, { projectId: 'test-project' });
  assert.deepEqual({
    previewAmounts: preview.rows.map(row => row.data.amount),
    storedAmounts: (await boqRepo.byProject('test-project')).map(row => row.amount),
    reportedTotal: report.domainResult.totalCost,
    projectTotal: (await projectRepo.findById('test-project')).totalCost,
  }, { previewAmounts: [0, 150], storedAmounts: [0, 150], reportedTotal: 150, projectTotal: 150 });
}

async function resourceTemplateFieldsAndPercentage() {
  const originalWriteFile = XLSX.writeFile;
  let exported;
  XLSX.writeFile = (workbook, name) => { exported = { workbook, name }; };
  try {
    await exportImportTemplate('equipment');
  } finally {
    XLSX.writeFile = originalWriteFile;
  }
  const stockPreview = await reviewResourceImport(await previewFile(xlsxFile(exported.workbook, exported.name), 'equipment'));
  await commitImport(stockPreview);

  const sheet = exported.workbook.Sheets[exported.workbook.SheetNames[0]];
  const [headers, stockRow] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const edits = { 编码: 'E-002', 设备名称: '轴流泵', 状态: 'inactive', 含税: 'yes', 税率: 0.13, 备注: '户外型', 价格备注: '三十日内有效' };
  const percentRow = Array.from(headers, (header, index) => edits[header] ?? stockRow[index]);
  const percentWorkbook = workbookFromSheets({ 设备: [headers, percentRow] });
  percentWorkbook.Sheets.设备[XLSX.utils.encode_cell({ r: 1, c: headers.indexOf('税率') })].z = '0%';
  const percentPreview = await reviewResourceImport(await previewFile(xlsxFile(percentWorkbook), 'equipment'));
  await commitImport(percentPreview);

  const [resources, prices] = await Promise.all([resourceRepo.all(), resourcePriceRepo.all()]);
  const actual = ['E-001', 'E-002'].map(code => {
    const resource = resources.find(row => row.code === code);
    const price = prices.find(row => row.resourceId === resource?.id);
    return {
      code, standard: resource?.standard, processStage: resource?.processStage, tags: resource?.tags, status: resource?.status,
      resourceNote: resource?.note, priceNote: price?.note, taxIncluded: price?.taxIncluded, taxRate: price?.taxRate,
      components: ['base', 'freight', 'installation', 'commissioning'].map(key => price?.components?.[key]),
    };
  });
  const sample = {
    standard: 'GB/T 24674', processStage: '污泥泵房', tags: ['泵', '污泥'],
    taxIncluded: true, taxRate: 13, components: [11000, 800, 800, 200],
  };
  assert.deepEqual(actual, [
    { ...sample, code: 'E-001', status: 'active', resourceNote: '', priceNote: '' },
    { ...sample, code: 'E-002', status: 'inactive', resourceNote: '户外型', priceNote: '三十日内有效' },
  ]);
}

async function priceValidityPeriods() {
  const july = ['M01', '水泥', 't', 430, '2026-07-01', '四川', '2026-07-01', '2026-07-31'];
  const august = [...july.slice(0, 6), '2026-08-01', '2026-08-31'];
  const workbook = workbookFromSheets({ 材料: [
    ['材料编码', '材料名称', '单位', '单价', '价格日期', '省', '生效日期', '失效日期'], july, august, july,
  ] });
  const preview = await reviewResourceImport(await previewFile(xlsxFile(workbook), 'material'));
  const report = await commitImport(preview);
  const periods = (await resourcePriceRepo.all()).map(price => [price.validFrom, price.validTo]).sort();
  assert.deepEqual({ periods, skipped: report.domainResult.counts.pricesSkipped }, {
    periods: [['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31']], skipped: 1,
  });
}

async function bareMaterialCsv() {
  const file = new File(['材料名称,单位\n河砂,吨\n'], '仅材料名称和单位.csv');
  const preview = await reviewResourceImport(await previewFile(file, 'material'));
  assert.deepEqual(preview.rows.filter(row => row.importable).map(row => [row.data.name, row.data.unit]), [['河砂', '吨']]);
  await commitImport(preview);
  assert.deepEqual((await resourceRepo.all()).map(row => [row.name, row.unit]), [['河砂', '吨']]);
  assert.deepEqual(await resourcePriceRepo.all(), []);
}

async function largeHeaderGrid() {
  const matrix = Array.from({ length: 170_001 }, () => ['水泥', 't', 200]);
  matrix[0] = ['资源信息', '', '单价'];
  matrix[1] = ['材料名称', '单位', '元/t'];
  const header = buildHeaderTree({
    sheetName: '大表', matrix, headerStart: 0, headerEnd: 1,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
  });
  assert.deepEqual(header.columns.map(column => column.displayName), ['资源信息 / 材料名称', '资源信息 / 单位', '单价']);
}

const regressionCases = {
  bundleParentBoundaries, conflictingMaterialCode, preserveExistingLibraryLinks, explicitZeroProjectAmount,
  resourceTemplateFieldsAndPercentage, priceValidityPeriods, bareMaterialCsv, largeHeaderGrid,
};

export async function runImportWorkflowRegressions(names = Object.keys(regressionCases)) {
  const failures = [];
  for (const name of names) {
    if (!Object.hasOwn(regressionCases, name)) throw new Error(`Unknown import regression case: ${name}`);
    try {
      await withImportEnvironment(regressionCases[name]);
    } catch (cause) {
      failures.push(new Error(name, { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} import workflow regressions failed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = process.argv.slice(2);
  await runImportWorkflowRegressions(names.length ? names : undefined);
  console.log('Import workflow regressions passed');
}
