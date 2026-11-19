import C from './memory/core.js';
import Engine from './memory/engine.js';
import DEFAULT_PRESET from './memory/preset.js';
import { createStorage, parseState, marker } from './memory/storage.js';
import { createApi, MainAPI, getStMateHandle, readLocalKey, writeLocalKey } from './memory/api.js';
import { prepareHistoryWindow, applyHistoryWindow, historyWindowStatus } from './memory/history-window.js';
import { createSyncGate } from './memory/sync-gate.js';

export const MEMORY_DEFAULTS = Object.freeze({
  apiMode: 'main',
  mainModelOverride: '',
  apiUrl: '',
  model: '',
  temperature: 0.25,
  maxTokens: 8192,
  frequency: 3,
  batchSize: 10,
  chapterSpan: 24,
  timeoutSeconds: 180,
  maxInputChars: 240000,
  depth: 12,
  historyRounds: 5,
  suggestions: false,
  stripCardMemory: true,
  extraBody: '{}',
  preset: DEFAULT_PRESET,
  autoEnableNewChats: true,
  assistantAutoCompress: false,
  assistantWarnTokens: 8000,
  assistantAutoTokens: 12000,
  assistantTargetTokens: 3500,
  // Retained silently as 'off' for backward compatibility with yantai-sync settings validator
  directorMode: 'off',
  directorStrength: 'standard',
  directorRules: '',
});

const NUMERIC_FIELDS = {
  frequency: ['每几轮整理一次', 1, 100],
  batchSize: ['单次最多补记几轮', 1, 100],
  chapterSpan: ['每多少轮封存一卷', 9, 120],
  historyRounds: ['保留最近几轮原文（0＝不裁剪）', 0, 100],
  depth: ['世界书插入深度', 0, 100],
  temperature: ['采样温度', 0, 2],
  maxTokens: ['最大输出 Token', 512, 32768],
  timeoutSeconds: ['超时秒数', 30, 900],
  maxInputChars: ['单次输入字符上限', 10000, 2000000],
  assistantWarnTokens: ['过长提醒阈值（估算 Token）', 1000, 100000],
  assistantAutoTokens: ['自动压缩阈值（估算 Token）', 2000, 200000],
  assistantTargetTokens: ['压缩目标（估算 Token）', 1000, 100000],
};

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function button(text, action, primary = false) {
  const el = node('button', text, `yt-button${primary ? ' yt-button-primary' : ''}`);
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}

function section(title, detail) {
  const box = node('section', undefined, 'yt-section');
  const head = node('div', undefined, 'yt-section-head');
  head.append(node('h3', title, 'yt-section-title'));
  if (detail) head.append(node('span', detail, 'yt-section-hint'));
  box.append(head);
  return box;
}

function inputField(label, value, type = 'text') {
  const wrap = node('label', undefined, 'yt-field');
  wrap.append(node('span', label, 'yt-field-label'));
  const el = node(type === 'textarea' ? 'textarea' : 'input', undefined, type === 'textarea' ? 'yt-textarea' : 'yt-input');
  if (type !== 'textarea') el.type = type;
  el.value = value ?? '';
  wrap.append(el);
  return { wrap, input: el };
}

function toggle(label, checked, handler) {
  const wrap = node('label', undefined, 'yt-toggle-row');
  const input = node('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', handler);
  wrap.append(input, node('span', label));
  return { wrap, input };
}

function readableTable(headers, rows) {
  const table = node('table', undefined, 'yt-memory-table');
  const thead = node('thead'), tr = node('tr');
  headers.forEach(h => { const th = node('th', h); th.scope = 'col'; tr.append(th); });
  thead.append(tr);
  table.append(thead);
  const body = node('tbody');
  rows.forEach(values => {
    const row = node('tr');
    values.forEach((value, index) => {
      const td = node('td', String(value ?? '—'));
      td.dataset.label = headers[index];
      row.append(td);
    });
    body.append(row);
  });
  table.append(body);
  return table;
}

export function validateConfig(candidate) {
  const next = {
    ...MEMORY_DEFAULTS,
    ...candidate,
    directorMode: 'off',
    directorStrength: 'standard',
    directorRules: '',
    suggestions: false,
    stripCardMemory: true,
  };
  if (!['main', 'st_mate_aux', 'custom'].includes(next.apiMode)) throw new Error('请选择有效的记忆连接方式。');
  next.mainModelOverride = String(next.mainModelOverride || '').trim().slice(0, 200);
  for (const [key, [label, min, max]] of Object.entries(NUMERIC_FIELDS)) {
    next[key] = Number(next[key]);
    if (!Number.isFinite(next[key]) || next[key] < min || next[key] > max || (key !== 'temperature' && !Number.isInteger(next[key]))) {
      throw new Error(`${label}应在 ${min}—${max} 之间。`);
    }
  }
  if (next.batchSize < next.frequency) throw new Error('单次最多补记轮数不能小于整理间隔。');
  if (next.assistantAutoTokens < next.assistantWarnTokens) throw new Error('自动压缩阈值不能低于提醒阈值。');
  if (next.assistantTargetTokens >= next.assistantAutoTokens) throw new Error('压缩目标应低于自动压缩阈值。');
  if (typeof next.preset !== 'string' || !next.preset.trim() || next.preset.length > 200000) {
    throw new Error('整理规则预设不能为空，且最多 20 万字符。');
  }
  if (next.apiMode === 'custom') C.apiPayload(next, [], '');
  return next;
}

export const completionFingerprint = messages => C.hash(JSON.stringify((messages || []).map(m => ({ name: m.name, mes: m.mes, is_user: m.is_user, is_system: m.is_system }))));

export function parseBackup(text, rounds) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('备份文件不是有效 JSON。'); }
  if (data?.type === 'script') throw new Error('这是脚本安装文件，不含聊天记忆。请导入“记忆备份”文件。');
  if (data.format && !['yantai-memory-backup', 'jingdu-memory-backup'].includes(data.format)) {
    throw new Error('请选择砚台或静读导出的记忆备份文件。');
  }
  const state = C.validateState(data.state || data);
  if (C.reconcile(state, rounds).changed) throw new Error('备份与当前聊天正文不匹配，未导入，避免串入其他存档。');
  return state;
}

export async function createMemory({ host, store, ui }) {
  const savedMem = store.get().memory || {};
  const missing = Object.fromEntries(Object.entries(MEMORY_DEFAULTS).filter(([k]) => savedMem[k] === undefined));
  if (!savedMem.v4ChapteredMigrated) {
    if (!savedMem.frequency || savedMem.frequency === 1) missing.frequency = 3;
    if (!savedMem.historyRounds || savedMem.historyRounds === 3) missing.historyRounds = 5;
    if (!savedMem.depth || savedMem.depth === 4) missing.depth = 12;
    if (!savedMem.chapterSpan) missing.chapterSpan = 24;
    if (Number(savedMem.maxTokens) > 32768) missing.maxTokens = 8192;
    if (!savedMem.assistantWarnTokens || savedMem.assistantWarnTokens <= 3500) missing.assistantWarnTokens = 8000;
    if (!savedMem.assistantAutoTokens || savedMem.assistantAutoTokens <= 5000) missing.assistantAutoTokens = 12000;
    if (!savedMem.assistantTargetTokens || savedMem.assistantTargetTokens <= 1800) missing.assistantTargetTokens = 3500;
    missing.directorMode = 'off';
    missing.preset = DEFAULT_PRESET;
    missing.v4ChapteredMigrated = true;
  }
  if (Object.keys(missing).length) await store.updateModule('memory', missing);

  const config = () => ({
    ...MEMORY_DEFAULTS,
    ...store.get().memory,
    directorMode: 'off',
    suggestions: false,
    stripCardMemory: true,
  });

  let alive = true, generation = null, target = null, pane = 'chat', renderVersion = 0, memoryDirty = false;
  let assistantRunning = false, assistantAnswer = '';
  let migrationRunning = false;
  let pullingModels = false, pulledCustomModels = [];
  let needsSyncAfterPause = false;
  let statusText = '新聊天自动启用记忆，默认每 3 轮归档一次。', statusKind = 'info', injectionText = '等待下一次生成校验注入状态';
  let allRows = false, draftSettings = null, draftPreset = null;
  let historyPlan = null;
  const noteDrafts = new Map(), cleanups = [];

  const capture = () => {
    const chat = host.currentChat();
    if (!chat || chat.isGroup) return null;
    const messages = (chat.messages || []).map(m => ({ name: m.name, mes: m.mes, is_user: m.is_user, is_system: m.is_system }));
    if (generation?.key === chat.key && ['regenerate', 'swipe'].includes(generation.type) && !messages.at(-1)?.is_user) {
      messages.pop();
    }
    return { ...chat, messages };
  };

  function report(message, kind = 'info') {
    statusText = String(message);
    statusKind = kind;
    if (target?.isConnected) {
      const el = target.querySelector('.yt-memory-status-text');
      const dot = target.querySelector('.yt-status-dot');
      if (el) el.textContent = statusText;
      if (dot) dot.dataset.kind = engine?.running ? 'busy' : kind;
      const run = target.querySelector('.yt-memory-run');
      const stop = target.querySelector('.yt-memory-stop');
      if (run) run.disabled = !!engine?.running || !storage.confirmed.get(capture()?.key)?.state.enabled;
      if (stop) stop.disabled = !engine?.running;
    }
  }

  const storage = createStorage(host, config, { context: capture, alive: () => alive, isDirty: () => memoryDirty });
  const api = createApi(host);
  const adapter = { ...storage, ...api, context: capture, key: () => capture()?.key, isGenerating: () => !!generation };
  const engine = new Engine(adapter, config, report);
  const gate = createSyncGate({
    engine,
    isGenerating: () => !!generation,
    onPause: () => { historyPlan = null; },
    onResume: () => {
      if (needsSyncAfterPause && alive) {
        needsSyncAfterPause = false;
        void syncRefresh();
      }
    },
  });

  function requireGenerationReady() {
    if (!gate.paused()) return;
    host.context()?.stopGeneration?.();
    throw new Error('正在交接存档，请等同步完成后再生成回复。');
  }

  const action = fn => async event => {
    const source = event?.currentTarget;
    if (source?.tagName === 'BUTTON') source.disabled = true;
    try { await gate.run(() => fn(event)); }
    catch (error) { report(error.message || String(error), 'error'); host.toast(error.message || String(error), 'error'); }
    finally { if (source?.isConnected) source.disabled = false; }
  };

  // IME & input focus guard: never nuke active inputs during background events
  function hasFocusedInputInPanel() {
    const activeEl = globalThis.document?.activeElement;
    if (!activeEl || !target?.isConnected || !target.contains(activeEl)) return false;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName);
  }

  const refresh = async ({ force = false } = {}) => {
    if (!alive || !target?.isConnected) return;
    if (!force && hasFocusedInputInPanel()) return;
    await render(target);
  };

  const syncRefresh = async () => {
    if (gate.paused()) { needsSyncAfterPause = true; return; }
    try {
      await gate.run(async () => {
        await engine.sync();
        memoryDirty = false;
        await refresh();
      });
    } catch (error) { report(error.message, 'error'); }
  };

  async function consentFor(captured, loaded, legacy = false) {
    if (loaded.owned) return true;
    if (loaded.legacy && !legacy) {
      throw new Error('该聊天含旧版静读记忆，请先在整理配置底部点击“读取旧版记忆”完成迁移。');
    }
    if (loaded.book) {
      const message = legacy
        ? '将旧版静读记忆迁入新的砚台聊天世界书（保留原有条目与原文件不变）？'
        : loaded.fork
          ? '这是分支存档副本。为此分支建立独立的记忆世界书并保留匹配记录（原存档不变）？'
          : '当前聊天已绑定聊天世界书。将该书原有条目完整复制到新的砚台记忆世界书并绑定本聊天（原世界书文件不改动）？';
      if (!await ui.confirm(message, { title: '建立独立聊天记忆书', confirmLabel: '建立并绑定' })) return false;
    }
    if (capture()?.key !== captured.key) throw new Error('聊天已切换，请重新操作。');
    storage.allowCreate(captured.key);
    return true;
  }

  async function getView() {
    const chat = capture();
    if (!chat) return null;
    const loaded = await storage.load(chat);
    if (capture()?.key !== chat.key) return null;
    const rounds = C.roundsFrom(chat.messages, true);
    const state = C.reconcile(loaded.state, rounds).state;
    return { chat, loaded, rounds, state, memory: C.materialize(state) };
  }

  function memoryEstimate(view) {
    const cfg = config();
    return C.estimateTokens(C.renderMemory(view.memory, false, 'off', {
      prompt: true,
      recentEvents: 8,
      maxThreads: 12,
      omitRecentRounds: Math.max(0, Number(cfg.historyRounds) || 5),
    }));
  }

  async function refreshWorldbookFormatOnly() {
    const fresh = await getView();
    if (!fresh?.state.enabled) throw new Error('请先开启当前聊天的记忆。');
    if (!fresh.memory.through) throw new Error('当前还没有已整理的记忆。');
    await engine.serial(async () => {
      const current = await storage.load(fresh.chat);
      await storage.save(fresh.chat, current.state, current, () => capture()?.key === fresh.chat.key);
    });
    const afterView = await getView();
    const tokens = afterView ? memoryEstimate(afterView) : 0;
    report(`已刷新为分卷无导演精简排版（0 次请求），当前注入约 ${tokens.toLocaleString()} Token。`, 'success');
  }

  async function runOneClickArchiveSlimming() {
    if (migrationRunning || assistantRunning) throw new Error('记忆助手正在处理另一项请求，请稍候。');
    if (engine.running || generation) throw new Error('主回复或记忆整理进行中，请等完成后再执行精修。');
    const fresh = await getView();
    if (!fresh?.state.enabled) throw new Error('请先开启当前聊天的记忆。');
    if (!fresh.memory.through) throw new Error('当前还没有可精修的记忆。');
    migrationRunning = true;
    try {
      const cfg = config();
      report(`正在按分卷结构梳理前 ${fresh.memory.through} 轮纪要并结案已完成旧线程（1 次请求）…`);
      const payload = await api.payload(cfg, C.migrationMessages(fresh.memory, Math.min(cfg.maxInputChars, 180000)));
      const answer = await api.request(payload, new AbortController().signal, cfg.timeoutSeconds);
      const result = C.validateMigrationOutput(answer, fresh.memory);
      await engine.serial(async () => {
        const current = await storage.load(fresh.chat);
        if (current.state.revision !== fresh.state.revision) throw new Error('记忆在精修期间发生变化，未覆盖。');
        const delta = {
          chapterMode: true,
          replaceChapters: result.replaceChapters,
          openChapter: null,
          events: [],
          corrections: [],
          summary: result.summary,
          threads: result.threads,
          scene: fresh.memory.scene || null,
          suggestions: [],
        };
        const batch = C.makeBatch(delta, fresh.rounds, fresh.memory.through, '记忆助手分卷精修与旧账结案');
        await storage.save(fresh.chat, { ...current.state, history: [...current.state.history, batch], compact: null }, current, () => capture()?.key === fresh.chat.key);
      });
      report(`前 ${fresh.memory.through} 轮记忆已重构为锁定分卷（共 ${result.replaceChapters.length} 卷），原始逐轮记录完整保留。`, 'success');
    } finally {
      migrationRunning = false;
    }
  }

  async function runAssistantCompression(level = 2, automatic = false) {
    if (assistantRunning || migrationRunning) throw new Error('记忆助手正在处理另一项请求，请稍候。');
    if (engine.running || generation) throw new Error('主回复或记忆整理进行中，请稍候。');
    const fresh = await getView();
    if (!fresh?.state.enabled) throw new Error('请先开启当前聊天的记忆。');
    if (!fresh.memory.through) throw new Error('当前还没有可压缩的记忆。');
    assistantRunning = true;
    try {
      const estimate = memoryEstimate(fresh);
      const cfg = config();
      if (automatic && estimate < cfg.assistantAutoTokens) return false;
      report(`${automatic ? '注入长度已超自动压缩阈值，' : ''}正在生成合卷浓缩视图（1 次请求）…`);
      const messages = C.assistantMessages({ ...fresh.memory, compact: null }, level, cfg.assistantTargetTokens);
      const payload = await api.payload(cfg, messages);
      const result = await api.request(payload, new AbortController().signal, cfg.timeoutSeconds);
      const compact = C.validateAssistantOutput(result, fresh.memory, level);
      await engine.serial(async () => {
        const current = await storage.load(fresh.chat);
        if (current.state.revision !== fresh.state.revision) throw new Error('记忆在压缩期间发生变化，未覆盖。');
        await storage.save(fresh.chat, { ...current.state, compact }, current, () => capture()?.key === fresh.chat.key);
      });
      report('已完成合卷浓缩视图并同步世界书，原始分卷与逐轮记录完整保留，可随时撤销。', 'success');
      return true;
    } finally {
      assistantRunning = false;
    }
  }

  async function clearAssistantCompression() {
    const fresh = await getView();
    if (!fresh?.state.compact) { report('当前未使用压缩视图。'); return; }
    await engine.serial(async () => {
      const current = await storage.load(fresh.chat);
      if (current.state.revision !== fresh.state.revision) throw new Error('记忆已变化，未撤销。');
      await storage.save(fresh.chat, { ...current.state, compact: null }, current, () => capture()?.key === fresh.chat.key);
    });
    report('已撤销压缩，恢复完整分卷视图。', 'success');
  }

  async function askAssistant(question, context = '') {
    const text = String(question || '').trim();
    if (!text) throw new Error('请先输入想询问的问题。');
    if (assistantRunning) throw new Error('记忆助手正在处理中，请稍候。');
    assistantRunning = true;
    try {
      const cfg = config();
      report('记忆助手正在查看当前档案…');
      const payload = await api.payload(cfg, C.assistantQuestionMessages(text, context));
      const answer = await api.request(payload, new AbortController().signal, cfg.timeoutSeconds);
      assistantAnswer = answer;
      report('记忆助手已回复。', 'success');
      return answer;
    } finally {
      assistantRunning = false;
    }
  }

  async function restoreState(imported, captured, loaded, legacy = false) {
    if (!await consentFor(captured, loaded, legacy)) return;
    engine.cancel('正在导入记忆备份。', false);
    await engine.serial(async () => {
      const fresh = await storage.load(captured);
      await storage.save(
        captured,
        { ...imported, owner: captured.key, enabled: loaded.owned ? loaded.state.enabled : true, pausedByUser: false, lastError: '' },
        { ...fresh, removeLegacy: legacy },
        () => capture()?.key === captured.key,
      );
    });
    report('记忆备份已导入并启用，未发起额外模型请求。', 'success');
    await refresh({ force: true });
  }

  function upload(text, accept, callback) {
    const wrap = node('span', undefined, 'yt-memory-upload');
    const file = node('input');
    file.type = 'file';
    file.accept = accept;
    file.hidden = true;
    file.addEventListener('change', action(async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try { await callback(selected); } finally { file.value = ''; }
    }));
    wrap.append(button(text, () => file.click()), file);
    return wrap;
  }

  function renderChat(box, view) {
    if (!view) {
      const empty = section('当前总览', '支持单角色聊天');
      empty.append(node('p', host.currentChat()?.isGroup ? '暂不支持群聊模式，请打开单角色存档。' : '尚未打开角色聊天。打开任意新角色对话后会自动启用记忆，满 3 轮自动归档。', 'yt-empty'));
      box.append(empty);
      return;
    }

    const { chat, loaded, state, memory, rounds } = view;
    const cfg = config();
    const overview = node('section', undefined, 'yt-section');

    const topBar = node('div', undefined, 'yt-chat-bar');
    const titleGroup = node('div', undefined, 'yt-chat-meta');
    titleGroup.append(node('strong', `${chat.name || '当前角色'} · ${chat.id}`, 'yt-memory-chat-name'));
    if (loaded.charBooks?.length) {
      titleGroup.append(node('span', `角色世界书：${loaded.charBooks.join('、')}（并存生效）`, 'yt-pill'));
    }
    const enabledToggle = toggle('启用本聊天记忆', state.enabled, action(async event => {
      const checkbox = event.currentTarget;
      const next = checkbox.checked;
      try {
        const current = await storage.load(chat);
        if (next && !await consentFor(chat, current)) { checkbox.checked = false; return; }
        await engine.setEnabled(next);
        await refresh({ force: true });
      } catch (error) {
        checkbox.checked = state.enabled;
        throw error;
      }
    }));
    topBar.append(titleGroup, enabledToggle.wrap);
    overview.append(topBar);

    if (loaded.fork) overview.append(node('p', '检测到分支存档副本，已默认暂停记忆；勾选上方开关可为此分支建立独立记忆书。', 'yt-notice'));
    if (loaded.legacy) overview.append(node('p', '检测到旧版静读记忆，可在“整理配置 → 备份与导入导出”中迁移接管。', 'yt-notice'));

    const estimate = memoryEstimate(view);
    const sealedCount = memory.chapters?.length || (memory.through > 0 && !memory.openChapter ? 1 : 0);
    const stats = node('div', undefined, 'yt-memory-stats');
    [
      [memory.through, '已记轮数'],
      [Math.max(0, rounds.length - memory.through), '待记轮数'],
      [sealedCount, '锁定分卷'],
      [estimate.toLocaleString(), '注入估算 Token'],
    ].forEach(([value, label]) => {
      const item = node('div');
      item.append(node('strong', String(value)), node('span', label));
      stats.append(item);
    });
    overview.append(stats);

    const commands = node('div', undefined, 'yt-inline');
    const run = button('立即整理 · 1 次请求', action(async () => {
      await engine.run(true);
      noteDrafts.delete(chat.key);
      await refresh({ force: true });
    }), true);
    run.classList.add('yt-memory-run');
    run.disabled = !state.enabled || !!engine.running;

    const stop = button('停止', action(async () => {
      engine.cancel();
      report('已请求停止整理，旧记录完整保留。');
    }));
    stop.classList.add('yt-memory-stop');
    stop.disabled = !engine.running;
    commands.append(run, stop);

    if (memory.through > 0) {
      const refreshFmtBtn = button('刷新世界书排版 · 0 请求', action(async () => {
        await refreshWorldbookFormatOnly();
        await refresh({ force: true });
      }));
      refreshFmtBtn.disabled = !state.enabled || !!engine.running;
      commands.append(refreshFmtBtn);
    }
    overview.append(commands);

    if (state.pausedByUser) {
      overview.append(node('p', '已手动暂停自动整理；点击“立即整理”成功后恢复自动运行。', 'yt-notice'));
    } else if (state.lastError) {
      overview.append(node('p', `上次整理未完成：${state.lastError}`, 'yt-notice'));
    }
    if (estimate >= cfg.assistantWarnTokens) {
      overview.append(node('p', `当前注入约 ${estimate.toLocaleString()} Token，可前往“记忆助手”合并浓缩超早期分卷。`, 'yt-notice'));
    }

    const metaList = node('div', undefined, 'yt-meta-lines');
    metaList.append(
      node('p', `节奏：每 ${cfg.frequency} 轮自动整理 · 每满 ${cfg.chapterSpan} 轮封存一卷（永不重洗旧卷） · 保留最近 ${cfg.historyRounds} 轮对话原文`, 'yt-muted'),
      node('p', loaded.book ? `绑定聊天世界书：${loaded.book}` : '聊天世界书：首次满轮整理时自动建立（不改动角色世界书）', 'yt-muted'),
      node('p', injectionText, 'yt-muted yt-memory-injection'),
    );
    overview.append(metaList);
    box.append(overview);

    const noteDetails = node('details', undefined, 'yt-memory-advanced');
    if (state.note || noteDrafts.get(chat.key)) noteDetails.open = true;
    noteDetails.append(node('summary', state.note ? '纠正或补充记忆（已有待生效备注）' : '纠正或补充一处记忆'));
    const field = inputField('事实修订备注（下次整理或点“立即整理”时生效）', noteDrafts.get(chat.key) ?? state.note, 'textarea');
    field.input.rows = 3;
    field.input.placeholder = '例如：第 12 轮她只是在心里起意，并未当面说出；或：翡翠手镯仍在右腕未摘下。';
    field.input.addEventListener('input', () => noteDrafts.set(chat.key, field.input.value));
    const saveNoteBtn = button('保存备注', action(async () => {
      if (!state.enabled) throw new Error('请先开启当前聊天的记忆。');
      await engine.saveNote(field.input.value);
      noteDrafts.delete(chat.key);
      report('修订备注已保存，将在下次整理时应用。', 'success');
    }));
    noteDetails.append(field.wrap, saveNoteBtn);
    box.append(noteDetails);
  }

  function renderRecords(box, view) {
    if (!view?.memory.through) {
      box.append(node('p', '当前聊天尚无已归档记忆。对话满 3 轮或点击“立即整理”后即可在此查阅。', 'yt-empty'));
      return;
    }
    const mem = view.memory;

    if (mem.scene) {
      const sceneSec = section('当前场景与知情边界', '防跨角色读心锚点');
      const lines = [
        `时间：${mem.scene.time || '未明'} ｜ 地点：${mem.scene.location || '未明'} ｜ 在场：${mem.scene.present?.join('、') || '未明'}`,
      ];
      if (mem.scene.secrets?.length) {
        lines.push(`双方知情差：${mem.scene.secrets.join('；')}`);
      }
      sceneSec.append(node('p', lines.join('\n'), 'yt-memory-prose'));
      box.append(sceneSec);
    }

    const activeSummary = (mem.compact && mem.compact.through === mem.through && mem.compact.summary)
      ? mem.compact.summary
      : mem.summary;
    const volHint = mem.compact && mem.compact.through === mem.through
      ? '合卷浓缩视图生效中'
      : `已锁定 ${mem.chapters?.length || 0} 卷 · 封存旧卷永不重洗`;
    const chronicleSec = section('分卷主线纪要', volHint);
    chronicleSec.append(node('p', activeSummary || '暂无摘要。', 'yt-memory-prose'));
    box.append(chronicleSec);

    const anchors = C.extractLongTermAnchors(mem);
    if (anchors.items.length) {
      const itemSec = section('关键信物与状态账本', `常驻保留 ${anchors.items.length} 项核心物品／凭证`);
      itemSec.append(readableTable(
        ['记录轮次', '信物／凭证名称', '来历与当前归属状态'],
        anchors.items.map(it => [
          it.firstRound === it.round ? `第 ${it.round} 轮` : `第 ${it.firstRound}→${it.round} 轮`,
          it.name,
          it.reason,
        ]),
      ));
      box.append(itemSec);
    }

    const projection = C.projectForPrompt(mem, { recentEvents: 12, maxThreads: 24 });
    const activeIds = new Set(projection.threads.map(t => t.id));
    const activeThreadsSec = section('当前开放线程与有效约定', `${projection.threads.length} 条生效中`);
    activeThreadsSec.append(
      projection.threads.length
        ? readableTable(
            ['类型', '标题', '已确认内容', '条件／待解', '进展'],
            projection.threads.map(t => [t.kind, t.title, t.known || t.content, t.unknown || t.due || '—', t.status]),
          )
        : node('p', '暂无开放线程。', 'yt-muted'),
    );
    box.append(activeThreadsSec);

    const archivedThreads = mem.threads.filter(t => !activeIds.has(t.id));
    if (archivedThreads.length) {
      const details = node('details', undefined, 'yt-memory-advanced');
      details.append(node('summary', `已结案或归档事项（${archivedThreads.length} 条 · 不占提示词空间）`));
      details.append(readableTable(
        ['记录时间', '类型', '标题', '结案状态'],
        archivedThreads.map(t => [t.at, t.kind, t.title || t.content, t.status]),
      ));
      box.append(details);
    }

    const ledger = section('逐轮事件全表', `共 ${mem.events.length} 轮完整底档`);
    const rows = allRows ? mem.events : mem.events.slice(-12);
    if (mem.events.length > 12) {
      ledger.append(button(
        allRows ? '收起为最近 12 轮' : `展开全部 ${mem.events.length} 轮`,
        action(async () => { allRows = !allRows; await refresh({ force: true }); }),
      ));
    }
    ledger.append(readableTable(
      ['轮次', '时间', '地点', '因果经过', '信物／暗线后果'],
      rows.map(r => [
        r.round,
        r.time,
        r.place,
        r.description || r.action || '—',
        [r.item ? `${r.item.name}（${r.item.reason}）` : '', ...(r.consequences || [])].filter(Boolean).join('；') || '—',
      ]),
    ));
    box.append(ledger);
  }

  function renderAssistant(box, view) {
    const intro = section('分卷精修与超长篇浓缩', '原始逐轮事件永久保留');
    if (!view) {
      intro.append(node('p', '请先打开一个角色聊天后再使用记忆助手。', 'yt-empty'));
      box.append(intro);
      return;
    }
    const estimate = memoryEstimate(view), cfg = config();
    intro.append(node('p', `当前注入记忆约 ${estimate.toLocaleString()} Token（估算）。日常 300 轮以内由自动分卷锁定机制直接保障零丢记忆，无需手动压缩；若是从旧版继承的存档或超 500 轮长篇，可按需使用下方工具。`, 'yt-muted'));
    if (view.memory.compact) {
      intro.append(node('p', '当前正在使用合卷浓缩视图，可随时点击“撤销浓缩”恢复原分卷。', 'yt-notice'));
    }

    const actions = node('div', undefined, 'yt-inline');
    const slimBtn = button('分卷精修旧存档＋清理旧线程 · 1 次请求', action(async () => {
      await runOneClickArchiveSlimming();
      await refresh({ force: true });
    }), true);
    const mergeBtn = button('超长篇早期分卷合编 · 1 次请求', action(async () => {
      if (!await ui.confirm('将当前全卷浓缩为高密度合卷视图？原始分卷与逐轮事件不会删除，随时可撤销。', { title: '确认合卷浓缩', confirmLabel: '开始合编' })) return;
      await runAssistantCompression(2);
      await refresh({ force: true });
    }));
    const busy = assistantRunning || migrationRunning || !view.state.enabled || !view.memory.through;
    slimBtn.disabled = busy;
    mergeBtn.disabled = busy;
    actions.append(slimBtn, mergeBtn);
    if (view.memory.compact) {
      actions.append(button('撤销浓缩', action(async () => {
        await clearAssistantCompression();
        await refresh({ force: true });
      })));
    }
    intro.append(actions);
    box.append(intro);

    const help = section('询问记忆助手', '仅作答，不改动聊天与世界书');
    const question = inputField('输入你的疑问', '', 'textarea');
    question.input.rows = 3;
    question.input.placeholder = '例如：检查一下前文有哪些还没解开的线索？或者：如何搭配轻量模型最稳？';
    help.append(question.wrap);
    const ask = button('发送提问 · 1 次请求', action(async () => {
      const context = view ? C.renderMemory({ ...view.memory, compact: null }, false, 'off').slice(0, 30000) : '';
      await askAssistant(question.input.value, context);
      await refresh({ force: true });
    }));
    ask.disabled = assistantRunning;
    help.append(ask);
    if (assistantAnswer) help.append(node('div', assistantAnswer, 'yt-memory-prose yt-assistant-answer'));
    box.append(help);
  }

  function renderSettings(box) {
    const current = { ...config(), ...(draftSettings || {}) };
    const stMate = getStMateHandle();
    const auxInfo = stMate?.inspectAuxChannel?.() || null;

    const connSec = section('记忆整理模型连接', '推荐轻量快速模型（如 Flash / DeepSeek / Haiku）');
    const modeWrap = node('label', undefined, 'yt-field');
    modeWrap.append(node('span', '连接通道', 'yt-field-label'));
    const modeSelect = node('select', undefined, 'yt-select');
    const modeOptions = [
      ['st_mate_aux', stMate ? '跟随 ST伴侣「副 API 通道」（推荐轻量模型）' : '跟随 ST伴侣「副 API 通道」（未安装时自动回退主 API）'],
      ['main', '跟随酒馆主 API（支持同站指定轻量模型）'],
      ['custom', '独立自定义 API（OpenAI 兼容接口）'],
    ];
    modeOptions.forEach(([val, text]) => {
      const opt = node('option', text);
      opt.value = val;
      modeSelect.append(opt);
    });
    modeSelect.value = ['st_mate_aux', 'main', 'custom'].includes(current.apiMode) ? current.apiMode : 'main';
    modeWrap.append(modeSelect);
    connSec.append(modeWrap);

    // 1) ST-Mate Aux panel
    const auxBox = node('div', undefined, 'yt-subpanel');
    auxBox.hidden = modeSelect.value !== 'st_mate_aux';
    if (stMate && auxInfo) {
      const auxRow = node('div', undefined, 'yt-inline');
      auxRow.append(node('span', `当前通道：${auxInfo.detailLabel || auxInfo.badgeLabel}`, 'yt-muted'));
      if (typeof stMate.open === 'function') {
        auxRow.append(button('打开伴侣 API 工作台选模', () => {
          document.getElementById('yt-memory-dialog')?.close?.();
          stMate.open('api-dock');
        }));
      }
      auxBox.append(auxRow);
    } else {
      auxBox.append(node('p', '当前未检测到运行中的 ST伴侣（朋友单独安装时将自动回退跟随酒馆主 API）。', 'yt-muted'));
    }
    connSec.append(auxBox);

    // 2) Follow Main API panel (+ optional same-station lightweight model override!)
    const mainBox = node('div', undefined, 'yt-subpanel');
    mainBox.hidden = modeSelect.value !== 'main';
    try {
      const conn = MainAPI.connection(host.context(), current.mainModelOverride);
      mainBox.append(node('p', `当前主连接：${conn.source} · 主对话模型 ${conn.hostModel || '默认'}${conn.isOverridden ? ` → 记忆使用 ${conn.model}` : ''}`, 'yt-muted'));
    } catch (error) {
      mainBox.append(node('p', error.message, 'yt-notice'));
    }
    const overrideField = inputField('同站指定记忆轻量模型（可选，留空则使用当前主模型）', current.mainModelOverride || '', 'text');
    overrideField.input.placeholder = '可手填或从右侧候选点选同站轻量模型，零额外配密钥';
    const hostModels = MainAPI.availableHostModels(host.context());
    if (hostModels.length) {
      const listId = 'yt-mem-host-models';
      const datalist = node('datalist');
      datalist.id = listId;
      hostModels.forEach(m => { const opt = node('option'); opt.value = m; datalist.append(opt); });
      overrideField.input.setAttribute('list', listId);
      overrideField.wrap.append(datalist);
    }
    overrideField.input.addEventListener('input', () => {
      draftSettings = { ...(draftSettings || {}), mainModelOverride: overrideField.input.value };
    });
    mainBox.append(overrideField.wrap);
    connSec.append(mainBox);

    // 3) Custom API panel (+ one-click fetch model list!)
    const customBox = node('div', undefined, 'yt-subpanel');
    customBox.hidden = modeSelect.value !== 'custom';
    const controls = { mainModelOverride: overrideField.input };
    const urlField = inputField('API 地址（OpenAI 兼容 /v1）', current.apiUrl, 'url');
    urlField.input.placeholder = 'https://你的服务地址/v1';
    urlField.input.autocomplete = 'off';
    urlField.input.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), apiUrl: urlField.input.value }; });
    controls.apiUrl = urlField.input;

    const keyField = inputField('API 密钥（仅存本地浏览器）', readLocalKey(), 'password');
    keyField.input.placeholder = 'sk-...';
    keyField.input.autocomplete = 'off';
    controls.apiKey = keyField.input;

    const modelWrap = node('div', undefined, 'yt-field');
    modelWrap.append(node('span', '记忆模型名称', 'yt-field-label'));
    const modelRow = node('div', undefined, 'yt-model-row');
    const modelInput = node('input', undefined, 'yt-input');
    modelInput.type = 'text';
    modelInput.value = current.model ?? '';
    modelInput.placeholder = '点右侧“拉取模型”选择，或直接输入模型 ID';
    modelInput.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), model: modelInput.value }; });
    controls.model = modelInput;

    const pullBtn = button(pullingModels ? '拉取中…' : '拉取模型', action(async () => {
      if (pullingModels) return;
      pullingModels = true;
      try {
        const models = await api.fetchCustomModels(urlField.input.value, keyField.input.value.trim());
        pulledCustomModels = models;
        if (!models.length) {
          report('连接成功，但服务商未返回公开模型列表，请直接手填模型 ID。');
        } else {
          if (!modelInput.value.trim()) {
            modelInput.value = models[0];
            draftSettings = { ...(draftSettings || {}), model: models[0] };
          }
          report(`已获取 ${models.length} 个可用模型，可在下拉框中点选轻量模型。`, 'success');
        }
      } finally {
        pullingModels = false;
      }
      await refresh({ force: true });
    }));
    modelRow.append(modelInput, pullBtn);
    modelWrap.append(modelRow);

    if (pulledCustomModels.length) {
      const quickSelect = node('select', undefined, 'yt-select');
      const placeholderOpt = node('option', `从已拉取的 ${pulledCustomModels.length} 个模型中点选…`);
      placeholderOpt.value = '';
      quickSelect.append(placeholderOpt);
      pulledCustomModels.forEach(m => {
        const opt = node('option', m);
        opt.value = m;
        if (m === modelInput.value.trim()) opt.selected = true;
        quickSelect.append(opt);
      });
      quickSelect.addEventListener('change', () => {
        if (!quickSelect.value) return;
        modelInput.value = quickSelect.value;
        draftSettings = { ...(draftSettings || {}), model: quickSelect.value };
      });
      modelWrap.append(quickSelect);
    }

    customBox.append(urlField.wrap, keyField.wrap, modelWrap);
    connSec.append(customBox);

    modeSelect.addEventListener('change', () => {
      draftSettings = { ...(draftSettings || {}), apiMode: modeSelect.value };
      auxBox.hidden = modeSelect.value !== 'st_mate_aux';
      mainBox.hidden = modeSelect.value !== 'main';
      customBox.hidden = modeSelect.value !== 'custom';
    });

    // Cadence & Long-Horizon Chapter Archiving
    const cadenceSec = section('自动整理与长线分卷', '300+ 轮防丢记忆核心参数');
    const autoEnable = toggle('新聊天默认启用记忆（与角色世界书自动共存）', current.autoEnableNewChats !== false, () => {
      draftSettings = { ...(draftSettings || {}), autoEnableNewChats: autoEnable.input.checked };
    });
    controls.autoEnableNewChats = autoEnable.input;
    cadenceSec.append(autoEnable.wrap);

    const primaryKeys = ['frequency', 'batchSize', 'chapterSpan', 'historyRounds'];
    const primaryGrid = node('div', undefined, 'yt-grid');
    const advancedGrid = node('div', undefined, 'yt-grid');

    for (const [key, [label, min, max]] of Object.entries(NUMERIC_FIELDS)) {
      const field = inputField(label, current[key], 'number');
      controls[key] = field.input;
      field.input.min = min;
      field.input.max = max;
      field.input.step = key === 'temperature' ? '0.05' : '1';
      field.input.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), [key]: field.input.value }; });
      (primaryKeys.includes(key) ? primaryGrid : advancedGrid).append(field.wrap);
    }
    cadenceSec.append(primaryGrid);

    const saveBtn = button('保存配置', action(async () => {
      const next = {
        ...config(),
        apiMode: modeSelect.value,
        mainModelOverride: controls.mainModelOverride.value.trim(),
        apiUrl: controls.apiUrl.value.trim(),
        model: controls.model.value.trim(),
        extraBody: controls.extraBody.value.trim(),
        preset: controls.preset.value.trim(),
        autoEnableNewChats: controls.autoEnableNewChats.checked,
        assistantAutoCompress: controls.assistantAutoCompress.checked,
      };
      for (const key of Object.keys(NUMERIC_FIELDS)) next[key] = controls[key].value;
      const validated = validateConfig(next);
      if (next.apiMode === 'custom' || controls.apiKey.value.trim() !== readLocalKey()) {
        writeLocalKey(controls.apiKey.value.trim());
      }
      engine.cancel('配置已更新，停止进行中的旧整理。', false);
      await store.updateModule('memory', validated);
      draftSettings = null;
      draftPreset = null;
      const chat = capture();
      if (chat) {
        await engine.serial(async () => {
          const loaded = await storage.load(chat);
          if (loaded.owned) await storage.save(chat, loaded.state, loaded, () => capture()?.key === chat.key);
        });
      }
      report('配置已保存并立即生效。', 'success');
      await refresh({ force: true });
    }), true);

    box.append(connSec, cadenceSec, saveBtn);

    // Folded Advanced Options + Prompt Preset
    const advanced = node('details', undefined, 'yt-memory-advanced');
    advanced.append(node('summary', '高级参数与整理规则模板'));
    const autoCompress = toggle('超过阈值后空闲时自动合卷压缩（默认关闭）', !!current.assistantAutoCompress, () => {
      draftSettings = { ...(draftSettings || {}), assistantAutoCompress: autoCompress.input.checked };
    });
    controls.assistantAutoCompress = autoCompress.input;
    const extraField = inputField('自定义接口额外请求体（JSON）', current.extraBody, 'textarea');
    extraField.input.rows = 2;
    controls.extraBody = extraField.input;
    extraField.input.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), extraBody: extraField.input.value }; });

    const presetField = inputField('记忆整理系统规则模板', draftPreset ?? current.preset, 'textarea');
    presetField.input.rows = 12;
    presetField.input.classList.add('yt-memory-preset');
    controls.preset = presetField.input;
    presetField.input.addEventListener('input', () => { draftPreset = presetField.input.value; });

    const presetActions = node('div', undefined, 'yt-inline');
    presetActions.append(
      button('恢复默认规则', action(async () => {
        if (!await ui.confirm('恢复为砚台默认分卷整理规则？点击上方“保存配置”后生效。', { title: '恢复默认规则', confirmLabel: '恢复' })) return;
        draftPreset = DEFAULT_PRESET;
        presetField.input.value = DEFAULT_PRESET;
        report('已载入默认规则，请点击“保存配置”生效。');
      })),
      button('导出规则', () => host.download('yantai-memory-preset.txt', presetField.input.value)),
      upload('导入规则', '.txt,.md,text/plain', async file => {
        if (file.size > 200000) throw new Error('规则文件超过 200 KB。');
        const text = await file.text();
        if (!text.trim()) throw new Error('规则文件为空。');
        draftPreset = text;
        presetField.input.value = text;
        report('规则已载入，请点击“保存配置”生效。');
      }),
    );

    advanced.append(advancedGrid, autoCompress.wrap, extraField.wrap, presetField.wrap, presetActions);
    box.append(advanced);

    // Folded Data Backup & Migration
    const dataDetails = node('details', undefined, 'yt-memory-advanced');
    const currentChat = capture();
    const hasLegacy = Boolean(currentChat && storage.confirmed.get(currentChat.key)?.legacy);
    if (hasLegacy) dataDetails.open = true;
    dataDetails.append(node('summary', '备份与导入导出'));
    const backups = node('div', undefined, 'yt-inline');
    backups.append(
      button('导出 JSON 备份', action(async () => {
        const fresh = await getView();
        if (!fresh) throw new Error('请先打开聊天。');
        host.download(
          `yantai-memory-${C.hash(fresh.chat.key)}.json`,
          JSON.stringify({ format: 'yantai-memory-backup', version: C.VERSION, state: fresh.state }, null, 2),
          'application/json',
        );
        report('JSON 记忆备份已导出。', 'success');
      })),
      button('导出可读 TXT', action(async () => {
        const fresh = await getView();
        if (!fresh) return;
        host.download('yantai-memory.txt', C.renderMemory(fresh.memory, false, 'off', { includeArchived: true }) || '尚无记忆记录。');
      })),
      upload('导入 JSON 备份', '.json,application/json', async file => {
        if (file.size > 20000000) throw new Error('备份超过 20 MB。');
        const fresh = await getView();
        if (!fresh) throw new Error('请先打开对应的聊天。');
        const imported = parseBackup(await file.text(), fresh.rounds);
        if (!await ui.confirm('用该备份替换本聊天记忆？聊天正文不会改动。', { title: '导入记忆备份', confirmLabel: '确认导入' })) return;
        await restoreState(imported, fresh.chat, fresh.loaded, fresh.loaded.legacy);
      }),
    );
    if (hasLegacy) {
      backups.append(button('读取旧版静读记忆', action(async () => {
        const fresh = await getView();
        if (!fresh) return;
        const legacy = parseState(fresh.loaded.data, true);
        if (!legacy) throw new Error('未找到旧版内部备份条目。');
        if (C.reconcile(legacy, fresh.rounds).changed) throw new Error('旧版备份与当前聊天正文不一致。');
        await restoreState(legacy, fresh.chat, fresh.loaded, true);
      }), true));
    }
    dataDetails.append(backups);
    box.append(dataDetails);
  }

  async function render(container) {
    target = container;
    const version = ++renderVersion;
    const shell = node('div', undefined, 'yt-memory');
    const nav = node('div', undefined, 'yt-memory-tabs');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', '叙事记忆');
    for (const [key, label] of [
      ['chat', '当前总览'],
      ['records', '记忆档案'],
      ['assistant', '记忆助手'],
      ['settings', '整理配置'],
    ]) {
      const tab = button(label, action(async () => { pane = key; await refresh({ force: true }); }));
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(pane === key));
      nav.append(tab);
    }

    const statusBar = node('div', undefined, 'yt-memory-status');
    statusBar.setAttribute('role', 'status');
    const dot = node('span', undefined, 'yt-status-dot');
    dot.dataset.kind = engine.running ? 'busy' : statusKind;
    const textSpan = node('span', statusText, 'yt-memory-status-text');
    statusBar.append(dot, textSpan);

    shell.append(nav, statusBar);
    const content = node('div', undefined, 'yt-memory-content');
    content.setAttribute('role', 'tabpanel');
    shell.append(content);
    container.replaceChildren(shell);

    if (pane === 'settings') {
      renderSettings(content);
      return;
    }
    content.append(node('p', '正在读取当前聊天记忆…', 'yt-muted'));
    try {
      const view = await getView();
      if (!alive || version !== renderVersion || target !== container) return;
      content.replaceChildren();
      if (pane === 'chat') renderChat(content, view);
      else if (pane === 'records') renderRecords(content, view);
      else renderAssistant(content, view);
    } catch (error) {
      if (version === renderVersion) {
        content.replaceChildren(node('p', error.message, 'yt-notice'));
        report(error.message, 'error');
      }
    }
  }

  cleanups.push(host.on('GENERATION_STARTED', (type, _options, dryRun) => {
    if (!dryRun) requireGenerationReady();
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    historyPlan = null;
    const start = host.currentChat();
    generation = { key: start?.key, type, stopped: false, before: completionFingerprint(start?.messages) };
    gate.cancelScheduled();
    if (['regenerate', 'swipe'].includes(type)) engine.cancel('正在重新生成，停止上一版回复的整理。', false);
  }));

  cleanups.push(host.on('GENERATION_AFTER_COMMANDS', async (type, _options, dryRun) => {
    if (!dryRun) requireGenerationReady();
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    try {
      await gate.run(async () => {
        if (engine.running) await engine.running;
        await engine.sync();
      });
    } catch (error) { report(error.message, 'error'); }
  }));

  cleanups.push(host.on('GENERATION_STOPPED', () => {
    historyPlan = null;
    if (generation) generation.stopped = true;
    gate.cancelScheduled();
  }));

  cleanups.push(host.on('GENERATION_ENDED', () => {
    const finished = generation;
    generation = null;
    historyPlan = null;
    if (!finished || finished.stopped || finished.key !== capture()?.key) return;
    gate.cancelScheduled();
    gate.schedule(async () => {
      const latest = capture();
      if (!alive || generation || finished.key !== latest?.key) return;
      const last = latest.messages.at(-1);
      if (!last || last.is_user || last.is_system || !last.mes?.trim() || completionFingerprint(latest.messages) === finished.before) return;
      const memoryUpdated = await engine.run(false);
      if (memoryUpdated && config().assistantAutoCompress && !assistantRunning) {
        try { await gate.run(() => runAssistantCompression(2, true)); }
        catch (error) { report(`自动压缩未完成，原分卷记忆保留：${error.message}`, 'error'); }
      }
      if (pane === 'chat' || pane === 'records') await refresh();
    }, () => alive && !generation && finished.key === capture()?.key, 900);
  }));

  const changed = () => {
    memoryDirty = true;
    historyPlan = null;
    gate.cancelScheduled();
    if (gate.paused()) { needsSyncAfterPause = true; return; }
    engine.cancel('剧情已修改，停止旧整理。', false);
    void syncRefresh();
  };
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED']) {
    cleanups.push(host.on(event, changed));
  }

  cleanups.push(host.on('CHAT_CHANGED', () => {
    memoryDirty = true;
    assistantAnswer = '';
    historyPlan = null;
    gate.cancelScheduled();
    generation = null;
    if (gate.paused()) { needsSyncAfterPause = true; return; }
    engine.cancel('聊天已切换，停止上一聊天整理。', false);
    injectionText = '等待下一次生成校验注入状态';
    report('正在读取当前聊天记忆…');
    void syncRefresh().then(() => {
      const view = storage.confirmed.get(capture()?.key);
      if (view) {
        report(view.state.enabled ? '当前聊天记忆已就绪（按间隔自动归档）。' : '当前聊天记忆已暂停。');
      }
    });
  }));

  cleanups.push(host.on('WORLDINFO_ENTRIES_LOADED', storage.filterLore));

  cleanups.push(host.on('WORLD_INFO_ACTIVATED', entries => {
    if (gate.paused()) return;
    const current = capture(), loaded = current && storage.confirmed.get(current.key);
    if (!alive || generation?.stopped || !loaded?.state.enabled || storage.binding(current) !== loaded.book) return;
    applyHistoryWindow(historyPlan, entries, current.key, loaded.state.revision);
  }));

  cleanups.push(host.on('CHAT_COMPLETION_PROMPT_READY', ({ chat, dryRun } = {}) => {
    if (!dryRun) requireGenerationReady();
    const current = capture(), loaded = current && storage.confirmed.get(current.key);
    if (dryRun || !Array.isArray(chat)) return;
    const text = chat.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    if (historyPlan?.applied && (!loaded?.state.enabled || current?.key !== historyPlan.owner ||
        loaded.state.revision !== historyPlan.revision || storage.binding(current) !== loaded.book ||
        !text.includes(historyPlan.begin) || !text.includes(historyPlan.end))) {
      host.context().stopGeneration();
      report('记忆未完整进入本次提示词，已中止生成以防丢失前情。请检查世界书空间，或将保留原文轮数设为 0。', 'error');
      host.toast(statusText, 'error');
      return;
    }
    if (!loaded?.state.enabled || !C.materialize(loaded.state).through) return;
    const found = text.includes(marker(current.key, loaded.state.revision)) && text.includes(marker(current.key, loaded.state.revision, true));
    injectionText = found
      ? `最近一次提示词校验：已携带前 ${C.materialize(loaded.state).through} 轮记忆。${historyWindowStatus(historyPlan)}`
      : '最近一次提示词未检测到记忆块，请检查世界书预算或总上下文上限。';
    const display = target?.querySelector('.yt-memory-injection');
    if (display) display.textContent = injectionText;
  }));

  if (capture()) {
    try { await engine.sync(); memoryDirty = false; }
    catch (error) { report(error.message, 'error'); }
  }

  return {
    render,
    refresh,
    pauseForSync: () => gate.pause(),
    syncStatus: () => gate.status(),
    interceptHistory(prepared, _contextSize, _abort, type) {
      requireGenerationReady();
      historyPlan = null;
      const current = capture(), loaded = current && storage.confirmed.get(current.key);
      if (!alive || host.context()?.mainApi !== 'openai' || !generation || generation.stopped ||
          generation.key !== current?.key || !loaded?.owned || !loaded.state.enabled ||
          storage.binding(current) !== loaded.book || typeof host.context()?.stopGeneration !== 'function') return;
      if (host.currentChat()?.messages.some(m => m?.extra?.tool_invocations?.length || m?.extra?.tool_calls?.length)) return;
      historyPlan = prepareHistoryWindow({
        prepared,
        messages: current.messages,
        state: loaded.state,
        owner: current.key,
        keepRounds: config().historyRounds,
        type,
        stripCardMemory: true,
      });
    },
    destroy() {
      alive = false;
      historyPlan = null;
      renderVersion++;
      gate.destroy();
      engine.dispose();
      cleanups.forEach(fn => fn?.());
      target = null;
    },
    status() {
      const view = storage.confirmed.get(capture()?.key);
      return {
        running: !!engine.running,
        enabled: !!view?.state.enabled,
        through: view ? C.materialize(view.state).through : 0,
        lastError: view?.state.lastError || '',
        message: statusText,
      };
    },
  };
}
