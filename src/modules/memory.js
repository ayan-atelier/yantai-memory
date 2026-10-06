import C from './memory/core.js';
import Engine from './memory/engine.js';
import DEFAULT_PRESET from './memory/preset.js';
import { createStorage, LEGACY_TAG, parseState, marker } from './memory/storage.js';
import { createApi, MainAPI, readLocalKey, writeLocalKey } from './memory/api.js';
import { prepareHistoryWindow, applyHistoryWindow, historyWindowStatus } from './memory/history-window.js';
import { createSyncGate } from './memory/sync-gate.js';
import { DIRECTOR_MODES, DIRECTOR_STRENGTHS, DIRECTOR_MODE_LABELS } from './memory/director.js';

export const MEMORY_DEFAULTS = Object.freeze({ apiMode: 'main', apiUrl: '', model: '', temperature: 0.25,
  maxTokens: 8192, frequency: 1, batchSize: 10, timeoutSeconds: 180, maxInputChars: 240000,
  depth: 4, historyRounds: 3, suggestions: false, stripCardMemory: true, extraBody: '{}', preset: DEFAULT_PRESET,
  assistantAutoCompress: false, assistantWarnTokens: 16000, assistantAutoTokens: 20000, assistantTargetTokens: 10000,
  directorMode: 'off', directorStrength: 'standard', directorRules: '' });
const fields = { frequency: ['每几轮自动整理一次', 1, 100], batchSize: ['每次最多整理几轮', 1, 100],
  temperature: ['温度', 0, 2], maxTokens: ['最大输出 tokens', 512, 65536], timeoutSeconds: ['超时秒数', 30, 900],
  depth: ['世界书插入深度', 0, 100], historyRounds: ['主回复保留最近几轮原文（0＝不限制）', 0, 100],
  maxInputChars: ['单次整理输入上限（字符）', 10000, 2000000],
  assistantWarnTokens: ['记忆过长提醒阈值（估算 Token）', 1000, 100000],
  assistantAutoTokens: ['自动压缩阈值（估算 Token）', 2000, 200000],
  assistantTargetTokens: ['压缩目标（估算 Token）', 1000, 100000] };
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, action, primary = false) {
  const el = node('button', text, `yt-button${primary ? ' yt-button-primary' : ''}`);
  el.type = 'button'; el.addEventListener('click', action); return el;
}
function section(title, detail) {
  const box = node('section', undefined, 'yt-section');
  box.append(node('h3', title, 'yt-section-title'));
  if (detail) box.append(node('p', detail, 'yt-muted'));
  return box;
}
function inputField(label, value, type = 'text') {
  const wrap = node('label', undefined, 'yt-field');
  wrap.append(node('span', label));
  const el = node(type === 'textarea' ? 'textarea' : 'input', undefined, type === 'textarea' ? 'yt-textarea' : 'yt-input');
  if (type !== 'textarea') el.type = type;
  el.value = value ?? ''; wrap.append(el);
  return { wrap, input: el };
}
function toggle(label, checked, handler) {
  const wrap = node('label', undefined, 'yt-toggle-row');
  const input = node('input'); input.type = 'checkbox'; input.checked = checked;
  input.addEventListener('change', handler); wrap.append(input, node('span', label));
  return { wrap, input };
}
function readableTable(headers, rows) {
  const table = node('table', undefined, 'yt-memory-table');
  const thead = node('thead'), tr = node('tr');
  headers.forEach(h => { const th = node('th', h); th.scope = 'col'; tr.append(th); });
  thead.append(tr); table.append(thead);
  const body = node('tbody');
  rows.forEach(values => {
    const row = node('tr');
    values.forEach((value, index) => { const td = node('td', String(value ?? '—')); td.dataset.label = headers[index]; row.append(td); });
    body.append(row);
  });
  table.append(body); return table;
}
export function validateConfig(candidate) {
  const next = { ...MEMORY_DEFAULTS, ...candidate };
  if (!['main', 'custom'].includes(next.apiMode)) throw new Error('请选择连接方式。');
  if (!DIRECTOR_MODES.includes(next.directorMode)) throw new Error('请选择导演控制台模式。');
  if (!DIRECTOR_STRENGTHS.includes(next.directorStrength)) throw new Error('请选择导演控制台强度。');
  if (typeof next.directorRules !== 'string' || next.directorRules.length > 50000) throw new Error('导演补充规则最多 5 万字符。');
  for (const [key, [label, min, max]] of Object.entries(fields)) {
    next[key] = Number(next[key]);
    if (!Number.isFinite(next[key]) || next[key] < min || next[key] > max || (key !== 'temperature' && !Number.isInteger(next[key]))) throw new Error(`${label}应在 ${min}—${max} 之间。`);
  }
  if (next.batchSize < next.frequency) throw new Error('每批轮数不能小于自动整理间隔。');
  if (next.assistantAutoTokens < next.assistantWarnTokens) throw new Error('自动压缩阈值不能低于提醒阈值。');
  if (next.assistantTargetTokens >= next.assistantAutoTokens) throw new Error('压缩目标应低于自动压缩阈值。');
  if (typeof next.preset !== 'string' || !next.preset.trim() || next.preset.length > 200000) throw new Error('记忆预设不能为空，且最多 20 万字符。');
  if (next.apiMode === 'custom') C.apiPayload(next, [], '');
  return next;
}
export const completionFingerprint = messages => C.hash(JSON.stringify((messages || []).map(m => ({ name: m.name, mes: m.mes, is_user: m.is_user, is_system: m.is_system }))));
export function parseBackup(text, rounds) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('备份不是有效 JSON。'); }
  if (data?.type === 'script') throw new Error('这是旧版脚本安装文件，不含聊天记忆。请在旧版记忆面板导出“记忆备份”。');
  if (data.format && !['yantai-memory-backup', 'jingdu-memory-backup'].includes(data.format)) throw new Error('请选择砚台或旧版静读导出的记忆备份。');
  const state = C.validateState(data.state || data);
  if (C.reconcile(state, rounds).changed) throw new Error('备份与当前聊天正文不匹配，未导入，避免混入其他剧情。');
  return state;
}

export async function createMemory({ host, store, ui }) {
  const missing = Object.fromEntries(Object.entries(MEMORY_DEFAULTS).filter(([k]) => store.get().memory?.[k] === undefined));
  if (Object.keys(missing).length) await store.updateModule('memory', missing);
  // These two switches remain in old settings only for backup compatibility.
  // They are intentionally no longer user-facing: presentation blocks are
  // always filtered internally, and future-plot suggestions are retired.
  const config = () => ({ ...MEMORY_DEFAULTS, ...store.get().memory, suggestions: false, stripCardMemory: true });
  let alive = true, generation = null, target = null, pane = 'chat', renderVersion = 0, memoryDirty = false;
  let assistantRunning = false, assistantAnswer = '';
  let migrationRunning = false, migrationPreview = null, migrationKey = '';
  let needsSyncAfterPause = false;
  let statusText = '打开聊天后可启用。', statusKind = 'info', injectionText = '尚未检查下一次发送。';
  let allRows = false, draftSettings = null, draftPreset = null;
  let historyPlan = null;
  const noteDrafts = new Map(), cleanups = [];
  const capture = () => {
    const chat = host.currentChat();
    if (!chat || chat.isGroup) return null;
    const messages = (chat.messages || []).map(m => ({ name: m.name, mes: m.mes, is_user: m.is_user, is_system: m.is_system }));
    if (generation?.key === chat.key && ['regenerate', 'swipe'].includes(generation.type) && !messages.at(-1)?.is_user) messages.pop();
    return { ...chat, messages };
  };
  function report(message, kind = 'info') {
    statusText = String(message); statusKind = kind;
    if (target?.isConnected) {
      const el = target.querySelector('.yt-memory-status');
      if (el) { el.textContent = statusText; el.dataset.kind = kind; }
      const run = target.querySelector('.yt-memory-run');
      const stop = target.querySelector('.yt-memory-stop');
      if (run) run.disabled = !!engine.running || !storage.confirmed.get(capture()?.key)?.state.enabled;
      if (stop) stop.disabled = !engine.running;
    }
  }
  const storage = createStorage(host, config, { context: capture, alive: () => alive, isDirty: () => memoryDirty });
  const api = createApi(host);
  const adapter = { ...storage, ...api, context: capture, key: () => capture()?.key, isGenerating: () => !!generation };
  const engine = new Engine(adapter, config, report);
  const gate = createSyncGate({ engine, isGenerating: () => !!generation,
    onPause: () => { historyPlan = null; },
    onResume: () => {
      if (needsSyncAfterPause && alive) { needsSyncAfterPause = false; void syncRefresh(); }
    } });
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
  const refresh = async () => { if (alive && target?.isConnected) await render(target); };
  const syncRefresh = async () => {
    if (gate.paused()) { needsSyncAfterPause = true; return; }
    try { await gate.run(async () => { await engine.sync(); memoryDirty = false; await refresh(); }); } catch (error) { report(error.message, 'error'); }
  };
  async function consentFor(captured, loaded, legacy = false) {
    if (loaded.owned) return true;
    if (loaded.legacy && !legacy) throw new Error('这个聊天仍绑定旧版静读记忆。请先关闭旧版脚本，再使用下方“读取旧版记忆”；不会自动接管它。');
    if (loaded.book) {
      const message = legacy
        ? '将旧版静读记忆读入新的砚台聊天世界书，保留无关条目和原世界书，当前聊天改为绑定新书。请先关闭旧版脚本，避免重复整理。继续？'
        : loaded.fork
          ? '这是从另一存档复制来的记忆。为此分支创建独立世界书，并保留与本分支正文匹配的记录？原存档不变。'
          : '当前聊天已经绑定世界书。将它复制到新的砚台记忆世界书，保留现有条目及原文件，并让本聊天绑定新书。继续？';
      if (!await ui.confirm(message, { title: '建立独立聊天记忆', confirmLabel: '建立并绑定' })) return false;
    }
    if (capture()?.key !== captured.key) throw new Error('聊天已切换，请重新操作。');
    storage.allowCreate(captured.key); return true;
  }
  async function getView() {
    const chat = capture();
    if (!chat) return null;
    const loaded = await storage.load(chat);
    if (capture()?.key !== chat.key) return null;
    const rounds = C.roundsFrom(chat.messages, config().stripCardMemory);
    const state = C.reconcile(loaded.state, rounds).state;
    return { chat, loaded, rounds, state, memory: C.materialize(state) };
  }
  function memoryEstimate(view) {
    return C.estimateTokens(C.renderMemory({ ...view.memory, compact: null }, false, 'off'));
  }
  async function runAssistantCompression(level = 1, automatic = false) {
    if (assistantRunning) throw new Error('小助手正在整理，请等这次处理完成。');
    if (engine.running || generation) throw new Error('主回复或记忆整理仍在进行，请等它结束后再使用小助手。');
    const fresh = await getView();
    if (!fresh?.state.enabled) throw new Error('请先打开当前聊天的记忆。');
    if (!fresh.memory.through) throw new Error('还没有可压缩的记忆。');
    assistantRunning = true;
    try {
      const estimate = memoryEstimate(fresh);
      const cfg = config();
      if (automatic && estimate < cfg.assistantAutoTokens) return false;
      report(`${automatic ? '记忆已超过自动压缩阈值，' : ''}小助手正在生成${level === 2 ? '二级' : '一级'}压缩预览…`);
      const messages = C.assistantMessages({ ...fresh.memory, compact: null }, level, cfg.assistantTargetTokens);
      const payload = await api.payload(cfg, messages);
      const result = await api.request(payload, new AbortController().signal, cfg.timeoutSeconds);
      const compact = C.validateAssistantOutput(result, fresh.memory, level);
      await engine.serial(async () => {
        const current = await storage.load(fresh.chat);
        if (current.state.revision !== fresh.state.revision) throw new Error('记忆在小助手处理期间发生变化，压缩结果未保存。');
        await storage.save(fresh.chat, { ...current.state, compact }, current, () => capture()?.key === fresh.chat.key);
      });
      report(`记忆已完成${level === 2 ? '二级' : '一级'}压缩。原始逐轮记录仍保留，可随时撤销压缩。`, 'success');
      return true;
    } finally { assistantRunning = false; }
  }
  async function clearAssistantCompression() {
    const fresh = await getView();
    if (!fresh?.state.compact) { report('当前没有启用压缩视图。'); return; }
    await engine.serial(async () => {
      const current = await storage.load(fresh.chat);
      if (current.state.revision !== fresh.state.revision) throw new Error('记忆已变化，未撤销压缩。');
      await storage.save(fresh.chat, { ...current.state, compact: null }, current, () => capture()?.key === fresh.chat.key);
    });
    report('已撤销压缩，恢复完整记忆视图。', 'success');
  }
  async function runAssistantMigration() {
    if (migrationRunning || assistantRunning) throw new Error('小助手正在处理另一项请求，请等它完成。');
    if (engine.running || generation) throw new Error('主回复或记忆整理仍在进行，请等它结束后再迁移。');
    const fresh = await getView();
    if (!fresh?.state.enabled) throw new Error('请先打开当前聊天的记忆。');
    if (!fresh.memory.through) throw new Error('还没有可迁移的记忆。');
    migrationRunning = true;
    try {
      const cfg = config();
      report('小助手正在分析旧档案，生成迁移预览…');
      const payload = await api.payload(cfg, C.migrationMessages(fresh.memory, Math.min(cfg.maxInputChars, 180000)));
      const answer = await api.request(payload, new AbortController().signal, cfg.timeoutSeconds);
      migrationPreview = C.validateMigrationOutput(answer, fresh.memory);
      migrationKey = `${fresh.chat.key}:${fresh.state.revision}`;
      report('迁移预览已生成。原记忆没有改动，请先检查摘要和开放线程。', 'success');
      await refresh();
      return migrationPreview;
    } finally { migrationRunning = false; }
  }
  async function applyMigrationPreview() {
    const fresh = await getView();
    if (!fresh || !migrationPreview || migrationKey !== `${fresh.chat.key}:${fresh.state.revision}`) throw new Error('迁移预览已经过期，请重新生成。');
    if (!await ui.confirm('应用这份迁移预览？原始事件不会删除，但会新增一条可撤销的主线摘要和线程修订记录。', { title: '确认应用迁移', confirmLabel: '应用迁移' })) return;
    await engine.serial(async () => {
      const current = await storage.load(fresh.chat);
      if (current.state.revision !== fresh.state.revision) throw new Error('记忆在预览期间发生变化，未应用迁移。');
      const delta = { events: [], corrections: [], summary: migrationPreview.summary, threads: migrationPreview.threads,
        suggestions: [], director: fresh.memory.director || null, directorError: '' };
      const batch = C.makeBatch(delta, fresh.rounds, fresh.memory.through, '因果模型迁移预览');
      await storage.save(fresh.chat, { ...current.state, history: [...current.state.history, batch], compact: null }, current, () => capture()?.key === fresh.chat.key);
    });
    migrationPreview = null; migrationKey = '';
    report('迁移已应用。原始逐轮事件仍保留，可以导出或回退。', 'success');
    await refresh();
  }
  async function askAssistant(question, context = '') {
    const text = String(question || '').trim();
    if (!text) throw new Error('先写下你想问小助手的问题。');
    if (assistantRunning) throw new Error('小助手正在处理另一项请求，请等它完成。');
    assistantRunning = true;
    try {
      const cfg = config();
      report('小助手正在看这件事…');
      const payload = await api.payload(cfg, C.assistantQuestionMessages(text, context));
      const answer = await api.request(payload, new AbortController().signal, cfg.timeoutSeconds);
      assistantAnswer = answer;
      report('小助手已经回答。', 'success');
      return answer;
    } finally { assistantRunning = false; }
  }
  async function restoreState(imported, captured, loaded, legacy = false) {
    if (!await consentFor(captured, loaded, legacy)) return;
    engine.cancel('正在恢复记忆备份。', false);
    await engine.serial(async () => {
      const fresh = await storage.load(captured);
      await storage.save(captured, { ...imported, owner: captured.key, enabled: loaded.owned && loaded.state.enabled,
        pausedByUser: false, lastError: '' }, { ...fresh, removeLegacy: legacy }, () => capture()?.key === captured.key);
    });
    migrationPreview = null; migrationKey = '';
    report('记忆已读入，没有发起模型请求。确认内容后可开启当前聊天的记忆。', 'success');
    await refresh();
  }
  function upload(text, accept, callback) {
    const wrap = node('span', undefined, 'yt-memory-upload');
    const file = node('input'); file.type = 'file'; file.accept = accept; file.hidden = true;
    file.addEventListener('change', action(async () => {
      const selected = file.files?.[0]; if (!selected) return;
      try { await callback(selected); } finally { file.value = ''; }
    }));
    wrap.append(button(text, () => file.click()), file); return wrap;
  }
  function renderChat(box, view) {
    const intro = section('把经过记清，把故事留给你。', '主回复完成后整理一次。记忆放在本聊天世界书里，下一轮随剧情一起发送。');
    if (!view) {
      intro.append(node('p', host.currentChat()?.isGroup ? '当前版本先支持单角色聊天。请打开一个角色存档。' : '先打开一个角色聊天，再为这份存档开启记忆。', 'yt-empty'));
      box.append(intro); return;
    }
    const { chat, loaded, state, memory, rounds } = view;
    intro.append(node('p', `${chat.name || '当前角色'} · ${chat.id}`, 'yt-memory-chat-name'));
    const enabled = toggle('当前聊天启用记忆', state.enabled, action(async event => {
      const checkbox = event.currentTarget;
      const next = checkbox.checked;
      try {
        const current = await storage.load(chat);
        if (next && !await consentFor(chat, current)) { checkbox.checked = false; return; }
        await engine.setEnabled(next); await refresh();
      } catch (error) { checkbox.checked = state.enabled; throw error; }
    }));
    intro.append(enabled.wrap, node('p', '同一聊天请只启用一套记忆系统。砚台不会替你关闭其他插件或世界书条目。', 'yt-muted'));
    if (loaded.fork) intro.append(node('p', '这是分支副本，记忆默认暂停。启用时会为此分支独立保存。', 'yt-notice'));
    if (loaded.legacy) intro.append(node('p', '发现旧版静读记忆。新版本尚未读取或接管它。', 'yt-notice'));
    const stats = node('div', undefined, 'yt-memory-stats');
    [[memory.through, '轮已整理'], [Math.max(0, rounds.length - memory.through), '轮待整理'], [C.renderMemory(memory, config().suggestions, config().directorMode).length.toLocaleString(), '字符记忆']]
      .forEach(([value, label]) => { const item = node('div'); item.append(node('strong', String(value)), node('span', label)); stats.append(item); });
    intro.append(stats);
    const estimate = memoryEstimate(view);
    if (estimate >= config().assistantWarnTokens) intro.append(node('p', `记忆目前约 ${estimate.toLocaleString()} Token（估算），已经偏长。可以打开“砚台小助手”查看压缩预览；默认不会自动修改。`, 'yt-notice'));
    const commands = node('div', undefined, 'yt-inline');
    const run = button('立即整理 · 1 次请求', action(async () => { await engine.run(true); noteDrafts.delete(chat.key); await refresh(); }), true);
    run.classList.add('yt-memory-run'); run.disabled = !state.enabled || !!engine.running;
    const stop = button('停止整理', action(async () => { engine.cancel(); report('已请求停止；已经发出的请求仍可能由服务商计费。'); }));
    stop.classList.add('yt-memory-stop'); stop.disabled = !engine.running;
    commands.append(run, stop); intro.append(commands);
    const modeLabel = DIRECTOR_MODE_LABELS[config().directorMode || 'off'];
    intro.append(node('p', `每 ${config().frequency} 轮自动整理，单次最多 ${config().batchSize} 轮。有积压时从最早未整理的一轮接着补，每次只发一次请求。当前导演控制台：${modeLabel}。`, 'yt-muted'));
    if (state.pausedByUser) intro.append(node('p', '你已停止自动整理，点击“立即整理”成功后恢复。', 'yt-notice'));
    else if (state.lastError) intro.append(node('p', `上次整理未成功：${state.lastError}。${state.enabled ? '下一轮主回复完成后会再次尝试，也可点击“立即整理”。' : '当前聊天记忆已关闭，重新启用后可继续整理。'}`, 'yt-notice'));
    intro.append(node('p', loaded.book ? `聊天世界书：${loaded.book}` : '首次启用时建立独立的聊天世界书。', 'yt-muted'));
    intro.append(node('p', '无需手动打开这两个世界书条目，也无需全局启用。记录可在“查看记忆”中阅读，生成时砚台会自动发送正文；内部备份不发送。', 'yt-muted'));
    intro.append(node('p', '番外隔离：以 `$` 开头并明确写出 IF／番外／外传／小剧场或“暂停当前剧情”的独立拍摄，会留在聊天记录中，但不进入主线记忆。', 'yt-muted'));
    intro.append(node('p', injectionText, 'yt-muted yt-memory-injection'));
    intro.append(node('p', config().historyRounds > 0
      ? `启用记忆后，主回复保留最近 ${config().historyRounds} 轮原文；尚未整理的正文继续保留。已记住的更早正文仅从本次请求省略，存档完整保留。`
      : '主回复正文范围跟随酒馆及预设，砚台不额外裁剪。', 'yt-muted'));
    box.append(intro);
    const note = section('纠正一处记忆', '写下你确认的事实。保存后，在下一次整理中修订；也可以点击“立即整理”。这会使用一次记忆请求。');
    const field = inputField('修订备注', noteDrafts.get(chat.key) ?? state.note, 'textarea');
    field.input.rows = 3; field.input.placeholder = '例如：她只是在心里产生这个念头，还没有告诉对方。';
    field.input.addEventListener('input', () => noteDrafts.set(chat.key, field.input.value));
    note.append(field.wrap);
    const save = button('保存修订备注', action(async () => {
      if (!state.enabled) throw new Error('请先启用当前聊天的记忆。');
      await engine.saveNote(field.input.value); noteDrafts.delete(chat.key); report('修订备注已保存，下次整理时生效。', 'success');
    }));
    note.append(save); box.append(note);
  }
  function renderRecords(box, view) {
    if (!view?.memory.through) { box.append(node('p', '还没有记忆。启用当前聊天，完成一轮互动后就会开始记录。', 'yt-empty')); return; }
    const mem = view.memory;
    if (mem.director) {
      const board = section('连续性场记', '只保存跨轮需要记住的现场资料，不是剧情正文，也不替砚台预设安排下一拍。');
      board.append(node('p', `频道：${mem.director.channel || '未知'}｜节奏：${mem.director.pace || '停留'}\n上一拍：${mem.director.lastBeat || '未明'}\n交接：${mem.director.handoff || '保留自然回应空间。'}`, 'yt-memory-prose'));
      box.append(board);
    }
    const overview = section('累计关键经过'); overview.append(node('p', mem.summary, 'yt-memory-prose')); box.append(overview);
    const projection = C.projectForPrompt(mem, { recentEvents: 12, maxThreads: 20 });
    const activeIds = new Set(projection.threads.map(t => t.id));
    const activeThreads = section('当前开放线程', '只显示仍会影响下一轮的任务、案件、线索、悬念和有效约定；已结案内容仍保存在本地档案。');
    activeThreads.append(projection.threads.length ? readableTable(['类型', '标题', '已知 / 内容', '未知 / 下一证据', '状态'], projection.threads.map(t => [t.kind, t.title, t.known || t.content, t.unknown || t.nextEvidence || '未明', t.state || t.status])) : node('p', '暂无。', 'yt-muted'));
    box.append(activeThreads);
    const archivedThreads = mem.threads.filter(t => !activeIds.has(t.id));
    if (archivedThreads.length) {
      const details = node('details', undefined, 'yt-memory-advanced');
      details.append(node('summary', `已结案或背景事项（${archivedThreads.length} 条）`));
      details.append(readableTable(['记录时间', '类型', '标题', '结果 / 状态'], archivedThreads.map(t => [t.at, t.kind, t.title || t.content, t.status])));
      box.append(details);
    }
    const ledger = section('因果事件记录', '默认只看最近记录；每条事件优先显示行动、原因、结果和后果。完整历史始终保留，不会因为折叠而删除。');
    const rows = allRows ? mem.events : mem.events.slice(-12);
    if (mem.events.length > 12) ledger.append(button(allRows ? '只看最近 12 轮' : `查看全部 ${mem.events.length} 轮`, action(async () => { allRows = !allRows; await refresh(); })));
    ledger.append(readableTable(['轮次', '时间', '地点', '事件', '原因', '结果 / 后果'], rows.map(r => [r.round, r.time, r.place, r.action || r.description, r.cause || '未明', [r.result, ...(r.consequences || [])].filter(Boolean).join('；') || '未明'])));
    box.append(ledger);
  }
  function renderAssistant(box, view) {
    const intro = section('砚台小助手', '一个只在你需要时出现的温柔搭档：可以压缩记忆，也可以解释当前插件和酒馆设置。它不会自动参与对戏。');
    intro.append(node('p', '我会先处理你点选的事情；压缩会保留原始逐轮记录，随时可以撤销。遇到不确定的酒馆规则，我会直接告诉你。', 'yt-memory-prose'));
    if (!view) {
      intro.append(node('p', '先打开一个角色聊天，小助手才能读取这份聊天的记忆。', 'yt-empty'));
      box.append(intro); return;
    }
    const estimate = memoryEstimate(view), cfg = config();
    intro.append(node('p', `当前记忆约 ${estimate.toLocaleString()} Token（估算值，仅用于提醒）。${estimate >= cfg.assistantWarnTokens ? '记忆已经偏长，可以考虑整理。' : '目前还不需要压缩。'}`, estimate >= cfg.assistantWarnTokens ? 'yt-notice' : 'yt-muted'));
    if (view.memory.compact) intro.append(node('p', `当前使用${view.memory.compact.level === 2 ? '二级' : '一级'}压缩视图，原始记录仍保留。`, 'yt-notice'));
    const actions = node('div', undefined, 'yt-inline');
    const levelOne = button('一级压缩 · 1 次请求', action(async () => { await runAssistantCompression(1); await refresh(); }), true);
    const levelTwo = button('二级压缩 · 1 次请求', action(async () => {
      if (!await ui.confirm('二级压缩会更强地合并旧阶段和重复细节，但原始逐轮记录仍会保留，可以撤销。继续吗？', { title: '确认二级压缩', confirmLabel: '继续压缩' })) return;
      await runAssistantCompression(2); await refresh();
    }));
    levelOne.disabled = assistantRunning || !view.state.enabled || !view.memory.through;
    levelTwo.disabled = levelOne.disabled;
    actions.append(levelOne, levelTwo);
    if (view.memory.compact) actions.append(button('撤销压缩', action(async () => { await clearAssistantCompression(); await refresh(); })));
    intro.append(actions);
    intro.append(node('p', `自动压缩：${cfg.assistantAutoCompress ? `开启，超过约 ${cfg.assistantAutoTokens.toLocaleString()} Token 后在空闲时整理` : '关闭，只提醒不自动调用'}。可在“API 与设置 → 更多设置”调整。`, 'yt-muted'));
    box.append(intro);
    const help = section('问我一点事情', '问题只会发给小助手，不会写入聊天、记忆或世界书。');
    const question = inputField('想问什么', '', 'textarea'); question.input.rows = 4; question.input.placeholder = '例如：为什么这轮没有被记住？或者：我想把最近几轮保留在主提示词里，应该改哪里？';
    help.append(question.wrap);
    const ask = button('问问小助手 · 1 次请求', action(async () => {
      const context = view ? C.renderMemory({ ...view.memory, compact: null }, false, 'off').slice(0, 30000) : '';
      await askAssistant(question.input.value, context); await refresh();
    }), true);
    ask.disabled = assistantRunning;
    help.append(ask);
    if (assistantAnswer) help.append(node('div', assistantAnswer, 'yt-memory-prose yt-assistant-answer'));
    box.append(help);
  }
  function renderSettings(box) {
    const current = { ...config(), ...(draftSettings || {}) };
    const form = section('连接与节奏', '默认跟随酒馆当前的聊天补全连接。整理使用独立的记忆预设，仍会产生一次额外请求。');
    const wrap = node('label', undefined, 'yt-field'); wrap.append(node('span', '记忆 API'));
    const select = node('select', undefined, 'yt-select'); select.name = 'yt-memory-apiMode';
    [['main', '跟随酒馆主 API'], ['custom', '自定义 API']].forEach(([value, text]) => { const option = node('option', text); option.value = value; select.append(option); });
    select.value = current.apiMode; wrap.append(select); form.append(wrap);
    const mainInfo = node('p', undefined, 'yt-notice');
    try { const conn = MainAPI.connection(host.context()); mainInfo.textContent = `当前连接：${conn.source} · ${conn.model || '服务端默认模型'}`; }
    catch (error) { mainInfo.textContent = error.message; }
    mainInfo.hidden = current.apiMode !== 'main'; form.append(mainInfo);
    const custom = node('div', undefined, 'yt-memory-custom'); custom.hidden = current.apiMode !== 'custom';
    custom.append(node('p', '填写 OpenAI 兼容的聊天补全接口。请求通过当前酒馆后端发送。', 'yt-muted'));
    const controls = {};
    for (const [key, label, type] of [['apiUrl', 'API 地址', 'url'], ['model', '模型名称', 'text'], ['apiKey', 'API Key', 'password']]) {
      const field = inputField(label, key === 'apiKey' ? readLocalKey() : current[key], type);
      field.input.autocomplete = 'off'; controls[key] = field.input;
      if (key === 'apiUrl') field.input.placeholder = 'https://你的服务地址/v1';
      if (key === 'model') field.input.placeholder = '服务商提供的完整模型 ID';
      if (key !== 'apiKey') field.input.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), [key]: field.input.value }; });
      custom.append(field.wrap);
    }
    custom.append(node('p', '密钥仅保存在当前浏览器。换设备需重新填写，导出预设与备份不会带上它。', 'yt-muted'));
    form.append(custom);
    select.addEventListener('change', () => {
      draftSettings = { ...(draftSettings || {}), apiMode: select.value };
      custom.hidden = select.value !== 'custom'; mainInfo.hidden = select.value !== 'main';
    });
    const cadence = node('div', undefined, 'yt-grid');
    const advanced = node('details', undefined, 'yt-memory-advanced'); advanced.append(node('summary', '更多设置'));
    for (const [key, [label, min, max]] of Object.entries(fields)) {
      const field = inputField(label, current[key], 'number'); controls[key] = field.input;
      field.input.min = min; field.input.max = max; field.input.step = key === 'temperature' ? '0.05' : '1';
      field.input.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), [key]: field.input.value }; });
      (['frequency', 'batchSize'].includes(key) ? cadence : advanced).append(field.wrap);
    }
    form.append(cadence);
    form.append(node('p', '普通聊天按间隔自动整理。失败后，下一轮主回复完成时再试；有积压时按先后补一批，也可手动补记，不会自动连发。', 'yt-muted'));
    const assistantSettings = section('小助手与记忆长度', '默认只提醒，不会自动调用压缩。自动压缩是高级选项，只有你主动打开后才会在空闲时多发一次请求。Token 数为估算值。');
    const autoCompress = toggle('超过阈值后自动压缩（高级）', !!current.assistantAutoCompress, () => {
      draftSettings = { ...(draftSettings || {}), assistantAutoCompress: autoCompress.input.checked };
    });
    controls.assistantAutoCompress = autoCompress.input; assistantSettings.append(autoCompress.wrap);
    assistantSettings.append(node('p', '压缩不会删除原始逐轮记录，只会切换一份可撤销的压缩视图。', 'yt-muted'));
    advanced.append(assistantSettings);
    const director = section('导演控制台（与记忆共用一次请求）', '关闭时完全保持原记忆插件行为；开启后，主回复完成后的同一次记忆请求会额外整理一份“下一轮运行参考”。它不进入累计剧情，也不会要求其他预设改变文风。');
    const directorMode = node('select', undefined, 'yt-select');
    for (const mode of DIRECTOR_MODES) { const option = node('option', DIRECTOR_MODE_LABELS[mode]); option.value = mode; directorMode.append(option); }
    directorMode.value = current.directorMode || 'off';
    const modeWrap = node('label', undefined, 'yt-field'); modeWrap.append(node('span', '导演模式'), directorMode); director.append(modeWrap);
    const strength = node('select', undefined, 'yt-select');
    for (const value of DIRECTOR_STRENGTHS) { const option = node('option', value === 'strong' ? '强约束（砚台模式）' : '标准'); option.value = value; strength.append(option); }
    strength.value = current.directorStrength || 'standard';
    const strengthWrap = node('label', undefined, 'yt-field'); strengthWrap.append(node('span', '导演提示强度'), strength); director.append(strengthWrap);
    const directorPreset = inputField('导演补充规则（可留空，内置规则仍生效）', current.directorRules || '', 'textarea');
    directorPreset.input.rows = 7; directorPreset.input.placeholder = '例如：本卡的特殊玩法只在卡片明确开启时使用。';
    director.append(directorPreset.wrap);
    director.append(node('p', '通用模式只提醒连续性、角色边界和自然交接；砚台模式才提供完整频道、上一拍、演员目标和防漂移工作台。模型没有证据时必须留空，不能为了“有戏”补权力关系。', 'yt-muted'));
    form.append(director);
    const extra = inputField('自定义 API 的额外参数（JSON）', current.extraBody, 'textarea'); extra.input.rows = 3; controls.extraBody = extra.input;
    extra.input.addEventListener('input', () => { draftSettings = { ...(draftSettings || {}), extraBody: extra.input.value }; });
    advanced.append(extra.wrap, node('p', '记忆正文默认放在聊天世界书深度 4，逐轮表完整发送。主回复默认保留最近 3 轮原文及未整理正文；设为 0 时跟随原设置。预设、人设、世界书及总上下文长度不改动。', 'yt-muted'));
    form.append(advanced);
    form.append(button('保存设置', action(async () => {
      const next = { ...config(), apiMode: select.value };
      for (const key of ['apiUrl', 'model', 'extraBody']) next[key] = controls[key].value.trim();
      for (const key of Object.keys(fields)) next[key] = controls[key].value;
      next.assistantAutoCompress = controls.assistantAutoCompress.checked;
      next.directorMode = directorMode.value;
      next.directorStrength = strength.value;
      next.directorRules = directorPreset.input.value.trim();
      const validated = validateConfig(next);
      if (next.apiMode === 'custom' || controls.apiKey.value.trim() !== readLocalKey()) writeLocalKey(controls.apiKey.value.trim());
      engine.cancel('连接设置已改变，停止当前整理。', false);
      await store.updateModule('memory', validated); draftSettings = null;
      const chat = capture();
      if (chat) await engine.serial(async () => {
        const loaded = await storage.load(chat);
        if (loaded.owned) await storage.save(chat, loaded.state, loaded, () => capture()?.key === chat.key);
      });
      report('设置已保存，没有发起模型请求。', 'success'); await refresh();
    }), true));
    box.append(form);
    const data = section('数据管理', '备份与迁移不会发送 API 密钥。导入会核对当前聊天正文，避免把其他故事混进来。');
    const backups = node('div', undefined, 'yt-inline');
    backups.append(button('导出记忆备份', action(async () => {
      const fresh = await getView(); if (!fresh) throw new Error('先打开聊天。');
      host.download(`yantai-memory-${C.hash(fresh.chat.key)}.json`, JSON.stringify({ format: 'yantai-memory-backup', version: C.VERSION, state: fresh.state }, null, 2), 'application/json');
      report('备份已导出。', 'success');
    })));
    backups.append(button('导出可读记忆', action(async () => {
      const fresh = await getView(); if (!fresh) return;
      host.download('yantai-memory.txt', C.renderMemory(fresh.memory, false, config().directorMode, { includeArchived: true }) || '尚无记忆记录。');
    })));
    backups.append(upload('导入记忆备份', '.json,application/json', async file => {
      if (file.size > 20000000) throw new Error('备份超过 20 MB，暂不导入。');
      const fresh = await getView(); if (!fresh) throw new Error('先打开对应的聊天。');
      const imported = parseBackup(await file.text(), fresh.rounds);
      if (!await ui.confirm('用这份备份替换本聊天的记忆？聊天正文不会改变。', { title: '导入记忆备份', confirmLabel: '导入' })) return;
      await restoreState(imported, fresh.chat, fresh.loaded, fresh.loaded.legacy);
    }));
    backups.append(button('小助手整理旧档案 · 预览', action(async () => { await runAssistantMigration(); })));
    const currentForMigration = capture();
    if (migrationPreview && currentForMigration && migrationKey.startsWith(`${currentForMigration.key}:`)) {
      const preview = section('迁移预览', '只会更新摘要和开放线程，不会删除原始逐轮事件。确认前可以直接放弃。');
      preview.append(node('p', migrationPreview.summary, 'yt-memory-prose'));
      preview.append(node('p', `准备更新 ${migrationPreview.threads.upsert.length} 条线程，解除 ${migrationPreview.threads.resolve.length} 条普通事项。`, 'yt-muted'));
      const previewActions = node('div', undefined, 'yt-inline');
      previewActions.append(button('应用迁移预览', action(async () => { await applyMigrationPreview(); }), true));
      previewActions.append(button('放弃预览', action(async () => { migrationPreview = null; migrationKey = ''; report('已放弃迁移预览。'); await refresh(); })));
      preview.append(previewActions); data.append(preview);
    }
    const currentChat = capture();
    if (currentChat && storage.confirmed.get(currentChat.key)?.legacy) backups.append(button('读取旧版记忆', action(async () => {
      const fresh = await getView(); if (!fresh) return;
      const legacy = parseState(fresh.loaded.data, true);
      if (!legacy) throw new Error('没有找到旧版内部备份。');
      if (C.reconcile(legacy, fresh.rounds).changed) throw new Error('旧版备份与本聊天正文不一致，请先在旧版核对或导出正确备份。');
      await restoreState(legacy, fresh.chat, fresh.loaded, true);
    })));
    data.append(backups); box.append(data);
  }
  function renderPreset(box) {
    const form = section('记忆预设', '只规定怎样记录已经发生的剧情。私人心理、人物判断、客观事实分开保存，不预写未来，也不接管扮演预设。');
    const field = inputField('整理规则', draftPreset ?? config().preset, 'textarea'); field.input.rows = 20; field.input.classList.add('yt-memory-preset');
    field.input.addEventListener('input', () => { draftPreset = field.input.value; }); form.append(field.wrap);
    const controls = node('div', undefined, 'yt-inline');
    controls.append(button('保存预设', action(async () => {
      if (!field.input.value.trim() || field.input.value.length > 200000) throw new Error('预设不能为空，且最多 20 万字符。');
      await store.updateModule('memory', { preset: field.input.value.trim() }); draftPreset = null;
      report('记忆预设已保存，下次整理生效。', 'success');
    }), true));
    controls.append(button('导出预设', () => host.download('yantai-memory-preset.txt', field.input.value)));
    controls.append(upload('导入预设', '.txt,.md,text/plain', async file => {
      if (file.size > 200000) throw new Error('预设文件超过 20 万字节。');
      const text = await file.text();
      if (!text.trim()) throw new Error('预设文件为空。');
      draftPreset = text; field.input.value = text; report('预设已载入，点击保存后生效。');
    }));
    controls.append(button('恢复默认预设', action(async () => {
      if (!await ui.confirm('恢复砚台默认记忆预设？建议先导出自己的修改。', { title: '恢复默认预设', confirmLabel: '恢复' })) return;
      draftPreset = DEFAULT_PRESET; field.input.value = DEFAULT_PRESET; report('默认预设已载入，点击保存后生效。');
    })));
    form.append(controls); box.append(form);
  }
  async function render(container) {
    target = container; const version = ++renderVersion;
    const shell = node('div', undefined, 'yt-memory');
    const nav = node('div', undefined, 'yt-memory-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '叙事记忆');
    for (const [key, label] of [['chat', '当前聊天'], ['records', '查看记忆'], ['assistant', '砚台小助手'], ['settings', 'API 与设置'], ['preset', '记忆预设']]) {
      const tab = button(label, action(async () => { pane = key; await refresh(); }));
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(pane === key));
      nav.append(tab);
    }
    const notice = node('p', statusText, 'yt-memory-status yt-notice'); notice.dataset.kind = statusKind; notice.setAttribute('role', 'status');
    shell.append(nav, notice);
    const content = node('div', undefined, 'yt-memory-content'); content.setAttribute('role', 'tabpanel'); shell.append(content);
    container.replaceChildren(shell);
    if (pane === 'settings') { renderSettings(content); return; }
    if (pane === 'preset') { renderPreset(content); return; }
    content.append(node('p', '正在读取当前聊天记忆…', 'yt-muted'));
    try {
      const view = await getView();
      if (!alive || version !== renderVersion || target !== container) return;
      content.replaceChildren();
      if (pane === 'chat') renderChat(content, view);
      else if (pane === 'records') renderRecords(content, view);
      else renderAssistant(content, view);
    } catch (error) { if (version === renderVersion) { content.replaceChildren(node('p', error.message, 'yt-notice')); report(error.message, 'error'); } }
  }
  cleanups.push(host.on('GENERATION_STARTED', (type, options, dryRun) => {
    if (!dryRun) requireGenerationReady();
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    historyPlan = null;
    const start = host.currentChat();
    generation = { key: start?.key, type, stopped: false, before: completionFingerprint(start?.messages) };
    gate.cancelScheduled();
    if (['regenerate', 'swipe'].includes(type)) engine.cancel('正在重新生成，停止旧回复的整理。', false);
  }));
  cleanups.push(host.on('GENERATION_AFTER_COMMANDS', async (type, options, dryRun) => {
    if (!dryRun) requireGenerationReady();
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    // Only waits for an existing request; never adds a model call before roleplay.
    try { await gate.run(async () => { if (engine.running) await engine.running; await engine.sync(); }); }
    catch (error) { report(error.message, 'error'); }
  }));
  cleanups.push(host.on('GENERATION_STOPPED', () => { historyPlan = null; if (generation) generation.stopped = true; gate.cancelScheduled(); }));
  cleanups.push(host.on('GENERATION_ENDED', () => {
    const finished = generation; generation = null; historyPlan = null;
    if (!finished || finished.stopped || finished.key !== capture()?.key) return;
    gate.cancelScheduled();
    gate.schedule(async () => {
      const latest = capture();
      if (!alive || generation || finished.key !== latest?.key) return;
      const last = latest.messages.at(-1);
      if (!last || last.is_user || last.is_system || !last.mes?.trim() || completionFingerprint(latest.messages) === finished.before) return;
      const memoryUpdated = await engine.run(false);
      if (memoryUpdated && config().assistantAutoCompress && !assistantRunning) {
        try {
          await gate.run(() => runAssistantCompression(1, true));
        } catch (error) { report(`自动压缩未完成，原记忆保留：${error.message}`, 'error'); }
      }
      if (pane === 'chat' || pane === 'records') await refresh();
    }, () => alive && !generation && finished.key === capture()?.key, 900);
  }));
  const changed = () => {
    memoryDirty = true;
    historyPlan = null;
    gate.cancelScheduled();
    if (gate.paused()) { needsSyncAfterPause = true; return; }
    engine.cancel('剧情已改变，停止旧整理。', false); void syncRefresh();
  };
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED']) cleanups.push(host.on(event, changed));
  cleanups.push(host.on('CHAT_CHANGED', () => {
    memoryDirty = true;
    assistantAnswer = '';
    migrationPreview = null; migrationKey = '';
    historyPlan = null;
    gate.cancelScheduled(); generation = null;
    if (gate.paused()) { needsSyncAfterPause = true; return; }
    engine.cancel('聊天已切换，停止旧聊天整理。', false);
    injectionText = '尚未检查下一次发送。'; report('正在读取当前聊天记忆…');
    void syncRefresh().then(() => report('当前聊天记忆已就绪。'));
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
      report('记忆未完整进入本次提示词，已停止生成，避免遗漏前情。请检查记忆世界书；也可将保留原文轮数设为 0，恢复原发送方式。', 'error');
      host.toast(statusText, 'error');
      return;
    }
    if (!loaded?.state.enabled || !C.materialize(loaded.state).through) return;
    const found = text.includes(marker(current.key, loaded.state.revision)) && text.includes(marker(current.key, loaded.state.revision, true));
    injectionText = found ? `最近一次提示词已包含记忆（整理至第 ${C.materialize(loaded.state).through} 轮）。` : '最近一次提示词未检测到完整记忆，请检查世界书启用状态与上下文空间。';
    if (found) injectionText += historyWindowStatus(historyPlan);
    const display = target?.querySelector('.yt-memory-injection'); if (display) display.textContent = injectionText;
  }));
  if (capture()) { try { await engine.sync(); memoryDirty = false; } catch (error) { report(error.message, 'error'); } }
  return { render, refresh,
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
      historyPlan = prepareHistoryWindow({ prepared, messages: current.messages, state: loaded.state,
        owner: current.key, keepRounds: config().historyRounds, type,
        stripCardMemory: config().stripCardMemory });
    },
    destroy() { alive = false; historyPlan = null; renderVersion++; gate.destroy(); engine.dispose(); cleanups.forEach(fn => fn?.()); target = null; },
    // Read-only status used by the home dashboard and integration tests.
    status() { const view = storage.confirmed.get(capture()?.key); return { running: !!engine.running, enabled: !!view?.state.enabled,
      through: view ? C.materialize(view.state).through : 0, message: statusText }; } };
}
