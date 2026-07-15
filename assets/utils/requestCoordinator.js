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

export function createLatestWorkspaceCoordinator({ snapshot, restore }) {
  let generation = 0;
  let latestSnapshot;
  return {
    async run(render) {
      const request = ++generation;
      try {
        await render();
      } catch (error) {
        if (request !== generation) {
          if (latestSnapshot !== undefined) restore(latestSnapshot);
          return false;
        }
        throw error;
      }
      if (request === generation) {
        latestSnapshot = snapshot();
        return true;
      }
      if (latestSnapshot !== undefined) restore(latestSnapshot);
      return false;
    },
  };
}
