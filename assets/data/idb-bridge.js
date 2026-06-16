// idb-keyval 桥接：把全局 UMD 包导出成 ES Module 接口
// UMD 全局变量通常是 idbKeyval；兼容旧写法 idbKeyVal
const idb = window.idbKeyval || window.idbKeyVal || {
  async get(key) {
    return JSON.parse(localStorage.getItem(key) || 'null');
  },
  async set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};
if (!idb) {
  console.error('[idb-bridge] idbKeyVal 未加载，请检查 CDN 引入');
}
export { idb };
