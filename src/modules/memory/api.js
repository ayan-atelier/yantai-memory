import C from './core.js';
import MainAPI from './main-api.js';

export const SECRET_SLOT = 'yantai:memory:custom-api-key:v1';
const CONTROL_KEY = Symbol.for('yantai.control.registry.v1');

export function readLocalKey(storage) {
  try { storage ??= globalThis.localStorage; return storage?.getItem(SECRET_SLOT) || ''; } catch { return ''; }
}

export function writeLocalKey(key, storage) {
  try {
    storage ??= globalThis.localStorage;
    if (key) storage.setItem(SECRET_SLOT, key); else storage.removeItem(SECRET_SLOT);
  } catch { throw new Error('当前浏览器不能保存密钥，请允许本站本地存储后再保存。'); }
}

export function getStMateHandle(root = globalThis) {
  const reg = root?.[CONTROL_KEY];
  const handle = reg?.modules instanceof Map ? reg.modules.get('st-mate') : null;
  return handle && typeof handle.requestAuxCompletion === 'function' ? handle : null;
}

export function extractText(data, context) {
  if (data?.error) {
    const detail = typeof data.error === 'string' ? data.error : (data.error?.message || '');
    throw new Error(`记忆 API 返回错误${detail ? `（${String(detail).slice(0, 120)}）` : ''}，旧记录保留。请检查连接、模型与额度。`);
  }
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length' || data?.stop_reason === 'max_tokens' || data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('记忆输出达到最大输出长度上限，未保存。请在配置中调大“最大输出 Token”或换用非推理轻量模型。');
  }
  if (choice?.message?.refusal) throw new Error('记忆模型拒绝执行整理，旧记忆保留。');
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.filter(x => x?.type === 'text').map(x => x.text || '').join('');
    if (text.trim()) return text;
  }
  const native = context?.extractMessageFromData?.(data, 'openai');
  if (typeof native === 'string' && native.trim()) return native;
  throw new Error('记忆 API 没有返回可读取的正文，旧记录保留。');
}

export function createApi(host) {
  return {
    async payload(config, messages) {
      if (config.apiMode === 'st_mate_aux') {
        const stMate = getStMateHandle();
        if (stMate) {
          return {
            __stMateAux: true,
            messages: JSON.parse(JSON.stringify(messages)),
            temperature: config.temperature,
            maxTokens: Math.max(512, Math.min(32768, Number(config.maxTokens) || 8192)),
          };
        }
        // Graceful fallback if ST-Mate is not installed or disabled
        return MainAPI.build(host.context(), config, messages, globalThis.SillyTavern?.libs?.yaml?.parse);
      }
      if (config.apiMode === 'main') {
        return MainAPI.build(host.context(), config, messages, globalThis.SillyTavern?.libs?.yaml?.parse);
      }
      return C.apiPayload(config, messages, readLocalKey());
    },

    async request(payload, signal, timeoutSeconds) {
      if (payload?.__stMateAux) {
        const stMate = getStMateHandle();
        if (!stMate) throw new Error('未检测到运行中的 ST伴侣副通道，请切换连接模式或启用 ST伴侣。');
        const res = await stMate.requestAuxCompletion({
          messages: payload.messages,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          signal,
          timeoutMs: Math.max(30, Number(timeoutSeconds) || 180) * 1000,
        });
        if (!res?.ok) {
          if (res?.aborted && signal?.aborted) {
            throw new Error('已停止整理；已经发出的请求仍可能由服务商计费。');
          }
          throw new Error(res?.message || '副通道记忆请求失败，旧记录保留。');
        }
        return res.cleanText || res.rawText || '';
      }

      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutSeconds * 1000);
      try {
        if (signal.aborted) throw new Error('请求已停止。');
        const data = await host.request('/api/backends/chat-completions/generate', { body: payload, signal: controller.signal });
        return extractText(data, host.context());
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(signal.aborted ? '已停止整理；已经发出的请求仍可能由服务商计费。' : '记忆请求超时，旧记录保留。');
        }
        const key = readLocalKey();
        throw new Error(key ? String(error.message || error).split(key).join('[密钥已隐藏]') : String(error.message || error));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },

    async fetchCustomModels(apiUrl, apiKey) {
      const normalizedUrl = C.normalizeApiUrl(apiUrl);
      const data = await host.request('/api/backends/chat-completions/status', {
        body: {
          chat_completion_source: 'custom',
          custom_url: normalizedUrl,
          custom_include_headers: JSON.stringify({ Authorization: apiKey ? `Bearer ${apiKey}` : '' }),
        },
      });
      const rawList = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.data?.data)
          ? data.data.data
          : [];
      const seen = new Set();
      const models = [];
      for (const item of rawList) {
        const id = typeof item === 'string' ? item.trim() : typeof item?.id === 'string' ? item.id.trim() : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push(id);
      }
      return models;
    },
  };
}

export { MainAPI };
