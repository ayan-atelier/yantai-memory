import { createMemoryApp } from './src/app.js';
import { lifecycle } from './shared/lifecycle.js';

const runtime = lifecycle(createMemoryApp, '砚台 · 叙事记忆');
globalThis.yantaiMemoryGenerationInterceptor = (...args) => runtime.intercept(...args);
export const onEnable = runtime.enable;
export const onDisable = runtime.disable;
if (globalThis.SillyTavern?.getContext) onEnable();
else window.addEventListener('load', onEnable, { once: true });
