import { LiveRecorder } from './LiveRecorder.js';
import { mountSubtitleManager, unmountSubtitleManager } from './SubtitleManager.js';
import { WsRealtimeClient } from './WsRealtimeClient.js';
import {
  AUTO_TRANSLATE_ON_PLAY_KEY,
  PROVIDER_STORAGE_KEYS,
  readProviderConfig,
  validateProviderConfig
} from '../shared/ProviderConfig.js';

let pollIntervalId: any = null;
let activeRecorder: LiveRecorder | null = null;
let activeWsClient: WsRealtimeClient | null = null;
let subtitleOverlay: HTMLElement | null = null;
let isTranslating = false;
let isStarting = false;
let activeVideo: HTMLVideoElement | null = null;
let activeSessionId: string | null = null;
let activeStream: MediaStream | null = null;
let isStartupBuffering = false;
let autoStartVideo: HTMLVideoElement | null = null;
let autoStartListener: EventListener | null = null;
let subtitleBufferedUntil = 0;
let syncWatchdogId: number | null = null;
let isWaitingForSubtitle = false;
const activeVideoListeners = new Map<string, EventListener>();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'GET_TRANSLATION_PLAYBACK_TIME') {
    sendResponse({ currentTime: activeVideo?.currentTime });
    return false;
  }
  if (
    message?.action === 'UPDATE_BILINGUAL_SUBTITLES' &&
    typeof message.endTime === 'number'
  ) {
    subtitleBufferedUntil = Math.max(subtitleBufferedUntil, message.endTime);
  }
  return false;
});

/**
 * Finds a robust, visible container in X's video tree to host the translator button.
 * Walks up the ancestor chain and prioritizes containers with Twitter player identifiers.
 */
function findSuitableVideoContainer(video: HTMLVideoElement): HTMLElement | null {
  let current = video.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 5) {
    const testId = current.getAttribute('data-testid');
    if (testId === 'videoPlayer' || testId === 'videoComponent') {
      return current;
    }
    current = current.parentElement;
    depth++;
  }
  
  // Fallback: Use ancestor at depth 2 (grandparent) or depth 1 (parent)
  const fallback = video.parentElement?.parentElement || video.parentElement;
  return fallback;
}

/**
 * Checks the current X/Twitter document for a visible video and injects/removes
 * the translation button accordingly. X often opens videos in overlays whose
 * route is not a plain /status/<id> page, so the video element is the source of
 * truth here.
 */
function checkRouteAndInject(): void {
  const videoElement = findPrimaryVideo();
  if (!videoElement) {
    cleanupAll();
    unbindAutoStartListener();
    return;
  }

  if (isTranslating && activeVideo && activeVideo !== videoElement) {
    cleanupAll();
  }
  bindAutoStartListener(videoElement);

  const videoParent = findSuitableVideoContainer(videoElement);
  if (!videoParent) {
    console.log('[EchoX] No suitable parent container found for video element.');
    return;
  }

  // 3. Prevent duplicate button injection by checking host container
  let host = videoParent.querySelector('#x-translator-btn-host') as HTMLElement | null;
  
  if (window.getComputedStyle(videoParent).position === 'static') {
    videoParent.style.position = 'relative';
  }

  removeForeignButtonHosts(videoParent);

  if (host && !document.body.contains(host)) {
    console.log('[EchoX] Detected detached translator button host. Forcing recreation.');
    host.remove();
    host = null;
  }

  if (!host) {
    console.log('[EchoX] Video found. Injecting translation button host container...');
    // Create host element for Shadow DOM encapsulation
    host = document.createElement('div');
    host.id = 'x-translator-btn-host';
    
    // Absolute position host wrapper
    Object.assign(host.style, {
      position: 'absolute',
      bottom: '65px', // Positions button cleanly above the standard video overlay controls
      right: '16px',
      zIndex: '10000',
      pointerEvents: 'auto'
    });

    const shadow = host.attachShadow({ mode: 'open' });

    // Create the actual button inside the Shadow DOM
    const btn = document.createElement('button');
    btn.id = 'x-translator-btn';
    btn.innerText = isTranslating ? '🛑 停止' : '✨ 翻译';

    // Apply high-end modern styling matching X's dark aesthetics
    Object.assign(btn.style, {
      backgroundColor: 'rgba(15, 23, 42, 0.75)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      border: '1px solid rgba(255, 255, 255, 0.25)',
      color: '#ffffff',
      padding: '8px 18px',
      borderRadius: '20px',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: 'bold',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
      transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      outline: 'none',
      borderStyle: 'solid'
    });

    // Hover dynamic transitions
    btn.onmouseenter = () => {
      btn.style.backgroundColor = 'rgba(15, 23, 42, 0.9)';
      btn.style.transform = 'scale(1.05)';
    };
    btn.onmouseleave = () => {
      btn.style.backgroundColor = 'rgba(15, 23, 42, 0.75)';
      btn.style.transform = 'none';
    };

    btn.onclick = (event: MouseEvent) => {
      event.stopPropagation();
      
      if (isTranslating) {
        stopTranslation();
      } else {
        void startTranslation(videoElement);
      }
    };

    shadow.appendChild(btn);
    videoParent.appendChild(host);
    console.log('[ButtonInjector] Translation button host successfully injected into video overlay.');
  }

  void maybeAutoStartTranslation(videoElement);
}

function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video'));
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const visibleVideos = videos
    .map((video) => ({ video, rect: video.getBoundingClientRect() }))
    .filter(({ rect }) => {
      const intersectsViewport =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < viewportHeight &&
        rect.left < viewportWidth;
      return rect.width > 0 && rect.height > 0 && intersectsViewport;
    });

  visibleVideos.sort((a, b) => {
    const viewportArea = viewportWidth * viewportHeight;
    const score = (rect: DOMRect) => {
      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
      );
      const visibleArea = visibleWidth * visibleHeight;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distanceFromCenter =
        Math.abs(centerX - viewportWidth / 2) / viewportWidth +
        Math.abs(centerY - viewportHeight / 2) / viewportHeight;
      return visibleArea / Math.max(1, viewportArea) - distanceFromCenter * 0.05;
    };
    return score(b.rect) - score(a.rect);
  });

  return visibleVideos[0]?.video || null;
}

function removeForeignButtonHosts(currentContainer: HTMLElement): void {
  const hosts = Array.from(document.querySelectorAll('#x-translator-btn-host'));
  for (const host of hosts) {
    if (!currentContainer.contains(host)) {
      host.remove();
    }
  }
}

function bindAutoStartListener(video: HTMLVideoElement): void {
  if (autoStartVideo === video && autoStartListener) {
    return;
  }
  unbindAutoStartListener();
  autoStartVideo = video;
  autoStartListener = () => {
    void maybeAutoStartTranslation(video);
  };
  video.addEventListener('play', autoStartListener);
}

function unbindAutoStartListener(): void {
  if (autoStartVideo && autoStartListener) {
    autoStartVideo.removeEventListener('play', autoStartListener);
  }
  autoStartVideo = null;
  autoStartListener = null;
}

async function maybeAutoStartTranslation(video: HTMLVideoElement): Promise<void> {
  if (isStarting || isTranslating || video.paused) {
    return;
  }
  try {
    const result = await chrome.storage.local.get([
      AUTO_TRANSLATE_ON_PLAY_KEY,
      'autoStartTranslation'
    ]);
    if (
      result[AUTO_TRANSLATE_ON_PLAY_KEY] === true ||
      result.autoStartTranslation === true
    ) {
      await startTranslation(video);
    }
  } catch (error) {
    console.warn('[ButtonInjector] Auto translation start check failed:', error);
  }
}

/**
 * Initiates the video capture, audio recording, and subtitle rendering.
 * 
 * @param video The HTMLVideoElement to translate.
 */
async function startTranslation(video: HTMLVideoElement): Promise<void> {
  if (isStarting || isTranslating) {
    return;
  }

  isStarting = true;
  updateButtonText('正在启动...');

  try {
    const storedConfig = await chrome.storage.local.get(PROVIDER_STORAGE_KEYS);
    const configError = validateProviderConfig(
      readProviderConfig(storedConfig)
    );
    if (configError) {
      alert(configError);
      await chrome.runtime.openOptionsPage();
      return;
    }

    if (video.paused) {
      alert('请先播放视频，再启动翻译。');
      return;
    }

    const capturableVideo = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const captureStream =
      capturableVideo.captureStream || capturableVideo.mozCaptureStream;
    const stream = captureStream?.call(video) || null;
    if (!stream) {
      console.error('[ButtonInjector] captureStream API is not supported or accessible on this element.');
      alert('抱歉，当前浏览器不支持捕获此视频的音频流。');
      return;
    }

    subtitleBufferedUntil = video.currentTime || 0;
    isStartupBuffering = true;

    subtitleOverlay = mountSubtitleManager(video);

    const isRealtime = storedConfig.openaiModel?.includes('realtime');

    activeSessionId = createSessionId();
    activeStream = stream;
    activeVideo = video;
    
    isTranslating = true;
    updateButtonText('🛑 停止');

    if (isRealtime) {
      activeWsClient = new WsRealtimeClient(stream, activeSessionId);
      await activeWsClient.start(storedConfig);
      isStartupBuffering = false;
      // For WebSocket realtime, we don't restart client heavily on pause
      bindVideoPlaybackEvents(video); 
    } else {
      const originalTime = video.currentTime;
      const originalMuted = video.muted;
      
      activeRecorder = createRecorder(stream, video, activeSessionId, true);
      activeRecorder.start();
      bindVideoPlaybackEvents(video);

      await runStartupBuffer(video, originalTime, originalMuted, activeSessionId);
      
      if (!isTranslating) return;

      activeRecorder = createRecorder(stream, video, activeSessionId, false);
      activeRecorder.start();
    }
    
    console.log('[ButtonInjector] Translation engine started.');
  } catch (err: any) {
    console.error('[ButtonInjector] Failed to start translation:', err);
    activeRecorder?.stop();
    activeRecorder = null;
    
    // Do NOT unmount the subtitle manager here. If WsRealtimeClient dispatched an error subtitle,
    // we want the user to be able to read it!
    // Instead, let's inject a fallback error subtitle just in case.
    if (subtitleOverlay) {
      window.dispatchEvent(new CustomEvent('ws-subtitle-update', {
        detail: {
          id: 'fatal-error',
          textEn: 'Translation startup failed.',
          textZh: '翻译引擎启动失败: ' + (err?.message || err),
          isFinal: false
        }
      }));
    }

    activeSessionId = null;
    activeVideo = null;
    activeStream = null;
    isStartupBuffering = false;
    video.muted = false;
    isTranslating = false;
  } finally {
    isStarting = false;
    if (!isTranslating) {
      updateButtonText('✨ 翻译');
    }
  }
}



async function runStartupBuffer(
  video: HTMLVideoElement,
  originalTime: number,
  originalMuted: boolean,
  sessionId: string
): Promise<void> {
  isStartupBuffering = true;
  updateButtonText('正在缓冲首句...');
  
  video.muted = true;
  await video.play().catch(() => undefined);

  // Wait 1.5s for the LiveRecorder's startup window to finish
  await new Promise(resolve => setTimeout(resolve, 1500));

  if (!isStarting && !isTranslating) return;

  video.pause();
  activeRecorder?.stop();
  activeRecorder = null;
  updateButtonText('等待首句字幕...');

  // Wait for the first subtitle chunk to arrive from the background
  await new Promise<void>(resolve => {
    let handled = false;
    const timeout = setTimeout(() => {
      if (!handled) {
        handled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    }, 4500);

    const listener = (msg: any) => {
      if (
        msg.action === 'UPDATE_BILINGUAL_SUBTITLES' &&
        msg.id?.includes(sessionId)
      ) {
        if (!handled) {
          handled = true;
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });

  if (!isStarting && !isTranslating) return;

  isStartupBuffering = false;
  video.currentTime = originalTime;
  video.muted = originalMuted;
  updateButtonText('🛑 停止');
  await video.play().catch(() => undefined);
}

function createRecorder(
  stream: MediaStream,
  video: HTMLVideoElement,
  sessionId: string,
  startupOnly = false
): LiveRecorder {
  return new LiveRecorder(stream, sessionId, {
    getCurrentTime: () => video.currentTime || 0,
    startupOnly,
    includeStartupWindows: startupOnly
  });
}

function bindVideoPlaybackEvents(video: HTMLVideoElement): void {
  unbindVideoPlaybackEvents();

  const pauseListener = () => {
    if (
      (!isTranslating && !isStarting) ||
      isStartupBuffering ||
      isWaitingForSubtitle
    ) {
      return;
    }
    if (activeWsClient) {
      // For realtime websocket, we just leave it open to minimize latency. 
      // DashScope ASR can handle silence. Or we could stop and restart, but let's just let it stream silence.
    } else {
      activeRecorder?.stop();
      activeRecorder = null;
      cancelActiveSession();
    }
  };

  const playListener = () => {
    if (
      isStartupBuffering ||
      !isTranslating ||
      !activeStream ||
      !activeSessionId ||
      activeRecorder ||
      activeWsClient
    ) {
      return;
    }
    activeRecorder = createRecorder(activeStream, video, activeSessionId);
    activeRecorder.start();
  };

  const seekListener = () => {
    if ((!isTranslating && !isStarting) || isStartupBuffering) return;
    
    if (activeWsClient) {
      clearSubtitles();
      subtitleBufferedUntil = video.currentTime || 0;
      return;
    }

    activeRecorder?.stop();
    activeRecorder = null;
    cancelActiveSession();
    clearSubtitles();
    subtitleBufferedUntil = video.currentTime || 0;
    if (!video.paused && activeStream && activeSessionId) {
      activeRecorder = createRecorder(activeStream, video, activeSessionId);
      activeRecorder.start();
    }
  };

  const endedListener = () => {
    if (isTranslating) {
      stopTranslation();
    }
  };

  activeVideoListeners.set('pause', pauseListener);
  activeVideoListeners.set('play', playListener);
  activeVideoListeners.set('seeking', seekListener);
  activeVideoListeners.set('ended', endedListener);

  for (const [eventName, listener] of activeVideoListeners) {
    video.addEventListener(eventName, listener);
  }
}

function unbindVideoPlaybackEvents(): void {
  if (activeVideo) {
    for (const [eventName, listener] of activeVideoListeners) {
      activeVideo.removeEventListener(eventName, listener);
    }
  }
  activeVideoListeners.clear();
}

function cancelActiveSession(): void {
  chrome.runtime.sendMessage({
    action: 'ABORT_TRANSLATION',
    sessionId: activeSessionId
  });
}

function clearSubtitles(): void {
  chrome.runtime.sendMessage({
    action: 'CLEAR_BILINGUAL_SUBTITLES'
  });
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stops translation recording, removes subtitle overlay, and signals the background to cancel translation.
 */
function stopTranslation(): void {
  unbindVideoPlaybackEvents();

  // 1. Release MediaRecorder/WebSocket handles
  if (activeRecorder) {
    activeRecorder.stop();
    activeRecorder = null;
  }
  if (activeWsClient) {
    activeWsClient.stop();
    activeWsClient = null;
  }

  // 2. Unmount subtitle React rendering tree
  if (subtitleOverlay) {
    unmountSubtitleManager(subtitleOverlay);
    subtitleOverlay = null;
  }

  isTranslating = false;
  isStarting = false;
  activeVideo = null;
  activeStream = null;
  subtitleBufferedUntil = 0;
  updateButtonText('✨ 翻译');

  cancelActiveSession();
  activeSessionId = null;
  console.log('[ButtonInjector] Translation engine stopped.');
}

/**
 * Small utility to hot-update the injected button text.
 */
function updateButtonText(text: string): void {
  const host = document.querySelector('#x-translator-btn-host') as HTMLElement | null;
  const btn = host?.shadowRoot?.querySelector('#x-translator-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.innerText = text;
  }
}

/**
 * Removes the button element from the page DOM.
 */
function removeButtonOnly(): void {
  const host = document.querySelector('#x-translator-btn-host');
  if (host) {
    host.remove();
    console.log('[ButtonInjector] Removed translation button host from DOM.');
  }
}

/**
 * Performs full cleanup of DOM components and stops any active translation processes.
 */
function cleanupAll(): void {
  removeButtonOnly();
  unbindAutoStartListener();
  if (isStarting || isTranslating || activeRecorder || subtitleOverlay) {
    console.log('[ButtonInjector] Page route transition detected. Resetting translation session.');
    stopTranslation();
  }
}

/**
 * Initializes the route patrol loop at a 1000ms frequency.
 */
export function initializeButtonInjector(): void {
  if (pollIntervalId) {
    console.warn('[ButtonInjector] Injector patrol loop is already active.');
    return;
  }
  checkRouteAndInject();
  pollIntervalId = setInterval(checkRouteAndInject, 1000);
  console.log('[ButtonInjector] Active keep-alive polling patrol initiated.');
}

/**
 * Shuts down the poll loop and clears active sessions.
 */
export function stopButtonInjector(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  cleanupAll();
  console.log('[ButtonInjector] Injector patrol loop stopped.');
}
