import assert from 'node:assert/strict';
import test from 'node:test';
import C from '../src/modules/memory/core.js';
import { AUTO_ENABLE_OPT_IN, AUTO_ENABLE_OPT_OUT, TAG, createStorage } from '../src/modules/memory/storage.js';

function harness({ book = '', data = { entries: {} }, autoEnableNewChats = true, frequency = 3, messages = [], charWorld = '' } = {}) {
  const metadata = book ? { world_info: book } : {};
  const chat = {
    key: 'chat-key',
    id: 'chat-id',
    name: '测试角色',
    avatar: 'char.png',
    characterId: 0,
    metadata,
    context: {
      chatMetadata: metadata,
      characters: [{ avatar: 'char.png', name: '测试角色', data: { extensions: { world: charWorld } } }],
      extensionSettings: {},
    },
    messages,
  };
  const worldBooks = new Map(book ? [[book, structuredClone(data)]] : []);
  const host = {
    context: () => chat.context,
    currentChat: () => chat,
    saveMetadata: async () => {},
    async request(path, options) {
      if (path === '/api/worldinfo/get') {
        return structuredClone(worldBooks.get(options?.body?.name) || data);
      }
      if (path === '/api/worldinfo/edit') {
        worldBooks.set(options.body.name, structuredClone(options.body.data));
        return { ok: true };
      }
      if (path === '/api/chats/get') return [{ chat_metadata: structuredClone(metadata) }];
      throw new Error(`unexpected request: ${path}`);
    },
  };
  const cacheBridge = { worldInfoCache: new Map() };
  const storage = createStorage(host, () => ({ autoEnableNewChats, frequency }), {
    context: () => chat,
    alive: () => true,
    cacheBridge,
  });
  return { chat, storage, worldBooks };
}

test('new chat stays auto-enabled across Round 0 -> Round 1 -> Round 2 -> Round 3 and coexists with character worldbook', async () => {
  const { chat, storage } = harness({ charWorld: '裴敬之｜全剧目设定集' });

  // Round 0 (greeting only)
  const r0 = await storage.load(chat);
  assert.equal(r0.state.enabled, true);
  assert.equal(r0.autoEnabled, true);
  assert.deepEqual(r0.charBooks, ['裴敬之｜全剧目设定集']);
  assert.equal(chat.metadata[AUTO_ENABLE_OPT_IN], true);

  // Round 1 completed (no worldbook created yet because frequency = 3!)
  chat.messages.push(
    { mes: '玩家第1句', is_user: true, name: 'User', is_system: false },
    { mes: '角色第1句', is_user: false, name: 'Char', is_system: false },
  );
  const r1 = await storage.load(chat);
  assert.equal(r1.state.enabled, true, 'Must remain enabled after Round 1!');

  // Round 2 completed
  chat.messages.push(
    { mes: '玩家第2句', is_user: true, name: 'User', is_system: false },
    { mes: '角色第2句', is_user: false, name: 'Char', is_system: false },
  );
  const r2 = await storage.load(chat);
  assert.equal(r2.state.enabled, true, 'Must remain enabled after Round 2!');

  // Even if opened fresh at Round 2 (e.g. plugin just enabled), <= max(frequency, 5) keeps it enabled!
  delete chat.metadata[AUTO_ENABLE_OPT_IN];
  const r2Fresh = await storage.load(chat);
  assert.equal(r2Fresh.state.enabled, true);

  // Opt-out persists cleanly in chat_metadata
  await storage.save(chat, { ...r2Fresh.state, enabled: false }, r2Fresh);
  const afterOptOut = await storage.load(chat);
  assert.equal(chat.metadata[AUTO_ENABLE_OPT_OUT], true);
  assert.equal(afterOptOut.state.enabled, false);
});

test('ancient unbound archive (> 5 rounds and never latched) is not silently opted in', async () => {
  const messages = [];
  for (let i = 1; i <= 8; i++) {
    messages.push(
      { mes: `用户第${i}句`, is_user: true, name: 'User', is_system: false },
      { mes: `角色第${i}句`, is_user: false, name: 'Char', is_system: false },
    );
  }
  const { chat, storage } = harness({ messages });
  const loaded = await storage.load(chat);
  assert.equal(loaded.state.enabled, false);
  assert.equal(loaded.autoEnabled, false);
});

test('a chat with an existing non-memory chat worldbook stays disabled until confirmed', async () => {
  const { chat, storage } = harness({ book: 'shared-book' });
  const loaded = await storage.load(chat);
  assert.equal(loaded.state.enabled, false);
  assert.equal(loaded.owned, false);
  await assert.rejects(storage.save(chat, { ...loaded.state, enabled: true }, loaded), /请先在记忆面板确认/);
});

test('stored states, fork copies, and global autoEnableNewChats=false behave deterministically', async () => {
  const state = C.emptyState('chat-key');
  state.enabled = true;
  const data = { entries: { 1: { uid: 1, content: JSON.stringify(state), extra: { [TAG]: { kind: 'state' } } } } };
  const owned = harness({ book: 'memory-book', data });
  const loaded = await owned.storage.load(owned.chat);
  assert.equal(loaded.owned, true);
  assert.equal(loaded.state.enabled, true);

  const forkState = { ...state, owner: 'other-chat' };
  const fork = harness({ book: 'memory-book', data: { entries: { 1: { uid: 1, content: JSON.stringify(forkState), extra: { [TAG]: { kind: 'state' } } } } } });
  const forkLoaded = await fork.storage.load(fork.chat);
  assert.equal(forkLoaded.fork, true);
  assert.equal(forkLoaded.state.enabled, false);

  const disabledGlobal = harness({ autoEnableNewChats: false });
  const disabledLoaded = await disabledGlobal.storage.load(disabledGlobal.chat);
  assert.equal(disabledLoaded.state.enabled, false);
});
