// idb-keyval 桥接：把全局 UMD 包导出成 ES Module 接口
// UMD 全局变量通常是 idbKeyval；兼容旧写法 idbKeyVal
const fallbackIdb = {
  async get(key) {
    return JSON.parse(localStorage.getItem(key) || 'null');
  },
  async set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

function currentIdb() {
  if (typeof window !== 'undefined') return window.idbKeyval || window.idbKeyVal || fallbackIdb;
  return fallbackIdb;
}

const idb = {
  get: (...args) => currentIdb().get(...args),
  set: (...args) => currentIdb().set(...args),
  del: (...args) => currentIdb().del?.(...args),
};

export { idb };
