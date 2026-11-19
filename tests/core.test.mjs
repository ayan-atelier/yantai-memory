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

test('skip batches advance through without changing mainline memory and survive restore', () => {
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

  const restored = C.validateState(state);
  assert.equal(restored.history[0].skip, true);
  assert.equal(C.materialize(restored).through, 1);
});

test('clean removes option menus, commentary, reasoning, and legacy memory while preserving <time> tags', () => {
  const raw = [
    '<think>这是思考过程</think>',
    '<time>建元二十五年·十月十五亥时｜东宫承恩殿</time>',
    '正文第一段。',
    '<airp_top>顶栏装饰</airp_top>',
    '<选项区>\nA：跟上去\nB：转身离开\n</选项区>',
    '<锐评>这段叙事张力不错。</锐评>',
    '正文第二段。',
    '<memory>旧记忆块</memory>',
    '<details><summary>【记忆区】</summary>旧折叠记忆</details>',
  ].join('\n');
  const cleaned = C.clean(raw);
  assert.match(cleaned, /\[时间地点\] 建元二十五年·十月十五亥时｜东宫承恩殿/);
  assert.match(cleaned, /正文第一段。/);
  assert.match(cleaned, /正文第二段。/);
  assert.doesNotMatch(cleaned, /思考过程|选项区|转身离开|锐评|旧记忆块|顶栏装饰/);
});

test('lightweight model parser self-heals chatter, markdown fences, trailing commas, and loose thread/item formats', () => {
  const messyOutput = `好的，为您整理如下：
\`\`\`json
{
  "scene": {
    "time": "周五深夜",
    "location": "河东官邸书房",
    "present": ["宋仲庭", "清砚"],
    "secrets": ["书房压着印有家属事项的机要袋，清砚尚不知情",],
  },
  "events": [
    {
      "round": 1,
      "importance": "core",
      "description": "宋仲庭取出老宅外祖母传下的满绿翡翠圆条镯套上清砚右腕，严令不准摘下。",
      "item": "满绿翡翠圆条镯",
      "tension": ["暧昧", "试探"],
    },
  ],
  "chapterTitle": "玉镯立契",
  "chapterSummary": "周五深夜回到河东官邸，宋仲庭在书房将沈家老宅外祖母传下的满绿翡翠圆条镯套上清砚右腕，承诺将两间铺面换作学校旁公寓。",
  "threads": {
    "upsert": [
      {
        "id": "vow_bracelet",
        "kind": "约定",
        "title": "翡翠镯不得摘除",
        "content": "宋仲庭要求清砚一直戴着翡翠圆条镯，下周办理公寓过户",
      },
    ],
    "resolve": [],
  },
}
\`\`\`
整理完毕！`;

  const old = C.emptyMemory();
  const delta = C.validateDelta(messyOutput, old, [1], 'b1');
  assert.equal(delta.chapterMode, true);
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0].time, '未明');
  assert.equal(delta.events[0].importance, 'core');
  assert.deepEqual(delta.events[0].item, { name: '满绿翡翠圆条镯', reason: '本轮关键物品／状态记录' });
  assert.deepEqual(delta.events[0].tension, ['轻松', '紧张']);
  assert.equal(delta.threads.upsert.length, 1);
  assert.equal(delta.threads.upsert[0].kind, '约定');
  assert.equal(delta.scene.location, '河东官邸书房');
  assert.equal(delta.scene.secrets.length, 1);

  // Next batch: lightweight model puts the '约定' into resolve -> auto-converted to resolved background upsert instead of throwing!
  const state = C.emptyState('chat');
  const rounds = C.roundsFrom([msg('u1', true), msg('a1', false), msg('u2', true), msg('a2', false)]);
  state.history.push(C.makeBatch(delta, rounds, 0));
  const memAfter1 = C.materialize(state);
  const vowId = memAfter1.threads[0].id;

  const delta2 = C.validateDelta({
    events: [{ round: 2, description: '次周小沈办妥学校旁公寓过户手续。' }],
    chapterSummary: '周五立契戴镯，次周办妥公寓过户。',
    threads: { upsert: [], resolve: [{ id: vowId, reason: '公寓已过户完成' }] },
  }, memAfter1, [2], 'b2');

  assert.equal(delta2.threads.resolve.length, 0);
  assert.equal(delta2.threads.upsert.length, 1);
  assert.equal(delta2.threads.upsert[0].state, 'resolved');
  assert.equal(delta2.threads.upsert[0].importance, 'background');
});

test('300-round long-horizon simulation: immutable chapters + key items + vows survive 100 batches with zero loss', () => {
  const totalRounds = 300;
  const rawMessages = [];
  for (let r = 1; r <= totalRounds; r++) {
    rawMessages.push(msg(`玩家第${r}轮输入`, true), msg(`角色第${r}轮回复`, false));
  }
  const allRounds = C.roundsFrom(rawMessages);
  assert.equal(allRounds.length, 300);

  const state = C.emptyState('long-chat');
  state.enabled = true;

  // Simulate 100 batches of 3 rounds each (frequency = 3, chapterSpan = 24 -> 12 sealed volumes + 1 open volume!)
  for (let start = 0; start < totalRounds; start += 3) {
    const mem = C.materialize(state);
    const batchRounds = [start + 1, start + 2, start + 3];
    const volumeNo = Math.floor(start / 24) + 1;

    // Verify lightweight model request NEVER asks it to rewrite already-sealed volumes
    const req = C.requestMessages('预设规则', mem, allRounds.slice(start, start + 3), '');
    const reqPayload = JSON.parse(req[1].content);
    if (start >= 24) {
      assert.ok(reqPayload.已封存前情分卷_只读勿重写.length >= 1);
      assert.equal(reqPayload.当前在途分卷.当前分卷起始轮, (volumeNo - 1) * 24 + 1);
    }

    const events = batchRounds.map(r => ({
      round: r,
      time: `第${r}日`,
      place: `场景${volumeNo}`,
      importance: r === 4 || r === 150 ? 'core' : 'active',
      description: r === 4
        ? '在第4轮定下生死契约并送出祖传祖母绿怀表，约定绝不转手他人。'
        : `第${r}轮具体因果事件经过，记录关键行动与结果。`,
      consequences: r === 299 ? ['幕后密信刚送达书房暗格，女主尚不知情'] : [],
      item: r === 4
        ? { name: '祖传祖母绿怀表', reason: '第4轮赠予清砚贴身保管' }
        : r === 180
          ? { name: '祖传祖母绿怀表', reason: '第180轮内侧刻上两人缩写后重新戴回' }
          : (r % 45 === 0 ? { name: `阶段信物_${r}`, reason: `第${r}轮获得` } : null),
    }));

    const threadsUpsert = start === 0
      ? [{ id: 'new-vow', kind: '誓言', title: '生死同盟誓言', content: '无论局势如何变化绝不背弃彼此', state: 'open', importance: 'core' }]
      : [];

    const delta = C.validateDelta({
      scene: {
        time: `第${start + 3}日夜晚`,
        location: `场景${volumeNo}`,
        present: ['男主', '女主'],
        secrets: ['暗格密信未拆封，女主尚不知情'],
      },
      events,
      chapterTitle: `卷题_${volumeNo}`,
      chapterSummary: `这是第${volumeNo}阶段独有核心剧情坐标【ANCHOR_VOL_${volumeNo}】，完整记录本阶段24轮关键转折。`,
      threads: { upsert: threadsUpsert, resolve: [] },
    }, mem, batchRounds, `b-${start}`, { chapterSpan: 24 });

    state.history.push(C.makeBatch(delta, allRounds, start));
  }

  // Validate full state durability through serialize/restore
  const restoredState = C.validateState(JSON.parse(JSON.stringify(state)));
  const finalMem = C.materialize(restoredState);

  assert.equal(finalMem.through, 300);
  assert.equal(finalMem.chapters.length, 12, '288 rounds = 12 sealed 24-round chapters');
  assert.equal(finalMem.openChapter.fromRound, 289);
  assert.equal(finalMem.openChapter.toRound, 300);

  const promptBody = C.renderMemory(finalMem, false, 'off', { prompt: true, omitRecentRounds: 5 });

  // 1. ALL 12 sealed chapters + Chapter 13 open stage remain 100% intact without any early volume washed away!
  for (let v = 1; v <= 13; v++) {
    assert.match(promptBody, new RegExp(`ANCHOR_VOL_${v}`), `Volume ${v} must not be lost at Round 300`);
  }
  // 2. Round 4 key item updated at Round 180 is STILL present in the permanent item ledger at Round 300!
  assert.match(promptBody, /祖传祖母绿怀表/);
  assert.match(promptBody, /第180轮内侧刻上两人缩写/);
  // 3. Early Round 4 core milestone & Round 1 standing vow are STILL present at Round 300!
  assert.match(promptBody, /生死同盟誓言/);
  assert.match(promptBody, /暗格密信未拆封/);
  // 4. Token budget at 300 rounds stays lean and reasonable (< 8,000 tokens)!
  const estTokens = C.estimateTokens(promptBody);
  assert.ok(estTokens < 8000, `Expected < 8000 tokens at 300 rounds, got ${estTokens}`);

  // 5. Reconcile rollback safety: editing Round 298 cleanly rewinds only the last batch, keeping all 12 sealed chapters intact!
  const editedRounds = allRounds.slice(0, 297);
  const rewound = C.reconcile(restoredState, editedRounds);
  assert.equal(rewound.changed, true);
  const rewoundMem = C.materialize(rewound.state);
  assert.equal(rewoundMem.through, 297);
  assert.equal(rewoundMem.chapters.length, 12);
});

test('legacy 0.3.x saves with director.scene load cleanly and transition smoothly into 0.4.0 chapters', () => {
  const rounds = C.roundsFrom([
    msg('u1', true), msg('a1', false),
    msg('u2', true), msg('a2', false),
  ]);
  const state = C.emptyState('legacy-chat');
  const legacyBatch = {
    id: 'legacy-b1',
    at: '2026-10-10T00:00:00.000Z',
    sources: [rounds[0].signature],
    prefix: C.hash(JSON.stringify([rounds[0].signature])),
    note: '',
    delta: {
      events: [{ round: 1, time: '秋夜', place: '船屋', description: '旧版第1轮事件。', item: { name: '旧信物', reason: '第1轮留存' }, tension: ['平稳'] }],
      corrections: [],
      summary: '【第一阶段（第1轮）】这是旧版存档的累计摘要。',
      threads: { upsert: [], resolve: [] },
      suggestions: [],
      director: {
        schema: 2,
        channel: '危机',
        pace: '转折',
        scene: {
          time: { value: '秋夜子时', basis: '正文' },
          location: { value: '哈德逊河船屋', basis: '正文' },
          present: [{ actor: 'John', basis: '正文' }, { actor: 'Rong', basis: '正文' }],
          knowledge: [{ actor: 'John', knows: '已暗中安排替身登机，Rong尚不知情', basis: '正文' }],
        },
      },
    },
  };
  state.history.push(legacyBatch);

  const validatedLegacy = C.validateState(state);
  const mem1 = C.materialize(validatedLegacy);
  assert.equal(mem1.through, 1);
  assert.equal(mem1.scene.location, '哈德逊河船屋');
  assert.match(mem1.scene.secrets[0], /替身登机/);

  // Now play Round 2 with v0.4.0 chaptered format: Round 1 legacy summary is locked as Volume 1, Round 2 starts openChapter!
  const delta2 = C.validateDelta({
    events: [{ round: 2, time: '次日清晨', place: '甲板', description: '新版第2轮事件。', item: null }],
    chapterTitle: '甲板新篇',
    chapterSummary: '次日清晨两人在甲板核对航线。',
    threads: { upsert: [], resolve: [] },
  }, mem1, [2], 'new-b2');
  validatedLegacy.history.push(C.makeBatch(delta2, rounds, 1));

  const mem2 = C.materialize(validatedLegacy);
  assert.equal(mem2.through, 2);
  assert.equal(mem2.chapters.length, 1);
  assert.match(mem2.chapters[0].summary, /旧版存档的累计摘要/);
  assert.equal(mem2.openChapter.fromRound, 2);
  const rendered = C.renderMemory(mem2, false, 'off', { prompt: true });
  assert.match(rendered, /旧版存档的累计摘要/);
  assert.match(rendered, /次日清晨两人在甲板核对航线/);
  assert.match(rendered, /旧信物/);
  assert.doesNotMatch(rendered, /导演运行台|大事推进器/);
});
