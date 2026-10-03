import JDMCore from './core.js';
/* One update = one model request. Persistence and the UI live in adapters. */
const JDMEngine = (() => {
  'use strict';
  const C = JDMCore;
  class Engine {
    constructor(adapter, configuration, report = () => {}) {
      this.a = adapter; this.configuration = configuration; this.report = report;
      this.running = null; this.controller = null; this.cancelReason = ''; this.cancelShouldPause = true; this.disposed = false;
      this.queue = Promise.resolve(); this.pendingSerial = 0; this.lastAttempt = null; this.retryAfterFailure = new Set(); this.operationEpoch = 0;
    }
    serial(fn) {
      this.pendingSerial++;
      const result = this.queue.then(fn, fn).finally(() => { this.pendingSerial--; });
      this.queue = result.catch(() => {});
      return result;
    }
    current(key) { return !this.disposed && (this.a.key ? this.a.key() : this.a.context()?.key) === key; }
    async sync(epoch = this.operationEpoch) {
      return this.serial(async () => {
        if (epoch !== this.operationEpoch || this.disposed) throw new Error(this.cancelReason || '整理已取消。');
        const context = this.a.context();
        if (!context) return null;
        const loaded = await this.a.load(context);
        if (epoch !== this.operationEpoch || !this.current(context.key)) throw new Error('聊天已切换，停止本次操作。');
        const rounds = C.roundsFrom(context.messages, this.configuration().stripCardMemory);
        const checked = C.reconcile(loaded.state, rounds);
        let state = checked.state;
        if (checked.changed && !loaded.fork) {
          state = await this.a.save(context, state, loaded, () => epoch === this.operationEpoch && this.current(context.key));
          if (epoch !== this.operationEpoch || !this.current(context.key)) throw new Error('剧情已改变，停止本次操作。');
          this.report(`剧情已修改，记忆退回到第${C.materialize(state).through}轮，等待重新整理。`);
        }
        return { context, rounds, state, loaded: { ...loaded, state }, memory: C.materialize(state) };
      });
    }
    async setEnabled(enabled) {
      if (!enabled) this.cancel('已关闭当前聊天的记忆整理。', false);
      return this.serial(async () => {
        const context = this.a.context();
        if (!context) throw new Error('先打开一个角色聊天。');
        const loaded = await this.a.load(context);
        const reconciled = C.reconcile(loaded.state, C.roundsFrom(context.messages, this.configuration().stripCardMemory)).state;
        const state = { ...reconciled, enabled, pausedByUser: false, lastError: '' };
        await this.a.save(context, state, loaded, () => this.current(context.key));
        this.retryAfterFailure.delete(context.key);
        this.report(enabled ? '当前聊天已启用。下一次主回复完成后自动整理。' : '已暂停整理，并关闭本聊天记忆注入；记录仍保留。');
      });
    }
    async saveNote(note) {
      return this.serial(async () => {
        const context = this.a.context();
        if (!context) throw new Error('先打开一个角色聊天。');
        const loaded = await this.a.load(context);
        await this.a.save(context, { ...loaded.state, note: String(note).trim() }, loaded, () => this.current(context.key));
      });
    }
    async run(manual = false) {
      if (this.running) return this.running;
      this.cancelReason = ''; this.cancelShouldPause = true;
      const epoch = this.operationEpoch;
      const operation = this.perform(manual, epoch);
      this.running = operation;
      try { return await operation; }
      finally { if (this.running === operation) this.running = null; this.controller = null; }
    }
    async perform(manual, epoch = this.operationEpoch) {
      let snapshot;
      try {
        if (manual && this.a.isGenerating?.()) throw new Error('主回复仍在生成，请等回复完成后再整理记忆。');
        snapshot = await this.sync(epoch);
        if (epoch !== this.operationEpoch || this.disposed) throw new Error(this.cancelReason || '整理已取消。');
        if (!snapshot) throw new Error('先打开一个角色聊天。');
        const { context, memory, state, rounds } = snapshot;
        const config = C.clone(this.configuration());
        if (!state.enabled) { if (manual) throw new Error('请先开启“当前聊天启用记忆”。'); return false; }
        if (!manual && state.pausedByUser) { this.report('你已停止自动整理，点击“立即整理”成功后恢复。'); return false; }
        const pending = rounds.slice(memory.through);
        if (!pending.length && !state.note) { if (manual) this.report('已经整理到最新，无需调用 API。'); return false; }
        const firstStandalone = pending.findIndex(round => round.standalone);
        // Never mix an explicitly marked IF/番外 production with mainline
        // memory. A normal prefix is still eligible for this request; a
        // leading standalone block is consumed locally below.
        const normalPending = firstStandalone < 0 ? pending : pending.slice(0, firstStandalone);
        if (firstStandalone === 0) {
          let count = 0;
          while (count < pending.length && pending[count].standalone) count++;
          const journal = C.makeSkipBatch(rounds, memory.through, count);
          const signatures = rounds.slice(0, memory.through + count).map(r => r.signature);
          const samePrefix = () => {
            if (epoch !== this.operationEpoch || !this.current(context.key)) return false;
            const nowContext = this.a.context();
            if (!nowContext) return false;
            const now = C.roundsFrom(nowContext.messages, config.stripCardMemory);
            return signatures.every((signature, i) => now[i]?.signature === signature);
          };
          await this.serial(async () => {
            if (!samePrefix()) throw new Error('剧情已改变，番外未写入记忆。');
            const fresh = await this.a.load(context);
            if (fresh.state.revision !== snapshot.state.revision) throw new Error('记忆在整理期间被另一项操作更新，番外未写入。');
            const next = { ...state, history: [...state.history, journal], compact: null, pausedByUser: false, lastError: '' };
            await this.a.save(context, next, fresh, samePrefix);
          });
          this.report(`已跳过 ${count} 轮番外／独立拍摄，不计入主线记忆。`);
          return true;
        }
        const forcedBoundary = firstStandalone > 0;
        if (!manual && normalPending.length < config.frequency && !forcedBoundary && !state.lastError && !this.retryAfterFailure.has(context.key)) return false;
        // Deduplicate a completed story snapshot, not just the oldest pending batch.
        // New replies must allow retrying that same batch even when a backlog has grown.
        const attempt = C.hash(JSON.stringify([context.key, rounds.map(r => r.signature)]));
        if (!manual && this.lastAttempt === attempt) return false;
        this.lastAttempt = attempt;
        const batch = normalPending.slice(0, config.batchSize);
        const signatures = rounds.slice(0, memory.through + batch.length).map(r => r.signature);
        const messages = C.requestMessages(config.preset, memory, batch, state.note, {
          mode: config.directorMode || 'off', strength: config.directorStrength || 'standard', rules: config.directorRules || ''
        });
        const characters = messages.reduce((n, m) => n + m.content.length, 0);
        if (characters > config.maxInputChars) throw new Error(`本次输入约${characters}字符，超过设置的${config.maxInputChars}字符。没有截断、没有请求；请减小每批轮数或调高输入上限。`);
        // All validation that can fail locally happens before starting the paid request.
        this.cancelReason = ''; this.cancelShouldPause = true;
        this.controller = new AbortController();
        const payload = await this.a.payload(config, messages);
        const before = () => {
          if (epoch !== this.operationEpoch || !this.current(context.key) || this.controller.signal.aborted) return false;
          const now = C.roundsFrom(this.a.context().messages, config.stripCardMemory);
          return signatures.every((signature, i) => now[i]?.signature === signature);
        };
        if (!before()) throw new Error('剧情已改变，本次没有发起请求。');
        this.report(batch.length ? `正在整理第${memory.through + 1}—${memory.through + batch.length}轮（本次1次请求）…` : '正在按你的备注修订记忆（本次1次请求）…');
        const result = await this.a.request(payload, this.controller.signal, config.timeoutSeconds);
        if (!before()) { if (!this.controller.signal.aborted) this.cancelShouldPause = false; throw new Error(this.cancelReason || '剧情或聊天已改变，已丢弃过期回复。'); }
        const delta = C.validateDelta(result, memory, batch.map(r => r.round));
        if ((config.directorMode || 'off') === 'off') delta.director = null;
        else if (!delta.director) delta.director = memory.director || null;
        const journal = C.makeBatch(delta, rounds, memory.through, state.note);
        await this.serial(async () => {
          if (!before()) throw new Error('剧情已改变，过期回复未写入。');
          const fresh = await this.a.load(context);
          if (fresh.state.revision !== snapshot.state.revision) throw new Error('记忆在整理期间被另一项操作更新，已丢弃此回复，避免覆盖。');
          const next = { ...state, history: [...state.history, journal], compact: null, note: '', pausedByUser: false, lastError: '' };
          await this.a.save(context, next, fresh, before);
        });
        this.retryAfterFailure.delete(context.key);
        this.report(`已整理至第${memory.through + batch.length}轮。${pending.length > batch.length ? `还有${pending.length - batch.length}轮待整理。` : '下一轮可使用这份记忆。'}`);
        return true;
      } catch (error) {
        const message = this.cancelReason || (error instanceof Error ? error.message : String(error));
        const cancelled = epoch !== this.operationEpoch || this.disposed;
        const pause = cancelled && this.cancelShouldPause;
        if (!cancelled && snapshot) this.retryAfterFailure.add(snapshot.context.key);
        if ((!cancelled || pause) && snapshot && this.current(snapshot.context.key)) {
          const failureEpoch = this.operationEpoch;
          try {
            await this.serial(async () => {
              const fresh = await this.a.load(snapshot.context);
              if (!fresh.state.enabled || failureEpoch !== this.operationEpoch) return;
              await this.a.save(snapshot.context, { ...fresh.state, pausedByUser: pause || !!fresh.state.pausedByUser,
                lastError: pause ? '' : message }, fresh,
                () => this.current(snapshot.context.key) && failureEpoch === this.operationEpoch);
            });
          } catch { /* Do not replace the original error, and never retry a paid request here. */ }
        }
        this.report(cancelled ? message : `${message}\n下一轮主回复完成后会再次尝试，也可点击“立即整理”。`, cancelled ? 'info' : 'error');
        return false;
      }
    }
    cancel(reason = '已停止整理，旧记忆保留。自动整理已暂停，点击“立即整理”成功后恢复。', pause = true) {
      this.operationEpoch++; this.cancelReason = reason; this.cancelShouldPause = pause;
      this.controller?.abort();
    }
    dispose() { this.disposed = true; this.cancel('脚本已关闭，已停止整理。', false); }
  }
  return Engine;
})();

export default JDMEngine;
