/* 砚台 · 叙事记忆核心确定性引擎（v0.4.2 · 隐藏楼层穿透兼容 & 铁打防丢保险箱） */
const JDMCore = (() => {
  'use strict';
  const VERSION = '0.4.2';
  const DEFAULT_CHAPTER_SPAN = 24;
  const DEFAULT_MAX_AUTO_TRIM = 3;
  const NON_STORY_TYPES = new Set([
    'help', 'welcome', 'empty', 'generic', 'comment',
    'slash_commands', 'formatting', 'hotkeys', 'macros',
    'welcome_prompt', 'assistant_note',
  ]);
  const TENSIONS = ['平稳', '轻松', '紧张', '焦灼', '冲突', '缓和', '未明'];
  const KINDS = ['未完成事项', '约定', '誓言', '任务', '案件', '线索', '悬念'];
  const EVENT_KINDS = ['scene', 'decision', 'clue', 'discovery', 'confrontation', 'consequence', 'transition', 'relationship', 'routine'];
  const IMPORTANCE = ['core', 'active', 'background'];
  const THREAD_STATES = ['open', 'blocked', 'resolved', 'dropped', 'superseded', 'dormant', 'unknown'];

  const clone = value => JSON.parse(JSON.stringify(value));
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  // Two independent 32-bit accumulators for deterministic prefix change detection.
  function hash(value) {
    const text = String(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619);
      b = Math.imul(b, 33) ^ c;
    }
    return `${text.length.toString(36)}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  }

  /**
   * 清洗进入记忆整理的消息正文：
   * 1. 剥离推理思考块（含未闭合残段）、脚本样式与 HTML 注释；
   * 2. 保留 <time>...</time> 内的时空锚点文字；
   * 3. 剥离旧记忆区、装饰顶底栏，以及四选一选项区／场外锐评／小剧场（严防轻量模型把未选备选路线误记为事实）。
   */
  function clean(text, stripCardMemory = true) {
    let result = String(text || '').replace(/\r\n?/g, '\n');
    result = result.replace(/<(think|thinking|analysis|reasoning|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    result = result.replace(/<(?:think|thinking|analysis|reasoning|thought)\b[^>]*>[\s\S]*$/i, '');
    result = result.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    result = result.replace(/<!--[\s\S]*?-->/g, '');
    result = result.replace(/<time\b[^>]*>([\s\S]*?)<\/time\s*>/gi, (_m, inner) => `\n[时间地点] ${String(inner || '').trim()}\n`);
    if (stripCardMemory) {
      result = result.replace(/(?:^|\n)[ \t#*]*(?:IV|Ⅳ|4)\s*[.、．]?\s*他会记得\s*[／/]\s*MEMORY\b[\s\S]*$/i, '');
      result = result.replace(/<(?:(?:[\w-]+):)?(?:memory|long_term_memory|short_term_memory|airp_top|airp_bottom|airp_theater|airp_options|airp_memory|options|choices)\b[^>]*>[\s\S]*?<\/(?:(?:[\w-]+):)?(?:memory|long_term_memory|short_term_memory|airp_top|airp_bottom|airp_theater|airp_options|airp_memory|options|choices)\s*>/gi, '');
      result = result.replace(/<(选项区|备选行动|行动选项|锐评|小剧场|番外小剧场)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
      result = result.replace(/<details\b[^>]*>\s*<summary\b[^>]*>[^<]*(?:记忆区|短期记忆|长期记忆|永久记忆|选项区|行动选项|小剧场|锐评)[\s\S]*?<\/details\s*>/gi, '');
      result = result.replace(/<details\b[^>]*>\s*<summary\b[^>]*>[^<]*(?:记忆区|短期记忆|长期记忆|永久记忆)[\s\S]*$/i, '');
      result = result.replace(/(?:^|\n)[ \t#*]*(?:记忆区|短期记忆|长期记忆|永久记忆|约定\/承诺)\s*[:：][\s\S]*$/i, '');
    }
    return result.replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function isStandaloneDirective(text) {
    const value = String(text || '').trim();
    if (!/^\$\s*/.test(value)) return false;
    const mode = /(?:暂停(?:当前)?剧情|番外|外传|平行世界|梦境线|小剧场|独立篇|采访篇|\bif(?:线|篇)?\b)/i.test(value);
    const action = /(?:生成|写|开启|进入|切换|在此条|本条|不计入记忆|暂停)/i.test(value);
    return mode && action;
  }

  /**
   * 区分「真正的酒馆非剧情系统消息」（欢迎卡片、/comment 场外备注、工具调用等）
   * 与「被玩家 /hide 隐藏的正常对话楼层」（酒馆 /hide 仅将 m.is_system 设为 true）。
   * 被 /hide 隐藏的 User / 角色剧情楼层一律视为有效剧情消息，保证隐藏楼层不丢记忆、可读可归档。
   */
  function isNonStoryMessage(m) {
    if (!m || typeof m.mes !== 'string' || !m.mes.trim()) return true;
    if (m.is_user) return false;
    const extra = m.extra;
    if (extra && typeof extra === 'object') {
      if (extra.uses_system_ui || extra.isSmallSys) return true;
      if (extra.type && NON_STORY_TYPES.has(String(extra.type))) return true;
      if (Array.isArray(extra.tool_invocations) && extra.tool_invocations.length > 0) return true;
      if (Array.isArray(extra.tool_calls) && extra.tool_calls.length > 0) return true;
    }
    if (m.is_system && (m.name === 'System' || m.force_avatar === 'img/five.png' || m.force_avatar === 'system') && extra?.type !== 'narrator') {
      return true;
    }
    return false;
  }

  function roundsFrom(messages, stripCardMemory = true) {
    const rounds = [];
    let prelude = [], current = null;
    const finish = () => {
      if (!current || !current.some(m => m.role === 'assistant')) return;
      const all = rounds.length === 0 ? [...prelude, ...current] : current;
      const source = all.map(m => ({ id: m.id, hash: hash(JSON.stringify([m.role, m.name, m.raw])) }));
      const cleanedMessages = all.map(m => ({ id: m.id, role: m.role, name: m.name, text: clean(m.raw, stripCardMemory) }));
      rounds.push({
        round: rounds.length + 1,
        source,
        signature: hash(JSON.stringify(source)),
        standalone: isStandaloneDirective(cleanedMessages.find(m => m.role === 'user')?.text),
        messages: cleanedMessages,
      });
      prelude = [];
      current = null;
    };
    (messages || []).forEach((m, id) => {
      if (isNonStoryMessage(m)) return;
      const message = { id, role: m.is_user ? 'user' : 'assistant', name: String(m.name || ''), raw: m.mes };
      if (message.role === 'user') {
        if (current?.some(x => x.role === 'assistant')) finish();
        if (!current) current = [];
        current.push(message);
      } else if (current) current.push(message);
      else prelude.push(message);
    });
    finish();
    return rounds;
  }

  function emptyState(owner) {
    return {
      schema: 1,
      version: VERSION,
      owner,
      revision: '',
      enabled: false,
      history: [],
      note: '',
      pausedByUser: false,
      lastError: '',
      compact: null,
      holdMismatch: false,
      vault: null,
      createdAt: new Date().toISOString(),
    };
  }

  function emptyMemory() {
    return {
      through: 0,
      skipped: 0,
      events: [],
      chapters: [],
      openChapter: null,
      summary: '',
      threads: [],
      scene: null,
      suggestions: [],
      compact: null,
    };
  }

  const optionalString = (value, max = 2000) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';
  const stringList = (value, maxItems = 8, maxChars = 500) => Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, maxItems).map(item => item.trim().slice(0, maxChars))
    : [];

  function requireString(value, field, max = 30000, empty = false) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) {
      throw new Error(`记忆返回格式不完整：${field} 应为${empty ? '' : '非空'}文本。旧记忆未修改。`);
    }
    return value.trim();
  }

  function distillKnowledgeClause(knows = '') {
    const text = String(knows || '').trim();
    if (text.length <= 120) return text;
    const clauses = text.split(/[；;。]/).map(s => s.trim()).filter(Boolean);
    const asymmetric = clauses.filter(s => /(?:仍不知|不知情|尚未|未告知|隐瞒|私下|暗中|盘算|后台|怀疑|提级|冻结|录入了|挡回|误以为|误认)/.test(s));
    if (asymmetric.length) return asymmetric.join('；').slice(0, 150);
    return `${text.slice(0, 118)}…`;
  }

  /**
   * 兼容提取轻量客观现场锚点（同时支持 0.4+ 新 scene 与 0.3.x 旧 director.scene）。
   */
  function normalizeScene(rawScene, previousScene = null) {
    if (!isObject(rawScene)) return previousScene ? clone(previousScene) : null;
    const time = typeof rawScene.time === 'string'
      ? optionalString(rawScene.time, 300)
      : optionalString(rawScene.time?.value, 300);
    const location = typeof rawScene.location === 'string'
      ? optionalString(rawScene.location, 400)
      : optionalString(rawScene.location?.value || rawScene.place, 400);

    let present = [];
    if (Array.isArray(rawScene.present)) {
      present = rawScene.present
        .map(item => (typeof item === 'string' ? item.trim() : optionalString(item?.actor || item?.name, 100)))
        .filter(Boolean)
        .slice(0, 10);
    }

    let secrets = [];
    if (Array.isArray(rawScene.secrets)) {
      secrets = stringList(rawScene.secrets, 6, 260);
    } else if (Array.isArray(rawScene.knowledge)) {
      secrets = rawScene.knowledge
        .map(k => {
          if (typeof k === 'string') return k.trim().slice(0, 240);
          if (k?.actor && k?.knows) return `${String(k.actor).trim()}：${distillKnowledgeClause(k.knows)}`;
          return '';
        })
        .filter(Boolean)
        .slice(0, 5);
    }

    const merged = {
      time: time || previousScene?.time || '',
      location: location || previousScene?.location || '',
      present: present.length ? present : (previousScene?.present ? [...previousScene.present] : []),
      secrets: secrets.length ? secrets : [],
    };
    if (!merged.time && !merged.location && !merged.present.length && !merged.secrets.length) {
      return previousScene ? clone(previousScene) : null;
    }
    return merged;
  }

  function composeChronicle(chapters = [], openChapter = null) {
    const blocks = [];
    for (const ch of chapters) {
      if (!ch?.summary) continue;
      if (ch.legacyBase && /^【/.test(ch.summary.trim())) {
        blocks.push(ch.summary.trim());
      } else if (ch.legacyBase) {
        blocks.push(`【前情卷宗（第1—${ch.toRound}轮）】\n${ch.summary.trim()}`);
      } else {
        const titleSuffix = ch.title ? `：${ch.title}` : '';
        blocks.push(`【第${ch.index}卷（第${ch.fromRound}—${ch.toRound}轮）${titleSuffix}】\n${ch.summary.trim()}`);
      }
    }
    if (openChapter?.summary) {
      const titleSuffix = openChapter.title ? `：${openChapter.title}` : '';
      const range = openChapter.fromRound && openChapter.toRound && openChapter.toRound >= openChapter.fromRound
        ? `（第${openChapter.fromRound}—${openChapter.toRound}轮）`
        : '';
      blocks.push(`【当前阶段${range}${titleSuffix}】\n${openChapter.summary.trim()}`);
    }
    return blocks.join('\n\n').trim();
  }

  function materialize(state) {
    const memory = emptyMemory();
    let legacySummary = '';
    let legacyThrough = 0;

    for (const batch of state.history) {
      if (batch.skip) {
        memory.through += batch.sources.length;
        memory.skipped += batch.sources.length;
        continue;
      }
      for (const row of batch.delta.events) memory.events.push(clone(row));
      for (const correction of batch.delta.corrections) {
        const index = memory.events.findIndex(row => row.round === correction.round);
        if (index >= 0) memory.events[index] = clone(correction.replacement);
      }
      for (const row of batch.delta.threads.upsert) {
        const index = memory.threads.findIndex(t => t.id === row.id);
        if (index >= 0) memory.threads[index] = clone(row);
        else memory.threads.push(clone(row));
      }
      for (const item of batch.delta.threads.resolve) {
        const index = memory.threads.findIndex(t => t.id === item.id);
        if (index >= 0) {
          if (['约定', '誓言'].includes(memory.threads[index].kind)) {
            memory.threads[index] = {
              ...memory.threads[index],
              state: 'resolved',
              importance: 'background',
              status: item.reason || '已履行／翻篇',
            };
          } else {
            memory.threads.splice(index, 1);
          }
        }
      }

      if (batch.delta.scene) {
        memory.scene = normalizeScene(batch.delta.scene, memory.scene);
      } else if (batch.delta.director?.scene) {
        memory.scene = normalizeScene(batch.delta.director.scene, memory.scene);
      }

      if (batch.delta.chapterMode) {
        if (legacySummary && legacyThrough > 0 && memory.chapters.length === 0) {
          memory.chapters.push({
            index: 1,
            fromRound: 1,
            toRound: legacyThrough,
            title: '前情卷宗',
            summary: legacySummary,
            legacyBase: true,
          });
          legacySummary = '';
        }
        memory.through += batch.sources.length;
        if (Array.isArray(batch.delta.replaceChapters)) {
          memory.chapters = clone(batch.delta.replaceChapters);
          memory.openChapter = batch.delta.openChapter ? clone(batch.delta.openChapter) : null;
        } else if (batch.delta.sealedChapter) {
          memory.chapters.push(clone(batch.delta.sealedChapter));
          memory.openChapter = null;
        } else if (typeof batch.delta.chapterSummary === 'string' && batch.delta.chapterSummary.trim()) {
          const lastSealedEnd = memory.chapters.at(-1)?.toRound || 0;
          const fromRound = Number.isInteger(batch.delta.chapterFromRound) && batch.delta.chapterFromRound > 0
            ? batch.delta.chapterFromRound
            : (memory.openChapter?.fromRound || (lastSealedEnd + 1));
          memory.openChapter = {
            fromRound,
            toRound: Math.max(fromRound, memory.through),
            title: optionalString(batch.delta.chapterTitle, 80) || memory.openChapter?.title || '',
            summary: batch.delta.chapterSummary.trim(),
          };
        }
        memory.summary = composeChronicle(memory.chapters, memory.openChapter) || batch.delta.summary || memory.summary;
      } else {
        memory.through += batch.sources.length;
        memory.chapters = [];
        memory.openChapter = null;
        memory.summary = batch.delta.summary || memory.summary;
        legacySummary = memory.summary;
        legacyThrough = memory.through;
      }
      memory.suggestions = [];
    }

    if (state.compact && Number.isInteger(state.compact.through) && state.compact.through > 0 && state.compact.through <= memory.through && state.compact.summary) {
      memory.compact = clone(state.compact);
    }
    return memory;
  }

  function normalizeEventKind(value) {
    const key = optionalString(value, 40).toLowerCase();
    const aliases = { 场景: 'scene', 场面: 'scene', 决定: 'decision', 线索: 'clue', 发现: 'discovery', 对峙: 'confrontation', 后果: 'consequence', 转场: 'transition', 关系: 'relationship', 日常: 'routine' };
    return EVENT_KINDS.includes(key) ? key : aliases[optionalString(value, 40)] || 'scene';
  }

  function normalizeImportance(value, fallback = 'active') {
    const raw = optionalString(value, 30);
    const key = raw.toLowerCase();
    if (key === 'routine' || raw === '日常' || raw === '过渡') return 'background';
    const aliases = { 核心: 'core', 锚点: 'core', 关键: 'core', 里程碑: 'core', 重要: 'active', 活跃: 'active', 背景: 'background', 普通: 'background' };
    return IMPORTANCE.includes(key) ? key : aliases[raw] || fallback;
  }

  function normalizeTensionList(value) {
    if (!Array.isArray(value) || !value.length) return ['平稳'];
    const mapWord = word => {
      const w = optionalString(word, 20);
      if (TENSIONS.includes(w)) return w;
      if (/冲突|争执|对抗|爆发|撕破/.test(w)) return '冲突';
      if (/焦灼|危急|紧迫|高压/.test(w)) return '焦灼';
      if (/紧张|试探|警惕|压抑|危机/.test(w)) return '紧张';
      if (/轻松|愉快|甜蜜|温情|暧昧|调情/.test(w)) return '轻松';
      if (/缓和|安抚|软化|和解/.test(w)) return '缓和';
      if (/未明|未知/.test(w)) return '未明';
      return '平稳';
    };
    const mapped = [...new Set(value.map(mapWord).filter(Boolean))].slice(0, 2);
    return mapped.length ? mapped : ['平稳'];
  }

  function normalizeItem(rawItem) {
    if (rawItem == null || rawItem === false) return null;
    if (typeof rawItem === 'string') {
      const cleaned = rawItem.trim();
      if (!cleaned || /^(?:无|无新增|none|null|—|-)$/i.test(cleaned)) return null;
      return { name: cleaned.slice(0, 600), reason: '本轮关键物品／状态记录' };
    }
    if (!isObject(rawItem)) return null;
    const name = optionalString(rawItem.name || rawItem.item || rawItem.title, 600);
    if (!name || /^(?:无|无新增|none|null|—|-)$/i.test(name)) return null;
    const reason = optionalString(rawItem.reason || rawItem.status || rawItem.detail || rawItem.description, 1200) || '关键物品／归属状态';
    return { name, reason };
  }

  function normalizeThreadState(value, status = '') {
    const key = optionalString(value, 30).toLowerCase();
    if (THREAD_STATES.includes(key)) return key;
    const text = `${key} ${optionalString(status, 200)}`;
    if (/完成|履行|已解决|解决|结案|成功|达成|翻篇/.test(text)) return 'resolved';
    if (/取消|放弃|失效|撤回/.test(text)) return 'dropped';
    if (/替代|取代/.test(text)) return 'superseded';
    if (/阻塞|卡住|等待/.test(text)) return 'blocked';
    if (/休眠|暂存|背景/.test(text)) return 'dormant';
    return 'open';
  }

  function activeThread(thread) {
    if (!thread) return false;
    const state = normalizeThreadState(thread.state, thread.status);
    return !['resolved', 'dropped', 'superseded'].includes(state)
      && normalizeImportance(thread.importance, 'active') !== 'background';
  }

  function normalizeEvent(value, fallbackRound = null) {
    if (!isObject(value)) throw new Error('逐轮记录格式不正确。');
    const round = Number.isInteger(value.round) ? value.round : fallbackRound;
    if (!Number.isInteger(round) || round < 1) throw new Error('逐轮记录缺少正确轮次。');
    const rawDesc = optionalString(value.description || value.summary, 4000)
      || [optionalString(value.action, 1200), optionalString(value.result, 1200)].filter(Boolean).join('，');
    const description = requireString(rawDesc, `第${round}轮事件描述`, 4000);
    const rawKind = optionalString(value.importance, 30).toLowerCase() === 'routine' && !value.kind ? 'routine' : value.kind;
    return {
      round,
      time: optionalString(value.time, 300) || '未明',
      place: optionalString(value.place || value.location, 500) || '未明',
      description,
      item: normalizeItem(value.item),
      tension: normalizeTensionList(value.tension),
      eventId: optionalString(value.eventId || value.id, 160) || `e-${round}`,
      kind: normalizeEventKind(rawKind),
      importance: normalizeImportance(value.importance, 'active'),
      actors: stringList(value.actors, 8, 120),
      action: optionalString(value.action, 1200),
      cause: optionalString(value.cause, 1200),
      result: optionalString(value.result, 1200),
      consequences: stringList(value.consequences, 8, 800),
      evidenceRefs: stringList(value.evidenceRefs || value.evidence, 8, 240),
      dependsOn: stringList(value.dependsOn || value.causedBy, 8, 160),
    };
  }

  function normalizeKind(rawKind, priorKind = '') {
    if (priorKind && KINDS.includes(priorKind)) return priorKind;
    const k = optionalString(rawKind, 40);
    if (KINDS.includes(k)) return k;
    if (/誓|承诺/.test(k)) return '誓言';
    if (/约|契约|协议|规矩/.test(k)) return '约定';
    if (/案|调查/.test(k)) return '案件';
    if (/线索|证据|暗线|秘密/.test(k)) return '线索';
    if (/悬念|伏笔|危机|隐患/.test(k)) return '悬念';
    if (/任务|目标|计划/.test(k)) return '任务';
    return '未完成事项';
  }

  function normalizeThread(value, prior, id, batchId, index) {
    const kind = normalizeKind(value.kind, prior?.kind);
    const content = optionalString(value.content ?? value.known ?? value.title ?? prior?.content, 5000);
    if (!content) throw new Error('事项缺少有效内容。');
    const status = optionalString(value.status ?? prior?.status, 2000) || '进行中';
    const peopleRaw = value.people ?? prior?.people;
    const people = Array.isArray(peopleRaw)
      ? peopleRaw.filter(Boolean).join('、') || '未指明'
      : (optionalString(peopleRaw, 1500) || '未指明');
    const result = {
      id: prior ? prior.id : (/^(?:t-|new-)/.test(id) ? `t-${batchId}-${index + 1}` : `t-${batchId}-${index + 1}`),
      kind,
      at: optionalString(prior?.at || value.at, 300) || '剧情记录',
      people,
      content,
      due: optionalString(value.due ?? prior?.due, 1200) || '未说明',
      status,
      state: normalizeThreadState(value.state ?? prior?.state, status),
      importance: normalizeImportance(value.importance ?? prior?.importance, prior?.importance || 'active'),
      title: optionalString(value.title ?? prior?.title, 300) || content.slice(0, 60),
      known: optionalString(value.known ?? prior?.known, 1800),
      unknown: optionalString(value.unknown ?? prior?.unknown, 1800),
      nextEvidence: optionalString(value.nextEvidence ?? prior?.nextEvidence, 1200),
      lastTouchedRound: Number.isInteger(value.lastTouchedRound)
        ? value.lastTouchedRound
        : (Number.isInteger(prior?.lastTouchedRound) ? prior.lastTouchedRound : null),
      relatedEventIds: stringList(value.relatedEventIds ?? value.evidence ?? prior?.relatedEventIds, 12, 160),
    };
    // Preserve stable ID when restoring persisted batches from disk.
    if (!prior && batchId === 'restore' && id) result.id = id;
    return result;
  }

  /**
   * 去除 JSON 字符串外部的尾随逗号（轻量模型最常见格式瑕疵）。
   */
  function stripTrailingJsonCommas(input) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === ',') {
        let j = i + 1;
        while (j < input.length && /\s/.test(input[j])) j++;
        if (input[j] === '}' || input[j] === ']') continue;
      }
      out += ch;
    }
    return out;
  }

  function extractBalancedJsonObject(text) {
    const start = text.indexOf('{');
    if (start < 0) return '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  function parseResponse(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 500000) {
      throw new Error('记忆回复为空或过大。');
    }
    const hadThink = /<(?:think|thinking|analysis|reasoning|thought)\b/i.test(raw);
    let text = raw
      .trim()
      .replace(/<(think|thinking|analysis|reasoning|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(?:think|thinking|analysis|reasoning|thought)\b[^>]*>[\s\S]*$/i, '')
      .trim();

    if (!text && hadThink) {
      throw new Error('推理思考占满了输出长度上限，未生成记忆 JSON。建议换用非推理轻量模型，或在配置中调大“最大输出 Token”。');
    }

    const candidates = [text];
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence?.[1]) candidates.push(fence[1].trim());
    const balanced = extractBalancedJsonObject(text);
    if (balanced) candidates.push(balanced);

    for (const candidate of candidates) {
      if (!candidate) continue;
      try { return JSON.parse(candidate); } catch { /* try repaired */ }
      try { return JSON.parse(stripTrailingJsonCommas(candidate)); } catch { /* next */ }
    }
    throw new Error('模型没有返回完整 JSON。已保留旧记忆；可检查轻量模型连接或调大最大输出长度后重试。');
  }

  /**
   * 确定性提取跨百轮长线锚点（关键物品最新状态 + 早期核心里程碑 + 长期誓言约定），
   * 保证哪怕到 300 轮以后，第 3 轮戴上的信物或立下的铁律也不会因事件滑窗而遗忘。
   */
  function extractLongTermAnchors(memory, cutoffRound = Infinity, excludeEventIds = new Set()) {
    const allEvents = Array.isArray(memory?.events) ? memory.events : [];
    const eligible = cutoffRound < Infinity ? allEvents.filter(r => r.round <= cutoffRound) : allEvents;

    const itemMap = new Map();
    for (const row of eligible) {
      if (!row?.item?.name) continue;
      const normKey = row.item.name.toLowerCase().replace(/[\s·—\-()（）【】「」"'《》，,。]/g, '').slice(0, 48);
      if (!normKey) continue;
      const existing = itemMap.get(normKey);
      itemMap.set(normKey, {
        name: row.item.name,
        reason: row.item.reason,
        firstRound: existing ? existing.firstRound : row.round,
        round: row.round,
        importance: row.importance === 'core' || existing?.importance === 'core' ? 'core' : (row.importance || 'active'),
      });
    }
    const items = [...itemMap.values()]
      .sort((a, b) => (a.importance === 'core' ? -1 : 1) - (b.importance === 'core' ? -1 : 1) || (b.round - a.round))
      .slice(0, 16)
      .sort((a, b) => a.firstRound - b.firstRound);

    const minMilestoneCutoff = Number.isFinite(cutoffRound) ? Math.max(0, cutoffRound - 18) : Math.max(0, allEvents.length - 18);
    const corePool = eligible.filter(r =>
      r.importance === 'core' &&
      r.round <= minMilestoneCutoff &&
      !excludeEventIds.has(r.eventId || `e-${r.round}`),
    );
    let milestones = corePool;
    if (corePool.length > 6) {
      const picked = new Set();
      const step = (corePool.length - 1) / 5;
      for (let i = 0; i < 6; i++) picked.add(corePool[Math.round(i * step)]);
      milestones = [...picked];
    }

    const standingVows = (Array.isArray(memory?.threads) ? memory.threads : [])
      .filter(t => activeThread(t) && ['约定', '誓言'].includes(t.kind))
      .slice(0, 8)
      .map(threadForPrompt);

    return { items, milestones: milestones.map(eventForPrompt), standingVows };
  }

  function eventForPrompt(row) {
    const value = {
      eventId: row.eventId || `legacy-round-${row.round}`,
      round: row.round,
      time: row.time,
      place: row.place,
      kind: row.kind || 'scene',
      importance: row.importance || 'active',
      actors: row.actors || [],
      action: row.action || '',
      cause: row.cause || '',
      result: row.result || '',
      consequences: row.consequences || [],
      evidenceRefs: row.evidenceRefs || [],
      dependsOn: row.dependsOn || [],
      description: row.description,
    };
    if (row.item) value.item = clone(row.item);
    return value;
  }

  function threadForPrompt(thread) {
    return {
      id: thread.id,
      kind: thread.kind,
      title: thread.title || thread.content,
      people: thread.people,
      content: thread.content,
      due: thread.due,
      status: thread.status,
      state: normalizeThreadState(thread.state, thread.status),
      importance: normalizeImportance(thread.importance, 'active'),
      known: thread.known || '',
      unknown: thread.unknown || '',
      nextEvidence: thread.nextEvidence || '',
      lastTouchedRound: thread.lastTouchedRound || null,
      relatedEventIds: thread.relatedEventIds || [],
    };
  }

  function projectForPrompt(memory, budget = {}) {
    const recentLimit = Math.max(3, Math.min(16, Number(budget.recentEvents) || 10));
    const threadLimit = Math.max(4, Math.min(24, Number(budget.maxThreads) || 12));
    const allEvents = Array.isArray(memory?.events) ? memory.events : [];
    const omitRecent = Math.max(0, Number(budget.omitRecentRounds) || 0);
    const cutoffRound = (omitRecent > 0 && (Number(memory?.through) || 0) > omitRecent)
      ? (Number(memory.through) - omitRecent)
      : Infinity;
    const pool = cutoffRound < Infinity ? allEvents.filter(row => row.round <= cutoffRound) : allEvents;
    const selected = new Map();
    pool.slice(-recentLimit).forEach(row => selected.set(row.eventId || `legacy-round-${row.round}`, row));

    // Preserve secret off-screen consequences from the omitted recent rounds so hidden asymmetry isn't lost.
    if (cutoffRound < Infinity) {
      allEvents
        .filter(row => row.round > cutoffRound && Array.isArray(row.consequences) && row.consequences.length > 0)
        .slice(-3)
        .forEach(row => selected.set(row.eventId || `legacy-round-${row.round}`, row));
    }

    const projectedEvents = [...selected.values()].sort((a, b) => a.round - b.round).map(eventForPrompt);
    const selectedIds = new Set(projectedEvents.map(e => e.eventId));
    const anchors = extractLongTermAnchors(memory, cutoffRound, selectedIds);

    const activeThreadsAll = (Array.isArray(memory?.threads) ? memory.threads : []).filter(activeThread);
    const rank = { core: 0, active: 1, background: 2 };
    const sortedThreads = activeThreadsAll
      .sort((a, b) => (rank[normalizeImportance(a.importance)] - rank[normalizeImportance(b.importance)]) || ((b.lastTouchedRound || 0) - (a.lastTouchedRound || 0)))
      .slice(0, threadLimit)
      .map(threadForPrompt);

    const activeSummary = (memory?.compact && memory.compact.through === memory.through && memory.compact.summary)
      ? memory.compact.summary
      : (memory?.summary || '');

    return {
      through: Number(memory?.through) || 0,
      skipped: Number(memory?.skipped) || 0,
      summary: String(activeSummary),
      chapters: Array.isArray(memory?.chapters) ? clone(memory.chapters) : [],
      openChapter: memory?.openChapter ? clone(memory.openChapter) : null,
      scene: memory?.scene ? clone(memory.scene) : null,
      anchors,
      events: projectedEvents,
      threads: sortedThreads,
      projection: { recentEvents: recentLimit, maxThreads: threadLimit, archivedHidden: true },
    };
  }

  function reconcile(state, rounds) {
    let kept = 0, cursor = 0;
    for (const batch of state.history) {
      if (!batch.sources.every((signature, index) => rounds[cursor + index]?.signature === signature)) break;
      if (batch.prefix !== hash(JSON.stringify(rounds.slice(0, cursor + batch.sources.length).map(r => r.signature)))) break;
      cursor += batch.sources.length;
      kept++;
    }
    if (kept === state.history.length && (!state.compact || state.compact.through <= cursor)) {
      return { state, changed: false, removed: 0 };
    }
    const next = { ...clone(state), history: state.history.slice(0, kept) };
    if (next.compact && next.compact.through > cursor) next.compact = null;
    return { state: next, changed: true, removed: materialize(state).through - cursor };
  }

  /**
   * 前文编辑／错别字修改／切换某楼 swipe 但总轮数未减少时，重新锚定批次签名，一轮记忆都不删除。
   */
  function reanchorState(state, rounds) {
    const through = materialize(state).through;
    if (!Array.isArray(rounds) || rounds.length < through) return clone(state);
    let cursor = 0;
    const nextHistory = state.history.map(batch => {
      const len = batch.sources.length;
      const nextSources = rounds.slice(cursor, cursor + len).map(r => r.signature);
      const nextPrefix = hash(JSON.stringify(rounds.slice(0, cursor + len).map(r => r.signature)));
      cursor += len;
      return { ...clone(batch), sources: nextSources, prefix: nextPrefix };
    });
    return { ...clone(state), history: nextHistory, holdMismatch: false };
  }

  /**
   * 精确裁剪并重锚定至指定轮数（targetCount < through），支持单批跨多轮时的批次内保留，绝不连坐整批清零。
   */
  function trimStateToRounds(state, rounds) {
    const targetCount = Array.isArray(rounds) ? rounds.length : 0;
    const oldThrough = materialize(state).through;
    if (targetCount >= oldThrough) return reanchorState(state, rounds);
    if (targetCount <= 0) {
      return { ...clone(state), history: [], compact: null, holdMismatch: false };
    }

    let cursor = 0;
    const nextHistory = [];
    for (const batch of state.history) {
      const len = batch.sources.length;
      if (len === 0) {
        if (cursor <= targetCount) {
          const nextPrefix = hash(JSON.stringify(rounds.slice(0, cursor).map(r => r.signature)));
          const copy = { ...clone(batch), prefix: nextPrefix };
          if (Array.isArray(copy.delta?.replaceChapters)) {
            copy.delta.replaceChapters = copy.delta.replaceChapters
              .filter(ch => (Number(ch.fromRound) || 1) <= targetCount)
              .map((ch, idx) => ({ ...ch, index: idx + 1, toRound: Math.min(Number(ch.toRound) || targetCount, targetCount) }));
            copy.delta.summary = composeChronicle(copy.delta.replaceChapters, copy.delta.openChapter) || copy.delta.summary;
          }
          nextHistory.push(copy);
        }
        continue;
      }
      if (cursor + len <= targetCount) {
        const nextSources = rounds.slice(cursor, cursor + len).map(r => r.signature);
        const nextPrefix = hash(JSON.stringify(rounds.slice(0, cursor + len).map(r => r.signature)));
        nextHistory.push({ ...clone(batch), sources: nextSources, prefix: nextPrefix });
        cursor += len;
        continue;
      }
      if (cursor < targetCount) {
        const nextSources = rounds.slice(cursor, targetCount).map(r => r.signature);
        const nextPrefix = hash(JSON.stringify(rounds.slice(0, targetCount).map(r => r.signature)));
        if (batch.skip) {
          nextHistory.push({ ...clone(batch), sources: nextSources, prefix: nextPrefix });
        } else {
          const nextDelta = clone(batch.delta);
          nextDelta.events = (nextDelta.events || []).filter(e => e.round <= targetCount);
          nextDelta.corrections = (nextDelta.corrections || []).filter(c => c.round <= targetCount);
          if (nextDelta.sealedChapter) {
            const sc = nextDelta.sealedChapter;
            delete nextDelta.sealedChapter;
            nextDelta.chapterMode = true;
            nextDelta.chapterFromRound = sc.fromRound;
            nextDelta.chapterTitle = sc.title || '';
            nextDelta.chapterSummary = sc.summary || '';
          }
          nextHistory.push({ ...clone(batch), sources: nextSources, prefix: nextPrefix, delta: nextDelta });
        }
        cursor = targetCount;
      }
      break;
    }

    const nextCompact = state.compact && state.compact.through <= targetCount ? clone(state.compact) : null;
    return { ...clone(state), history: nextHistory, compact: nextCompact, holdMismatch: false };
  }

  /**
   * 内部保险箱快照：始终保留更高轮数的历史完整记忆（0 Token 占用），防止连续回退冲掉最初完整备份。
   */
  function captureVault(existingVault, prevState, reason = '剧情回退前自动存档') {
    const prevThrough = materialize(prevState).through;
    if (prevThrough <= 0) return existingVault ? clone(existingVault) : null;
    if (existingVault && Number(existingVault.through) > prevThrough && Array.isArray(existingVault.history) && existingVault.history.length > 0) {
      return clone(existingVault);
    }
    return {
      through: prevThrough,
      history: clone(prevState.history),
      compact: prevState.compact ? clone(prevState.compact) : null,
      at: new Date().toISOString(),
      reason: String(reason || '剧情回退前自动存档').slice(0, 120),
    };
  }

  /**
   * 铁打不丢对齐策略：
   * 1. 完全一致 -> 若此前处于保护锁定态则自动解锁；
   * 2. 轮数未少（>= oldThrough），仅前文改字／修错别字／切换 swipe -> 自动重锚定签名，0 轮丢失；
   * 3. 尾部小幅删楼悔棋（减少 1—3 轮且聊天非空） -> 精确裁剪至当前轮数，并将完整旧版自动存入 vault 保险箱；
   * 4. 大幅减少（> 3 轮）或聊天突变为 0 轮 -> 触发防清零保护锁（holdMismatch=true），原世界书记忆一字不删！
   */
  function smartReconcile(state, rounds, options = {}) {
    const maxAutoTrim = Number.isInteger(options.maxAutoTrim) ? options.maxAutoTrim : DEFAULT_MAX_AUTO_TRIM;
    const oldThrough = materialize(state).through;
    const newCount = Array.isArray(rounds) ? rounds.length : 0;

    if (oldThrough === 0) {
      if (state.holdMismatch) {
        return { state: { ...clone(state), holdMismatch: false }, changed: true, action: 'unheld', removed: 0, oldThrough: 0, newThrough: 0 };
      }
      return { state, changed: false, action: 'none', removed: 0, oldThrough: 0, newThrough: 0 };
    }

    const exact = reconcile(state, rounds);
    if (!exact.changed) {
      if (state.holdMismatch) {
        return { state: { ...clone(state), holdMismatch: false }, changed: true, action: 'unheld', removed: 0, oldThrough, newThrough: oldThrough };
      }
      return { state, changed: false, action: 'none', removed: 0, oldThrough, newThrough: oldThrough };
    }

    if (newCount >= oldThrough) {
      const reanchored = reanchorState(state, rounds);
      return {
        state: reanchored,
        changed: true,
        action: 'reanchored',
        removed: 0,
        oldThrough,
        newThrough: oldThrough,
      };
    }

    const drop = oldThrough - newCount;
    if (newCount > 0 && drop <= maxAutoTrim) {
      const vault = captureVault(state.vault, state, `删楼回退前备份（共 ${oldThrough} 轮）`);
      const trimmed = { ...trimStateToRounds(state, rounds), vault };
      const afterThrough = materialize(trimmed).through;
      return {
        state: trimmed,
        changed: true,
        action: 'trimmed',
        removed: oldThrough - afterThrough,
        oldThrough,
        newThrough: afterThrough,
      };
    }

    const vault = captureVault(state.vault, state, `大幅变动保护备份（共 ${oldThrough} 轮）`);
    const vaultUpdated = JSON.stringify(vault?.history || null) !== JSON.stringify(state.vault?.history || null);
    if (state.holdMismatch && !vaultUpdated) {
      return { state, changed: false, action: 'held', removed: 0, oldThrough, newThrough: oldThrough };
    }
    return {
      state: { ...clone(state), holdMismatch: true, vault },
      changed: true,
      action: 'held',
      removed: 0,
      oldThrough,
      newThrough: oldThrough,
    };
  }

  /**
   * 玩家主动点击“确认按当前聊天轮数对齐”：将原记忆存入保险箱后裁剪至当前轮数。
   */
  function confirmAlignState(state, rounds) {
    const oldThrough = materialize(state).through;
    const vault = captureVault(state.vault, state, `手动对齐前备份（共 ${oldThrough} 轮）`);
    return { ...trimStateToRounds(state, rounds), vault, holdMismatch: false };
  }

  /**
   * 从内部保险箱一键无损恢复完整历史记忆（0 次模型请求）。
   */
  function restoreFromVault(state, rounds) {
    if (!state?.vault || !Array.isArray(state.vault.history) || !state.vault.history.length) {
      throw new Error('保险箱中暂无可恢复的更高进度记忆备份。');
    }
    const candidate = {
      ...clone(state),
      history: clone(state.vault.history),
      compact: state.vault.compact ? clone(state.vault.compact) : null,
      holdMismatch: false,
      pausedByUser: false,
      lastError: '',
    };
    const vaultThrough = materialize(candidate).through;
    const newCount = Array.isArray(rounds) ? rounds.length : 0;
    if (newCount >= vaultThrough) {
      return reanchorState(candidate, rounds);
    }
    return { ...candidate, holdMismatch: true };
  }

  function validateDelta(raw, old, expectedRounds, batchId = uid(), options = {}) {
    const value = typeof raw === 'string' ? parseResponse(raw) : raw;
    if (!isObject(value)) throw new Error('记忆返回必须是一个对象。');
    if (!Array.isArray(value.events) || value.events.length !== expectedRounds.length) {
      throw new Error(`新增记录数量（${Array.isArray(value.events) ? value.events.length : 0}）与待整理轮数（${expectedRounds.length}）不一致，未保存。`);
    }
    const events = value.events.map((row, i) => normalizeEvent(row, expectedRounds.length === 1 && row?.round == null ? expectedRounds[0] : null));
    events.forEach((row, i) => {
      if (row.round !== expectedRounds[i]) throw new Error('新增轮次有遗漏、重复或错序，未保存。');
    });

    const corrections = value.corrections ?? [];
    if (!Array.isArray(corrections) || corrections.length > (old.events?.length || 0)) {
      throw new Error('旧记录修订格式有误。');
    }
    const corrected = new Set();
    const normalizedCorrections = corrections.flatMap(c => {
      if (!isObject(c) || !Number.isInteger(c.round) || !old.events.some(r => r.round === c.round) || corrected.has(c.round)) {
        if (batchId === 'restore') throw new Error('修订指向不存在或重复的旧轮次。');
        return [];
      }
      corrected.add(c.round);
      const replacement = normalizeEvent(c.replacement, c.round);
      if (replacement.round !== c.round) return [];
      return [{ round: c.round, reason: optionalString(c.reason, 2000) || '依据后续剧情修订', replacement }];
    });

    // Thread normalization with graceful self-healing for lightweight models
    const rawThreads = isObject(value.threads) ? value.threads : { upsert: [], resolve: [] };
    const rawUpsert = Array.isArray(rawThreads.upsert) ? rawThreads.upsert : [];
    const rawResolve = Array.isArray(rawThreads.resolve) ? rawThreads.resolve : [];
    if (rawUpsert.length + rawResolve.length > 1000) throw new Error('单次事项更新过多，未保存。');

    const upsertMap = new Map();
    rawUpsert.forEach((t, index) => {
      if (!isObject(t)) return;
      const rawId = optionalString(t.id, 200) || `new-${index + 1}`;
      const prior = (old.threads || []).find(x => x.id === rawId);
      try {
        const normalized = normalizeThread(t, prior, rawId, batchId, index);
        const mapKey = prior ? prior.id : rawId;
        upsertMap.set(mapKey, normalized);
      } catch (err) {
        if (batchId === 'restore') throw err;
      }
    });

    const resolveList = [];
    rawResolve.forEach(item => {
      if (!isObject(item) && typeof item !== 'string') return;
      const id = typeof item === 'string' ? item.trim() : optionalString(item.id, 200);
      const reason = typeof item === 'string' ? '已完成／结案' : (optionalString(item.reason, 2000) || '已完成／结案');
      if (!id || upsertMap.has(id)) return;
      const prior = (old.threads || []).find(x => x.id === id);
      if (!prior) return;
      // Graceful self-healing: if a lightweight model resolves a vow/agreement, archive it instead of throwing!
      if (['约定', '誓言'].includes(prior.kind)) {
        upsertMap.set(prior.id, {
          ...clone(prior),
          state: 'resolved',
          importance: 'background',
          status: reason,
        });
        return;
      }
      resolveList.push({ id, reason });
    });

    const scene = value.scene ? normalizeScene(value.scene, old.scene || null)
      : (value.director?.scene ? normalizeScene(value.director.scene, old.scene || null) : null);

    // Chapter mode vs legacy flat summary compatibility
    const hasExplicitChapterMode = Boolean(
      value.chapterMode ||
      (typeof value.chapterSummary === 'string' && value.chapterSummary.trim()) ||
      value.sealedChapter ||
      Array.isArray(value.replaceChapters),
    );

    const chapterSpan = Math.max(9, Math.min(120, Number(options.chapterSpan) || DEFAULT_CHAPTER_SPAN));

    if (hasExplicitChapterMode && batchId !== 'restore') {
      const existingChapters = Array.isArray(old.chapters) ? clone(old.chapters) : [];
      if (!existingChapters.length && old.summary && old.through > 0 && !old.openChapter) {
        existingChapters.push({
          index: 1,
          fromRound: 1,
          toRound: old.through,
          title: '前情卷宗',
          summary: old.summary,
          legacyBase: true,
        });
      }
      const chapterText = requireString(value.chapterSummary || value.summary, '当前阶段纪要', 30000);
      const chapterTitle = optionalString(value.chapterTitle, 80);
      const endRound = expectedRounds.length ? expectedRounds.at(-1) : old.through;

      // Note-only revision right after a sealed chapter updates the latest sealed chapter cleanly
      if (expectedRounds.length === 0 && !old.openChapter && existingChapters.length > 0) {
        const updatedChapters = clone(existingChapters);
        const last = updatedChapters.at(-1);
        last.summary = chapterText;
        if (chapterTitle) last.title = chapterTitle;
        const fullSummary = composeChronicle(updatedChapters, null);
        return {
          chapterMode: true,
          replaceChapters: updatedChapters,
          openChapter: null,
          events,
          corrections: normalizedCorrections,
          summary: fullSummary,
          threads: { upsert: [...upsertMap.values()], resolve: resolveList },
          scene,
          suggestions: [],
        };
      }

      const lastSealedEnd = existingChapters.at(-1)?.toRound || 0;
      const fromRound = old.openChapter?.fromRound || (lastSealedEnd + 1);
      const span = endRound - fromRound + 1;

      if (expectedRounds.length > 0 && span >= chapterSpan) {
        const sealedChapter = {
          index: existingChapters.length + 1,
          fromRound,
          toRound: endRound,
          title: chapterTitle || `阶段纪要`,
          summary: chapterText,
        };
        const fullSummary = composeChronicle([...existingChapters, sealedChapter], null);
        return {
          chapterMode: true,
          sealedChapter,
          events,
          corrections: normalizedCorrections,
          summary: fullSummary,
          threads: { upsert: [...upsertMap.values()], resolve: resolveList },
          scene,
          suggestions: [],
        };
      }

      const nextOpen = { fromRound, toRound: Math.max(fromRound, endRound), title: chapterTitle || old.openChapter?.title || '', summary: chapterText };
      const fullSummary = composeChronicle(existingChapters, nextOpen);
      return {
        chapterMode: true,
        chapterFromRound: fromRound,
        chapterTitle: nextOpen.title,
        chapterSummary: chapterText,
        events,
        corrections: normalizedCorrections,
        summary: fullSummary,
        threads: { upsert: [...upsertMap.values()], resolve: resolveList },
        scene,
        suggestions: [],
      };
    }

    if (batchId === 'restore' && value.chapterMode) {
      return {
        chapterMode: true,
        ...(value.sealedChapter ? { sealedChapter: clone(value.sealedChapter) } : {}),
        ...(Array.isArray(value.replaceChapters) ? { replaceChapters: clone(value.replaceChapters), openChapter: value.openChapter ? clone(value.openChapter) : null } : {}),
        ...(typeof value.chapterSummary === 'string' ? { chapterFromRound: value.chapterFromRound, chapterTitle: optionalString(value.chapterTitle, 80), chapterSummary: value.chapterSummary } : {}),
        events,
        corrections: normalizedCorrections,
        summary: requireString(value.summary || value.chapterSummary, '累计关键经过', 120000),
        threads: { upsert: [...upsertMap.values()], resolve: resolveList },
        ...(scene ? { scene } : {}),
        suggestions: [],
      };
    }

    const summary = requireString(value.summary || value.chapterSummary, '累计关键经过', 120000);
    const out = {
      events,
      corrections: normalizedCorrections,
      summary,
      threads: { upsert: [...upsertMap.values()], resolve: resolveList },
      suggestions: [],
    };
    if (scene) out.scene = scene;
    if (batchId === 'restore' && value.director) out.director = clone(value.director);
    return out;
  }

  function makeBatch(delta, rounds, through, note = '') {
    return {
      id: uid(),
      at: new Date().toISOString(),
      sources: rounds.slice(through, through + delta.events.length).map(r => r.signature),
      prefix: hash(JSON.stringify(rounds.slice(0, through + delta.events.length).map(r => r.signature))),
      note,
      delta,
    };
  }

  function makeSkipBatch(rounds, through, count, reason = '独立番外，不计入主线记忆。') {
    const sources = rounds.slice(through, through + count).map(r => r.signature);
    return {
      id: uid(),
      at: new Date().toISOString(),
      sources,
      prefix: hash(JSON.stringify(rounds.slice(0, through + count).map(r => r.signature))),
      note: '',
      skip: true,
      reason,
    };
  }

  function normalizeCompactRecord(rawCompact) {
    return rawCompact && isObject(rawCompact) && Number.isInteger(rawCompact.through)
      && rawCompact.through >= 0 && typeof rawCompact.summary === 'string' && rawCompact.summary.trim()
      ? {
          through: rawCompact.through,
          level: Math.max(1, Math.min(2, Number(rawCompact.level) || 1)),
          summary: rawCompact.summary.trim().slice(0, 120000),
          keepRounds: Math.max(0, Math.min(16, Number(rawCompact.keepRounds) || 5)),
          at: String(rawCompact.at || new Date().toISOString()),
        }
      : null;
  }

  function validateHistoryList(rawHistory, owner = '') {
    const tempState = { ...emptyState(owner), history: [] };
    let through = 0;
    for (const batch of rawHistory) {
      if (!batch || !Array.isArray(batch.sources) || !batch.sources.every(x => typeof x === 'string') || typeof batch.prefix !== 'string') {
        throw new Error('备份来源记录不完整。');
      }
      if (batch.skip) {
        tempState.history.push({
          id: String(batch.id || uid()),
          at: String(batch.at || ''),
          sources: [...batch.sources],
          prefix: batch.prefix,
          note: '',
          skip: true,
          reason: String(batch.reason || '独立番外，不计入主线记忆。'),
        });
        through += batch.sources.length;
        continue;
      }
      const old = materialize(tempState);
      const persistedIds = (batch.delta?.threads?.upsert || []).filter(t => !old.threads.some(x => x.id === t.id));
      const syntheticOld = { ...old, threads: [...old.threads, ...persistedIds] };
      const delta = validateDelta(batch.delta, syntheticOld, batch.sources.map((_, i) => through + i + 1), 'restore');
      tempState.history.push({
        id: String(batch.id || uid()),
        at: String(batch.at || ''),
        sources: [...batch.sources],
        prefix: batch.prefix,
        note: String(batch.note || ''),
        delta,
      });
      through += batch.sources.length;
    }
    return { history: tempState.history, through };
  }

  function validateState(input) {
    if (!input || input.schema !== 1 || typeof input.owner !== 'string' || !Array.isArray(input.history)) {
      throw new Error('不是此版本的记忆备份。');
    }
    const compact = normalizeCompactRecord(input.compact);
    const { history } = validateHistoryList(input.history, input.owner);

    let vault = null;
    if (isObject(input.vault) && Array.isArray(input.vault.history) && input.vault.history.length > 0) {
      try {
        const validatedVault = validateHistoryList(input.vault.history, input.owner);
        if (validatedVault.through > 0) {
          vault = {
            through: validatedVault.through,
            history: validatedVault.history,
            compact: normalizeCompactRecord(input.vault.compact),
            at: String(input.vault.at || new Date().toISOString()),
            reason: String(input.vault.reason || '历史记忆备份').slice(0, 120),
          };
        }
      } catch {
        vault = null;
      }
    }

    return {
      ...emptyState(input.owner),
      revision: String(input.revision || ''),
      enabled: !!input.enabled,
      note: String(input.note || ''),
      pausedByUser: !!input.pausedByUser || (!!input.pausedOnError && input.lastError === '已停止整理。旧记忆保留，不会自动重试。'),
      lastError: String(input.lastError || ''),
      compact,
      holdMismatch: !!input.holdMismatch,
      vault,
      history,
      createdAt: input.createdAt || new Date().toISOString(),
    };
  }

  function safeText(text) {
    return String(text).replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝');
  }
  const cell = value => safeText(value).replace(/\|/g, '／').replace(/\r?\n/g, '；');

  function formatPromptEventLine(row) {
    const baseRaw = (row.description && row.description.trim())
      ? row.description.trim()
      : [row.action, row.result].filter(Boolean).join('，').trim();
    const base = baseRaw.length > 260 ? `${baseRaw.slice(0, 258)}…` : baseRaw;
    const parts = [`第${row.round}轮${row.time && row.time !== '未明' ? `（${row.time}${row.place && row.place !== '未明' ? ` · ${row.place}` : ''}）` : (row.place && row.place !== '未明' ? `（${row.place}）` : '')}：${base}`];
    if (row.item?.name && !base.includes(row.item.name)) {
      parts.push(`信物／物品：${row.item.name}（${row.item.reason}）`);
    }
    const extraConsequences = (Array.isArray(row.consequences) ? row.consequences : []).filter(c => {
      const text = String(c || '').trim();
      return text && !base.includes(text.slice(0, 10));
    });
    if (extraConsequences.length) {
      parts.push(`暗线／持续影响：${extraConsequences.slice(0, 2).join('；').slice(0, 140)}`);
    }
    return `- ${parts.join('；')}`;
  }

  /**
   * 渲染记忆文本：
   * - prompt === true：生成注入给主模型的精炼长程世界书上下文（分卷史册 + 长期信物里程碑 + 近期事件 + 开放线程 + 知情边界）
   * - prompt !== true：导出可读全文报告
   */
  function renderMemory(memory, _includeSuggestions = false, _legacyMode = 'off', options = {}) {
    if (!memory?.through && !memory?.summary) return '';
    const prompt = options.prompt === true;
    const source = prompt ? projectForPrompt(memory, options) : memory;
    const omitRecent = Math.max(0, Number(options.omitRecentRounds) || 0);
    const cutoffRound = (prompt && omitRecent > 0 && memory.through > omitRecent) ? (memory.through - omitRecent) : memory.through;
    const headerNote = (prompt && cutoffRound < memory.through)
      ? `前情已整理至第${memory.through}轮（第1—${cutoffRound}轮收纳于此，最近第${cutoffRound + 1}—${memory.through}轮完整对话原文紧接在本条下方）`
      : `已整理至第${memory.through}轮${memory.skipped ? `（另有${memory.skipped}轮独立番外未计入主线）` : ''}`;

    let text = `${headerNote}\n\n`;

    if (prompt) {
      const scene = source.scene;
      if (scene) {
        const sceneLine = [
          scene.time ? `时间=${scene.time}` : '',
          scene.location ? `地点=${scene.location}` : '',
          scene.present?.length ? `在场=${scene.present.join('、')}` : '',
        ].filter(Boolean).join('；');
        if (sceneLine) text += `【当前场景锚点】${sceneLine}\n`;
        if (scene.secrets?.length) {
          text += `【知情差与防读心边界】${safeText(scene.secrets.join('；'))}\n`;
        }
        if (sceneLine || scene.secrets?.length) text += '\n';
      }

      text += `【分卷主线纪要】\n${safeText(source.summary || '尚未形成摘要。')}\n`;

      const { items = [], milestones = [] } = source.anchors || {};
      if (items.length || milestones.length) {
        text += `\n【关键信物与长期锚点】\n`;
        for (const it of items) {
          const roundLabel = it.firstRound === it.round ? `第${it.round}轮` : `第${it.firstRound}→${it.round}轮`;
          const compactReason = String(it.reason || '').length > 85 ? `${String(it.reason).slice(0, 83)}…` : it.reason;
          text += `- [信物／状态 · ${roundLabel}] ${safeText(it.name)}：${safeText(compactReason)}\n`;
        }
        for (const m of milestones) {
          const snippet = (m.description || '').length > 105 ? `${m.description.slice(0, 103)}…` : m.description;
          text += `- [早期节点 · 第${m.round}轮] ${safeText(snippet)}\n`;
        }
      }

      text += `\n【近期因果事件】\n`;
      text += source.events.length ? source.events.map(formatPromptEventLine).join('\n') : '（近期轮次见下方完整对话原文）';
      if (cutoffRound < memory.through) {
        text += `\n- （注：第${cutoffRound + 1}—${memory.through}轮完整对话紧接在下方聊天历史中，请按时间顺序自然承接）`;
      }

      text += `\n\n【当前开放线程与有效约定】\n`;
      text += source.threads.length
        ? source.threads.map(t => {
            const title = t.title || t.content;
            const known = (t.known || t.content || '').slice(0, 150);
            const unknown = (t.unknown && t.unknown !== '未明' && !known.includes(t.unknown.slice(0, 10))) ? `；待解=${t.unknown.slice(0, 90)}` : '';
            const due = (t.due && !['未说明', '未明'].includes(t.due) && !known.includes(t.due.slice(0, 8))) ? `；条件=${t.due.slice(0, 70)}` : '';
            return `- [${t.kind}] ${safeText(title)}（${safeText(t.status)}）：${safeText(known)}${safeText(unknown)}${safeText(due)}`;
          }).join('\n')
        : '暂无。';
      return text;
    }

    // Readable full export mode
    const compact = memory.compact?.through === memory.through && memory.compact.summary ? memory.compact : null;
    if (memory.scene) {
      const s = memory.scene;
      text += `【当前场景与知情边界】\n时间：${s.time || '未明'}｜地点：${s.location || '未明'}｜在场：${s.present?.join('、') || '未明'}`;
      if (s.secrets?.length) text += `\n知情差：${s.secrets.join('；')}`;
      text += '\n\n';
    }
    if (compact) {
      text += `【分卷主线纪要 · 压缩视图】\n${safeText(compact.summary)}\n\n`;
    } else {
      text += `【分卷主线纪要】\n${safeText(memory.summary)}\n\n`;
    }

    const anchors = extractLongTermAnchors(memory);
    if (anchors.items.length) {
      text += `【关键信物与状态账本】\n`;
      text += anchors.items.map(it => `- 第${it.round}轮 · ${safeText(it.name)}：${safeText(it.reason)}`).join('\n') + '\n\n';
    }

    const active = memory.threads.filter(activeThread);
    const archived = memory.threads.filter(thread => !activeThread(thread));
    text += `【当前开放线程与有效约定】\n`;
    if (!active.length) text += '暂无。';
    else {
      text += '|记录时间|类型|标题|涉及人物|内容／进展|条件／待解|状态|\n|---|---|---|---|---|---|---|\n';
      text += active.map(t => `|${[t.at, t.kind, t.title || t.content.slice(0, 60), t.people, t.known || t.content, t.unknown || t.due, t.status].map(cell).join('|')}|`).join('\n');
    }
    if (archived.length) {
      text += `\n\n【已结案或归档事项】\n共 ${archived.length} 条保存在本地档案中。`;
      if (options.includeArchived) {
        text += '\n|记录时间|类型|标题|涉及人物|内容|状态|\n|---|---|---|---|---|---|\n';
        text += archived.map(t => `|${[t.at, t.kind, t.title || t.content.slice(0, 60), t.people, t.content, t.status].map(cell).join('|')}|`).join('\n');
      }
    }

    text += `\n\n【逐轮事件全表】\n|轮次|时间|地点|因果经过|关键信物／物品|原因／状态|\n|---|---|---|---|---|---|\n`;
    const rows = compact ? memory.events.slice(-(compact.keepRounds || 10)) : memory.events;
    text += rows.map(row => `|${[row.round, row.time, row.place, row.description, row.item?.name || '—', row.item?.reason || '—'].map(cell).join('|')}|`).join('\n');
    return text;
  }

  const FORMAT = `只输出一个合法 JSON 对象，不加代码围栏或额外说明。结构如下：
{
  "scene": {
    "time": "当前故事时间或未明",
    "location": "当前地点或未明",
    "present": ["在场人物"],
    "secrets": ["双方知情差：谁私下做了什么而哪一方尚不知情（无则[]）"]
  },
  "events": [
    {
      "round": 1,
      "time": "本轮时间或未明",
      "place": "本轮地点或未明",
      "importance": "core/active/routine",
      "description": "60—140字具体因果事实（含起因、关键行动或决定、直接结果）",
      "consequences": ["未公开的场外暗线或跨轮持续生效的状态变化，无则[]"],
      "item": null
    }
  ],
  "chapterTitle": "当前分卷阶段短标题（4—12字）",
  "chapterSummary": "仅整理【当前在途分卷】从本卷起始轮到本轮的累计主线纪要（180—400中文字，保留具体时空、关键信物、决定性转折与知情差；严禁重写已封存旧卷！）",
  "threads": {
    "upsert": [],
    "resolve": []
  },
  "corrections": []
}
字段细则：
1. events 仅输出本次新增轮次，round 与输入一一对应；有重要物品／凭证／伤痕状态新增或变更时 item 填 {"name":"标准名称","reason":"来历及当前在谁手里／状态"}，否则填 null。
2. chapterSummary 只汇总「当前在途分卷」（见输入中的当前分卷起始轮与本卷已有纪要），绝对不要把“已封存前情分卷”重新抄进去！
3. threads.upsert 每条为 {"id":"已有id或new-1","kind":"未完成事项/任务/案件/线索/悬念/约定/誓言","title":"短标题","at":"记录时间","people":"相关人物","content":"具体事项或原话","known":"已确认事实","unknown":"待解悬念或空串","due":"期限条件或未说明","status":"当前进展","state":"open/blocked/resolved/dropped","importance":"core/active/background","lastTouchedRound":1}。未变化的旧条目程序自动保留，无需重抄。
4. 已完成或翻篇的短期事项、线索、任务放入 threads.resolve：[{"id":"旧id","reason":"完成或翻篇依据"}]；已履行或失效的约定／誓言请在 upsert 中将 state 改为 "resolved"、importance 改为 "background"。
5. corrections 仅在用户修订备注或确凿新证据纠正旧轮次事实错误时使用：[{"round":旧轮次,"reason":"依据","replacement":完整事件对象}]，平时保持 []。`;

  function requestMessages(preset, old, rounds, note) {
    const sealedChapters = Array.isArray(old.chapters) ? clone(old.chapters) : [];
    if (!sealedChapters.length && old.summary && old.through > 0 && !old.openChapter) {
      sealedChapters.push({
        index: 1,
        fromRound: 1,
        toRound: old.through,
        title: '前情卷宗',
        summary: old.summary,
      });
    }
    // Keep sealed background digest bounded so even at Round 500 the lightweight model input stays fast & compact
    const sealedDigest = sealedChapters.slice(-8).map(ch => ({
      volume: ch.index,
      rounds: `${ch.fromRound}-${ch.toRound}`,
      title: ch.title || '',
      summary: String(ch.summary || '').slice(0, 450),
    }));

    const lastSealedEnd = sealedChapters.at(-1)?.toRound || 0;
    const currentFromRound = old.openChapter?.fromRound || (lastSealedEnd + 1);
    const activeThreads = (Array.isArray(old.threads) ? old.threads : [])
      .filter(activeThread)
      .slice(0, 16)
      .map(t => ({
        id: t.id,
        kind: t.kind,
        title: t.title || t.content,
        people: t.people,
        content: t.content,
        known: t.known || '',
        unknown: t.unknown || '',
        due: t.due,
        status: t.status,
        state: t.state,
        importance: t.importance,
      }));

    const anchors = extractLongTermAnchors(old);
    const recentEvents = (Array.isArray(old.events) ? old.events : []).slice(-6).map(r => ({
      round: r.round,
      time: r.time,
      place: r.place,
      description: r.description,
      consequences: r.consequences || [],
      item: r.item || null,
    }));

    const userPayload = {
      已封存前情分卷_只读勿重写: sealedDigest,
      当前在途分卷: {
        当前分卷起始轮: currentFromRound,
        本卷已有标题: old.openChapter?.title || '',
        本卷已有纪要: old.openChapter?.summary || '',
      },
      上一轮场景与知情差: old.scene || null,
      已登记关键信物参考: anchors.items.slice(-12).map(it => ({ name: it.name, status: it.reason })),
      近期已记事件参考: recentEvents,
      当前开放线程与约定: activeThreads,
      本次新增轮次: rounds.map(r => ({ round: r.round, messages: r.messages })),
      用户修订备注: note || '',
      本次必须输出的events轮次: rounds.map(r => r.round),
    };

    return [
      { role: 'system', content: `${preset.trim()}\n\n【JSON 输出规范】\n${FORMAT}` },
      { role: 'user', content: JSON.stringify(userPayload) },
    ];
  }

  function estimateTokens(text) {
    const value = String(text || '');
    let ascii = 0, other = 0;
    for (const char of value) /[\x00-\x7f]/.test(char) ? ascii++ : other++;
    return Math.ceil(other + ascii / 4);
  }

  function assistantMessages(memory, level = 1, targetTokens = 3500) {
    const source = renderMemory({ ...memory, compact: null }, false, 'off', { includeArchived: true });
    const instruction = level >= 2
      ? '进行超长篇分卷合编压缩：将全部前情按【第一卷（第1—X轮）：标题】【第二卷（第X—Y轮）：标题】……【近期主线】浓缩为清晰的分卷档案。必须完整保留：①关键时间节点与地点转换；②所有重要信物／凭证／身体印记的来历与现状；③决定性因果事件与幕后布局；④双方知情差与长期约定。严禁写成抽象空话！'
      : '进行分阶段精修整理：合并重复日常过渡，按阶段标题清晰保留全部关键时间、地点、信物道具、因果转折与双方知情边界，严禁遗漏关键设定或写成空洞套话。';
    return [
      {
        role: 'system',
        content: `你是砚台的记忆整理助手，服务于酒馆虚构角色扮演。你只整理已有记忆档案，不续写未来剧情，不编造未发生事实。${instruction}\n只输出合法 JSON，不加代码围栏：{"through":${memory.through},"level":${level},"summary":"整理后的完整分卷纪要","keepRounds":8}。建议总长度控制在约 ${targetTokens} Token 以内。`,
      },
      { role: 'user', content: source.slice(0, 180000) },
    ];
  }

  function migrationMessages(memory, maxInputChars = 180000) {
    const allEvents = (memory?.events || []).map(r => ({
      round: r.round,
      time: r.time,
      place: r.place,
      importance: r.importance,
      description: r.description,
      consequences: r.consequences || [],
      item: r.item || null,
    }));
    const allThreads = (memory?.threads || []).map(threadForPrompt);
    const archive = {
      through: memory?.through || 0,
      currentSummary: memory?.summary || '',
      allEvents,
      allThreads,
    };
    const limit = Math.max(30000, Number(maxInputChars) || 180000);
    let source = JSON.stringify(archive);
    if (source.length > limit) {
      const selected = new Map();
      allEvents.filter(row => row.importance === 'core' || row.item).slice(-30).forEach(row => selected.set(row.round, row));
      allEvents.slice(-90).forEach(row => selected.set(row.round, row));
      source = JSON.stringify({ ...archive, allEvents: [...selected.values()].sort((a, b) => a.round - b.round), allThreads: allThreads.slice(-40), truncated: true });
    }
    return [
      {
        role: 'system',
        content: '你是砚台记忆精修与旧账清理助手。请基于已有事件将长线前情重新梳理为清晰的分卷纪要（chapters），并清理已完成的过期线程，绝不删改原始逐轮事件。每卷约 20—35 轮，保留具体时间、地点、关键信物、因果转折与知情边界，严禁写成空洞套话。对于开放线程：已完成或翻篇的短期事项放入 resolve，已履行的约定／誓言在 upsert 中将 state 改为 "resolved"、importance 改为 "background"。只输出合法 JSON：{"chapters":[{"index":1,"fromRound":1,"toRound":30,"title":"阶段标题","summary":"本卷具体纪要"}],"threads":{"upsert":[],"resolve":[]}}（若总轮数不足一卷也可直接输出 {"summary":"完整分阶段纪要","threads":{"upsert":[],"resolve":[]}}）。',
      },
      { role: 'user', content: source },
    ];
  }

  function validateMigrationOutput(raw, memory) {
    const value = typeof raw === 'string' ? parseResponse(raw) : raw;
    if (!isObject(value)) throw new Error('精修结果不是有效对象。');
    const changes = isObject(value.threads) ? value.threads : { upsert: [], resolve: [] };

    let replaceChapters = null;
    let summaryText = '';
    if (Array.isArray(value.chapters) && value.chapters.length > 0) {
      replaceChapters = value.chapters.map((ch, idx) => ({
        index: idx + 1,
        fromRound: Math.max(1, Number(ch.fromRound) || 1),
        toRound: Math.max(1, Number(ch.toRound) || memory.through || 1),
        title: optionalString(ch.title, 80) || `阶段 ${idx + 1}`,
        summary: requireString(ch.summary, `第${idx + 1}卷纪要`, 30000),
      }));
      summaryText = composeChronicle(replaceChapters, null);
    } else {
      summaryText = requireString(value.summary, '精修纪要', 60000);
      replaceChapters = [{
        index: 1,
        fromRound: 1,
        toRound: memory.through || 1,
        title: '精修卷宗',
        summary: summaryText,
        legacyBase: true,
      }];
    }

    const delta = validateDelta(
      { events: [], corrections: [], summary: summaryText, threads: changes },
      memory,
      [],
      'migration',
    );
    return {
      summary: summaryText,
      replaceChapters,
      threads: delta.threads,
      at: new Date().toISOString(),
    };
  }

  function assistantQuestionMessages(question, context = '') {
    return [
      {
        role: 'system',
        content: '你是砚台叙事记忆助手，温和、清晰地解答用户关于当前记忆档案、世界书共存、分卷整理或参数配置的问题。砚台叙事记忆默认每 3 轮自动整理一次，每满 24 轮自动封存一卷且永不重洗早期旧卷，关键信物与长期约定常驻保留，主回复默认保留最近 5 轮完整原文并把前情记忆放在这 5 轮之前（深度 12），且与角色自带的角色世界书完全叠加共存。请用自然简洁的中文直接给出解答与操作建议，不要输出 JSON，不要续写角色扮演正文。',
      },
      { role: 'user', content: JSON.stringify({ 问题: String(question || '').trim(), 当前记忆参考: String(context || '').slice(0, 30000) }) },
    ];
  }

  function validateAssistantOutput(raw, memory, level = 1) {
    const value = typeof raw === 'string' ? parseResponse(raw) : raw;
    if (!isObject(value)) throw new Error('记忆助手没有返回有效的压缩结果。');
    const through = Number(value.through ?? memory.through);
    if (through !== memory.through) throw new Error('压缩结果对应的记忆版本已变化，未保存。');
    const summary = requireString(value.summary, '压缩纪要', 120000);
    return {
      through,
      level: Math.max(1, Math.min(2, Number(value.level) || level)),
      summary,
      keepRounds: Math.max(0, Math.min(16, Number(value.keepRounds) || 8)),
      at: new Date().toISOString(),
    };
  }

  function normalizeApiUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { throw new Error('请填写完整 API 地址，例如 https://你的服务地址/v1。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('API 地址应为 http/https 地址，不带账号、查询参数或片段。');
    }
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|models)\/?$/, '').replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  }

  function isTemperatureUnsupported(model = '') {
    const m = String(model || '').trim().toLowerCase();
    return /^(?:o1|o3|o4)(?:$|[-_])/.test(m) || /claude-opus-4-7|claude-opus-5/.test(m);
  }

  function apiPayload(config, messages, key) {
    const model = String(config.model || '').trim();
    if (!model) throw new Error('请先填写或拉取选择记忆模型名称。');
    let extra;
    try { extra = JSON.parse(config.extraBody || '{}'); } catch { throw new Error('额外请求参数不是合法 JSON。'); }
    if (!isObject(extra)) throw new Error('额外请求参数应是 JSON 对象。');
    for (const blocked of ['messages', 'model', 'stream', 'n', 'tools', 'tool_choice', '__proto__', 'constructor', 'prototype']) {
      if (Object.prototype.hasOwnProperty.call(extra, blocked)) throw new Error(`额外参数不能覆盖 ${blocked}。`);
    }
    const remove = Object.keys(extra).filter(k => extra[k] === null);
    extra = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null));

    const safeMaxTokens = Math.max(512, Math.min(32768, Number(config.maxTokens) || 8192));
    const payload = {
      chat_completion_source: 'custom',
      custom_url: normalizeApiUrl(config.apiUrl),
      model,
      messages,
      stream: false,
      n: 1,
      max_tokens: safeMaxTokens,
      custom_include_headers: JSON.stringify({ Authorization: key ? `Bearer ${key}` : '' }),
      custom_include_body: JSON.stringify(extra),
      custom_exclude_body: JSON.stringify(remove),
    };
    if (!isTemperatureUnsupported(model)) {
      let temp = Number(config.temperature);
      if (!Number.isFinite(temp)) temp = 0.25;
      if (temp <= 0 && /minimax/i.test(model)) temp = 0.01;
      payload.temperature = temp;
    }
    return payload;
  }

  return {
    VERSION,
    DEFAULT_CHAPTER_SPAN,
    DEFAULT_MAX_AUTO_TRIM,
    TENSIONS,
    KINDS,
    FORMAT,
    uid,
    hash,
    clone,
    clean,
    isNonStoryMessage,
    isStandaloneDirective,
    roundsFrom,
    emptyState,
    emptyMemory,
    normalizeScene,
    composeChronicle,
    extractLongTermAnchors,
    materialize,
    projectForPrompt,
    reconcile,
    reanchorState,
    trimStateToRounds,
    captureVault,
    smartReconcile,
    confirmAlignState,
    restoreFromVault,
    parseResponse,
    validateDelta,
    validateState,
    makeBatch,
    makeSkipBatch,
    renderMemory,
    requestMessages,
    estimateTokens,
    assistantMessages,
    migrationMessages,
    validateMigrationOutput,
    assistantQuestionMessages,
    validateAssistantOutput,
    safeText,
    normalizeApiUrl,
    isTemperatureUnsupported,
    apiPayload,
  };
})();

export default JDMCore;
