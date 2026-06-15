import { initializeButtonInjector, stopButtonInjector } from './ButtonInjector.js';
import { initializeVodInterceptor } from './VodInterceptor.js';

initializeButtonInjector();
if (
  location.hostname.endsWith('x.com') ||
  location.hostname.endsWith('twitter.com')
) {
  initializeVodInterceptor();
}

window.addEventListener('pagehide', () => {
  stopButtonInjector();
}, { once: true });
