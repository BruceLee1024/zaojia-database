// 统一表格导入内核：合并表头、表头树、多数据区与行分类。
// 该模块保留物理列身份，不使用可能重复的表头文字作为唯一 key。

const MAX_HEADER_DEPTH = 6;
const HEADER_TERMS = [
  '序号', '编号', '编码', '项目编码', '清单编码', '名称', '项目名称', '清单名称', '材料名称', '设备名称',
  '项目特征', '特征', '规格', '型号', '单位', '计量单位', '数量', '工程量', '工程数量', '单价', '综合单价', '合价',
  '金额', '专业', '工艺段', '分类', '费用分类', '备注', '价格日期', '价格来源', '税率', '品牌', '生产厂家',
];
const UNIT_RE = /^(?:m|m2|m3|m²|m³|㎡|㎥|t|kg|kw|kwh|h|米|平方米|立方米|吨|千克|台|套|项|个|根|座|块|组|工日|元|%|元\/[^\s]+)$/i;
const TOTAL_RE = /^(?:其中[:：]?)?(?:分部小计|分项小计|本页小计|小计|合计|总计|累计|费用合计|合计金额)$/;
const NOTE_RE = /^(?:说明|备注|注|注意|编制说明)[:：]/;

export function normalizeHeaderText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\s　]+/g, '')
    .replace(/[()（）\[\]［］【】]/g, '')
    .replace(/[\\/_-]/g, '')
    .toLowerCase();
}

export function expandMergedHeaderGrid(matrix = [], merges = [], headerStart = 0, headerEnd = matrix.length - 1) {
  const grid = matrix.map(row => Array.isArray(row) ? [...row] : []);
  const warnings = [];
  const claimed = new Map();
  const maxRow = Math.max(0, grid.length - 1);
  const maxColumn = Math.max(0, ...grid.map(row => row.length - 1));

  for (const merge of merges || []) {
    const startRow = Number(merge?.s?.r);
    const endRow = Number(merge?.e?.r);
    const startColumn = Number(merge?.s?.c);
    const endColumn = Number(merge?.e?.c);
    if (![startRow, endRow, startColumn, endColumn].every(Number.isInteger)
      || startRow > endRow || startColumn > endColumn
      || startRow < 0 || startColumn < 0 || endRow > maxRow || endColumn > maxColumn) {
      warnings.push('检测到越界或无效的合并单元格范围');
      continue;
    }
    if (endRow < headerStart || startRow > headerEnd) continue;
    const anchor = grid[startRow]?.[startColumn];
    if (isBlank(anchor)) warnings.push(`合并区域 R${startRow + 1}C${startColumn + 1} 的左上角为空`);
    for (let row = Math.max(startRow, headerStart); row <= Math.min(endRow, headerEnd); row += 1) {
      if (!grid[row]) grid[row] = [];
      for (let column = startColumn; column <= endColumn; column += 1) {
        const key = `${row}:${column}`;
        if (claimed.has(key)) warnings.push(`合并单元格范围在 R${row + 1}C${column + 1} 重叠`);
        claimed.set(key, merge);
        if (isBlank(grid[row][column])) grid[row][column] = anchor ?? '';
      }
    }
  }
  return { grid, warnings };
}

export function buildHeaderTree({ sheetName = '', regionId = '', matrix = [], merges = [], headerStart = 0, headerEnd = 0 } = {}) {
  const safeStart = Math.max(0, Number(headerStart) || 0);
  const safeEnd = Math.min(matrix.length - 1, Math.max(safeStart, Number(headerEnd) || safeStart));
  const { grid, warnings } = expandMergedHeaderGrid(matrix, merges, safeStart, safeEnd);
  const columnCount = Math.max(0, ...matrix.slice(safeStart, safeEnd + 1).map(row => Array.isArray(row) ? row.length : 0));
  const titleRows = detectTitleRows(grid, merges, safeStart, safeEnd, columnCount);
  const columns = [];

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const rawHeaderCells = [];
    for (let row = safeStart; row <= safeEnd; row += 1) {
      rawHeaderCells.push({ row, value: String(grid[row]?.[columnIndex] ?? '').trim() });
    }
    const values = rawHeaderCells
      .filter(cell => !titleRows.has(cell.row))
      .map(cell => cell.value)
      .filter(Boolean);
    const path = [];
    values.forEach(value => {
      if (!path.length || normalizeHeaderText(path[path.length - 1]) !== normalizeHeaderText(value)) path.push(value);
    });
    let unitHint = '';
    if (path.length > 1 && UNIT_RE.test(path[path.length - 1].replace(/\s/g, ''))) unitHint = path.pop();
    if (!path.length && !unitHint) continue;
    const id = `${sheetName || 'sheet'}:${regionId || `${safeStart}-${safeEnd}`}:C${columnIndex + 1}`;
    columns.push({
      id,
      columnIndex,
      path,
      leaf: path[path.length - 1] || unitHint,
      unitHint,
      displayName: path.join(' / ') || unitHint,
      normalizedPath: path.map(normalizeHeaderText).filter(Boolean),
      rawHeaderCells,
    });
  }
  return {
    sheetName,
    regionId,
    headerStart: safeStart,
    headerEnd: safeEnd,
    titleRows: [...titleRows],
    title: [...titleRows].map(row => String(grid[row]?.find(value => !isBlank(value)) ?? '').trim()).filter(Boolean).join(' / '),
    columns,
    warnings: [...new Set(warnings)],
  };
}

export function detectImportRegions(workbook = {}, { maxHeaderDepth = MAX_HEADER_DEPTH, schema = null } = {}) {
  const regions = [];
  const schemaTerms = importSchemaTerms(schema);
  for (const sheet of workbook.sheets || []) {
    const matrix = Array.isArray(sheet.matrix) ? sheet.matrix : [];
    if (!matrix.some(row => Array.isArray(row) && row.some(value => !isBlank(value)))) continue;
    const candidates = findHeaderCandidates(sheet, Math.min(MAX_HEADER_DEPTH, Math.max(1, maxHeaderDepth)), schemaTerms);
    const selected = selectHeaderCandidates(candidates);
    if (!selected.length) {
      const fallback = createManualFallbackRegion(sheet);
      if (fallback) regions.push(fallback);
      continue;
    }
    selected.forEach((candidate, index) => {
      const next = selected[index + 1];
      const dataStart = candidate.headerEnd + 1;
      const dataEnd = next ? next.headerStart - 1 : matrix.length - 1;
      const regionId = `${sheet.name || 'sheet'}:${candidate.headerStart + 1}-${candidate.headerEnd + 1}`;
      const header = buildHeaderTree({
        sheetName: sheet.name || '', regionId, matrix, merges: sheet.merges || [],
        headerStart: candidate.headerStart, headerEnd: candidate.headerEnd,
      });
      const classified = buildImportRows(matrix, header.columns, dataStart, dataEnd);
      if (!classified.rows.length && !classified.skippedRows.length) return;
      regions.push({
        id: regionId,
        sheetName: sheet.name || '',
        hidden: Boolean(sheet.hidden),
        matrix,
        merges: sheet.merges || [],
        headerStart: candidate.headerStart,
        headerEnd: candidate.headerEnd,
        dataStart,
        dataEnd,
        confidence: candidate.confidence,
        manualRequired: candidate.confidence === 'low',
        score: candidate.score,
        title: header.title,
        columns: header.columns,
        signature: createHeaderSignature(header.columns),
        rows: classified.rows,
        skippedRows: classified.skippedRows,
        warnings: [...new Set([...(sheet.warnings || []), ...header.warnings])],
      });
    });
  }
  return regions;
}

export function classifyImportRow(values = [], columns = []) {
  const nonEmpty = values.map((value, index) => ({ value, index })).filter(item => !isBlank(item.value));
  if (!nonEmpty.length) return 'blank';
  const texts = nonEmpty.map(item => String(item.value).trim());
  const combined = texts.join('');
  if (texts.some(text => TOTAL_RE.test(text.replace(/\s/g, '')))) return 'subtotal';
  if (texts.length === 1 && NOTE_RE.test(texts[0])) return 'note';
  const headerMatches = texts.filter(text => isHeaderTerm(text) || matchesImportColumn(text, columns)).length;
  if (headerMatches >= Math.min(2, Math.max(1, nonEmpty.length - 1))) return 'repeated_header';
  const numericMeasureCount = nonEmpty.filter(item => {
    if (!isNumeric(item.value)) return false;
    const column = columns.find(candidate => candidate.columnIndex === item.index);
    return /(?:工程量|数量|单价|合价|金额|人工费|材料费|机械费|暂估价)/.test(
      normalizeHeaderText([...(column?.path || []), column?.leaf || ''].join('')),
    );
  }).length;
  // 分部行常以“0101 + 土石方工程”出现。编码虽由数字组成，但不是计量值。
  if (nonEmpty.length <= 2 && numericMeasureCount === 0 && combined.length <= 80) return 'section';
  const meaningfulColumns = columns.filter(column => !/^(?:序号|编号)$/i.test(normalizeHeaderText(column.leaf)));
  const meaningfulValues = meaningfulColumns.filter(column => !isBlank(values[column.columnIndex]));
  return meaningfulValues.length ? 'detail' : 'invalid';
}

function findHeaderCandidates(sheet, maxDepth, schemaTerms = []) {
  const matrix = sheet.matrix || [];
  const candidates = [];
  for (let start = 0; start < matrix.length; start += 1) {
    // “分部小计 / 合计 / 说明”属于数据区结构行，不能借用后续明细中的
    // 表头关键词成为新数据区起点。标准计价表通常会在每个分部末尾重复出现这类行。
    if (isLikelyBodyRow(matrix[start])) continue;
    if (!hasPossibleHeaderSignal(matrix, start, maxDepth, schemaTerms)) continue;
    for (let depth = 1; depth <= maxDepth && start + depth < matrix.length; depth += 1) {
      const end = start + depth - 1;
      if (depth > 1 && isLikelyBodyRow(matrix[end])) break;
      const header = buildHeaderTree({ sheetName: sheet.name || '', regionId: 'candidate', matrix, merges: sheet.merges || [], headerStart: start, headerEnd: end });
      const score = scoreHeaderCandidate(matrix, header, end + 1, sheet.merges || [], schemaTerms);
      if (score < 0.45) continue;
      candidates.push({ headerStart: start, headerEnd: end, score, confidence: score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low' });
    }
  }
  return candidates;
}

function selectHeaderCandidates(candidates) {
  if (!candidates.length) return [];
  const strongest = Math.max(...candidates.map(candidate => candidate.score));
  // 一旦工作表存在可靠正式表头，只保留同等级候选。项目特征长文本常包含
  // “单位、工程量、专业”等词，但这类低分命中不应把标准清单切成多个数据区。
  const eligible = strongest >= 0.8
    ? candidates.filter(candidate => candidate.score >= 0.75)
    : candidates;
  const ranked = [...eligible].sort((a, b) => b.score - a.score || a.headerStart - b.headerStart || a.headerEnd - b.headerEnd);
  const selected = [];
  for (const candidate of ranked) {
    const conflicts = selected.some(item => rangesOverlap(candidate.headerStart, candidate.headerEnd, item.headerStart, item.headerEnd)
      || Math.abs(candidate.headerStart - item.headerStart) <= 1);
    if (!conflicts) selected.push(candidate);
  }
  return selected.sort((a, b) => a.headerStart - b.headerStart);
}

function scoreHeaderCandidate(matrix, header, dataStart, merges, schemaTerms = []) {
  const columns = header.columns;
  if (columns.length < 2) return 0;
  const matched = columns.filter(column => column.path.some(value => isHeaderTerm(value, schemaTerms))).length;
  if (matched < 2) return 0;
  const unique = new Set(columns.map(column => column.normalizedPath.join('>'))).size / columns.length;
  const nextRows = matrix.slice(dataStart, dataStart + 5);
  const dataRows = nextRows.filter(row => classifyImportRow(row || [], columns) === 'detail').length;
  const dataDensity = nextRows.length ? dataRows / nextRows.length : 0;
  const mergeCount = (merges || []).filter(merge => merge.s.r <= header.headerEnd && merge.e.r >= header.headerStart).length;
  const mergeScore = Math.min(1, mergeCount / 3);
  const headerCells = matrix.slice(header.headerStart, header.headerEnd + 1).flat().filter(value => !isBlank(value));
  const numericRate = headerCells.length ? headerCells.filter(isNumeric).length / headerCells.length : 0;
  const titlePenalty = header.title ? 0.05 : 0;
  const depthFit = dataRows > 0 ? 0.1 : 0;
  return clamp(
    Math.min(1, matched / Math.min(6, columns.length)) * 0.45
      + unique * 0.15
      + dataDensity * 0.25
      + mergeScore * 0.1
      + depthFit
      - numericRate * 0.35
      - titlePenalty,
  );
}

export function buildImportRows(matrix, columns, start, end) {
  const rows = [];
  const skippedRows = [];
  for (let sourceRow = start; sourceRow <= end; sourceRow += 1) {
    const raw = Array.isArray(matrix[sourceRow]) ? matrix[sourceRow] : [];
    const kind = classifyImportRow(raw, columns);
    const values = Object.fromEntries(columns.map(column => [column.id, raw[column.columnIndex] ?? '']));
    const item = { sourceRow, sourceRowNumber: sourceRow + 1, kind, raw, values };
    const previous = rows[rows.length - 1];
    // 很多计价表会把“项目特征”或被纵向合并单元格遮住的数量、单价放到下一物理行。
    // 这不是一条新清单；在字段映射前先折叠为同一条逻辑明细，避免导入时误拆或漏掉特征。
    if (previous && isContinuationRow(item, columns)) {
      appendContinuationRow(previous, item, columns);
    } else if (previous && isComplementRow(item, columns, previous)) {
      appendComplementRow(previous, item);
    } else if (kind === 'detail') {
      rows.push(item);
    } else {
      skippedRows.push(item);
    }
  }
  return { rows, skippedRows };
}

function isContinuationRow(item, columns) {
  if (item.kind !== 'section') return false;
  const populated = populatedColumns(item, columns);
  if (!populated.length || populated.some(({ column }) => isMeasureColumn(column))) return false;
  const text = populated.map(({ value }) => String(value).trim()).join(' ');
  if (!text || /(?:分部|分项|单位工程|章节|工程$|安装工程$|土建工程$)/.test(text)) return false;
  const hasFeatureColumn = populated.some(({ column }) => isFeatureColumn(column));
  const listLike = /^(?:[（(]?\d+[.)、】【、]|[-—•])\s*/.test(text);
  // 只吸收有明确特征列的单元格，或呈现为“1、……/（1）……”的续写说明。
  return hasFeatureColumn || listLike;
}

function isComplementRow(item, columns, previous) {
  if (item.kind !== 'detail') return false;
  const populated = populatedColumns(item, columns);
  if (!populated.length || populated.some(({ column }) => isNameColumn(column))) return false;
  // 仅处理由纵向合并/拆行产生的“无名称补充行”：该行必须只含单位或数值字段，
  // 且能补齐上一行的空字段。这样正常的短行不会被错误合并。
  if (!populated.every(({ column }) => isMeasureColumn(column) || isSerialColumn(column))) return false;
  return populated.some(({ column }) => isBlank(previous.values[column.id]));
}

function appendContinuationRow(previous, continuation, columns) {
  const populated = populatedColumns(continuation, columns);
  const destination = populated.find(({ column }) => isFeatureColumn(column))?.column
    || columns.find(isFeatureColumn)
    || populated[0]?.column;
  if (!destination) return;
  const text = populated.map(({ value }) => String(value).trim()).filter(Boolean).join('\n');
  if (!text) return;
  const original = String(previous.values[destination.id] ?? '').trim();
  previous.values[destination.id] = original ? `${original}\n${text}` : text;
  previous.continuationRows ||= [];
  previous.continuationRows.push(continuation.sourceRowNumber);
}

function appendComplementRow(previous, complement) {
  Object.entries(complement.values).forEach(([key, value]) => {
    if (isBlank(previous.values[key]) && !isBlank(value)) previous.values[key] = value;
  });
  previous.continuationRows ||= [];
  previous.continuationRows.push(complement.sourceRowNumber);
}

function populatedColumns(item, columns) {
  return columns
    .map(column => ({ column, value: item.values[column.id] }))
    .filter(({ value }) => !isBlank(value));
}

function columnText(column = {}) {
  return normalizeHeaderText([...(column.path || []), column.leaf || ''].join(' '));
}

function isFeatureColumn(column) {
  return /(?:项目特征|特征|规格|型号|工作内容|描述|备注|说明)/.test(columnText(column));
}

function isNameColumn(column) {
  return /(?:项目名称|清单名称|材料名称|设备名称|名称)/.test(columnText(column)) && !isFeatureColumn(column);
}

function isMeasureColumn(column) {
  return /(?:工程量|工程数量|数量|单价|合价|金额|人工费|材料费|机械费|税率|计量单位|单位)/.test(columnText(column));
}

function isSerialColumn(column) {
  return /^(?:序号|编号)$/.test(columnText(column));
}

function detectTitleRows(grid, merges, start, end, columnCount) {
  const titles = new Set();
  if (!columnCount) return titles;
  for (let row = start; row <= end; row += 1) {
    const merge = (merges || []).find(item => item.s.r === row && item.e.r === row && (item.e.c - item.s.c + 1) / columnCount >= 0.7);
    const values = (grid[row] || []).slice(0, columnCount).filter(value => !isBlank(value));
    const normalized = [...new Set(values.map(normalizeHeaderText).filter(Boolean))];
    const signalCount = values.filter(isHeaderTerm).length;
    const projectMetadata = normalized.length <= 2 && values.some(value => /^\s*(?:工程名称|项目名称|单位工程名称|招标人|建设单位)\s*[:：]/.test(String(value)));
    const fullWidthMergedTitle = Boolean(merge) && normalized.length === 1;
    if (projectMetadata || fullWidthMergedTitle
      || ((values.length / columnCount >= 0.7 && normalized.length === 1) && signalCount < 2)) titles.add(row);
  }
  return titles;
}

function isStructuralStartRow(row = []) {
  const texts = (Array.isArray(row) ? row : [])
    .filter(value => !isBlank(value))
    .map(value => String(value).trim());
  if (!texts.length) return false;
  return texts.some(text => TOTAL_RE.test(text.replace(/\s/g, '')))
    || (texts.length === 1 && NOTE_RE.test(texts[0]));
}

function isLikelyBodyRow(row = []) {
  if (isStructuralStartRow(row)) return true;
  const values = (Array.isArray(row) ? row : []).filter(value => !isBlank(value));
  if (values.length < 2) return false;
  const first = String(values[0] ?? '').trim().replace(/\s/g, '');
  const numericLikeCount = values.filter(value => {
    const text = String(value ?? '').trim().replace(/[,，¥￥\s]/g, '');
    return isNumeric(value) || /^(?:[a-z]{0,4}[.-]?)?\d{2,}[a-z\d.-]*$/i.test(text);
  }).length;
  if (values.length >= 3 && numericLikeCount >= 1) return true;
  return values.length === 2 && numericLikeCount >= 1 && !isHeaderTerm(first) && !values.every(isHeaderTerm);
}

function hasPossibleHeaderSignal(matrix, start, maxDepth, schemaTerms = []) {
  const values = matrix.slice(start, start + maxDepth).flat().filter(value => !isBlank(value));
  return values.filter(value => isHeaderTerm(value, schemaTerms)).length >= 2;
}

function createHeaderSignature(columns) {
  return columns.map(column => column.normalizedPath.join('>') || `c${column.columnIndex + 1}`).join('|');
}

function isHeaderTerm(value, extraTerms = []) {
  const text = normalizeHeaderText(value);
  if (!text || /^\d+(?:\.\d+)?$/.test(text)) return false;
  const terms = Array.isArray(extraTerms) ? extraTerms : [];
  return [...HEADER_TERMS, ...terms].some(term => {
    const normalized = normalizeHeaderText(term);
    if (normalized.length <= 1 || text.length <= 1) return text === normalized;
    return text === normalized || text.includes(normalized) || normalized.includes(text);
  });
}

function importSchemaTerms(schema) {
  return [...new Set((schema?.fields || []).flatMap(field => [field.label, ...(field.aliases || [])]).filter(Boolean))];
}

function matchesImportColumn(value, columns) {
  const normalized = normalizeHeaderText(value);
  return Boolean(normalized) && columns.some(column => [column.leaf, ...(column.path || [])].some(header => normalizeHeaderText(header) === normalized));
}

function createManualFallbackRegion(sheet) {
  const matrix = sheet.matrix || [];
  const headerStart = matrix.findIndex(row => Array.isArray(row) && row.some(value => !isBlank(value)));
  if (headerStart < 0) return null;
  const regionId = `${sheet.name || 'sheet'}:${headerStart + 1}-${headerStart + 1}:manual`;
  const header = buildHeaderTree({
    sheetName: sheet.name || '', regionId, matrix, merges: sheet.merges || [], headerStart, headerEnd: headerStart,
  });
  const classified = buildImportRows(matrix, header.columns, headerStart + 1, matrix.length - 1);
  return {
    id: regionId,
    sheetName: sheet.name || '',
    hidden: Boolean(sheet.hidden),
    matrix,
    merges: sheet.merges || [],
    headerStart,
    headerEnd: headerStart,
    dataStart: headerStart + 1,
    dataEnd: matrix.length - 1,
    confidence: 'low',
    manualRequired: true,
    score: 0,
    title: header.title,
    columns: header.columns,
    signature: createHeaderSignature(header.columns),
    rows: classified.rows,
    skippedRows: classified.skippedRows,
    warnings: [...new Set([...(sheet.warnings || []), ...header.warnings, '未自动识别出可靠表头，请手动确认表头范围'])],
  };
}

function isNumeric(value) {
  const text = String(value ?? '').trim().replace(/[,，¥￥\s]/g, '');
  return text !== '' && Number.isFinite(Number(text));
}

function isBlank(value) {
  if (value === undefined || value === null) return true;
  // 导出表常用横线、斜线或“无”填充空单元格；把它们当作内容会让补充行
  // 误判为新明细，也会降低表头和字段映射的置信度。
  return /^(?:|--?|—|－|\/?|无|n\/?a)$/i.test(String(value).trim());
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
