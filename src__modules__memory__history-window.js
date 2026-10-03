import C from './core.js';
import { marker } from './storage.js';

// ST's IGNORE_SYMBOL applies to the generation copy, not saved chat visibility.
// Keep every message available for WI scanning and regex depth calculations.
export const HISTORY_IGNORE = Symbol.for('ignore');

export function prepareHistoryWindow({ prepared, messages, state, owner, keepRounds = 3,
  type = 'normal', stripCardMemory = true }) {
  if (!Array.isArray(prepared) || !Array.isArray(messages) || !state?.enabled ||
      state.owner !== owner || !Number.isInteger(keepRounds) || keepRounds < 1 ||
      !['normal', 'regenerate', 'swipe', 'continue'].includes(type || 'normal')) return null;
  const rounds = C.roundsFrom(messages, stripCardMemory);
  // A changed or unconfirmed prefix must be reconciled by the memory engine first.
  if (C.reconcile(state, rounds).changed) return null;
  const through = C.materialize(state).through;
  const count = Math.min(through, Math.max(0, rounds.length - keepRounds));
  if (!count) return null;
  const covered = new Set(rounds.slice(0, count).flatMap(r => r.source.map(s => s.id)));
  // Native indices are assigned after filtering hidden/system messages. Tool
  // conversations have a separate native filter; leave those requests untouched.
  if (messages.some(m => m?.extra?.tool_invocations?.length || m?.extra?.tool_calls?.length)) return null;
  const visible = messages.map((message, id) => ({ message, id })).filter(x => x.message && !x.message.is_system);
  const candidates = new Map();
  for (const item of prepared) {
    if (!Number.isInteger(item?.index) || item.index < 0) continue;
    const source = visible[item.index];
    if (!source || !covered.has(source.id) || item.is_system || item.extra?.type ||
        item.extra?.[HISTORY_IGNORE] || !!item.is_user !== !!source.message.is_user ||
        String(item.name || '') !== String(source.message.name || '')) continue;
    candidates.set(item, source.id);
  }
  if (!candidates.size) return null;
  return { prepared, candidates, owner, revision: state.revision, through, keepRounds,
    pending: rounds.length - through, removed: 0, applied: false,
    begin: marker(owner, state.revision), end: marker(owner, state.revision, true) };
}

export function applyHistoryWindow(plan, entries, owner, revision) {
  if (!plan || plan.applied || plan.owner !== owner || plan.revision !== revision || !Array.isArray(entries)) return 0;
  // Only a memory entry actually selected by WI may replace earlier prose.
  // Before activation, the complete original history still participates in WI.
  const present = entries.some(e => !e.disable && typeof e.content === 'string' &&
    e.content.includes(plan.begin) && e.content.includes(plan.end));
  if (!present) return 0;
  for (let i = 0; i < plan.prepared.length; i++) {
    const item = plan.prepared[i];
    if (!plan.candidates.has(item) || item.extra?.[HISTORY_IGNORE]) continue;
    // Neither the original message nor its shared `extra` object is mutated.
    plan.prepared[i] = { ...item, extra: { ...item.extra, [HISTORY_IGNORE]: true } };
    plan.removed++;
  }
  plan.applied = true;
  return plan.removed;
}

export function historyWindowStatus(plan) {
  if (!plan?.applied || !plan.removed) return '';
  return `本次保留最近 ${plan.keepRounds} 轮原文及当前输入，已省略 ${plan.removed} 条已记住的旧消息。` +
    (plan.pending ? `另保留 ${plan.pending} 轮尚未整理的正文。` : '') + '存档、预设和世界书未改动。';
}
