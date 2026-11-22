import JDMCore from './core.js';

/* One update = one model request. Persistence and UI live in adapters. */
const JDMEngine = (() => {
  'use strict';
  const C = JDMCore;

  class Engine {
    constructor(adapter, configuration, report = () => {}) {
      this.a = adapter;
      this.configuration = configuration;
      this.report = report;
      this.running = null;
      this.controller = null;
      this.cancelReason = '';
      this.cancelShouldPause = true;
      this.disposed = false;
      this.queue = Promise.resolve();
      this.pendingSerial = 0;
      this.lastAttempt = null;
      this.retryAfterFailure = new Set();
      this.operationEpoch = 0;
    }

    serial(fn) {
      this.pendingSerial++;
      const result = this.queue.then(fn, fn).finally(() => { this.pendingSerial--; });
      this.queue = result.catch(() => {});
      return result;
    }

    current(key) {
      return !this.disposed && (this.a.key ? this.a.key() : this.a.context()?.key) === key;
    }

    async sync(epoch = this.operationEpoch) {
      return this.serial(async () => {
        if (epoch !== this.operationEpoch || this.disposed) throw new Error(this.cancelReason || '整理已取消。');
        const context = this.a.context();
        if (!context) return null;
        const loaded = await this.a.load(context);
        if (epoch !== this.operationEpoch || !this.current(context.key)) throw new Error('聊天已切换，停止本次操作。');
        const rounds = C.roundsFrom(context.messages, this.configuration().stripCardMemory !== false);
        const checked = C.smartReconcile(loaded.state, rounds);
        let state = checked.state;
        if (checked.changed && !loaded.fork) {
          state = await this.a.save(context, state, loaded, () => epoch === this.operationEpoch && this.current(context.key));
          if (epoch !== this.operationEpoch || !this.current(context.key)) throw new Error('剧情已改变，停止本次操作。');
          if (checked.action === 'reanchored') {
            this.report(`检测到前文微调，已自动续接原有 ${checked.newThrough} 轮世界书记忆（未清除任何记录）。`, 'info');
          } else if (checked.action === 'trimmed') {
            this.report(`已随删楼对齐至第 ${checked.newThrough} 轮（回退前的 ${checked.oldThrough} 轮完整记忆已存入保险箱，可随时一键恢复）。`, 'info');
          } else if (checked.action === 'held') {
            this.report(`防丢保护已锁定：世界书已存 ${checked.oldThrough} 轮记忆，多于当前可见 ${rounds.length} 轮，未自动清除原记忆。`, 'info');
          } else if (checked.action === 'unheld') {
            this.report(`已恢复衔接原有 ${checked.newThrough} 轮世界书记忆。`, 'success');
          }
        }
        return { context, rounds, state, loaded: { ...loaded, state }, memory: C.materialize(state) };
      });
    }

    async setEnabled(enabled) {
      if (!enabled) this.cancel('已关闭当前聊天的记忆整理。', false);
      return this.serial(async () => {
        const context = this.a.context();
        if (!context) throw new Error('请先打开一个角色聊天。');
        const loaded = await this.a.load(context);
        const reconciled = C.smartReconcile(loaded.state, C.roundsFrom(context.messages, this.configuration().stripCardMemory !== false)).state;
        const state = { ...reconciled, enabled, pausedByUser: false, lastError: '' };
        await this.a.save(context, state, loaded, () => this.current(context.key));
        this.retryAfterFailure.delete(context.key);
        this.report(enabled ? '当前聊天记忆已开启，满间隔自动整理。' : '已暂停本聊天记忆整理与注入，已有记录完整保留。');
      });
    }

    async confirmAlign() {
      this.cancel('正在按当前聊天对齐记忆进度。', false);
      return this.serial(async () => {
        const context = this.a.context();
        if (!context) throw new Error('请先打开一个角色聊天。');
        const loaded = await this.a.load(context);
        const rounds = C.roundsFrom(context.messages, this.configuration().stripCardMemory !== false);
        const oldThrough = C.materialize(loaded.state).through;
        const aligned = C.confirmAlignState(loaded.state, rounds);
        const saved = await this.a.save(context, { ...aligned, pausedByUser: false, lastError: '' }, loaded, () => this.current(context.key));
        const afterThrough = C.materialize(saved).through;
        this.retryAfterFailure.delete(context.key);
        this.report(`已对齐至第 ${afterThrough} 轮（原 ${oldThrough} 轮完整记忆已保留在保险箱，随时可恢复）。`, 'success');
        return saved;
      });
    }

    async restoreVault() {
      this.cancel('正在从保险箱恢复原记忆。', false);
      return this.serial(async () => {
        const context = this.a.context();
        if (!context) throw new Error('请先打开一个角色聊天。');
        const loaded = await this.a.load(context);
        const rounds = C.roundsFrom(context.messages, this.configuration().stripCardMemory !== false);
        const restored = C.restoreFromVault(loaded.state, rounds);
        const saved = await this.a.save(context, restored, loaded, () => this.current(context.key));
        const afterThrough = C.materialize(saved).through;
        this.retryAfterFailure.delete(context.key);
        this.report(`已从保险箱无损恢复全部 ${afterThrough} 轮世界书记忆（0 次请求）。`, 'success');
        return saved;
      });
    }

    async saveNote(note) {
      return this.serial(async () => {
        const context = this.a.context();
        if (!context) throw new Error('请先打开一个角色聊天。');
        const loaded = await this.a.load(context);
        await this.a.save(context, { ...loaded.state, note: String(note).trim() }, loaded, () => this.current(context.key));
      });
    }

    async run(manual = false) {
      if (this.running) return this.running;
      this.cancelReason = '';
      this.cancelShouldPause = true;
      const epoch = this.operationEpoch;
      const operation = this.perform(manual, epoch);
      this.running = operation;
      try { return await operation; }
      finally {
        if (this.running === operation) this.running = null;
        this.controller = null;
      }
    }

    async perform(manual, epoch = this.operationEpoch) {
      let snapshot;
      try {
        if (manual && this.a.isGenerating?.()) throw new Error('主回复仍在生成，请等回复完成后再整理记忆。');
        snapshot = await this.sync(epoch);
        if (epoch !== this.operationEpoch || this.disposed) throw new Error(this.cancelReason || '整理已取消。');
        if (!snapshot) throw new Error('请先打开一个角色聊天。');
        const { context, memory, state, rounds } = snapshot;
        const config = C.clone(this.configuration());
        if (!state.enabled) {
          if (manual) throw new Error('请先开启“当前聊天启用记忆”。');
          return false;
        }
        if (state.holdMismatch) {
          if (manual) {
            throw new Error(`当前处于记忆防丢保护态（世界书已存 ${memory.through} 轮，当前聊天可见 ${rounds.length} 轮）。为保护原世界书记忆不被覆盖，请先在总览上方确认对齐或恢复楼层。`);
          }
          return false;
        }
        if (!manual && state.pausedByUser) {
          this.report('自动整理已手动暂停，点“立即整理”成功后恢复。');
          return false;
        }
        const pending = rounds.slice(memory.through);
        if (!pending.length && !state.note) {
          if (manual) this.report('记忆已是最新，无需调用模型。');
          return false;
        }
        const firstStandalone = pending.findIndex(round => round.standalone);
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
            const now = C.roundsFrom(nowContext.messages, config.stripCardMemory !== false);
            return signatures.every((signature, i) => now[i]?.signature === signature);
          };
          await this.serial(async () => {
            if (!samePrefix()) throw new Error('剧情已改变，番外跳过记录未保存。');
            const fresh = await this.a.load(context);
            if (fresh.state.revision !== snapshot.state.revision) throw new Error('记忆在整理期间已被另一操作更新。');
            const nextCompact = state.compact && state.compact.through === memory.through
              ? { ...state.compact, through: memory.through + count }
              : state.compact || null;
            const next = { ...state, history: [...state.history, journal], compact: nextCompact, pausedByUser: false, lastError: '' };
            await this.a.save(context, next, fresh, samePrefix);
          });
          this.report(`已自动跳过 ${count} 轮独立番外，不计入主线记忆。`);
          return true;
        }

        const forcedBoundary = firstStandalone > 0;
        if (!manual && normalPending.length < config.frequency && !forcedBoundary && !state.lastError && !this.retryAfterFailure.has(context.key)) {
          return false;
        }
        const attempt = C.hash(JSON.stringify([context.key, rounds.map(r => r.signature)]));
        if (!manual && this.lastAttempt === attempt) return false;
        this.lastAttempt = attempt;

        const batch = normalPending.slice(0, config.batchSize);
        const signatures = rounds.slice(0, memory.through + batch.length).map(r => r.signature);
        const messages = C.requestMessages(config.preset, memory, batch, state.note);
        const characters = messages.reduce((n, m) => n + m.content.length, 0);
        if (characters > config.maxInputChars) {
          throw new Error(`本次输入约 ${characters.toLocaleString()} 字符，超过上限 ${config.maxInputChars.toLocaleString()} 字符。请减小单次补记轮数或调高输入上限。`);
        }

        this.cancelReason = '';
        this.cancelShouldPause = true;
        this.controller = new AbortController();
        const payload = await this.a.payload(config, messages);
        const before = () => {
          if (epoch !== this.operationEpoch || !this.current(context.key) || this.controller.signal.aborted) return false;
          const now = C.roundsFrom(this.a.context().messages, config.stripCardMemory !== false);
          return signatures.every((signature, i) => now[i]?.signature === signature);
        };
        if (!before()) throw new Error('剧情已改变，本次没有发起请求。');

        this.report(batch.length ? `正在整理第 ${memory.through + 1}—${memory.through + batch.length} 轮（1 次请求）…` : '正在按修订备注更新记忆（1 次请求）…');
        const result = await this.a.request(payload, this.controller.signal, config.timeoutSeconds);
        if (!before()) {
          if (!this.controller.signal.aborted) this.cancelShouldPause = false;
          throw new Error(this.cancelReason || '剧情或聊天已改变，已丢弃过期回复。');
        }

        const delta = C.validateDelta(result, memory, batch.map(r => r.round), undefined, {
          chapterSpan: config.chapterSpan || C.DEFAULT_CHAPTER_SPAN,
        });
        const journal = C.makeBatch(delta, rounds, memory.through, state.note);

        await this.serial(async () => {
          if (!before()) throw new Error('剧情已改变，过期回复未写入。');
          const fresh = await this.a.load(context);
          if (fresh.state.revision !== snapshot.state.revision) {
            throw new Error('记忆在整理期间被另一操作更新，已放弃覆盖。');
          }
          const next = {
            ...state,
            history: [...state.history, journal],
            compact: null,
            note: '',
            pausedByUser: false,
            lastError: '',
          };
          await this.a.save(context, next, fresh, before);
        });

        this.retryAfterFailure.delete(context.key);
        const newThrough = memory.through + batch.length;
        const sealedNotice = delta.sealedChapter
          ? `（第 ${delta.sealedChapter.index} 卷「第 ${delta.sealedChapter.fromRound}—${delta.sealedChapter.toRound} 轮」已封存锁定）`
          : '';
        this.report(
          `已整理至第 ${newThrough} 轮${sealedNotice}。${pending.length > batch.length ? `尚有 ${pending.length - batch.length} 轮积压待补。` : '后续对话将自动携带最新记忆。'}`,
          'success',
        );
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
              await this.a.save(
                snapshot.context,
                { ...fresh.state, pausedByUser: pause || !!fresh.state.pausedByUser, lastError: pause ? '' : message },
                fresh,
                () => this.current(snapshot.context.key) && failureEpoch === this.operationEpoch,
              );
            });
          } catch { /* Never mask original error */ }
        }
        this.report(cancelled ? message : `${message}（下一轮完成后会自动重试，也可点“立即整理”）`, cancelled ? 'info' : 'error');
        return false;
      }
    }

    cancel(reason = '已停止整理，旧记忆保留。点击“立即整理”可恢复。', pause = true) {
      this.operationEpoch++;
      this.cancelReason = reason;
      this.cancelShouldPause = pause;
      this.controller?.abort();
    }

    dispose() {
      this.disposed = true;
      this.cancel('插件已卸载，停止整理。', false);
    }
  }

  return Engine;
})();

export default JDMEngine;
