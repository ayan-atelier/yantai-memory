/* Uses ST's public request builder without mutating the user's active roleplay connection. */
const JDMMainAPI = (() => {
  'use strict';
  const PROTECTED = new Set([
    'messages', 'prompt', 'system', 'instructions', 'contents', 'input',
    'model', 'stream', 'stream_options', 'n', 'tools', 'tool_choice', 'functions', 'function_call',
    'enable_web_search', 'request_images', 'stop', 'logit_bias', 'json_schema', 'response_format',
    '__proto__', 'constructor', 'prototype',
  ]);

  function isTemperatureUnsupported(model = '') {
    const m = String(model || '').trim().toLowerCase();
    return /^(?:o1|o3|o4)(?:$|[-_])/.test(m) || /claude-opus-4-7|claude-opus-5/.test(m);
  }

  function connection(ctx, overrideModel = '') {
    if (ctx?.mainApi !== 'openai') {
      throw new Error('跟随模式支持酒馆“聊天补全”连接。请在酒馆选择聊天补全，或切换为独立自定义 API。');
    }
    if (!ctx.chatCompletionSettings || typeof ctx.getChatCompletionModel !== 'function' ||
        typeof ctx.ChatCompletionService?.presetToGeneratePayload !== 'function') {
      throw new Error('当前酒馆未提供主 API 请求接口，可先切换为独立自定义 API。');
    }
    const source = ctx.chatCompletionSettings.chat_completion_source;
    if (!source) throw new Error('请先在酒馆主 API 中选择服务商。');
    const hostModel = ctx.getChatCompletionModel(ctx.chatCompletionSettings);
    const trimmedOverride = typeof overrideModel === 'string' ? overrideModel.trim() : '';
    const model = trimmedOverride || hostModel;
    if (!model && source !== 'openrouter') throw new Error('请先在酒馆主 API 中选择模型。');
    return { source, model, hostModel: hostModel || '', isOverridden: Boolean(trimmedOverride) };
  }

  /**
   * 从当前酒馆主面板 DOM 中只读提取当前服务商已加载的模型候选列表（零请求、零副作用），
   * 方便玩家在“跟随主 API”下直接点选同站点的轻量模型用于记忆整理。
   */
  function availableHostModels(ctx, doc = globalThis.document) {
    if (!doc) return [];
    const source = ctx?.chatCompletionSettings?.chat_completion_source || '';
    const selectorMap = {
      custom: '#model_custom_select, #custom_model_id',
      openai: '#model_openai_select',
      claude: '#model_claude_select',
      makersuite: '#model_google_select',
      vertexai: '#model_vertexai_select',
      openrouter: '#model_openrouter_select',
      deepseek: '#model_deepseek_select',
      xai: '#model_xai_select',
      mistralai: '#model_mistralai_select',
      groq: '#model_groq_select',
      siliconflow: '#model_siliconflow_select',
      moonshot: '#model_moonshot_select',
      minimax: '#model_minimax_select',
      zai: '#model_zai_select',
    };
    const sel = selectorMap[source] || 'select[id^="model_"][id$="_select"]';
    const seen = new Set();
    const out = [];
    for (const selectEl of doc.querySelectorAll(sel)) {
      if (selectEl.tagName !== 'SELECT') continue;
      for (const opt of selectEl.options) {
        const val = String(opt.value || '').trim();
        if (!val || seen.has(val) || val === 'custom') continue;
        seen.add(val);
        out.push(val);
      }
    }
    return out;
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
    const selected = connection(ctx, settings.mainModelOverride);
    const safeMaxTokens = Math.max(512, Math.min(32768, Number(settings.maxTokens) || 8192));
    const payload = await ctx.ChatCompletionService.presetToGeneratePayload({}, {
      temperature: settings.temperature,
      openai_max_tokens: safeMaxTokens,
      enable_web_search: false,
      request_images: false,
    }, {
      model: selected.model,
      chat_completion_source: selected.source,
      messages: JSON.parse(JSON.stringify(messages)),
      stream: false,
      n: 1,
    });
    if (selected.source === 'custom') {
      const include = readExtra(payload.custom_include_body, parseYaml, false);
      const exclude = readExtra(payload.custom_exclude_body, parseYaml, true);
      payload.custom_include_body = JSON.stringify(Object.fromEntries(Object.entries(include).filter(([k]) => !PROTECTED.has(k))));
      payload.custom_exclude_body = JSON.stringify(exclude.filter(k => typeof k === 'string' && !PROTECTED.has(k)));
    }
    for (const key of ['source', 'tools', 'tool_choice', 'functions', 'function_call', 'json_schema', 'response_format', 'logit_bias']) {
      delete payload[key];
    }
    Object.assign(payload, {
      messages: JSON.parse(JSON.stringify(messages)),
      model: selected.model,
      chat_completion_source: selected.source,
      stream: false,
      n: 1,
      stop: [],
      max_tokens: safeMaxTokens,
      enable_web_search: false,
      request_images: false,
    });
    if (isTemperatureUnsupported(selected.model)) {
      delete payload.temperature;
    } else if (Number(payload.temperature) <= 0 && (selected.source === 'minimax' || /minimax/i.test(selected.model))) {
      payload.temperature = 0.01;
    }
    return payload;
  }

  return { connection, availableHostModels, build };
})();

export default JDMMainAPI;
