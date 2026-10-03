import assert from 'node:assert/strict';
import test from 'node:test';
import C from '../src/modules/memory/core.js';

const msg = (mes, is_user, name = is_user ? 'User' : 'Char') => ({ mes, is_user, name, is_system: false });

test('only explicit dollar production directives become standalone rounds', () => {
  assert.equal(C.isStandaloneDirective('$暂停当前剧情，生成一个if线番外。不计入记忆。'), true);
  assert.equal(C.isStandaloneDirective('$生成一个温馨小剧场。'), true);
  assert.equal(C.isStandaloneDirective('$100'), false);
  assert.equal(C.isStandaloneDirective('普通对白里提到番外'), false);
  const rounds = C.roundsFrom([
    msg('普通对白', true), msg('正常回复', false),
    msg('$暂停当前剧情，生成一个if线番外。不计入记忆。', true), msg('番外回复', false),
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].standalone, false);
  assert.equal(rounds[1].standalone, true);
});

test('skip batches advance through without changing mainline memory', () => {
  const rounds = C.roundsFrom([
    msg('$暂停当前剧情，生成一个if线番外。不计入记忆。', true), msg('番外回复', false),
  ]);
  const state = C.emptyState('chat');
  const skip = C.makeSkipBatch(rounds, 0, 1);
  state.history.push(skip);
  const memory = C.materialize(state);
  assert.equal(memory.through, 1);
  assert.equal(memory.events.length, 0);
  assert.equal(memory.summary, '');
  assert.equal(C.reconcile(state, rounds).changed, false);
});

test('skip batches survive export validation and old normal state stays readable', () => {
  const rounds = C.roundsFrom([msg('$暂停当前剧情，生成一个if线番外。', true), msg('番外', false)]);
  const source = rounds[0].signature;
  const state = C.emptyState('chat');
  state.history.push({ ...C.makeSkipBatch(rounds, 0, 1), sources: [source] });
  const restored = C.validateState(state);
  assert.equal(restored.history[0].skip, true);
  assert.equal(C.materialize(restored).through, 1);

  const old = C.emptyState('old');
  old.history = [];
  assert.equal(C.validateState(old).owner, 'old');
});

test('rendered director exposes scene anchors and agency mode without prose', () => {
  const memory = { through: 1, summary: '已发生一轮。', events: [], threads: [], suggestions: [], director: {
    schema: 2, channel: '关系', pace: '停留', lastBeat: '两人停在门口。', continuityCue: [], characterGoals: [], characterGuardrails: [],
    userAgency: { mode: 'limited', settled: '用户停下脚步。', open: '是否进门。' }, handoff: '', riskFlags: [],
    scene: { location: { value: '村口', basis: '正文' }, present: [{ actor: '陆承安', basis: '正文' }] },
  } };
  const text = C.renderMemory(memory, false, 'full');
  assert.match(text, /现场锚点：地点：村口｜在场：陆承安/);
  assert.match(text, /玩家授权模式：limited/);
});

test('presentation blocks and legacy memory panels are removed before summarizing', () => {
  const cleaned = C.clean('正文一\n<airp_top>状态栏</airp_top>\n<airp_options>选项</airp_options>\n<airp_theater>番外</airp_theater>\n正文二\n<memory>旧记忆</memory>\n<details><summary>【记忆区】</summary><details><summary>短期记忆</summary>旧内容</details></details>');
  assert.equal(cleaned, '正文一\n\n\n正文二');
});

test('compact view is reversible and keeps original history', () => {
  const state = C.emptyState('chat');
  state.history.push({ id: 'b1', at: '', sources: ['s1'], prefix: 'p', note: '', delta: {
    events: [{ round: 1, time: '未明', place: '村口', description: '两人见面。', item: null, tension: ['平稳'] }],
    corrections: [], summary: '完整摘要。', threads: { upsert: [], resolve: [] }, suggestions: [], director: null,
  }});
  state.compact = { through: 1, level: 1, summary: '压缩摘要。', keepRounds: 1, at: '' };
  const memory = C.materialize(state);
  const rendered = C.renderMemory(memory, false, 'off');
  assert.match(rendered, /累计关键经过·压缩版/);
  assert.match(rendered, /压缩摘要/);
  const restored = C.validateState(state);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.compact.summary, '压缩摘要。');
});

test('assistant result must match the memory version', () => {
  const memory = { through: 4 };
  assert.throws(() => C.validateAssistantOutput('{"through":3,"summary":"旧"}', memory), /版本已变化/);
  const compact = C.validateAssistantOutput('{"through":4,"level":2,"summary":"保留事实。","keepRounds":2}', memory, 2);
  assert.equal(compact.level, 2);
  assert.equal(compact.keepRounds, 2);
});
