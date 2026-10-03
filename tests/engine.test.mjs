import assert from 'node:assert/strict';
import test from 'node:test';
import Engine from '../src/modules/memory/engine.js';
import C from '../src/modules/memory/core.js';

test('automatic run skips leading IF rounds without calling the memory API', async () => {
  const context = { key: 'chat', name: '测试', messages: [
    { mes: '$暂停当前剧情，生成一个if线番外。不计入记忆。', is_user: true, name: 'User', is_system: false },
    { mes: '番外内容', is_user: false, name: 'Char', is_system: false },
  ] };
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
    stripCardMemory: true, frequency: 10, batchSize: 10, maxInputChars: 100000,
    directorMode: 'off', directorStrength: 'standard', directorRules: '', preset: '',
  });
  const engine = new Engine(adapter, configuration);
  assert.equal(await engine.run(false), true);
  assert.equal(requests, 0);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].skip, true);
  assert.equal(C.materialize(state).through, 1);
});
