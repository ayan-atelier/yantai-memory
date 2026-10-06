import { createHost } from '../shared/host.js';
import { createStore } from '../shared/store.js';
import { createPanel, node, button } from '../shared/ui.js';
import { installEntries } from '../shared/entries.js';
import { createMemory } from './modules/memory.js';

export async function createMemoryApp() {
  const host = createHost(), store = createStore(host);
  const panel = createPanel('yt-memory-dialog', '叙事记忆', { version: '0.3.0' });
  const controlKey = Symbol.for('yantai.control.registry.v1');
  let memory = null, alive = true, ownerWork = Promise.resolve(), reconciling = 0;
  const moduleEnabled = () => store.get().controlEnabled !== false;
  const hasLegacy = () => !!document.getElementById('yantai-dialog') || !!document.getElementById('yt-runtime-dialog');
  const syncKey = Symbol.for('yantai.memory.sync');
  const syncBridge = Object.freeze({
    version: 1,
    status() { return { active: alive, enabled: moduleEnabled(), ready: moduleEnabled() && !!memory && !reconciling && !hasLegacy(), ...(memory?.syncStatus() || {}) }; },
    async pause() {
      if (!moduleEnabled()) throw new Error('叙事记忆已由砚台总库关闭，请先重新启用后再同步。');
      if (!alive || reconciling || hasLegacy() || !memory) throw new Error('叙事记忆尚未就绪，请先关闭其他砚台记忆／导演扩展或刷新酒馆后再同步。');
      return memory.pauseForSync();
    },
  });
  globalThis[syncKey] = syncBridge;
  const registry = globalThis[controlKey] || (globalThis[controlKey] = { version: 1, modules: new Map() });
  if (!(registry.modules instanceof Map)) registry.modules = new Map();
  const controlModule = {
    id: 'yantai-memory', label: '叙事记忆', version: '0.3.1-dev', schemaVersion: 1, namespace: 'yantai',
    inspect() {
      const status = memory?.status?.() || syncBridge.status();
      const enabled = moduleEnabled();
      return {
        installed: true, enabled,
        health: !enabled ? 'ok' : status.lastError ? 'degraded' : status.ready === false ? 'degraded' : 'ok',
        sources: [
          { kind: 'host-settings', namespace: 'yantai', scope: 'host', portable: 'partial', readable: true, writable: true },
          { kind: 'chat-worldbook', namespace: 'yantai_narrative_memory_v1', scope: 'chat', portable: 'yes', readable: true, writable: true },
        ],
        checks: [
          { id: 'engine', label: '整理引擎', status: !enabled ? 'info' : status.lastError ? 'degraded' : 'ok', detail: !enabled ? '已由砚台总库关闭；聊天记录与世界书保留' : status.lastError || (status.running ? '正在整理' : '已就绪') },
          { id: 'sync', label: '存档同步', status: 'info', detail: '由酒馆聊天世界书承载；总控不接管存档同步' },
        ],
      };
    },
    async setEnabled(value) {
      const enabled = Boolean(value);
      store.patch({ controlEnabled: enabled });
      if (!enabled) {
        panel.close();
        memory?.destroy();
        memory = null;
        await ownerWork;
      } else {
        await reconcile();
      }
      await render();
      globalThis.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
      return enabled;
    },
  };
  registry.modules.set(controlModule.id, controlModule);
  globalThis.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
  async function render() {
    if (!alive || !panel.dialog.open) return;
    if (!moduleEnabled() || hasLegacy() || !memory) {
      panel.content.replaceChildren(node('h3', !moduleEnabled() ? '叙事记忆已关闭' : hasLegacy() ? '旧砚台仍在运行' : '正在读取记忆…'));
      if (!moduleEnabled()) {
        panel.content.append(node('p', '已由砚台总库关闭。聊天记录、记忆世界书和其他模块不会被删除；需要时可在总库重新启用。', 'yt-notice'));
        return;
      }
      if (hasLegacy()) {
        panel.content.append(node('p', '为避免重复整理或重复注入，请先在扩展列表停用旧版砚台记忆／导演运行时，再刷新酒馆。旧聊天和世界书会保留。', 'yt-notice'));
        panel.content.append(button('重新检查并接续', () => void reconcile()));
      }
      return;
    }
    await memory.render(panel.content);
  }
  function reconcile() {
    reconciling++;
    ownerWork = ownerWork.then(async () => {
      if (!alive) return;
      if (!moduleEnabled()) {
        memory?.destroy(); memory = null;
      } else if (hasLegacy()) {
        memory?.destroy(); memory = null;
      } else if (!memory) {
        const candidate = await createMemory({ host, store, ui: { confirm: panel.confirm } });
        if (!alive || !moduleEnabled() || hasLegacy()) candidate.destroy(); else memory = candidate;
      }
      await render();
    }).catch(error => {
      host.toast(error.message || '记忆启动失败，请刷新酒馆后重试。', 'error');
      if (alive && panel.dialog.open) panel.content.replaceChildren(node('p', error.message, 'yt-notice'));
    }).finally(() => { reconciling--; });
    return ownerWork;
  }
  function open() { panel.open(); void render(); }
  const entries = installEntries({ id:'yt-memory', label:'叙事记忆', glyph:'fa-book-open', order:10, open, host });
  const observer = new MutationObserver(records => {
    if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && ['yantai-dialog', 'yt-runtime-dialog'].includes(n.id)))) void reconcile();
  });
  observer.observe(document.body, { childList:true });
  document.addEventListener('yantai:memory:open', open);
  await reconcile();
  return { open, close:panel.close, host, store,
    get memory() { return memory; },
    async interceptHistory(...args) { await ownerWork; if (alive && !hasLegacy()) return memory?.interceptHistory(...args); },
    async destroy() {
      alive = false; observer.disconnect(); entries.destroy(); document.removeEventListener('yantai:memory:open', open);
      if (globalThis[syncKey] === syncBridge) delete globalThis[syncKey];
      if (globalThis[controlKey]?.modules instanceof Map && globalThis[controlKey].modules.get(controlModule.id) === controlModule) globalThis[controlKey].modules.delete(controlModule.id);
      globalThis.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
      memory?.destroy(); memory = null; await ownerWork; store.destroy(); panel.destroy();
    }
  };
}
