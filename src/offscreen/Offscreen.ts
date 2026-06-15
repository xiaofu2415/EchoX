interface SessionState {
  ws: WebSocket | null;
  sessionId: string;
  tabId?: number;
  frameId?: number;
  model: string;
  taskId: string;
  isGummyReady: boolean;
  gummyAudioQueue: ArrayBuffer[];
  pendingAudioQueue: string[];
  currentSequence: number;
  baseSequence: number;
  currentEn: string;
  currentZh: string;
  lastItemId: string;
  wsConnectStartedAt: number;
  measuredConnectLatencyMs: number;
  protocolRequestSentAt: number;
  networkProfileReady: boolean;
  stopped: boolean;
  closeTimer: number | null;
}

const MAX_PENDING_AUDIO_CHUNKS = 100;
const activeSessions = new Map<string, SessionState>();
const EXPECTED_RUNTIME_ERRORS =
  /receiving end does not exist|message port closed/i;

function isCurrentSession(state: SessionState): boolean {
  return activeSessions.get(state.sessionId) === state && !state.stopped;
}

function sendSessionMessage(
  state: SessionState,
  action: string,
  payload: Record<string, unknown> = {}
): void {
  try {
    void chrome.runtime
      .sendMessage({
        action,
        sessionId: state.sessionId,
        tabId: state.tabId,
        frameId: state.frameId,
        ...payload
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (!EXPECTED_RUNTIME_ERRORS.test(detail)) {
          console.warn('[Offscreen] Failed to send session message:', error);
        }
      });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!EXPECTED_RUNTIME_ERRORS.test(detail)) {
      console.warn('[Offscreen] Failed to send session message:', error);
    }
  }
}

function reportNetworkProfile(
  state: SessionState,
  protocolLatencyMs?: number
): void {
  sendSessionMessage(state, 'OFFSCREEN_WS_NETWORK_PROFILE', {
    connectLatencyMs: state.measuredConnectLatencyMs || undefined,
    protocolLatencyMs
  });
}

function decodeBase64Audio(base64Audio: string): ArrayBuffer {
  const binaryString = window.atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function clearSessionQueues(state: SessionState): void {
  state.pendingAudioQueue = [];
  state.gummyAudioQueue = [];
  state.isGummyReady = false;
}

function closeSession(state: SessionState, graceful: boolean): void {
  if (state.stopped) {
    return;
  }

  state.stopped = true;
  clearSessionQueues(state);
  if (activeSessions.get(state.sessionId) === state) {
    activeSessions.delete(state.sessionId);
  }

  if (state.closeTimer !== null) {
    window.clearTimeout(state.closeTimer);
    state.closeTimer = null;
  }

  const socket = state.ws;
  state.ws = null;
  if (!socket) {
    return;
  }

  if (graceful && socket.readyState === WebSocket.OPEN) {
    try {
      if (state.model.includes('gummy')) {
        socket.send(JSON.stringify({
          header: {
            action: 'finish-task',
            task_id: state.taskId
          },
          payload: {}
        }));
      } else {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    } catch (error) {
      console.warn('[Offscreen] Failed to finalize WebSocket session:', error);
    }

    state.closeTimer = window.setTimeout(() => {
      state.closeTimer = null;
      socket.close();
    }, 500);
    return;
  }

  socket.close();
}

function sendSubtitle(
  state: SessionState,
  id: string,
  textEn: string,
  textZh: string,
  isFinal: boolean
): void {
  sendSessionMessage(state, 'OFFSCREEN_WS_SUBTITLE', {
    id,
    textEn,
    textZh,
    isFinal
  });
}

function sendError(state: SessionState, message: string): void {
  sendSessionMessage(state, 'OFFSCREEN_WS_ERROR', { message });
}

function handleGummyMessage(state: SessionState, data: any): boolean {
  if (!data.header?.event) {
    return false;
  }

  if (data.header.event === 'task-failed') {
    console.error('[Offscreen] Gummy API Error:', data);
    sendError(
      state,
      `翻译任务失败: ${data.header.error_message || JSON.stringify(data)}`
    );
    return true;
  }

  if (data.header.event === 'task-started') {
    state.isGummyReady = true;
    const socket = state.ws;
    if (socket?.readyState === WebSocket.OPEN) {
      for (const buffer of state.gummyAudioQueue) {
        socket.send(buffer);
      }
    }
    state.gummyAudioQueue = [];
    return true;
  }

  if (data.header.event !== 'result-generated') {
    return true;
  }

  const payload = data.payload || {};
  const output = payload.output || {};

  let text = '';
  if (output.transcription) {
    if (typeof output.transcription === 'string') {
      text = output.transcription;
    } else if (typeof output.transcription.text === 'string') {
      text = output.transcription.text;
    }
  }

  let translation = '';
  if (output.translations) {
    if (output.translations.translations) {
      const translationMap = output.translations.translations;
      if (translationMap.zh?.text) {
        translation = translationMap.zh.text;
      } else {
        const language = Object.keys(translationMap)[0];
        translation = language ? translationMap[language]?.text || '' : '';
      }
    } else if (Array.isArray(output.translations)) {
      const zhItem = output.translations.find(
        (item: any) => item.language === 'zh' || item.lang === 'zh'
      );
      translation = zhItem?.text || output.translations[0]?.text || '';
    } else if (output.translations.zh?.text) {
      translation = output.translations.zh.text;
    } else {
      for (const key of Object.keys(output.translations)) {
        if (output.translations[key]?.text) {
          translation = output.translations[key].text;
          break;
        }
      }
    }
  }

  const isSentenceEnd = Boolean(
    output.transcription?.sentenceEnd ||
    output.transcription?.sentence_end ||
    output.translations?.sentenceEnd ||
    output.translations?.sentence_end ||
    payload.sentence_end ||
    payload.sentenceEnd ||
    output.sentenceEnd ||
    output.sentence_end
  );

  if (text) {
    state.currentEn = text;
  }
  if (translation) {
    state.currentZh = translation;
  }

  const enResult = splitIntoSentences(state.currentEn, false);
  const zhResult = splitIntoSentences(state.currentZh, true);
  const matchedCount = Math.min(
    enResult.sentences.length,
    zhResult.sentences.length
  );

  for (let i = 0; i < matchedCount; i++) {
    sendSubtitle(
      state,
      `live-${state.sessionId}-ws-${state.baseSequence + i}`,
      enResult.sentences[i],
      zhResult.sentences[i],
      true
    );
  }

  const activeEn = (
    enResult.sentences.slice(matchedCount).join(' ') +
    ' ' +
    (enResult.active[0] || '')
  ).trim();
  const activeZh = (
    zhResult.sentences.slice(matchedCount).join('') +
    (zhResult.active[0] || '')
  ).trim();

  if (!isSentenceEnd && (activeEn || activeZh)) {
    sendSubtitle(
      state,
      `live-${state.sessionId}-ws-${state.baseSequence + matchedCount}`,
      activeEn,
      activeZh,
      false
    );
  }

  if (isSentenceEnd) {
    const hasActive = Boolean(activeEn || activeZh);
    if (hasActive) {
      sendSubtitle(
        state,
        `live-${state.sessionId}-ws-${state.baseSequence + matchedCount}`,
        activeEn,
        activeZh,
        true
      );
    }
    state.currentSequence =
      state.baseSequence + matchedCount + (hasActive ? 1 : 0);
    state.baseSequence = state.currentSequence;
    state.currentEn = '';
    state.currentZh = '';
  }

  return true;
}

function handleRealtimeMessage(state: SessionState, data: any): void {
  if (data.type === 'error') {
    console.error('[Offscreen] API Error:', data.error);
    sendError(
      state,
      `翻译任务失败: ${data.error?.message || JSON.stringify(data.error)}`
    );
    return;
  }

  let hasDelta = false;

  if (
    data.type === 'response.text.delta' ||
    data.type === 'response.translation.delta' ||
    data.type === 'response.audio_transcript.delta'
  ) {
    state.currentZh += data.delta || '';
    hasDelta = true;
  }

  if (
    data.type === 'response.audio_transcript.text' ||
    data.type === 'response.text.text' ||
    data.type === 'response.translation.text'
  ) {
    const fullText = data.text || '';
    const stash = data.stash || '';
    let recentEn = '';
    let recentZh = '';

    try {
      const parts = fullText
        .split(/(?<=[。！？.!?])\s*/)
        .filter((part: string) => part.trim().length > 0);
      const lastPart = parts.slice(-1).join(' ') + stash;
      if (lastPart.includes('|')) {
        const segments = lastPart.split('|');
        recentEn = segments[0]?.trim() || '';
        recentZh = segments[1]?.trim() || '';
      } else {
        recentZh = lastPart;
      }
    } catch {
      // Ignore malformed incremental text and wait for the next event.
    }

    if (recentEn || recentZh) {
      if (recentEn) {
        state.currentEn = recentEn;
      }
      if (recentZh) {
        state.currentZh = recentZh;
      }
      hasDelta = true;
    }

    if (data.item_id && data.item_id !== state.lastItemId) {
      if (state.lastItemId) {
        state.currentSequence++;
      }
      state.lastItemId = data.item_id;
    }
  }

  if (
    data.type === 'conversation.item.input_audio_transcription.completed' &&
    data.transcript
  ) {
    state.currentEn = data.transcript;
    hasDelta = true;
  }

  if (hasDelta) {
    sendSubtitle(
      state,
      `live-${state.sessionId}-ws-${state.currentSequence}`,
      state.currentEn,
      state.currentZh,
      false
    );
  }

  const isDone =
    data.type === 'response.text.done' ||
    data.type === 'response.translation.done' ||
    data.type === 'response.audio_transcript.done' ||
    data.type === 'response.done' ||
    data.type === 'item.completed';

  if (isDone) {
    if (data.transcript) {
      state.currentZh = data.transcript;
    }
    if (data.text) {
      state.currentZh = data.text;
    }
    if (data.translation) {
      state.currentZh = data.translation;
    }

    if (data.item?.content) {
      for (const content of data.item.content) {
        if (content.transcript) {
          state.currentZh = content.transcript;
        }
        if (content.text) {
          state.currentZh = content.text;
        }
      }
    }

    if (
      state.currentEn.trim() ||
      state.currentZh.trim() ||
      data.type === 'item.completed'
    ) {
      sendSubtitle(
        state,
        `live-${state.sessionId}-ws-${state.currentSequence}`,
        state.currentEn,
        state.currentZh,
        true
      );
      state.currentSequence++;
      state.currentEn = '';
      state.currentZh = '';
    }
    return;
  }

  if (
    !hasDelta &&
    data.type !== 'response.audio.delta' &&
    data.type !== 'response.audio.done'
  ) {
    try {
      const copy = { ...data };
      delete copy.item;
      console.log('[Offscreen] Ignored event:', data.type, copy);
    } catch {
      // Logging should never interrupt audio processing.
    }
  }
}

function createSessionState(
  sessionId: string,
  tabId: number | undefined,
  frameId: number | undefined,
  model: string
): SessionState {
  return {
    ws: null,
    sessionId,
    tabId,
    frameId,
    model,
    taskId: crypto.randomUUID().replace(/-/g, ''),
    isGummyReady: false,
    gummyAudioQueue: [],
    pendingAudioQueue: [],
    currentSequence: 0,
    baseSequence: 0,
    currentEn: '',
    currentZh: '',
    lastItemId: '',
    wsConnectStartedAt: performance.now(),
    measuredConnectLatencyMs: 0,
    protocolRequestSentAt: 0,
    networkProfileReady: false,
    stopped: false,
    closeTimer: null
  };
}

function startSession(msg: any, sendResponse: (response?: any) => void): void {
  const sessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
  if (!sessionId) {
    sendResponse({ ok: false, error: 'Missing sessionId.' });
    return;
  }

  const existing = activeSessions.get(sessionId);
  if (existing) {
    closeSession(existing, false);
  }

  const state = createSessionState(
    sessionId,
    typeof msg.tabId === 'number' ? msg.tabId : undefined,
    typeof msg.frameId === 'number' ? msg.frameId : undefined,
    typeof msg.model === 'string' ? msg.model : ''
  );
  activeSessions.set(sessionId, state);

  try {
    console.log('[Offscreen] Connecting session:', sessionId, msg.wsUrl);
    const socket = new WebSocket(msg.wsUrl);
    state.ws = socket;
    sendResponse({ ok: true });

    socket.onopen = () => {
      if (!isCurrentSession(state) || state.ws !== socket) {
        socket.close();
        return;
      }

      console.log('[Offscreen] WebSocket connected. Session:', sessionId);
      state.measuredConnectLatencyMs = Math.max(
        0,
        performance.now() - state.wsConnectStartedAt
      );
      reportNetworkProfile(state);
      state.protocolRequestSentAt = performance.now();

      if (state.model.includes('gummy')) {
        state.gummyAudioQueue.push(
          ...state.pendingAudioQueue.map(decodeBase64Audio)
        );
        state.pendingAudioQueue = [];
        socket.send(JSON.stringify({
          header: {
            action: 'run-task',
            task_id: state.taskId,
            streaming: 'duplex'
          },
          payload: {
            model: state.model,
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            input: {},
            parameters: {
              sample_rate: 16000,
              format: 'pcm',
              transcription_enabled: true,
              translation_enabled: true,
              translation_target_languages: ['zh']
            }
          }
        }));
        return;
      }

      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions:
            "You are a real-time speech translator. Listen to the English audio and translate it to Chinese. Output exactly: English transcript | Chinese translation.",
          input_audio_transcription: {
            model: 'qwen3-asr-flash-realtime',
            language: 'en'
          },
          translation: {
            language: 'zh'
          }
        }
      }));

      for (const base64Audio of state.pendingAudioQueue) {
        socket.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Audio
        }));
      }
      state.pendingAudioQueue = [];
    };

    socket.onmessage = (event) => {
      if (!isCurrentSession(state) || state.ws !== socket) {
        return;
      }

      try {
        const data = JSON.parse(event.data);
        if (!state.networkProfileReady) {
          const isProtocolReady =
            data.type === 'session.created' ||
            data.type === 'session.updated' ||
            data.header?.event === 'task-started';
          if (isProtocolReady) {
            state.networkProfileReady = true;
            reportNetworkProfile(
              state,
              state.protocolRequestSentAt
                ? Math.max(0, performance.now() - state.protocolRequestSentAt)
                : undefined
            );
          }
        }

        if (!handleGummyMessage(state, data)) {
          handleRealtimeMessage(state, data);
        }
      } catch (error) {
        console.warn('[Offscreen] Failed to parse message', error, event.data);
      }
    };

    socket.onerror = (event) => {
      if (isCurrentSession(state)) {
        console.error('[Offscreen] WebSocket error. Session:', sessionId, event);
      }
    };

    socket.onclose = (event) => {
      if (state.ws === socket) {
        state.ws = null;
      }
      if (!isCurrentSession(state)) {
        return;
      }

      activeSessions.delete(sessionId);
      clearSessionQueues(state);
      console.log(
        `[Offscreen] WebSocket closed. Session: ${sessionId}, Code: ${event.code}, Reason: ${event.reason}`
      );
      if (event.code === 1006) {
        sendError(
          state,
          'WebSocket 连接被拒绝（Code 1006）。请确认：1) API Key 是否有效 2) 是否已在百炼控制台开通该模型权限。'
        );
      } else if (event.code !== 1000 && event.code !== 1005) {
        sendError(
          state,
          `WebSocket 连接关闭（Code ${event.code}）: ${event.reason || '未知原因'}`
        );
      }
    };
  } catch (error) {
    activeSessions.delete(sessionId);
    clearSessionQueues(state);
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Offscreen] Failed to create WebSocket:', error);
    sendError(state, `创建 WebSocket 失败: ${message}`);
    sendResponse({ ok: false, error: message });
  }
}

// Notify background that the single offscreen document is ready.
try {
  void chrome.runtime
    .sendMessage({ action: 'OFFSCREEN_READY' })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (!EXPECTED_RUNTIME_ERRORS.test(detail)) {
        console.warn('[Offscreen] Failed to report readiness:', error);
      }
    });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (!EXPECTED_RUNTIME_ERRORS.test(detail)) {
    console.warn('[Offscreen] Failed to report readiness:', error);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') {
    return false;
  }

  if (msg.action === 'start_ws') {
    startSession(msg, sendResponse);
    return true;
  }

  if (msg.action === 'send_audio') {
    const state =
      typeof msg.sessionId === 'string'
        ? activeSessions.get(msg.sessionId)
        : undefined;
    if (!state || state.stopped) {
      sendResponse({ ok: false, error: 'Session not found.' });
      return false;
    }

    if (typeof msg.base64Audio !== 'string') {
      sendResponse({ ok: false, error: 'Invalid audio payload.' });
      return false;
    }

    const socket = state.ws;
    if (socket?.readyState === WebSocket.OPEN) {
      if (state.model.includes('gummy')) {
        const audioBuffer = decodeBase64Audio(msg.base64Audio);
        if (state.isGummyReady) {
          socket.send(audioBuffer);
        } else {
          state.gummyAudioQueue.push(audioBuffer);
          if (state.gummyAudioQueue.length > MAX_PENDING_AUDIO_CHUNKS) {
            state.gummyAudioQueue.shift();
          }
        }
      } else {
        socket.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.base64Audio
        }));
      }
    } else {
      state.isGummyReady = false;
      state.pendingAudioQueue.push(msg.base64Audio);
      if (state.pendingAudioQueue.length > MAX_PENDING_AUDIO_CHUNKS) {
        state.pendingAudioQueue.shift();
      }
    }

    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'stop_ws') {
    const state =
      typeof msg.sessionId === 'string'
        ? activeSessions.get(msg.sessionId)
        : undefined;
    if (state) {
      console.log('[Offscreen] Stopping session:', state.sessionId);
      closeSession(state, true);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function splitIntoSentences(
  text: string,
  isChinese: boolean
): { sentences: string[]; active: string[] } {
  if (!text) {
    return { sentences: [], active: [] };
  }

  if (isChinese) {
    const regex = text.length > 18 ? /[。！？，]/ : /[。！？]/;
    const sentences: string[] = [];
    let current = '';

    for (const char of text) {
      current += char;
      if (regex.test(char)) {
        sentences.push(current);
        current = '';
      }
    }

    return {
      sentences,
      active: current ? [current] : []
    };
  }

  const wordCount = text.trim().split(/\s+/).length;
  const splitRegex =
    wordCount > 12 ? /([.!?,])(\s+|$)/g : /([.!?])(\s+|$)/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = splitRegex.exec(text)) !== null) {
    const endPosition = match.index + match[1].length;
    sentences.push(text.slice(lastIndex, endPosition).trim());
    lastIndex = splitRegex.lastIndex;
  }

  const activeText = text.slice(lastIndex).trim();
  return {
    sentences,
    active: activeText ? [activeText] : []
  };
}
