export function createLatestRequestGuard() {
  let generation = 0;
  return {
    async run(load, commit) {
      const requestGeneration = ++generation;
      try {
        const value = await load();
        if (requestGeneration !== generation) return { stale: true, value };
        await commit(value);
        return { stale: false, value };
      } catch (error) {
        if (requestGeneration !== generation) return { stale: true, error };
        throw error;
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}

export function createBusyActionRunner({ onBusy = () => {}, onError = () => {} } = {}) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(action) {
      if (busy) return { skipped: true };
      busy = true;
      onBusy(true);
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        onError(error);
        return { ok: false, error };
      } finally {
        busy = false;
        onBusy(false);
      }
    },
  };
}
