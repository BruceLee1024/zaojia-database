// 按需加载体积较大的浏览器依赖，避免首屏为尚未使用的导入导出和图表付出解析成本。
const pending = new Map();

function loadScript(key, src, ready) {
  if (ready()) return Promise.resolve();
  if (pending.has(key)) return pending.get(key);
  if (typeof document === 'undefined') return Promise.reject(new Error(`${key} 仅能在浏览器中加载`));

  const task = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-vendor-key="${key}"]`);
    if (existing) {
      existing.addEventListener('load', () => ready() ? resolve() : reject(new Error(`${key} 加载失败`)), { once: true });
      existing.addEventListener('error', () => reject(new Error(`${key} 加载失败，请检查网络或本地文件`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.vendorKey = key;
    script.onload = () => ready() ? resolve() : reject(new Error(`${key} 加载失败`));
    script.onerror = () => reject(new Error(`${key} 加载失败，请检查网络或本地文件`));
    document.head.appendChild(script);
  }).finally(() => pending.delete(key));

  pending.set(key, task);
  return task;
}

export async function ensureXlsx() {
  await loadScript('xlsx', '../assets/vendor/xlsx/xlsx.full.min.js', () => Boolean(globalThis.XLSX?.read && globalThis.XLSX?.utils));
  return globalThis.XLSX;
}

export async function ensureChart() {
  await loadScript('chartjs', '../assets/vendor/chartjs/chart.umd.min.js', () => typeof globalThis.Chart === 'function');
  return globalThis.Chart;
}
