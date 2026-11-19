import assert from 'node:assert/strict';
import test from 'node:test';
import Engine from '../src/modules/memory/engine.js';
import C from '../src/modules/memory/core.js';
import { createStorage } from '../src/modules/memory/storage.js';

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
