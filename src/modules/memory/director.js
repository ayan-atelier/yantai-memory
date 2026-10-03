/* Director-console rules shared by the one-call memory request and the
 * rendered chat-worldbook state. The console is a small continuity clerk,
 * not a second roleplay preset. */

export const DIRECTOR_MODES = Object.freeze(['off', 'compat', 'full']);
export const DIRECTOR_STRENGTHS = Object.freeze(['standard', 'strong']);
export const DIRECTOR_CHANNELS = Object.freeze(['日常', '关系', '任务', '冲突', '危机', '修复', '转场', '未知']);
export const DIRECTOR_PACES = Object.freeze(['停留', '推进', '转折', '收束', '恢复']);

export const DIRECTOR_MODE_LABELS = Object.freeze({
  off: '关闭导演控制台',
  compat: '兼容提示·通用预设',
  full: '完整导演·砚台预设',
});

const CHANNEL_ALIASES = Object.freeze({
  日常: '日常', 生活: '日常', 普通: '日常', 闲暇: '日常',
  关系: '关系', 情感: '关系', 感情: '关系', 亲密: '关系',
  任务: '任务', 调查: '任务', 行动: '任务', 工作: '任务', 剧情: '任务',
  冲突: '冲突', 争执: '冲突', 对抗: '冲突',
  危机: '危机', 危险: '危机', 紧急: '危机', 高潮: '危机',
  修复: '修复', 恢复: '修复', 善后: '修复', 和解: '修复',
  转场: '转场', 过渡: '转场', 跳转: '转场', 番外: '转场',
  未知: '未知', 不明: '未知',
});
const PACE_SET = new Set(DIRECTOR_PACES);
const AGENCY_MODES = new Set(['strict', 'limited', 'full', 'unspecified']);

export const DIRECTOR_DEFAULT_RULES = Object.freeze({
  compat: [
    '你是轻量连续性场记，不是第二套角色扮演预设。只整理当前聊天已经给出的事实，并给下一轮一个可接的落点；不要重复规定文风、字数、语言或频道表现，也不要替原预设强行规划剧情。',
    '把“已发生事实”和“可选建议”分开：lastBeat、continuityCue、scene、userAgency.settled 只能写有证据的内容；characterGoals、handoff、riskFlags 只能作为建议或风险提醒，不能写成已经发生的事实。没有证据就使用“未明”、空数组或保留上一版。',
    '尊重当前预设的玩家授权模式。严格对戏时把未决定的行动留给用户；有限接续和完整扩写只有在预设或本轮要求明确启用时才可使用，不要把“不能替用户决定”误作所有模式的一刀切禁令。不要把氛围、推测或套路写成关系升级、敌意、服从或亲密事实。',
  ].join('\\n'),
  full: [
    '你是“砚台·连续剧导演”的运行时场记，同时检查角色是否接住了上一拍。你不写正文，不重做角色卡，不替代当前预设；只输出有证据的连续性记录，以及简短、可执行的下一拍建议。',
    '收视率来自连续性、具体动机、可回应的交接和适度变化，不来自每轮反转、强行升级或让所有人围着用户转。可以停留、观察、平稳对话或自然收束。频道只描述当前叙事功能：日常、关系、任务、冲突、危机、修复、转场；不要让频道名称变成剧情命令。',
    '事实层只能依据当前输入、角色卡、世界书和已经记录的剧情：lastBeat、continuityCue、scene、userAgency.settled、知情范围都必须能指出依据。建议层只能提供可选的角色目标、交接、护栏或风险，不得把建议写成事实，也不得与事实字段互相抄写。',
    '人物目标写成眼下具体要处理的事；人物性格、卡片设定、知情范围和已建立关系优先。不要把谨慎写成超雄，把关心写成占有，把沉默写成同意，把一次配合写成永久服从。年龄、身份或关系字段矛盾时，保留矛盾并采用不依赖矛盾的保守处理，不自行用常识裁决。',
    '“用户”是剧情中的扮演对象，不是现实操作者。按照当前预设授权记录用户已经做出的行动；严格模式留出回应空间，有限接续只允许小幅承接，完整扩写才可按明确要求补写普通行动、台词或心理。任何模式都不能否定用户已经明确写出的事实。',
  ].join('\\n'),
});

export const DIRECTOR_FALLBACK = Object.freeze({
  schema: 2,
  channel: '未知',
  pace: '停留',
  lastBeat: '导演状态尚未生成；以当前聊天原文和卡片为准。',
  continuityCue: [],
  characterGoals: [],
  characterGuardrails: ['保持卡片已建立的人物性格和知情范围。'],
  userAgency: { settled: '未明', open: '把下一步留给用户。' },
  handoff: '保留一个自然、可回应的现场落点，不替用户作答。',
  riskFlags: ['导演状态未生成'],
});

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const textValue = (value, max) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, max) : '';
const clone = value => JSON.parse(JSON.stringify(value));

function canonicalChannel(value) {
  if (typeof value !== 'string') return '';
  return CHANNEL_ALIASES[value.trim()] || '';
}

function normalizeAgencyMode(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim().toLowerCase();
  if (AGENCY_MODES.has(key)) return key;
  const aliases = {
    严格对戏: 'strict', 严格: 'strict', 不抢话: 'strict',
    有限接续: 'limited', 有限: 'limited', 小幅接续: 'limited',
    完整扩写: 'full', 完整: 'full', 抢话: 'full',
    未明: 'unspecified', 默认: 'unspecified',
  };
  return aliases[value.trim()] || '';
}

function normalizeStringList(input, previous, maxItems, maxChars) {
  if (!Array.isArray(input)) return { value: Array.isArray(previous) ? clone(previous) : [], updated: false };
  const usable = input.filter(value => typeof value === 'string' && value.trim())
    .slice(0, maxItems).map(value => value.trim().slice(0, maxChars));
  if (!usable.length) return { value: Array.isArray(previous) ? clone(previous) : [], updated: false };
  return { value: usable, updated: true };
}

function normalizeGoalList(input, previous) {
  if (!Array.isArray(input)) return { value: Array.isArray(previous) ? clone(previous) : [], updated: false };
  const usable = input.slice(0, 4).flatMap(row => {
    if (!isObject(row)) return [];
    const actor = textValue(row.actor, 100);
    const goal = textValue(row.goal, 500);
    if (!actor || !goal) return [];
    return [{
      actor,
      goal,
      basis: textValue(row.basis, 500) || '依据未明',
      limit: textValue(row.limit, 500) || '保持当前卡片与用户边界。',
    }];
  });
  if (!usable.length) return { value: Array.isArray(previous) ? clone(previous) : [], updated: false };
  return { value: usable, updated: true };
}

function normalizeEvidencePoint(input, previous) {
  if (!isObject(input)) return previous && isObject(previous) ? clone(previous) : null;
  const value = textValue(input.value, 300);
  const basis = textValue(input.basis, 500);
  if (!value || !basis) return previous && isObject(previous) ? clone(previous) : null;
  return { value, basis };
}

function normalizePresent(input, previous) {
  if (!Array.isArray(input)) return Array.isArray(previous) ? clone(previous) : [];
  const usable = input.slice(0, 12).flatMap(row => {
    if (!isObject(row)) return [];
    const actor = textValue(row.actor || row.name, 120);
    const basis = textValue(row.basis, 500);
    return actor && basis ? [{ actor, basis }] : [];
  });
  return usable.length ? usable : (Array.isArray(previous) ? clone(previous) : []);
}

function normalizeKnowledge(input, previous) {
  if (!Array.isArray(input)) return Array.isArray(previous) ? clone(previous) : [];
  const usable = input.slice(0, 12).flatMap(row => {
    if (!isObject(row)) return [];
    const actor = textValue(row.actor || row.name, 120);
    const knows = textValue(row.knows || row.knowledge, 800);
    const basis = textValue(row.basis, 500);
    return actor && knows && basis ? [{ actor, knows, basis }] : [];
  });
  return usable.length ? usable : (Array.isArray(previous) ? clone(previous) : []);
}

function normalizeScene(input, previous) {
  const old = isObject(previous) ? previous : {};
  if (!isObject(input)) return Object.keys(old).length ? clone(old) : undefined;
  const scene = {};
  const time = normalizeEvidencePoint(input.time, old.time);
  const location = normalizeEvidencePoint(input.location, old.location);
  const present = normalizePresent(input.present, old.present);
  const knowledge = normalizeKnowledge(input.knowledge, old.knowledge);
  if (time) scene.time = time;
  if (location) scene.location = location;
  if (present.length) scene.present = present;
  if (knowledge.length) scene.knowledge = knowledge;
  return Object.keys(scene).length ? scene : (Object.keys(old).length ? clone(old) : undefined);
}

export function directorRules(mode = 'off', strength = 'standard', custom = '') {
  if (!DIRECTOR_MODES.includes(mode) || mode === 'off') return '';
  const base = DIRECTOR_DEFAULT_RULES[mode];
  const intensity = strength === 'strong' && mode === 'full'
    ? '\\n强度档：只提高事实核对和连续性检查，不增加文风、字数或剧情强制；无法确认的字段宁可保留上一版或留空。'
    : '';
  const addition = typeof custom === 'string' && custom.trim()
    ? '\\n\\n【使用者补充规则】\\n' + custom.trim() : '';
  return '\\n\\n【砚台·导演控制台：' + DIRECTOR_MODE_LABELS[mode] + '】\\n'
    + base + intensity + addition;
}

export function directorSchemaPrompt(mode = 'off') {
  if (!DIRECTOR_MODES.includes(mode) || mode === 'off') return '';
  const compact = mode === 'compat';
  const schema = [
    '本次还要输出 director 对象，不能把它混入 events、summary 或 threads。它是轻量场记，事实与建议必须分开。格式：',
    '\"director\":{\"schema\":2,\"channel\":\"日常/关系/任务/冲突/危机/修复/转场/未知\",\"pace\":\"停留/推进/转折/收束/恢复\",\"lastBeat\":\"本轮已经发生的具体一拍，最多240字\",\"continuityCue\":[\"下一轮必须接住的已发生事实，最多3条\"],\"scene\":{\"time\":{\"value\":\"已确认时间\",\"basis\":\"原文依据\"},\"location\":{\"value\":\"已确认地点\",\"basis\":\"原文依据\"},\"present\":[{\"actor\":\"人物\",\"basis\":\"原文依据\"}],\"knowledge\":[{\"actor\":\"人物\",\"knows\":\"该人物明确知道的内容\",\"basis\":\"原文依据\"}]},\"characterGoals\":[{\"actor\":\"角色名\",\"goal\":\"当前要处理的具体目标或行动\",\"basis\":\"本轮证据或卡片已知事实\",\"limit\":\"不能越过的性格/知情/用户边界\"}],\"characterGuardrails\":[\"防止本轮漂移的具体提醒，最多5条\"],\"userAgency\":{\"mode\":\"strict/limited/full/unspecified\",\"settled\":\"用户本轮已经明确做出的事\",\"open\":\"还没有决定、必须留给用户的部分\"},\"handoff\":\"给用户的自然回应落点，最多160字，不是命令，不是已发生事实\",\"riskFlags\":[\"当前确有依据的冲突、重复、知情越界或授权风险，最多5条\"]}',
    'scene 是可选字段；时间、地点、在场人物和知情范围没有明确证据时不要填，不要用空壳或常识补全。已有上一版的有效字段，若本轮没有新证据则保留，不要用空值覆盖。',
    compact
      ? '兼容模式可只填频道、节奏、上一拍和一名角色；不要添加可见导演板、改写格式或强迫剧情推进。'
      : '完整模式也要保持简短；每个 goal 都写行动和依据，不写抽象权力关系。',
    'lastBeat、continuityCue、scene、userAgency.settled 是事实层；characterGoals、characterGuardrails、handoff、riskFlags 是建议/提醒层。后者不能冒充已发生事实，也不要和事实字段互相抄写。',
  ];
  return '\\n\\n' + schema.join('\\n');
}

export function normalizeDirector(value, previous = null) {
  const old = isObject(previous) ? previous : DIRECTOR_FALLBACK;
  if (!isObject(value)) return { value: clone(old), fallback: true };

  const channel = canonicalChannel(value.channel) || canonicalChannel(old.channel) || '未知';
  const pace = PACE_SET.has(value.pace) ? value.pace : (PACE_SET.has(old.pace) ? old.pace : '停留');
  const lastBeat = textValue(value.lastBeat, 240) || textValue(old.lastBeat, 240) || DIRECTOR_FALLBACK.lastBeat;
  const continuity = normalizeStringList(value.continuityCue, old.continuityCue, 3, 360);
  const goals = normalizeGoalList(value.characterGoals, old.characterGoals);
  const guardrails = normalizeStringList(value.characterGuardrails, old.characterGuardrails, 5, 300);
  const risks = normalizeStringList(value.riskFlags, old.riskFlags, 5, 240);
  const oldUser = isObject(old.userAgency) ? old.userAgency : {};
  const inputUser = isObject(value.userAgency) ? value.userAgency : {};
  const agency = {
    settled: textValue(inputUser.settled, 500) || textValue(oldUser.settled, 500) || '未明',
    open: textValue(inputUser.open, 500) || textValue(oldUser.open, 500) || '把下一步留给用户。',
  };
  const mode = normalizeAgencyMode(inputUser.mode) || normalizeAgencyMode(oldUser.mode);
  if (mode) agency.mode = mode;
  const handoff = textValue(value.handoff, 160) || textValue(old.handoff, 160)
    || '保留一个自然、可回应的现场落点，不替用户作答。';
  const scene = normalizeScene(value.scene, old.scene);
  const result = {
    schema: 2,
    channel,
    pace,
    lastBeat,
    continuityCue: continuity.value,
    characterGoals: goals.value,
    characterGuardrails: guardrails.value,
    userAgency: agency,
    handoff,
    riskFlags: risks.value,
  };
  if (scene) result.scene = scene;

  // A wholly empty or wholly malformed object is not an update. Individual
  // bad/empty properties already fell back to their prior values above, so a
  // good state survives and callers can show a useful fallback warning.
  const agencyUseful = isObject(value.userAgency) && (
    !!textValue(value.userAgency.settled, 500) ||
    !!textValue(value.userAgency.open, 500) ||
    !!normalizeAgencyMode(value.userAgency.mode)
  );
  const sceneUseful = isObject(value.scene) && (
    !!normalizeEvidencePoint(value.scene.time, null) ||
    !!normalizeEvidencePoint(value.scene.location, null) ||
    normalizePresent(value.scene.present, []).length > 0 ||
    normalizeKnowledge(value.scene.knowledge, []).length > 0
  );
  const useful = !!canonicalChannel(value.channel) || PACE_SET.has(value.pace) ||
    !!textValue(value.lastBeat, 240) || continuity.updated || goals.updated ||
    guardrails.updated || risks.updated || agencyUseful || !!textValue(value.handoff, 160) || sceneUseful;
  return useful ? { value: result, fallback: false } : { value: clone(old), fallback: true };
}
