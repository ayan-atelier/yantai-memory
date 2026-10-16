import assert from 'node:assert/strict';
import test from 'node:test';
import C from '../src/modules/memory/core.js';
import { AUTO_ENABLE_OPT_OUT, TAG, createStorage } from '../src/modules/memory/storage.js';

function harness({ book = '', data = { entries: {} }, autoEnableNewChats = true, messages = [] } = {}) {
  const metadata = book ? { world_info: book } : {};
  const chat = { key: 'chat-key', id: 'chat-id', name: '测试', avatar: 'avatar', metadata,
    context: { chatMetadata: metadata }, messages };
  const host = {
    currentChat: () => chat,
    saveMetadata: async () => {},
    async request(path) {
      if (path === '/api/worldinfo/get') return structuredClone(data);
      if (path === '/api/chats/get') return [{ chat_metadata: structuredClone(metadata) }];
      throw new Error(`unexpected request: ${path}`);
    },
  };
  const storage = createStorage(host, () => ({ autoEnableNewChats }), { context: () => chat, alive: () => true });
  return { chat, storage };
}

test('a brand-new unbound chat is enabled by default and can persist an opt-out', async () => {
  const { chat, storage } = harness();
  const initial = await storage.load(chat);
  assert.equal(initial.state.enabled, true);
  assert.equal(initial.autoEnabled, true);
  assert.equal(initial.autoDisabled, false);

  await storage.save(chat, { ...initial.state, enabled: false }, initial);
  const afterOptOut = await storage.load(chat);
  assert.equal(chat.metadata[AUTO_ENABLE_OPT_OUT], true);
  assert.equal(afterOptOut.state.enabled, false);
  assert.equal(afterOptOut.autoEnabled, false);
  assert.equal(afterOptOut.autoDisabled, true);
});

test('a chat with an existing worldbook but no yantai state stays disabled', async () => {
  const { chat, storage } = harness({ book: 'shared-book' });
  const loaded = await storage.load(chat);
  assert.equal(loaded.state.enabled, false);
  assert.equal(loaded.autoEnabled, false);
  assert.equal(loaded.owned, false);
  await assert.rejects(storage.save(chat, { ...loaded.state, enabled: true }, loaded), /请先在记忆面板确认/);
});

test('an older unbound chat with completed rounds is not silently opted in', async () => {
  const { chat, storage } = harness({ messages: [
    { mes: '用户第一句', is_user: true, name: 'User', is_system: false },
    { mes: '角色第一句', is_user: false, name: 'Char', is_system: false },
  ] });
  const loaded = await storage.load(chat);
  assert.equal(loaded.state.enabled, false);
  assert.equal(loaded.autoEnabled, false);
});

test('stored states and fork copies keep their explicit enablement', async () => {
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
});

test('the default can be disabled globally without changing stored chats', async () => {
  const { chat, storage } = harness({ autoEnableNewChats: false });
  const loaded = await storage.load(chat);
  assert.equal(loaded.state.enabled, false);
  assert.equal(loaded.autoEnabled, false);
});
