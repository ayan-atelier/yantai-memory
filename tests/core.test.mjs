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

test('structured causal fields and investigation threads remain optional and validate', () => {
  const old = C.emptyMemory();
  const delta = C.validateDelta({
    events: [{ round: 1, time: '夜间', place: '车站', description: '发现一张票。',
      eventId: 'e-1', kind: 'clue', importance: 'core', actors: ['甲'], action: '甲发现车票',
      cause: '甲检查遗留物', result: '票面显示下一站', consequences: ['需要核实出票人'],
      evidenceRefs: ['round-1'], dependsOn: [], item: null, tension: ['紧张'] }],
    corrections: [], summary: '甲在车站发现车票，票面指向下一站，出票人未明。',
    threads: { upsert: [{ id: 'new-case', kind: '案件', title: '车票来源', at: '夜间', people: '甲',
      content: '确认车票是谁留下的', known: '票面指向下一站', unknown: '出票人', nextEvidence: '核对售票记录',
      due: '下一次调查', status: '调查中', state: 'open', importance: 'core', lastTouchedRound: 1, relatedEventIds: ['e-1'] }], resolve: [] },
  }, old, [1], 'batch');
  assert.equal(delta.events[0].kind, 'clue');
  assert.equal(delta.events[0].cause, '甲检查遗留物');
  assert.equal(delta.threads.upsert[0].kind, '案件');
  assert.equal(delta.threads.upsert[0].unknown, '出票人');
});

test('prompt projection hides resolved and background threads while keeping causal anchors', () => {
  const memory = { through: 20, skipped: 0, summary: '主线摘要', director: null,
    events: Array.from({ length: 20 }, (_, i) => ({ round: i + 1, eventId: `e-${i + 1}`, time: '未明', place: '未明', description: `事件${i + 1}`, kind: i === 0 ? 'discovery' : 'routine', importance: i === 0 ? 'core' : 'background', actors: [], action: '', cause: '', result: '', consequences: [], evidenceRefs: [], dependsOn: [], tension: ['平稳'] })),
    threads: [
      { id: 'active', kind: '案件', title: '开放案件', content: '调查', status: '调查中', state: 'open', importance: 'core', people: '甲', due: '未明', relatedEventIds: ['e-1'] },
      { id: 'done', kind: '约定', title: '已完成约定', content: '历史', status: '已履行', state: 'resolved', importance: 'active', people: '甲', due: '—', relatedEventIds: [] },
      { id: 'bg', kind: '任务', title: '背景任务', content: '背景', status: '暂存', state: 'dormant', importance: 'background', people: '甲', due: '—', relatedEventIds: [] },
    ] };
  const projected = C.projectForPrompt(memory, { recentEvents: 4, maxThreads: 4 });
  assert.deepEqual(projected.threads.map(t => t.id), ['active']);
  assert.ok(projected.events.some(row => row.eventId === 'e-1'));
  assert.ok(projected.events.length <= 5);
  const prompt = C.renderMemory(memory, false, 'off', { prompt: true, recentEvents: 4, maxThreads: 4 });
  assert.match(prompt, /开放案件/);
  assert.doesNotMatch(prompt, /已完成约定/);
});

test('legacy rows receive a stable fallback event id', () => {
  const old = C.emptyMemory();
  const delta = C.validateDelta({ events: [{ round: 1, time: '未明', place: '未明', description: '旧格式。', item: null, tension: ['平稳'] }], corrections: [], summary: '旧摘要', threads: { upsert: [], resolve: [] } }, old, [1]);
  assert.equal(delta.events[0].eventId, 'legacy-round-1');
  assert.equal(delta.events[0].kind, 'scene');
});

test('next整理请求 receives the bounded causal projection', () => {
  const old = { through: 15, skipped: 0, summary: '主线摘要', director: null,
    events: Array.from({ length: 15 }, (_, i) => ({ round: i + 1, eventId: `e-${i + 1}`, time: '未明', place: '未明', description: `旧事件${i + 1}`, kind: 'routine', importance: 'background', actors: [], action: '', cause: '', result: '', consequences: [], evidenceRefs: [], dependsOn: [], tension: ['平稳'] })),
    threads: [{ id: 'old', kind: '约定', title: '已履行', content: '旧约定', status: '已履行', state: 'resolved', importance: 'active', people: '甲', due: '—', relatedEventIds: [] }] };
  const messages = C.requestMessages('中性整理规则', old, [{ round: 16, messages: [] }], '');
  const input = JSON.parse(messages[1].content);
  assert.equal(input['上一版记忆'].events.length, 6);
  assert.equal(input['上一版记忆'].threads.length, 0);
  assert.equal(input['上一版记忆'].projection.archivedHidden, true);
});

test('migration assistant returns a reversible summary and thread patch without rewriting events', () => {
  const memory = { through: 2, skipped: 0, summary: '旧摘要', director: null,
    events: [{ round: 1, eventId: 'e-1', time: '未明', place: '车站', description: '发现车票。', kind: 'scene', importance: 'active', actors: [], action: '', cause: '', result: '', consequences: [], evidenceRefs: [], dependsOn: [], tension: ['平稳'] }],
    threads: [{ id: 't-old', kind: '约定', title: '旧约定', content: '旧内容', status: '进行中', people: '甲', due: '未明' }] };
  const messages = C.migrationMessages(memory, 50000);
  assert.match(messages[0].content, /不改写或删除原始事件/);
  const result = C.validateMigrationOutput(JSON.stringify({ summary: '按因果重写的摘要。', threads: { upsert: [{ id: 't-old', kind: '约定', title: '旧约定', at: '未明', people: '甲', content: '旧内容', due: '未明', status: '已履行', state: 'resolved', importance: 'background' }], resolve: [] } }), memory);
  assert.equal(result.summary, '按因果重写的摘要。');
  assert.equal(result.threads.upsert[0].state, 'resolved');
  assert.equal(memory.events[0].description, '发现车票。');
});

test('a migration patch with no new rounds survives backup validation', () => {
  const rounds = [{ signature: 'sig-1' }];
  const state = C.emptyState('chat');
  state.history.push({ id: 'b1', at: '', sources: ['sig-1'], prefix: 'prefix-1', note: '', delta: {
    events: [{ round: 1, time: '未明', place: '未明', description: '旧事件。', item: null, tension: ['平稳'] }],
    corrections: [], summary: '旧摘要', threads: { upsert: [], resolve: [] }, suggestions: [], director: null,
  }});
  const migration = C.makeBatch({ events: [], corrections: [], summary: '迁移后的摘要。', threads: { upsert: [], resolve: [] }, suggestions: [], director: null }, rounds, 1, '迁移');
  state.history.push(migration);
  const restored = C.validateState(state);
  assert.equal(C.materialize(restored).through, 1);
  assert.equal(C.materialize(restored).summary, '迁移后的摘要。');
});
