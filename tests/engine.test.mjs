import assert from 'node:assert/strict';
import test from 'node:test';
import Engine from '../src/modules/memory/engine.js';
import C from '../src/modules/memory/core.js';
import { createStorage } from '../src/modules/memory/storage.js';
import { prepareHistoryWindow, applyHistoryWindow, HISTORY_IGNORE } from '../src/modules/memory/history-window.js';

test('automatic run skips leading IF rounds without calling the memory API', async () => {
  const context = {
    key: 'chat',
    name: '测试',
    messages: [
      { mes: '$暂停当前剧情，生成一个if线番外。不计入记忆。', is_user: true, name: 'User', is_system: false },
      { mes: '番外内容', is_user: false, name: 'Char', is_system: false },
    ],
  };
  let state = { ...C.emptyState('chat'), enabled: true, revision: 'r1' };
  let requests = 0;
  const adapter = {
    context: () => context,
    key: () => context.key,
    isGenerating: () => false,
    async load() { return { state, fork: false, book: '', data: {}, originalRevision: state.revision, owned: true }; },
    async save(_context, next) { state = { ...next, revision: 'r2' }; return state; },
    async payload() { requests++; return {}; },
    async request() { requests++; throw new Error('should not request'); },
  };
  const configuration = () => ({
    stripCardMemory: true, frequency: 3, batchSize: 10, maxInputChars: 100000, preset: '',
  });
  const engine = new Engine(adapter, configuration);
  assert.equal(await engine.run(false), true);
  assert.equal(requests, 0);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].skip, true);
  assert.equal(C.materialize(state).through, 1);
});

test('end-to-end brand-new chat auto-summarizes at Round 3 and creates independent chat worldbook', async () => {
  const metadata = {};
  const chat = {
    key: 'new-chat-e2e',
    id: '2026-11-20',
    name: '裴敬之',
    avatar: 'pei.png',
    characterId: 0,
    metadata,
    context: {
      chatMetadata: metadata,
      characters: [{ avatar: 'pei.png', name: '裴敬之', data: { extensions: { world: '裴敬之｜全剧目设定集' } } }],
      updateWorldInfoList: async () => {},
    },
    messages: [{ mes: '开场白', is_user: false, name: '裴敬之', is_system: false }],
  };
  const books = new Map();
  const host = {
    context: () => chat.context,
    currentChat: () => chat,
    saveMetadata: async () => {},
    async request(path, options) {
      if (path === '/api/worldinfo/get') return structuredClone(books.get(options.body.name) || { entries: {} });
      if (path === '/api/worldinfo/edit') { books.set(options.body.name, structuredClone(options.body.data)); return { ok: true }; }
      if (path === '/api/chats/get') return [{ chat_metadata: structuredClone(metadata) }];
      throw new Error(`unexpected: ${path}`);
    },
  };
  const cfg = () => ({
    autoEnableNewChats: true,
    frequency: 3,
    batchSize: 10,
    chapterSpan: 24,
    historyRounds: 5,
    depth: 12,
    maxInputChars: 200000,
    timeoutSeconds: 60,
    preset: '测试预设',
  });
  const storage = createStorage(host, cfg, { context: () => chat, alive: () => true, cacheBridge: { worldInfoCache: new Map() } });
  let apiCalls = 0;
  const adapter = {
    ...storage,
    context: () => chat,
    key: () => chat.key,
    isGenerating: () => false,
    async payload(_c, messages) { return { messages }; },
    async request() {
      apiCalls++;
      return JSON.stringify({
        scene: { time: '民国二十六年冬夜', location: '澹园书房', present: ['裴敬之', '清砚'], secrets: [] },
        events: [
          { round: 1, description: '第1轮初入澹园。' },
          { round: 2, description: '第2轮书房奉茶。' },
          { round: 3, description: '第3轮交付金库副钥。', item: { name: '江东金库副钥', reason: '交清砚保管' }, importance: 'core' },
        ],
        chapterTitle: '初入澹园',
        chapterSummary: '冬夜初入澹园，裴敬之在书房将江东金库副钥交予清砚保管。',
        threads: { upsert: [], resolve: [] },
      });
    },
  };
  const engine = new Engine(adapter, cfg);

  // Round 1 finishes -> does not call API yet, STILL stays enabled!
  chat.messages.push({ mes: 'u1', is_user: true, name: '清砚' }, { mes: 'a1', is_user: false, name: '裴敬之' });
  assert.equal(await engine.run(false), false);
  assert.equal(apiCalls, 0);

  // Round 2 finishes -> does not call API yet, STILL stays enabled!
  chat.messages.push({ mes: 'u2', is_user: true, name: '清砚' }, { mes: 'a2', is_user: false, name: '裴敬之' });
  assert.equal(await engine.run(false), false);
  assert.equal(apiCalls, 0);

  // Round 3 finishes -> AUTOMATICALLY creates worldbook and summarizes Rounds 1-3 in 1 API call!
  chat.messages.push({ mes: 'u3', is_user: true, name: '清砚' }, { mes: 'a3', is_user: false, name: '裴敬之' });
  assert.equal(await engine.run(false), true);
  assert.equal(apiCalls, 1);
  assert.match(metadata.world_info, /^砚台记忆-裴敬之-/);
  const synced = await engine.sync();
  assert.equal(synced.memory.through, 3);
  assert.equal(synced.state.enabled, true);
});

test('end-to-end /hide 1-50 reproduction: hiding floors NEVER erases worldbook memory, and hidden floors can still be summarized', async () => {
  const metadata = {};
  const chat = {
    key: 'xu-jinwen-chat',
    id: '许今闻 - 2026-11-22@05h43m57s165ms',
    name: '许今闻',
    avatar: '许今闻1.png',
    characterId: 0,
    metadata,
    context: {
      chatMetadata: metadata,
      characters: [{ avatar: '许今闻1.png', name: '许今闻', data: { extensions: { world: '许今闻这孩子打小就聪明' } } }],
      updateWorldInfoList: async () => {},
    },
    messages: [{ mes: '第0楼开场白', is_user: false, name: '许今闻', is_system: false }],
  };
  for (let r = 1; r <= 24; r++) {
    chat.messages.push(
      { mes: `玩家第${r}轮对白`, is_user: true, name: '清砚', is_system: false },
      { mes: `许今闻第${r}轮回复`, is_user: false, name: '许今闻', is_system: false },
    );
  }
  // latch opt-in as normal chat
  metadata.yantai_memory_auto_enable_opt_in = true;

  const books = new Map();
  const host = {
    context: () => chat.context,
    currentChat: () => chat,
    saveMetadata: async () => {},
    async request(path, options) {
      if (path === '/api/worldinfo/get') return structuredClone(books.get(options.body.name) || { entries: {} });
      if (path === '/api/worldinfo/edit') { books.set(options.body.name, structuredClone(options.body.data)); return { ok: true }; }
      if (path === '/api/chats/get') return [{ chat_metadata: structuredClone(metadata) }];
      throw new Error(`unexpected: ${path}`);
    },
  };
  let autoHideArchived = false;
  let autoHiddenCount = 0;
  const cfg = () => ({
    autoEnableNewChats: true,
    autoHideArchived,
    frequency: 3,
    batchSize: 30,
    chapterSpan: 24,
    historyRounds: 5,
    depth: 12,
    maxInputChars: 200000,
    timeoutSeconds: 60,
    preset: '测试预设',
  });
  const storage = createStorage(host, cfg, { context: () => chat, alive: () => true, cacheBridge: { worldInfoCache: new Map() } });
  const adapter = {
    ...storage,
    async autoHideOldMessages(rounds, through, c) {
      const keep = Math.max(1, Number(c.historyRounds) || 5);
      const count = Math.min(through, Math.max(0, rounds.length - keep));
      let n = 0;
      for (const r of rounds.slice(0, count)) {
        for (const s of r.source) {
          if (s.id >= 1 && !chat.messages[s.id].is_system) {
            chat.messages[s.id].is_system = true;
            n++;
          }
        }
      }
      autoHiddenCount += n;
      return n;
    },
    context: () => chat,
    key: () => chat.key,
    isGenerating: () => false,
    async payload(_c, messages) { return { messages }; },
    async request(payload) {
      const userReq = JSON.parse(payload.messages[1].content);
      const batchRounds = userReq.本次必须输出的events轮次;
      return JSON.stringify({
        scene: { time: '深秋傍晚', location: '校门口', present: ['许今闻', '清砚'], secrets: [] },
        events: batchRounds.map(r => ({ round: r, description: `第${r}轮经过记录。` })),
        chapterTitle: '首卷纪要',
        chapterSummary: `第${batchRounds[0]}至${batchRounds.at(-1)}轮完整纪要。`,
        threads: { upsert: [], resolve: [] },
      });
    },
  };
  const engine = new Engine(adapter, cfg);

  // Step 1: Summarize all 24 rounds
  assert.equal(await engine.run(true), true);
  let snap = await engine.sync();
  assert.equal(snap.memory.through, 24);
  assert.equal(snap.memory.chapters.length, 1, '24 rounds sealed into Volume 1');

  // Step 2: User manually runs `/hide 1-50` -> marks messages 1..48 as `is_system: true`!
  for (let i = 1; i < chat.messages.length; i++) {
    chat.messages[i].is_system = true;
  }
  snap = await engine.sync();
  assert.equal(snap.memory.through, 24, '`/hide 1-50` MUST NEVER wipe the 24 rounds in the worldbook!');
  const savedBook = books.get(metadata.world_info);
  const bodyEntry = Object.values(savedBook.entries).find(e => e.comment.includes('剧情正文'));
  assert.ok(bodyEntry.content.length > 50, 'Worldbook body entry remains rich and non-empty after /hide 1-50');

  // Step 3: User runs `/unhide` on recent 3 rounds (Rounds 22-24 visible, Rounds 1-21 hidden) and plays Round 25-27 while Rounds 1-24 are hidden!
  for (let i = 1; i <= 42; i++) chat.messages[i].is_system = true;
  for (let i = 43; i < chat.messages.length; i++) chat.messages[i].is_system = false;
  // Also test historyWindow when Rounds 1-21 are already hidden by /hide and Rounds 22-24 are visible (with keepRounds=2 -> Round 22 should be ignored by window, Rounds 23-24 kept!)
  const visible = chat.messages.map((m, id) => ({ m, id })).filter(x => !x.m.is_system);
  const prepared = visible.map((v, index) => ({ index, is_user: v.m.is_user, is_system: false, name: v.m.name, mes: v.m.mes, extra: {} }));
  const plan = prepareHistoryWindow({
    prepared,
    messages: chat.messages,
    state: snap.state,
    owner: chat.key,
    keepRounds: 2,
    type: 'normal',
  });
  assert.ok(plan, 'History window still prepares cleanly alongside /hide');
  const removed = applyHistoryWindow(plan, [{ disable: false, content: bodyEntry.content }], chat.key, snap.state.revision);
  // Greeting (id=0) + Round 22 (id=43,44) = 3 visible items omitted, leaving Round 23 (id=45,46) & Round 24 (id=47,48) intact!
  assert.equal(removed, 3);
  assert.equal(Boolean(plan.prepared[0].extra[HISTORY_IGNORE]), true);
  assert.equal(Boolean(plan.prepared[1].extra[HISTORY_IGNORE]), true);
  assert.equal(Boolean(plan.prepared[2].extra[HISTORY_IGNORE]), true);
  assert.equal(Boolean(plan.prepared[3].extra[HISTORY_IGNORE]), false);

  // Step 4: Add Rounds 25-27, hide Round 25 BEFORE summarizing, and enable `autoHideArchived = true`!
  autoHideArchived = true;
  for (let r = 25; r <= 27; r++) {
    const hidden = r === 25;
    chat.messages.push(
      { mes: `玩家第${r}轮对白`, is_user: true, name: '清砚', is_system: hidden },
      { mes: `许今闻第${r}轮回复`, is_user: false, name: '许今闻', is_system: hidden },
    );
  }
  assert.equal(await engine.run(false), true, 'Summarizes Rounds 25-27 even when Round 25 was already hidden!');
  snap = await engine.sync();
  assert.equal(snap.memory.through, 27);
  assert.ok(autoHiddenCount > 0, 'autoHideArchived automatically hides newly eligible old floors');
  assert.equal(chat.messages[0].is_system, false, 'Message 0 greeting remains unhidden to preserve card CSS');

  // Step 5: Simulate catastrophic user mistake (deleting 20 rounds at once -> only 3 rounds left in chat)
  chat.messages.splice(7); // Leave greeting + 3 rounds (Rounds 1-3)
  snap = await engine.sync();
  assert.equal(snap.state.holdMismatch, true, 'Catastrophic drop triggers holdMismatch lock');
  assert.equal(snap.memory.through, 27, 'All 27 rounds remain intact in worldbook!');

  // User explicitly confirms aligning to Round 3 -> 27 rounds preserved in vault, then one-click restored!
  await engine.confirmAlign();
  snap = await engine.sync();
  assert.equal(snap.memory.through, 3);
  assert.equal(snap.state.vault?.through, 27);

  await engine.restoreVault();
  snap = await engine.sync();
  assert.equal(snap.memory.through, 27, 'Vault restores all 27 rounds with zero API requests!');
});
