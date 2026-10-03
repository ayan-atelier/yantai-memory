/* Uses ST's public request builder, without generating a roleplay prompt or changing its settings. */
const JDMMainAPI = (() => {
  'use strict';
  const PROTECTED = new Set(['messages', 'prompt', 'system', 'instructions', 'contents', 'input',
    'model', 'stream', 'stream_options', 'n', 'tools', 'tool_choice', 'functions', 'function_call',
    'enable_web_search', 'request_images', 'stop', 'logit_bias', 'json_schema', 'response_format',
    '__proto__', 'constructor', 'prototype']);
  function connection(ctx) {
    if (ctx?.mainApi !== 'openai') throw new Error('跟随模式目前支持酒馆的“聊天补全”连接。请在酒馆选择聊天补全，或切换为自定义记忆 API。');
    if (!ctx.chatCompletionSettings || typeof ctx.getChatCompletionModel !== 'function' ||
        typeof ctx.ChatCompletionService?.presetToGeneratePayload !== 'function') {
      throw new Error('当前酒馆未提供主 API 请求接口，可先使用自定义 API；更新酒馆后再试跟随模式。');
    }
    const source = ctx.chatCompletionSettings.chat_completion_source;
    if (!source) throw new Error('请先在酒馆主 API 中选择服务商。');
    const model = ctx.getChatCompletionModel(ctx.chatCompletionSettings);
    // OpenRouter deliberately permits its website-configured default model.
    if (!model && source !== 'openrouter') throw new Error('请先在酒馆主 API 中选择模型。');
    return { source, model };
  }
  function readExtra(text, parseYaml, array) {
    if (!text?.trim()) return array ? [] : {};
    let value;
    try {
      try { value = JSON.parse(text); }
      catch { if (typeof parseYaml !== 'function') throw new Error(); value = parseYaml(text); }
    } catch { throw new Error('主 API 的额外请求参数无法读取，请检查酒馆自定义连接中的 YAML／JSON 设置。'); }
    if (value === null || value === undefined) return array ? [] : {};
    if (array ? !Array.isArray(value) : typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('主 API 的额外请求参数格式不正确，请检查自定义连接设置。');
    }
    return value;
  }
  async function build(ctx, settings, messages, parseYaml) {
    const selected = connection(ctx);
    // An empty preset starts from current connection settings. Only memory sampling is overridden.
    const payload = await ctx.ChatCompletionService.presetToGeneratePayload({}, {
      temperature: settings.temperature, openai_max_tokens: settings.maxTokens,
      enable_web_search: false, request_images: false,
    }, { model: selected.model, chat_completion_source: selected.source,
      messages: JSON.parse(JSON.stringify(messages)), stream: false, n: 1 });
    // Do not let a main connection's optional extras replace our prompt or request multiple replies.
    if (selected.source === 'custom') {
      const include = readExtra(payload.custom_include_body, parseYaml, false);
      const exclude = readExtra(payload.custom_exclude_body, parseYaml, true);
      payload.custom_include_body = JSON.stringify(Object.fromEntries(Object.entries(include).filter(([k]) => !PROTECTED.has(k))));
      payload.custom_exclude_body = JSON.stringify(exclude.filter(k => typeof k === 'string' && !PROTECTED.has(k)));
    }
    for (const key of ['source', 'tools', 'tool_choice', 'functions', 'function_call', 'json_schema', 'response_format', 'logit_bias']) delete payload[key];
    Object.assign(payload, { messages: JSON.parse(JSON.stringify(messages)), model: selected.model,
      chat_completion_source: selected.source, stream: false, n: 1, stop: [],
      enable_web_search: false, request_images: false });
    return payload;
  }
  return { connection, build };
})();

export default JDMMainAPI;
