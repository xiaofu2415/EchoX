import { LiveRecorder } from './LiveRecorder.js';
import { mountSubtitleManager, unmountSubtitleManager } from './SubtitleManager.js';
import { WsRealtimeClient } from './WsRealtimeClient.js';
import { sendRuntimeMessageSafely } from './RuntimeMessaging.js';
import {
  attachButtonHost,
  findPlayerContext,
  getButtonSize,
  refreshPlayerContext,
  type PlayerContext
} from './PlayerAdapter.js';
import {
  AUTO_TRANSLATE_ON_PLAY_KEY,
  PROVIDER_STORAGE_KEYS,
  readProviderConfig,
  validateProviderConfig
} from '../shared/ProviderConfig.js';
import {
  DEFAULT_SUBTITLE_SETTINGS,
  SUBTITLE_SETTING_KEYS,
  readSubtitleSettings,
  type SubtitleDisplaySettings
} from '../shared/SubtitleSettings.js';

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
const controlVisibilityHandlers = new WeakMap<HTMLElement, EventListener>();
const controlVisibilityTimers = new WeakMap<HTMLElement, number>();
const webAudioCaptures = new WeakMap<
  HTMLVideoElement,
  {
    context: AudioContext;
    source: MediaElementAudioSourceNode;
    destination: MediaStreamAudioDestinationNode;
  }
>();

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

function placeButtonHost(
  host: HTMLElement,
  context: PlayerContext
): void {
  attachButtonHost(host, context);

  const button = host.shadowRoot?.querySelector(
    '#x-translator-btn'
  ) as HTMLButtonElement | null;
  if (button) {
    const size = getButtonSize(context.site);
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
    button.style.padding = '0';
    button.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
  }
}

function bindControlVisibilitySync(
  videoContainer: HTMLElement,
  video: HTMLVideoElement
): void {
  if (controlVisibilityHandlers.has(videoContainer)) {
    return;
  }

  const refreshPlacement = () => {
    if (controlVisibilityTimers.has(videoContainer)) {
      return;
    }
    const timer = window.setTimeout(() => {
      controlVisibilityTimers.delete(videoContainer);
      const currentHost = videoContainer.querySelector(
        '#x-translator-btn-host'
      ) as HTMLElement | null;
      const context = refreshPlayerContext(video);
      if (currentHost && context) {
        placeButtonHost(currentHost, context);
      }
    }, 80);
    controlVisibilityTimers.set(videoContainer, timer);
  };

  videoContainer.addEventListener('pointerenter', refreshPlacement, true);
  videoContainer.addEventListener('pointermove', refreshPlacement, true);
  controlVisibilityHandlers.set(videoContainer, refreshPlacement);
}

function createSettingsPanel(
  videoContainer: HTMLElement,
  video: HTMLVideoElement
): HTMLElement {
  const host = document.createElement('div');
  host.id = 'x-translator-settings-panel-host';
  Object.assign(host.style, {
    position: 'absolute',
    right: '12px',
    bottom: '58px',
    width: 'min(340px, calc(100% - 24px))',
    maxHeight: 'calc(100% - 76px)',
    overflowY: 'auto',
    zIndex: '10002',
    pointerEvents: 'auto',
    display: 'none'
  });

  const shadow = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('section');
  Object.assign(panel.style, {
    boxSizing: 'border-box',
    width: '100%',
    padding: '16px',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    borderRadius: '16px',
    color: '#fff',
    background: 'rgba(12, 14, 20, 0.92)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    boxShadow: '0 18px 45px rgba(0, 0, 0, 0.48)',
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '14px',
    paddingBottom: '12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.14)'
  });
  const title = document.createElement('strong');
  title.textContent = '视频翻译';
  title.style.fontSize = '16px';
  const closeButton = document.createElement('button');
  closeButton.textContent = '×';
  Object.assign(closeButton.style, {
    border: '0',
    color: '#fff',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '24px',
    lineHeight: '1'
  });
  closeButton.onclick = (event) => {
    event.stopPropagation();
    host.style.display = 'none';
  };
  header.append(title, closeButton);
  panel.appendChild(header);

  const controls = document.createElement('div');
  Object.assign(controls.style, {
    display: 'grid',
    gap: '16px'
  });

  const statusCard = document.createElement('div');
  Object.assign(statusCard.style, {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '12px',
    padding: '12px',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: '12px',
    background: 'rgba(255, 255, 255, 0.055)'
  });
  const statusCopy = document.createElement('span');
  Object.assign(statusCopy.style, {
    display: 'grid',
    gap: '3px'
  });
  const statusLabel = document.createElement('small');
  statusLabel.id = 'x-translator-panel-status';
  statusLabel.textContent = isTranslating ? '翻译运行中' : '翻译未开启';
  statusLabel.style.color = '#9ca7bc';
  const statusTitle = document.createElement('strong');
  statusTitle.textContent = '实时双语字幕';
  statusTitle.style.fontSize = '14px';
  statusCopy.append(statusLabel, statusTitle);

  const translationButton = document.createElement('button');
  translationButton.id = 'x-translator-panel-action';
  translationButton.textContent = isTranslating ? '停止' : '开始';
  Object.assign(translationButton.style, {
    height: '34px',
    minWidth: '64px',
    padding: '0 14px',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    borderRadius: '999px',
    color: '#fff',
    background: isTranslating ? '#536471' : '#f91880',
    cursor: 'pointer',
    fontWeight: '750'
  });
  translationButton.onclick = (event) => {
    event.stopPropagation();
    if (isTranslating) {
      stopTranslation();
    } else {
      void startTranslation(video);
    }
  };
  statusCard.append(statusCopy, translationButton);
  controls.appendChild(statusCard);

  const autoRow = document.createElement('label');
  Object.assign(autoRow.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '2px 2px 12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    cursor: 'pointer'
  });
  const autoCopy = document.createElement('span');
  Object.assign(autoCopy.style, {
    display: 'grid',
    gap: '3px'
  });
  const autoTitle = document.createElement('strong');
  autoTitle.textContent = '自动翻译';
  autoTitle.style.fontSize = '13px';
  const autoDescription = document.createElement('small');
  autoDescription.textContent = '视频播放后自动开启翻译';
  autoDescription.style.color = '#8b96aa';
  autoCopy.append(autoTitle, autoDescription);

  const autoToggle = document.createElement('input');
  autoToggle.type = 'checkbox';
  autoToggle.id = 'x-translator-auto-toggle';
  Object.assign(autoToggle.style, {
    width: '19px',
    height: '19px',
    accentColor: '#f91880',
    cursor: 'pointer'
  });
  autoToggle.onchange = () => {
    void chrome.storage.local.set({
      [AUTO_TRANSLATE_ON_PLAY_KEY]: autoToggle.checked,
      autoStartTranslation: autoToggle.checked
    });
  };
  autoRow.append(autoCopy, autoToggle);
  controls.appendChild(autoRow);

  const addRange = (
    label: string,
    key: keyof SubtitleDisplaySettings,
    min: number,
    max: number,
    unit: string,
    prefix = ''
  ) => {
    const wrapper = document.createElement('label');
    Object.assign(wrapper.style, { display: 'grid', gap: '8px' });
    const row = document.createElement('span');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      gap: '12px',
      fontSize: '13px'
    });
    const name = document.createElement('strong');
    name.textContent = label;
    const output = document.createElement('output');
    output.style.color = '#a9b9ff';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.dataset.settingKey = key;
    Object.assign(input.style, {
      width: '100%',
      accentColor: '#788fff',
      cursor: 'pointer'
    });
    input.oninput = () => {
      const value = Number(input.value);
      output.textContent = `${prefix}${value}${unit}`;
      void chrome.storage.local.set({ [key]: value });
    };
    row.append(name, output);
    wrapper.append(row, input);
    controls.appendChild(wrapper);

    return (settings: SubtitleDisplaySettings) => {
      const value = settings[key];
      input.value = String(value);
      output.textContent = `${prefix}${value}${unit}`;
    };
  };

  const applyEnglish = addRange(
    '英文字号',
    'subtitleEnglishFontSize',
    12,
    30,
    'px'
  );
  const applyChinese = addRange(
    '中文字幕号',
    'subtitleChineseFontSize',
    14,
    40,
    'px'
  );
  const applyPosition = addRange(
    '字幕条位置',
    'subtitleBottomPercent',
    4,
    55,
    '%',
    '距底部 '
  );
  const applyBackgroundOpacity = addRange(
    '背景不透明度',
    'subtitleBackgroundOpacity',
    0,
    100,
    '%'
  );

  const resetButton = document.createElement('button');
  resetButton.textContent = '恢复默认';
  Object.assign(resetButton.style, {
    height: '36px',
    marginTop: '2px',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: '10px',
    color: '#e8ebf7',
    background: 'rgba(255, 255, 255, 0.07)',
    cursor: 'pointer',
    fontWeight: '700'
  });
  resetButton.onclick = () => {
    void chrome.storage.local.set(DEFAULT_SUBTITLE_SETTINGS);
    applyEnglish(DEFAULT_SUBTITLE_SETTINGS);
    applyChinese(DEFAULT_SUBTITLE_SETTINGS);
    applyPosition(DEFAULT_SUBTITLE_SETTINGS);
    applyBackgroundOpacity(DEFAULT_SUBTITLE_SETTINGS);
  };
  controls.appendChild(resetButton);
  panel.appendChild(controls);
  shadow.appendChild(panel);
  videoContainer.appendChild(host);

  chrome.storage.local.get(
    [
      ...SUBTITLE_SETTING_KEYS,
      AUTO_TRANSLATE_ON_PLAY_KEY,
      'autoStartTranslation'
    ],
    (result: Record<string, unknown>) => {
      const settings = readSubtitleSettings(result);
      applyEnglish(settings);
      applyChinese(settings);
      applyPosition(settings);
      applyBackgroundOpacity(settings);
      autoToggle.checked =
        result[AUTO_TRANSLATE_ON_PLAY_KEY] === true ||
        result.autoStartTranslation === true;
    }
  );
  return host;
}

function toggleSettingsPanel(
  videoContainer: HTMLElement,
  video: HTMLVideoElement
): void {
  let panel = videoContainer.querySelector(
    '#x-translator-settings-panel-host'
  ) as HTMLElement | null;
  if (!panel) {
    panel = createSettingsPanel(videoContainer, video);
  }
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

/**
 * Checks the current X/Twitter document for a visible video and injects/removes
 * the translation button accordingly. X often opens videos in overlays whose
 * route is not a plain /status/<id> page, so the video element is the source of
 * truth here.
 */
function checkRouteAndInject(): void {
  const context = findPlayerContext();
  if (!context) {
    cleanupAll();
    unbindAutoStartListener();
    return;
  }
  const { video: videoElement, container: videoParent } = context;

  if (isTranslating && activeVideo && activeVideo !== videoElement) {
    cleanupAll();
  }
  bindAutoStartListener(videoElement);

  // 3. Prevent duplicate button injection by checking host container
  let host = videoParent.querySelector('#x-translator-btn-host') as HTMLElement | null;
  
  if (window.getComputedStyle(videoParent).position === 'static') {
    videoParent.style.position = 'relative';
  }

  bindControlVisibilitySync(videoParent, videoElement);
  removeForeignButtonHosts(videoParent);

  if (host && !document.body.contains(host)) {
    console.log('[EchoX] Detected detached translator button host. Forcing recreation.');
    host.remove();
    host = null;
  }

  if (!host) {
    console.log(
      `[VideoTranslator] ${context.site} video found. Injecting translation controls.`
    );
    // Create host element for Shadow DOM encapsulation
    host = document.createElement('div');
    host.id = 'x-translator-btn-host';
    
    const shadow = host.attachShadow({ mode: 'open' });

    // X-style translation icon: sparkle + T on the platform accent color.
    const btn = document.createElement('button');
    btn.id = 'x-translator-btn';
    btn.title = '视频翻译';
    btn.setAttribute('aria-label', '视频翻译');
    btn.innerHTML = `
      <svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">
        <defs>
          <linearGradient id="translateGradient" x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
            <stop stop-color="#2CD7F2"/>
            <stop offset=".5" stop-color="#3C82F6"/>
            <stop offset="1" stop-color="#8D4CF0"/>
          </linearGradient>
          <linearGradient id="translateSheen" x1="7" y1="2" x2="24" y2="30" gradientUnits="userSpaceOnUse">
            <stop stop-color="#FFF" stop-opacity=".2"/>
            <stop offset=".48" stop-color="#FFF" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#translateGradient)"/>
        <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#translateSheen)"/>
        <rect x="1.65" y="1.65" width="28.7" height="28.7" rx="7.35" fill="none" stroke="white" stroke-opacity=".18" stroke-width=".7"/>
        <path d="M9.7 5.2L11.2 9.3L15.3 10.8L11.2 12.3L9.7 16.4L8.2 12.3L4.1 10.8L8.2 9.3L9.7 5.2Z" fill="white"/>
        <path d="M17.1 6.8C21.6 5.45 25.55 7.25 26.45 11.35" fill="none" stroke="white" stroke-width="2.45" stroke-linecap="round"/>
        <path d="M23.35 9.45L26.6 11.75L28.05 8.2" fill="none" stroke="white" stroke-width="2.45" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M14.9 25.2C10.4 26.55 6.45 24.75 5.55 20.65" fill="none" stroke="white" stroke-width="2.45" stroke-linecap="round"/>
        <path d="M8.65 22.55L5.4 20.25L3.95 23.8" fill="none" stroke="white" stroke-width="2.45" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="16.1" y="15.25" width="12.1" height="3.55" rx=".7" fill="white"/>
        <rect x="20.3" y="17.8" width="3.7" height="10.35" rx=".65" fill="white"/>
      </svg>
    `;
    Object.assign(btn.style, {
      width: '30px',
      height: '30px',
      padding: '0',
      border: '0',
      borderRadius: '7px',
      color: '#ffffff',
      background: 'transparent',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.28)',
      transition: 'transform 0.16s ease, filter 0.16s ease',
      outline: 'none',
      overflow: 'hidden'
    });

    btn.onmouseenter = () => {
      btn.style.transform = 'scale(1.06)';
      btn.style.filter = 'brightness(1.08)';
    };
    btn.onmouseleave = () => {
      btn.style.transform = 'none';
      btn.style.filter = 'none';
    };

    btn.onclick = (event: MouseEvent) => {
      event.stopPropagation();
      toggleSettingsPanel(videoParent, videoElement);
    };

    shadow.appendChild(btn);
    placeButtonHost(host, context);
    console.log('[ButtonInjector] Translation button host successfully injected into video overlay.');
  } else {
    placeButtonHost(host, context);
  }

  void maybeAutoStartTranslation(videoElement);
}

function removeForeignButtonHosts(currentContainer: HTMLElement): void {
  const hosts = Array.from(
    document.querySelectorAll(
      '#x-translator-btn-host, #x-translator-settings-panel-host'
    )
  );
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

async function captureVideoAudio(video: HTMLVideoElement): Promise<MediaStream> {
  const capturableVideo = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  const nativeCapture =
    capturableVideo.captureStream || capturableVideo.mozCaptureStream;

  if (nativeCapture) {
    try {
      const stream = nativeCapture.call(video);
      if (stream.getAudioTracks().length > 0) {
        return stream;
      }
    } catch (error) {
      console.warn(
        '[ButtonInjector] Native media capture failed; trying Web Audio fallback.',
        error
      );
    }
  }

  let capture = webAudioCaptures.get(video);
  if (!capture) {
    const AudioContextConstructor =
      window.AudioContext ||
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error('当前浏览器不支持 Web Audio 音频采集。');
    }

    const context = new AudioContextConstructor();
    const source = context.createMediaElementSource(video);
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    source.connect(context.destination);
    capture = { context, source, destination };
    webAudioCaptures.set(video, capture);
  }

  if (capture.context.state === 'suspended') {
    await capture.context.resume();
  }

  if (capture.destination.stream.getAudioTracks().length === 0) {
    throw new Error('播放器没有可采集的音频轨道。');
  }

  console.log('[ButtonInjector] Using Web Audio media-element capture fallback.');
  return capture.destination.stream;
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
    const providerConfig = readProviderConfig(storedConfig);
    const configError = validateProviderConfig(providerConfig);
    if (configError) {
      alert(configError);
      await chrome.runtime.openOptionsPage();
      return;
    }

    if (video.paused) {
      alert('请先播放视频，再启动翻译。');
      return;
    }

    const stream = await captureVideoAudio(video);

    subtitleBufferedUntil = video.currentTime || 0;
    isStartupBuffering = true;

    const playerContext = refreshPlayerContext(video);
    if (!playerContext) {
      throw new Error('播放器已离开当前页面，请重新播放后再试。');
    }
    subtitleOverlay = mountSubtitleManager(
      video,
      playerContext.subtitleContainer,
      playerContext.site
    );

    const isRealtime = providerConfig.openaiModel.includes('realtime');

    activeSessionId = createSessionId();
    activeStream = stream;
    activeVideo = video;
    
    isTranslating = true;
    updateButtonText('🛑 停止');

    if (isRealtime) {
      activeWsClient = new WsRealtimeClient(stream, activeSessionId);
      await activeWsClient.start(providerConfig);
      isStartupBuffering = false;
      // For WebSocket realtime, we don't restart client heavily on pause
      bindVideoPlaybackEvents(video); 
    } else if (playerContext.isLive) {
      activeRecorder = createRecorder(stream, video, activeSessionId);
      activeRecorder.start();
      isStartupBuffering = false;
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
    activeWsClient?.stop();
    activeWsClient = null;
    
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
  sendRuntimeMessageSafely({
    action: 'ABORT_TRANSLATION',
    sessionId: activeSessionId
  }, 'ButtonInjector');
}

function clearSubtitles(): void {
  sendRuntimeMessageSafely({
    action: 'CLEAR_BILINGUAL_SUBTITLES'
  }, 'ButtonInjector');
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
    btn.title = text;
    btn.style.opacity = text.includes('启动') || text.includes('缓冲') ||
      text.includes('等待') ? '0.72' : '1';
  }

  const panelHost = document.querySelector(
    '#x-translator-settings-panel-host'
  ) as HTMLElement | null;
  const panelAction = panelHost?.shadowRoot?.querySelector(
    '#x-translator-panel-action'
  ) as HTMLButtonElement | null;
  const panelStatus = panelHost?.shadowRoot?.querySelector(
    '#x-translator-panel-status'
  ) as HTMLElement | null;
  if (!panelAction || !panelStatus) {
    return;
  }

  const isPending =
    text.includes('启动') ||
    text.includes('缓冲') ||
    text.includes('等待');
  const isActive = text.includes('停止');
  panelAction.disabled = isPending;
  panelAction.textContent = isPending ? '启动中' : isActive ? '停止' : '开始';
  panelAction.style.background = isActive ? '#536471' : '#f91880';
  panelAction.style.opacity = isPending ? '0.65' : '1';
  panelAction.style.cursor = isPending ? 'wait' : 'pointer';
  panelStatus.textContent = isPending
    ? text
    : isActive
      ? '翻译运行中'
      : '翻译未开启';
}

/**
 * Removes the button element from the page DOM.
 */
function removeButtonOnly(): void {
  const hosts = document.querySelectorAll(
    '#x-translator-btn-host, #x-translator-settings-panel-host'
  );
  for (const host of hosts) {
    host.remove();
  }
  console.log('[ButtonInjector] Removed translation controls from DOM.');
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
