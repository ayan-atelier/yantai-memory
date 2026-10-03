/** Quiescence lease for transfer. It never creates a new memory/model request. */
export function createSyncGate({ engine, isGenerating = () => false, onPause = () => {}, onResume = () => {},
  timeoutMs = 30000, timers = globalThis }) {
  const leases = new Set(), tasks = new Set(), destroyedWaiters = new Set();
  let disposed = false, scheduled = null, timer = null;
  const paused = () => leases.size > 0;
  const assertOpen = () => {
    if (disposed) throw new Error('叙事记忆已关闭，请刷新后重试同步。');
    if (paused()) throw new Error('正在交接存档，请等同步完成后再操作叙事记忆。');
  };
  const stopTimer = () => { if (timer !== null) timers.clearTimeout(timer); timer = null; };
  function run(fn) {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    const work = Promise.resolve().then(() => { assertOpen(); return fn(); });
    tasks.add(work);
    work.then(() => tasks.delete(work), () => tasks.delete(work));
    return work;
  }
  function arm() {
    if (disposed || paused() || !scheduled || timer !== null) return;
    const job = scheduled;
    timer = timers.setTimeout(() => {
      timer = null;
      if (disposed || scheduled !== job || paused()) return;
      scheduled = null;
      if (!job.valid()) { scheduled = null; return; }
      // The caller handles normal engine errors. No unhandled timer rejection.
      void run(job.fn).catch(() => {});
    }, job.delay);
  }
  function schedule(fn, valid = () => true, delay = 900) {
    if (disposed) return;
    stopTimer(); scheduled = { fn, valid, delay }; arm();
  }
  function cancelScheduled() { stopTimer(); scheduled = null; }
  async function drain() {
    while (true) {
      if (disposed) throw new Error('叙事记忆已关闭，本次同步已取消。');
      // run() and native engine.serial() may append work while an earlier action
      // drains. Re-check both queues after each settled snapshot.
      await Promise.allSettled([engine.running, engine.queue, ...tasks].filter(Boolean));
      if (disposed) throw new Error('叙事记忆已关闭，本次同步已取消。');
      if (!engine.running && !(engine.pendingSerial > 0) && !tasks.size) return;
    }
  }
  async function pause() {
    if (disposed) throw new Error('叙事记忆已关闭，请刷新后重试同步。');
    if (isGenerating()) throw new Error('酒馆正在生成回复，请结束后再交接存档。');
    const lease = {};
    const first = !paused();
    leases.add(lease);
    if (first) { stopTimer(); onPause(); }
    const release = () => {
      if (!leases.delete(lease) || disposed || paused()) return;
      onResume();
      // Resume only an already scheduled job, provided its captured chat is valid.
      if (scheduled && !scheduled.valid()) scheduled = null;
      arm();
    };
    let deadline, destroyedReject;
    try {
      const timeout = new Promise((_, reject) => {
        deadline = timers.setTimeout(() => reject(new Error('叙事记忆仍在整理或保存，已等候 30 秒。本次未同步，请完成后再试。')), timeoutMs);
      });
      const destroyed = new Promise((_, reject) => { destroyedReject = reject; destroyedWaiters.add(reject); });
      await Promise.race([drain(), timeout, destroyed]);
      if (disposed) throw new Error('叙事记忆已关闭，本次同步已取消。');
      return release;
    } catch (error) { release(); throw error; }
    finally {
      timers.clearTimeout(deadline);
      destroyedWaiters.delete(destroyedReject);
    }
  }
  function destroy() {
    disposed = true; cancelScheduled(); leases.clear();
    for (const reject of destroyedWaiters) reject(new Error('叙事记忆已关闭，本次同步已取消。'));
    destroyedWaiters.clear();
  }
  return { pause, run, schedule, cancelScheduled, assertOpen, paused,
    status: () => ({ paused: paused(), running: !!engine.running, queued: engine.pendingSerial || 0,
      activeActions: tasks.size, pendingAuto: !!scheduled, generating: !!isGenerating(), disposed }), destroy };
}
