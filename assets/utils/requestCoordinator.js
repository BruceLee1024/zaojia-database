export function createLatestCoordinator() {
  let generation = 0;
  return {
    async run(load, commit = null, reject = null) {
      const request = ++generation;
      try {
        const value = await load();
        if (request !== generation) return false;
        await commit?.(value, request);
        return value;
      } catch (error) {
        if (request !== generation) return false;
        if (reject) return await reject(error, request);
        throw error;
      }
    },
    invalidate() { generation += 1; },
  };
}

export function createSerializedKeyCoordinator() {
  const queues = new Map();
  return {
    run(key, operation) {
      const normalized = String(key || '');
      const previous = queues.get(normalized) || Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      queues.set(normalized, current);
      return current.finally(() => {
        if (queues.get(normalized) === current) queues.delete(normalized);
      });
    },
  };
}

export function createWorkspaceRoot(stagingNode) {
  let queryRoot = stagingNode;
  return {
    get innerHTML() { return queryRoot.innerHTML; },
    set innerHTML(value) { queryRoot.innerHTML = value; },
    get childNodes() { return stagingNode.childNodes; },
    querySelector(selector) { return queryRoot.querySelector(selector); },
    querySelectorAll(selector) { return queryRoot.querySelectorAll(selector); },
    activate(root) { queryRoot = root; },
    remove() { stagingNode.remove(); },
  };
}

export function createLatestWorkspaceCoordinator({ createRoot, commit, dispose = () => {} }) {
  let generation = 0;
  return {
    async run(render) {
      const request = ++generation;
      const root = createRoot();
      try {
        await render(root);
      } catch (error) {
        if (request !== generation) {
          dispose(root);
          return false;
        }
        dispose(root);
        throw error;
      }
      if (request !== generation) {
        dispose(root);
        return false;
      }
      commit(root);
      dispose(root);
      return true;
    },
  };
}
