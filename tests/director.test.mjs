import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIRECTOR_CHANNELS,
  DIRECTOR_FALLBACK,
  directorRules,
  directorSchemaPrompt,
  normalizeDirector,
} from '../src/modules/memory/director.js';

test('uses canonical AIRP channels and preserves mode APIs', () => {
  assert.deepEqual(DIRECTOR_CHANNELS, ['日常', '关系', '任务', '冲突', '危机', '修复', '转场', '未知']);
  assert.equal(directorRules('off'), '');
  assert.match(directorRules('compat'), /轻量连续性场记/);
  assert.match(directorSchemaPrompt('full'), /schema":2/);
});

test('normalizes schema-1 aliases without dropping readable fields', () => {
  const result = normalizeDirector({
    schema: 1,
    channel: '调查',
    pace: '推进',
    lastBeat: '掌柜把车辕旁的位置让开。',
    continuityCue: ['车在村口。'],
    userAgency: { settled: '用户询问借车时长。', open: '是否同意借车。' },
  });
  assert.equal(result.fallback, false);
  assert.equal(result.value.schema, 2);
  assert.equal(result.value.channel, '任务');
  assert.equal(result.value.lastBeat, '掌柜把车辕旁的位置让开。');
  assert.equal(result.value.userAgency.open, '是否同意借车。');
});

test('keeps prior good data when an update is empty or malformed', () => {
  const previous = {
    schema: 1,
    channel: '关系',
    pace: '推进',
    lastBeat: '已经发生的一拍。',
    continuityCue: ['必须接住的事实。'],
    characterGoals: [{ actor: '陆承安', goal: '把车送回村口。', basis: '本轮台词', limit: '不替用户决定。' }],
    characterGuardrails: ['保持克制。'],
    userAgency: { settled: '用户点头。', open: '是否喝茶。', mode: 'strict' },
    handoff: '等用户回应。',
    riskFlags: ['时间尚未确认。'],
    scene: { location: { value: '榆湾村口', basis: '开场白' } },
  };
  const result = normalizeDirector({
    channel: '',
    pace: 'bad',
    lastBeat: '',
    continuityCue: [],
    characterGoals: [],
    characterGuardrails: [''],
    userAgency: { settled: '', open: '', mode: 'bad' },
    handoff: '',
    riskFlags: [],
    scene: { time: { value: '14:00' } },
  }, previous);
  assert.equal(result.fallback, true);
  assert.equal(result.value.channel, '关系');
  assert.equal(result.value.pace, '推进');
  assert.equal(result.value.lastBeat, '已经发生的一拍。');
  assert.deepEqual(result.value.continuityCue, previous.continuityCue);
  assert.deepEqual(result.value.characterGoals, previous.characterGoals);
  assert.deepEqual(result.value.scene, previous.scene);
  assert.equal(result.value.userAgency.mode, 'strict');
});

test('treats schema-only and empty updates as no update', () => {
  const result = normalizeDirector({ schema: 2 });
  assert.equal(result.fallback, true);
  assert.equal(result.value.schema, 2);
});

test('does not invent optional scene fields or accept scene without evidence', () => {
  const noScene = normalizeDirector({ schema: 2, channel: '日常', pace: '停留' });
  assert.equal('scene' in noScene.value, false);
  const withScene = normalizeDirector({
    schema: 2,
    channel: '关系',
    scene: {
      time: { value: '1924年6月1日 14:10', basis: '本轮开场白' },
      location: { value: '榆湾村口', basis: '用户当前输入' },
      present: [{ actor: '陆承安', basis: '正文直接描写' }],
      knowledge: [{ actor: '陆承安', knows: '车属于用户哥哥', basis: '角色台词明确提到' }],
    },
  });
  assert.equal(withScene.value.scene.time.value, '1924年6月1日 14:10');
  assert.equal(withScene.value.scene.present[0].actor, '陆承安');
  assert.equal(withScene.value.scene.knowledge[0].knows, '车属于用户哥哥');
});

test('records agency aliases without making strict mode universal', () => {
  const limited = normalizeDirector({
    schema: 2,
    userAgency: { mode: '有限接续', settled: '用户递出车钥匙。' },
  });
  assert.equal(limited.value.userAgency.mode, 'limited');
  const full = normalizeDirector({
    schema: 2,
    userAgency: { mode: '抢话', settled: '用户要求完整扩写。' },
  });
  assert.equal(full.value.userAgency.mode, 'full');
  assert.equal(DIRECTOR_FALLBACK.userAgency.open, '把下一步留给用户。');
});
