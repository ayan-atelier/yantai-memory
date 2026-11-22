import { createHost } from '../shared/host.js';
import { createStore } from '../shared/store.js';
import { createPanel, node, button } from '../shared/ui.js';
import { installEntries } from '../shared/entries.js';
import { createMemory } from './modules/memory.js';

export async function createMemoryApp() {
  const host = createHost(), store = createStore(host);
  const panel = createPanel('yt-memory-dialog', '叙事记忆', { version: '0.4.2' });
  const controlKey = Symbol.for('yantai.control.registry.v1');
  let memory = null, alive = true, ownerWork = Promise.resolve(), reconciling = 0;

  // Heal historical state drift if ST-Mate has a saved preference for yantai-memory
  const stMateCfg = host.context()?.extensionSettings?.st_mate;
  if (stMateCfg && typeof stMateCfg === 'object' && typeof stMateCfg.modules?.memory === 'boolean') {
    const desired = stMateCfg.shellEnabled !== false && Boolean(stMateCfg.modules.memory);
    if ((store.get().controlEnabled !== false) !== desired) {
      store.patch({ controlEnabled: desired });
    }
  }

  const moduleEnabled = () => store.get().controlEnabled !== false;
  const hasLegacy = () => !!document.getElementById('yantai-dialog') || !!document.getElementById('yt-runtime-dialog');
  const syncKey = Symbol.for('yantai.memory.sync');
  const syncBridge = Object.freeze({
    version: 1,
    status() { return { active: alive, enabled: moduleEnabled(), ready: moduleEnabled() && !!memory && !reconciling && !hasLegacy(), ...(memory?.syncStatus() || {}) }; },
    async pause() {
      if (!moduleEnabled()) throw new Error('叙事记忆当前处于关闭状态，请先启用后再同步。');
      if (!alive || reconciling || hasLegacy() || !memory) throw new Error('叙事记忆尚未就绪，请先关闭旧版扩展或刷新酒馆后再同步。');
      return memory.pauseForSync();
    },
  });
  globalThis[syncKey] = syncBridge;

  const registry = globalThis[controlKey] || (globalThis[controlKey] = { version: 1, modules: new Map() });
  if (!(registry.modules instanceof Map)) registry.modules = new Map();
  const controlModule = {
    id: 'yantai-memory', label: '叙事记忆', version: '0.4.2', schemaVersion: 1, namespace: 'yantai',
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
          { id: 'engine', label: '整理引擎', status: !enabled ? 'info' : status.lastError ? 'degraded' : 'ok', detail: !enabled ? '已关闭；聊天记录与世界书完整保留' : status.lastError || (status.running ? '正在整理' : '已就绪') },
          { id: 'sync', label: '存档同步', status: 'info', detail: '由酒馆聊天世界书承载，与角色世界书并存' },
        ],
      };
    },
    async setEnabled(value) {
      const enabled = Boolean(value);
      if (enabled === moduleEnabled() && Boolean(memory) === enabled) return enabled;
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
    open() { open(); },
  };
  registry.modules.set(controlModule.id, controlModule);
  globalThis.dispatchEvent?.(new CustomEvent('yantai:control:updated'));

  async function render() {
    if (!alive || !panel.dialog.open) return;
    if (!moduleEnabled() || hasLegacy() || !memory) {
      panel.content.replaceChildren(node('h3', !moduleEnabled() ? '叙事记忆已关闭' : hasLegacy() ? '检测到旧版砚台扩展冲突' : '正在加载记忆…'));
      if (!moduleEnabled()) {
        panel.content.append(
          node('p', '当前已在 ST伴侣设置中关闭叙事记忆；聊天记录与已有记忆世界书均完整保留。', 'yt-notice'),
          button('立即开启叙事记忆', () => void controlModule.setEnabled(true), 'yt-button yt-button-primary'),
        );
        return;
      }
      if (hasLegacy()) {
        panel.content.append(node('p', '为避免重复整理或重复注入，请先在酒馆扩展列表停用旧版整合砚台扩展后刷新页面。', 'yt-notice'));
        panel.content.append(button('重新检查', () => void reconcile()));
      }
      return;
    }
    await memory.render(panel.content);
  }

  function reconcile() {
    reconciling++;
    ownerWork = ownerWork.then(async () => {
      if (!alive) return;
      if (!moduleEnabled() || hasLegacy()) {
        memory?.destroy();
        memory = null;
      } else if (!memory) {
        const candidate = await createMemory({ host, store, ui: { confirm: panel.confirm } });
        if (!alive || !moduleEnabled() || hasLegacy()) candidate.destroy();
        else memory = candidate;
      }
      await render();
    }).catch(error => {
      host.toast(error.message || '叙事记忆启动异常，请刷新后重试。', 'error');
      if (alive && panel.dialog.open) panel.content.replaceChildren(node('p', error.message, 'yt-notice'));
    }).finally(() => { reconciling--; });
    return ownerWork;
  }

  function open() { panel.open(); void render(); }
  const entries = installEntries({ id: 'yt-memory', label: '叙事记忆', glyph: 'fa-book-open', order: 10, open, host });
  const observer = new MutationObserver(records => {
    if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && ['yantai-dialog', 'yt-runtime-dialog'].includes(n.id)))) {
      void reconcile();
    }
  });
  observer.observe(document.body, { childList: true });
  document.addEventListener('yantai:memory:open', open);
  await reconcile();

  return {
    open,
    close: panel.close,
    host,
    store,
    get memory() { return memory; },
    async interceptHistory(...args) { await ownerWork; if (alive && !hasLegacy()) return memory?.interceptHistory(...args); },
    async destroy() {
      alive = false;
      observer.disconnect();
      entries.destroy();
      document.removeEventListener('yantai:memory:open', open);
      if (globalThis[syncKey] === syncBridge) delete globalThis[syncKey];
      if (globalThis[controlKey]?.modules instanceof Map && globalThis[controlKey].modules.get(controlModule.id) === controlModule) {
        globalThis[controlKey].modules.delete(controlModule.id);
      }
      globalThis.dispatchEvent?.(new CustomEvent('yantai:control:updated'));
      memory?.destroy();
      memory = null;
      await ownerWork;
      store.destroy();
      panel.destroy();
    },
  };
}
