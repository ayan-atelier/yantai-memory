const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function mergeSettings(target, patch) {
  if (!isObject(patch)) return target;
  for (const [key, value] of Object.entries(patch)) {
    if (unsafe.has(key) || value === undefined) continue;
    if (isObject(value)) target[key] = mergeSettings(isObject(target[key]) ? target[key] : {}, value);
    else target[key] = Array.isArray(value) ? structuredClone(value) : value;
  }
  return target;
}
export function createStore(host) {
  const c = host.context();
  if (!c?.extensionSettings || typeof c.saveSettingsDebounced !== 'function') throw new Error('酒馆没有提供扩展设置接口，请检查版本。');
  if (!isObject(c.extensionSettings.yantai)) c.extensionSettings.yantai = {};
  const config = c.extensionSettings.yantai;
  const listeners = new Set();
  function persist(module) {
    config.schemaVersion = 1;
    host.context().saveSettingsDebounced();
    for (const fn of listeners) { try { fn(config, module); } catch (e) { console.warn('[砚台] 设置回调失败', e.message); } }
  }
  return {
    get: () => config,
    updateModule(name, patch) {
      if (unsafe.has(name)) throw new Error('Invalid settings module');
      config[name] = mergeSettings(isObject(config[name]) ? config[name] : {}, patch); persist(name); return config[name];
    },
    patch(patch) { mergeSettings(config, patch); persist(null); },
    onChange(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    destroy() { listeners.clear(); },
  };
}
