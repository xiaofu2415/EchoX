import { initializeButtonInjector, stopButtonInjector } from './ButtonInjector.js';
import { ECHOX_RUNTIME_BUILD } from '../shared/RuntimeVersion.js';

console.log(`[VideoTranslator] EchoX runtime build: ${ECHOX_RUNTIME_BUILD}`);

initializeButtonInjector();

window.addEventListener('pagehide', () => {
  stopButtonInjector();
}, { once: true });
