import { initializeButtonInjector, stopButtonInjector } from './ButtonInjector.js';
import { initializeVodInterceptor } from './VodInterceptor.js';

initializeButtonInjector();
initializeVodInterceptor();

window.addEventListener('pagehide', () => {
  stopButtonInjector();
}, { once: true });
