// 五类导入目标的统一 Schema 与值转换。

const COMMON_NAME = ['项目名称', '清单名称', '工程名称', '名称', '项目内容', '工作内容描述'];
const COMMON_UNIT = ['计量单位', '单位', '计量'];

const SCHEMAS = {
  project_boq: schema('project_boq', '项目工程量清单', [
    field('code', '清单编码', ['项目编码', '清单编码', '编码'], 'text'),
    field('name', '清单名称', COMMON_NAME, 'text', true),
    field('feature', '项目特征', ['项目特征', '特征描述', '清单描述', '特征'], 'text'),
    field('unit', '单位', COMMON_UNIT, 'unit', true),
    field('qty', '工程量', ['工程数量', '工程量', '数量', '计量数量'], 'number', true),
    field('unitPrice', '综合单价', ['综合单价', '清单单价', '单价'], 'money', false, { positiveContext: ['综合', '清单', '报价'], negativeContext: ['人工费', '材料费', '机械费', '运杂费'] }),
    field('amount', '合价', ['综合合价', '合价', '金额', '总价'], 'money', false, { negativeContext: ['人工费', '材料费', '机械费'] }),
    field('process', '工艺段', ['工艺段', '工艺', '区域', '单体', '分部', '专业'], 'text', false, { inheritContext: true }),
    field('costCategory', '成本分类', ['成本分类', '费用分类', '工程分类', '分类', '类别'], 'text', false, { inheritContext: true }),
  ]),
  boq_library: schema('boq_library', '清单库', [
    field('major', '专业', ['专业', '适用专业'], 'text', false, { inheritContext: true }),
    field('code', '清单编码', ['清单编码', '项目编码', '编码'], 'text'),
    field('name', '清单名称', COMMON_NAME, 'text', true),
    field('feature', '项目特征', ['项目特征', '特征', '描述'], 'text'),
    field('unit', '单位', COMMON_UNIT, 'unit', true),
    field('defaultQty', '默认工程量', ['默认工程量', '工程量', '工程数量', '数量'], 'number'),
    field('scope', '适用范围', ['适用范围'], 'text'),
    field('structureGroup', '结构分组', ['结构分组', '费用分类'], 'text', false, { inheritContext: true }),
    field('quotaRefs', '关联定额', ['关联定额编码', '关联定额', '定额编码'], 'text'),
    field('source', '来源', ['来源'], 'text'), field('version', '版本', ['版本'], 'text'), field('note', '备注', ['备注', '说明'], 'text'),
  ]),
  quota: schema('quota', '常用定额', [
    field('name', '清单名称', COMMON_NAME, 'text', true),
    field('feature', '项目特征', ['项目特征', '特征描述', '特征'], 'text'),
    field('work', '工作内容', ['工作内容', '工作内容描述'], 'text'),
    field('rule', '工程量计算规则', ['工程量计算规则', '计算规则'], 'text'),
    field('unit', '单位', COMMON_UNIT, 'unit'),
    field('priceTotal', '综合单价', ['综合单价', '清单单价', '单价'], 'money', false, { negativeContext: ['人工费', '材料费', '机械费'] }),
  ]),
  material: resourceSchema('material', '材料'),
  equipment: resourceSchema('equipment', '设备'),
};

export function getImportSchema(targetType) {
  const value = SCHEMAS[targetType];
  if (!value) throw new Error('不支持的导入目标');
  return { ...value, fields: value.fields.map(item => ({ ...item, aliases: [...item.aliases] })) };
}

export function listImportSchemas() {
  return Object.values(SCHEMAS).map(item => ({ key: item.key, label: item.label }));
}

export function normalizeImportValue(value, kind = 'text') {
  if (kind === 'number' || kind === 'money' || kind === 'percent') return normalizeImportNumber(value, { percent: kind === 'percent' });
  if (kind === 'boolean') return normalizeImportBoolean(value);
  if (kind === 'date') return normalizeImportDate(value);
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

export function normalizeImportNumber(value, { percent = false } = {}) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = String(value).trim();
  if (!text || /^(?:-|--|—|无|n\/?a)$/i.test(text)) return 0;
  const negative = /^[（(].*[）)]$/.test(text);
  const hasPercent = /[%％]$/.test(text);
  text = text.replace(/[（）()]/g, '').replace(/[,，¥￥$\s]/g, '').replace(/[％%]$/, '');
  const match = text.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return 0;
  let number = Number(match[0]);
  if (!Number.isFinite(number)) return 0;
  if (negative) number = -Math.abs(number);
  if (percent || hasPercent) number /= 100;
  return number;
}

export function normalizeImportBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', '是', '含税', '启用'].includes(text);
}

export function normalizeImportDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000) return new Date(Date.UTC(1899, 11, 30 + value)).toISOString().slice(0, 10);
  const text = String(value ?? '').trim().replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/-+/g, '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : text;
}

function resourceSchema(key, label) {
  return schema(key, `${label}库`, [
    field('code', `${label}编码`, ['编码', `${label}编码`, 'code'], 'text'),
    field('category', '分类', ['分类', `${label}分类`, 'category'], 'text', false, { inheritContext: true }),
    field('name', `${label}名称`, ['名称', `${label}名称`, 'name'], 'text', true),
    field('specModel', '规格型号', ['规格型号', '规格', '型号', 'specModel'], 'text'),
    field('unit', '单位', COMMON_UNIT, 'unit', true),
    field('brand', '品牌', ['品牌', 'brand'], 'text'), field('manufacturer', '生产厂家', ['生产厂家', '制造商', 'manufacturer'], 'text'),
    field('unitPrice', '单价', ['单价', '不含税单价', '含税单价', '价格', 'unitPrice'], 'money'),
    field('sourceType', '价格来源', ['价格来源', '来源类型', 'sourceType'], 'text'),
    field('priceBasis', '价格口径', ['价格口径', '口径', 'priceBasis'], 'text'),
    field('taxIncluded', '含税', ['含税', 'taxIncluded'], 'boolean'), field('taxRate', '税率', ['税率', 'taxRate'], 'percent'),
    field('province', '省份', ['省', '省份', 'province'], 'text'), field('city', '城市', ['市', '城市', 'city'], 'text'), field('district', '区县', ['区县', '区', 'district'], 'text'),
    field('priceDate', '价格日期', ['价格日期', '日期', 'priceDate'], 'date'), field('supplier', '供应商', ['供应商', 'supplier'], 'text'),
    field('note', '备注', ['备注', '说明', 'note'], 'text'),
  ]);
}

function schema(key, label, fields) { return { key, label, fields }; }
function field(key, label, aliases, kind, required = false, extra = {}) { return { key, label, aliases, kind, required, ...extra }; }

