export const BUILTIN_SPECIALTIES = ['土建建筑', '装饰装修', '安装', '给排水', '电气', '暖通', '园林', '市政', '污水处理'];

export function normalizeSpecialty(value) {
  return String(value || '').trim();
}

export function effectiveSpecialty(line = {}, project = {}) {
  return normalizeSpecialty(line?.specialty) || normalizeSpecialty(project?.specialty);
}

export function specialtyRank(item = {}, specialty = '') {
  const candidate = normalizeSpecialty(item.specialty);
  const requested = normalizeSpecialty(specialty);
  if (requested && candidate === requested) return 2;
  if (!candidate) return 1;
  return 0;
}

export function specialtyMatchLabel(item = {}, specialty = '') {
  const rank = specialtyRank(item, specialty);
  if (!specialty) return item.specialty ? `专业：${item.specialty}` : '通用定额';
  if (rank === 2) return `匹配专业：${specialty}`;
  if (rank === 1) return '通用定额（未指定专业）';
  return `跨专业候选：${item.specialty}（需确认）`;
}
