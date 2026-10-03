import C from './core.js';
import MainAPI from './main-api.js';
export const SECRET_SLOT = 'yantai:memory:custom-api-key:v1';
export function readLocalKey(storage) {
  try { storage ??= globalThis.localStorage; return storage?.getItem(SECRET_SLOT) || ''; } catch { return ''; }
}
export function writeLocalKey(key, storage) {
  try {
    storage ??= globalThis.localStorage;
    if (key) storage.setItem(SECRET_SLOT, key); else storage.removeItem(SECRET_SLOT);
  } catch { throw new Error('当前浏览器不能保存密钥，请允许本站本地存储后再保存。'); }
}
export function extractText(data, context) {
  if (data?.error) throw new Error('记忆 API 返回错误，旧记录保留。请检查连接、模型和额度。');
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length' || data?.stop_reason === 'max_tokens' || data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('记忆输出达到长度上限，未保存。请增加输出上限或减小每批轮数。');
  if (choice?.message?.refusal) throw new Error('记忆模型未执行整理，旧记忆保留。');
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.filter(x => x.type === 'text').map(x => x.text || '').join('');
    if (text.trim()) return text;
  }
  const native = context?.extractMessageFromData?.(data, 'openai');
  if (typeof native === 'string' && native.trim()) return native;
  throw new Error('记忆 API 没有返回可读取的正文，旧记录保留。');
}
export function createApi(host) {
  return {
    async payload(config, messages) {
      if (config.apiMode === 'main') return MainAPI.build(host.context(), config, messages, globalThis.SillyTavern?.libs?.yaml?.parse);
      return C.apiPayload(config, messages, readLocalKey());
    },
    async request(payload, signal, timeoutSeconds) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutSeconds * 1000);
      try {
        if (signal.aborted) throw new Error('请求已停止。');
        const data = await host.request('/api/backends/chat-completions/generate', { body: payload, signal: controller.signal });
        return extractText(data, host.context());
      } catch (error) {
        if (controller.signal.aborted) throw new Error(signal.aborted ? '已停止整理；已经发出的请求仍可能由服务商计费。' : '记忆请求超时，旧记录保留。');
        const key = readLocalKey();
        throw new Error(key ? String(error.message || error).split(key).join('[密钥已隐藏]') : String(error.message || error));
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    },
  };
}
export { MainAPI };
