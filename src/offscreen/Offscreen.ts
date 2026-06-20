import {
  isDashScopeLiveTranslateRealtimeModel,
  isDashScopeTaskRealtimeModel
} from '../shared/ProviderConfig.js';
import {
  QWEN_LIVE_TRANSLATE_SESSION_VARIANTS,
  getQwenLiveTranslateSessionVariant,
  getRealtimeErrorText,
  isQwenRealtimeParameterErrorText
} from '../shared/QwenRealtime.js';
import { ECHOX_RUNTIME_BUILD } from '../shared/RuntimeVersion.js';

interface SessionState {
  ws: WebSocket | null;
  sessionId: string;
  tabId?: number;
  frameId?: number;
  model: string;
  wsUrl: string;
  apiKey: string;
  liveTranslateAuthMode: 'subprotocol' | 'header';
  retriedLiveTranslateHeaderAuth: boolean;
  taskId: string;
  liveTranslateSessionAttempt: number;
  isDashScopeTaskReady: boolean;
  dashScopeAudioQueue: ArrayBuffer[];
  pendingAudioQueue: string[];
  currentSequence: number;
  baseSequence: number;
  currentEn: string;
  currentZh: string;
  lastItemId: string;
  debugEventCounts: Record<string, number>;
  liveTranslateAudioAppendCount: number;
  liveTranslateAudioAppendsSinceCommit: number;
  liveTranslateLastManualCommitAt: number;
  realtimeOutputCount: number;
  realtimeTranslationOutputCount: number;
  lastRealtimeOutputAt: number;
  lastRealtimeTranslationOutputAt: number;
  lastRealtimeFinalText: string;
  lastRealtimeFinalAt: number;
  lastSubtitleEn: string;
  lastSubtitleEnAt: number;
  wsConnectStartedAt: number;
  measuredConnectLatencyMs: number;
  protocolRequestSentAt: number;
  networkProfileReady: boolean;
  realtimeSessionReady: boolean;
  realtimeSessionFallbackTimer: number | null;
  stopped: boolean;
  closeTimer: number | null;
}

const MAX_PENDING_AUDIO_CHUNKS = 100;
const activeSessions = new Map<string, SessionState>();
const EXPECTED_RUNTIME_ERRORS =
  /receiving end does not exist|message port closed/i;

console.log(`[Offscreen] EchoX runtime build: ${ECHOX_RUNTIME_BUILD}`);

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

function sendDebug(
  state: SessionState,
  message: string,
  detail: Record<string, unknown> = {}
): void {
  sendSessionMessage(state, 'OFFSCREEN_WS_DEBUG', {
    message,
    detail
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
  state.dashScopeAudioQueue = [];
  state.isDashScopeTaskReady = false;
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
  if (state.realtimeSessionFallbackTimer !== null) {
    window.clearTimeout(state.realtimeSessionFallbackTimer);
    state.realtimeSessionFallbackTimer = null;
  }

  const socket = state.ws;
  state.ws = null;
  if (!socket) {
    return;
  }

  if (graceful && socket.readyState === WebSocket.OPEN) {
    try {
      if (isDashScopeTaskRealtimeModel(state.model)) {
        socket.send(JSON.stringify({
          header: {
            action: 'finish-task',
            task_id: state.taskId
          },
          payload: {}
        }));
      } else if (isDashScopeLiveTranslateRealtimeModel(state.model)) {
        socket.close();
        return;
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

function getLiveTranslateSessionUpdate(state: SessionState): Record<string, unknown> {
  const variant = getQwenLiveTranslateSessionVariant(
    state.liveTranslateSessionAttempt
  );
  console.log(
    `[Offscreen] Live translate session variant #${state.liveTranslateSessionAttempt + 1}: ${variant.label}`
  );
  sendDebug(state, 'Qwen live translate session variant selected.', {
    attempt: state.liveTranslateSessionAttempt + 1,
    total: QWEN_LIVE_TRANSLATE_SESSION_VARIANTS.length,
    label: variant.label
  });
  return variant.session || {};
}

function getLiveTranslateSessionVariant(state: SessionState) {
  return getQwenLiveTranslateSessionVariant(state.liveTranslateSessionAttempt);
}

function shouldSendLiveTranslateSessionUpdate(state: SessionState): boolean {
  return Boolean(getLiveTranslateSessionVariant(state).session);
}

function getRealtimeSessionUpdate(state: SessionState): Record<string, unknown> {
  if (isDashScopeLiveTranslateRealtimeModel(state.model)) {
    return getLiveTranslateSessionUpdate(state);
  }

  return {
    instructions:
      "You are a real-time speech translator. Listen to the English audio and translate it to Chinese. Output exactly: English transcript | Chinese translation.",
    input_audio_format: 'pcm16',
    input_audio_transcription: {
      model: 'qwen3-asr-flash-realtime',
      language: 'en'
    },
    translation: {
      language: 'zh'
    }
  };
}

function shouldRetryLiveTranslateHeaderAuth(
  state: SessionState,
  event: CloseEvent
): boolean {
  return (
    isDashScopeLiveTranslateRealtimeModel(state.model) &&
    state.liveTranslateAuthMode === 'subprotocol' &&
    !state.retriedLiveTranslateHeaderAuth &&
    !state.networkProfileReady &&
    event.code === 1006
  );
}

function maybeCommitLiveTranslateAudioWindow(
  state: SessionState,
  socket: WebSocket
): void {
  if (!isDashScopeLiveTranslateRealtimeModel(state.model)) {
    return;
  }

  state.liveTranslateAudioAppendsSinceCommit += 1;
  // DashScope live-translate models drive turn detection and response creation
  // from their own realtime session. OpenAI Realtime commit/create events are
  // rejected by these models and can prevent subtitles from flowing.
  void socket;
}

function sendRealtimeAudioAppend(
  state: SessionState,
  socket: WebSocket,
  base64Audio: string
): void {
  socket.send(JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: base64Audio
  }));
  if (isDashScopeLiveTranslateRealtimeModel(state.model)) {
    state.liveTranslateAudioAppendCount += 1;
    if (state.liveTranslateAudioAppendCount <= 3) {
      sendDebug(state, 'Sent Qwen live translate audio chunk.', {
        chunk: state.liveTranslateAudioAppendCount,
        approxBytes: Math.round((base64Audio.length * 3) / 4)
      });
    }
  }
  maybeCommitLiveTranslateAudioWindow(state, socket);
}

function pushPendingAudio(state: SessionState, base64Audio: string): void {
  state.pendingAudioQueue.push(base64Audio);
  if (state.pendingAudioQueue.length > MAX_PENDING_AUDIO_CHUNKS) {
    state.pendingAudioQueue.shift();
  }
}

function flushPendingRealtimeAudio(state: SessionState, socket: WebSocket): void {
  if (!state.pendingAudioQueue.length) {
    return;
  }
  const pending = state.pendingAudioQueue;
  state.pendingAudioQueue = [];
  for (const base64Audio of pending) {
    sendRealtimeAudioAppend(state, socket, base64Audio);
  }
  if (isDashScopeLiveTranslateRealtimeModel(state.model)) {
    sendDebug(state, 'Flushed queued Qwen live translate audio.', {
      chunks: pending.length
    });
  }
}

function clearRealtimeSessionFallback(state: SessionState): void {
  if (state.realtimeSessionFallbackTimer !== null) {
    window.clearTimeout(state.realtimeSessionFallbackTimer);
    state.realtimeSessionFallbackTimer = null;
  }
}

function markRealtimeSessionReady(
  state: SessionState,
  socket: WebSocket,
  reason: string
): void {
  if (state.realtimeSessionReady) {
    return;
  }
  state.realtimeSessionReady = true;
  clearRealtimeSessionFallback(state);
  sendDebug(state, 'Realtime session ready for audio.', {
    reason,
    pendingAudioChunks: state.pendingAudioQueue.length
  });
  flushPendingRealtimeAudio(state, socket);
}

function scheduleRealtimeSessionFallback(
  state: SessionState,
  socket: WebSocket
): void {
  if (state.realtimeSessionReady || state.realtimeSessionFallbackTimer !== null) {
    return;
  }

  state.realtimeSessionFallbackTimer = window.setTimeout(() => {
    state.realtimeSessionFallbackTimer = null;
    if (
      !isCurrentSession(state) ||
      state.ws !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      state.realtimeSessionReady
    ) {
      return;
    }

    markRealtimeSessionReady(state, socket, 'session.created fallback timeout');
  }, 1200);
}

function sendSubtitle(
  state: SessionState,
  id: string,
  textEn: string,
  textZh: string,
  isFinal: boolean
): void {
  const normalizedEn = textEn.trim();
  const normalizedZh = textZh.trim();
  let outputEn = normalizedEn;
  if (normalizedEn) {
    state.lastSubtitleEn = normalizedEn;
    state.lastSubtitleEnAt = performance.now();
  } else if (
    normalizedZh &&
    isDashScopeLiveTranslateRealtimeModel(state.model) &&
    state.lastSubtitleEn &&
    performance.now() - state.lastSubtitleEnAt < 8000
  ) {
    outputEn = state.lastSubtitleEn;
  }

  sendSessionMessage(state, 'OFFSCREEN_WS_SUBTITLE', {
    id,
    textEn: outputEn,
    textZh: normalizedZh,
    isFinal
  });
}

function sendError(state: SessionState, message: string): void {
  sendSessionMessage(state, 'OFFSCREEN_WS_ERROR', { message });
}

function trimRealtimeWindow(
  text: string,
  isChinese: boolean,
  maxLength = isChinese ? 72 : 150
): string {
  let normalized = text.replace(/\s+/g, ' ').trim();
  if (isChinese) {
    normalized = dedupeRepeatedChineseSentences(normalized);
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const start = Math.max(0, normalized.length - maxLength);
  const recent = normalized.slice(start);
  const boundary = isChinese
    ? Math.max(
        recent.lastIndexOf('。'),
        recent.lastIndexOf('！'),
        recent.lastIndexOf('？'),
        recent.lastIndexOf('，')
      )
    : Math.max(
        recent.lastIndexOf('. '),
        recent.lastIndexOf('! '),
        recent.lastIndexOf('? '),
        recent.lastIndexOf(', ')
      );

  if (boundary > 0 && boundary < recent.length - 8) {
    return recent.slice(boundary + (isChinese ? 1 : 2)).trim();
  }
  return recent.trim();
}

function dedupeRepeatedChineseSentences(text: string): string {
  let normalized = text;
  for (let i = 0; i < 3; i++) {
    const next = normalized
      .replace(/([^。！？!?]{2,42}[。！？!?])\s*\1+/g, '$1')
      .replace(/([^，,。！？!?]{3,24}[，,])\s*\1+/g, '$1');
    if (next === normalized) {
      break;
    }
    normalized = next;
  }
  return normalized;
}

function mergeRealtimeTextWindow(
  current: string,
  incoming: string,
  isChinese: boolean
): { text: string; changed: boolean } {
  const normalizedIncoming = incoming.replace(/\s+/g, ' ').trim();
  if (!normalizedIncoming) {
    return { text: current, changed: false };
  }

  const normalizedCurrent = current.replace(/\s+/g, ' ').trim();
  if (
    normalizedIncoming === normalizedCurrent ||
    normalizedCurrent.endsWith(normalizedIncoming)
  ) {
    return { text: current, changed: false };
  }

  if (
    normalizedCurrent &&
    normalizedIncoming.startsWith(normalizedCurrent)
  ) {
    return {
      text: trimRealtimeWindow(normalizedIncoming, isChinese),
      changed: true
    };
  }

  return {
    text: trimRealtimeWindow(`${normalizedCurrent} ${normalizedIncoming}`, isChinese),
    changed: true
  };
}

function readDashScopeText(value: any): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = readDashScopeText(item);
      if (text) {
        return text;
      }
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of [
      'text',
      'transcript',
      'transcription',
      'translation',
      'sentence',
      'content',
      'result'
    ]) {
      const text = readDashScopeText(value[key]);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function readDashScopeTranslation(output: any): string {
  const translations = output.translations;
  if (translations) {
    if (typeof translations !== 'object') {
      return readDashScopeText(translations);
    }

    if (translations.translations) {
      const translationMap = translations.translations;
      const zhText = readDashScopeText(translationMap.zh);
      if (zhText) {
        return zhText;
      }
      for (const key of Object.keys(translationMap)) {
        const text = readDashScopeText(translationMap[key]);
        if (text) {
          return text;
        }
      }
    }

    if (Array.isArray(translations)) {
      const zhItem = translations.find(
        (item: any) =>
          item.language === 'zh' ||
          item.lang === 'zh' ||
          item.target_language === 'zh'
      );
      return readDashScopeText(zhItem) || readDashScopeText(translations);
    }

    const zhText = readDashScopeText(translations.zh);
    if (zhText) {
      return zhText;
    }
    for (const key of Object.keys(translations)) {
      const text = readDashScopeText(translations[key]);
      if (text) {
        return text;
      }
    }
    const directText = readDashScopeText(translations);
    if (directText) {
      return directText;
    }
  }

  return (
    readDashScopeText(output.translation) ||
    readDashScopeText(output.target_text) ||
    readDashScopeText(output.translated_text)
  );
}

function readRealtimeText(value: any): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(readRealtimeText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    for (const key of [
      'delta',
      'text',
      'transcript',
      'translation',
      'translations',
      'translation_text',
      'translated_text',
      'source_text',
      'target_text',
      'sentence',
      'content',
      'output_text',
      'stash',
      'part',
      'output',
      'response',
      'payload',
      'result',
      'source',
      'target'
    ]) {
      const text = readRealtimeText(value[key]);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function readRealtimeOutputText(data: any): string {
  return (
    readRealtimeText(data.text) ||
    readRealtimeText(data.transcript) ||
    readRealtimeText(data.translation) ||
    readRealtimeText(data.translations) ||
    readRealtimeText(data.translation_text) ||
    readRealtimeText(data.translated_text) ||
    readRealtimeText(data.source_text) ||
    readRealtimeText(data.target_text) ||
    readRealtimeText(data.output_text) ||
    readRealtimeText(data.part) ||
    readRealtimeText(data.item) ||
    readRealtimeText(data.delta) ||
    readRealtimeText(data.response) ||
    readRealtimeText(data.output) ||
    readRealtimeText(data.payload)
  );
}

function isRealtimeDoneEvent(type: unknown): boolean {
  if (typeof type !== 'string') {
    return false;
  }
  if (type === 'response.audio.done' || type.endsWith('.audio.done')) {
    return false;
  }
  return (
    type === 'response.done' ||
    type === 'response.output_item.done' ||
    type === 'response.content_part.done' ||
    type === 'item.completed' ||
    type.endsWith('.done') ||
    type.endsWith('.completed')
  );
}

function normalizeRealtimeFinalText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isDuplicateRealtimeDone(
  state: SessionState,
  finalText: string
): boolean {
  const normalized = normalizeRealtimeFinalText(finalText);
  if (!normalized || !state.lastRealtimeFinalText) {
    return false;
  }

  return (
    normalized === state.lastRealtimeFinalText &&
    performance.now() - state.lastRealtimeFinalAt < 5000
  );
}

function rememberRealtimeDone(state: SessionState, finalText: string): void {
  const normalized = normalizeRealtimeFinalText(finalText);
  if (!normalized) {
    return;
  }
  state.lastRealtimeFinalText = normalized;
  state.lastRealtimeFinalAt = performance.now();
}

function summarizeRealtimeEvent(data: any): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (
      key === 'audio' ||
      key === 'delta' && typeof value === 'string' && value.length > 300 ||
      key === 'item'
    ) {
      continue;
    }
    if (typeof value === 'string') {
      summary[key] = value.length > 240 ? `${value.slice(0, 240)}...` : value;
    } else if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      summary[key] = value;
    } else if (Array.isArray(value)) {
      summary[key] = value.slice(0, 3).map((item) =>
        typeof item === 'string'
          ? item.slice(0, 120)
          : typeof item === 'object' && item
            ? Object.keys(item).slice(0, 8)
            : item
      );
    } else if (typeof value === 'object') {
      if (key === 'part' || key === 'item' || key === 'session') {
        const record = value as Record<string, unknown>;
        const text = readRealtimeText(record);
        summary[key] = {
          keys: Object.keys(record).slice(0, 12),
          type: record.type || record.object,
          textLength: text.length,
          textPreview: text.slice(0, 180),
          modalities: record.modalities,
          translation: record.translation
        };
      } else {
        summary[key] = Object.keys(value as Record<string, unknown>).slice(0, 12);
      }
    }
  }
  return summary;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FFF]/.test(text);
}

function cleanRealtimeTextLabel(text: string): string {
  return text
    .replace(/^\s*[-*•\d.)]+\s*/, '')
    .replace(
      /^(?:en(?:glish)?|source(?:\s*text)?|transcript|original|英文|原文)\s*[:：-]\s*/i,
      ''
    )
    .replace(
      /^(?:zh|cn|chinese|target(?:\s*text)?|translation|中文|译文|翻译)\s*[:：-]\s*/i,
      ''
    )
    .trim();
}

function readLabeledRealtimePair(
  text: string
): { en: string; zh: string } {
  const sourceLabel =
    '(?:en(?:glish)?|source(?:\\s*text)?|transcript|original|英文|原文)';
  const targetLabel =
    '(?:zh|cn|chinese|target(?:\\s*text)?|translation|中文|译文|翻译)';
  const sourceThenTarget = new RegExp(
    `${sourceLabel}\\s*[:：-]\\s*([\\s\\S]*?)\\s*(?:\\n|[;；,，])?\\s*${targetLabel}\\s*[:：-]\\s*([\\s\\S]+)$`,
    'i'
  );
  const targetThenSource = new RegExp(
    `${targetLabel}\\s*[:：-]\\s*([\\s\\S]*?)\\s*(?:\\n|[;；,，])?\\s*${sourceLabel}\\s*[:：-]\\s*([\\s\\S]+)$`,
    'i'
  );

  const sourceMatch = text.match(sourceThenTarget);
  if (sourceMatch) {
    return {
      en: cleanRealtimeTextLabel(sourceMatch[1] || ''),
      zh: cleanRealtimeTextLabel(sourceMatch[2] || '')
    };
  }

  const targetMatch = text.match(targetThenSource);
  if (targetMatch) {
    return {
      en: cleanRealtimeTextLabel(targetMatch[2] || ''),
      zh: cleanRealtimeTextLabel(targetMatch[1] || '')
    };
  }

  return { en: '', zh: '' };
}

function splitRealtimeBilingualText(
  text: string
): { en: string; zh: string } {
  const normalized = text.replace(/\r/g, '\n').trim();
  if (!normalized) {
    return { en: '', zh: '' };
  }

  const labeledPair = readLabeledRealtimePair(normalized);
  if (labeledPair.en || labeledPair.zh) {
    return labeledPair;
  }

  if (normalized.includes('|')) {
    const [maybeEn, ...maybeZh] = normalized.split('|');
    return {
      en: cleanRealtimeTextLabel(maybeEn || ''),
      zh: cleanRealtimeTextLabel(maybeZh.join('|'))
    };
  }

  const lines = normalized
    .split(/\n+/)
    .map(cleanRealtimeTextLabel)
    .filter(Boolean);
  if (lines.length >= 2) {
    const enLines: string[] = [];
    const zhLines: string[] = [];
    for (const line of lines) {
      if (containsCjk(line)) {
        zhLines.push(line);
      } else {
        enLines.push(line);
      }
    }
    if (enLines.length || zhLines.length) {
      return {
        en: enLines.join(' ').trim(),
        zh: zhLines.join('').trim()
      };
    }
  }

  return containsCjk(normalized)
    ? { en: '', zh: cleanRealtimeTextLabel(normalized) }
    : { en: cleanRealtimeTextLabel(normalized), zh: '' };
}

function handleDashScopeTaskMessage(state: SessionState, data: any): boolean {
  if (!data.header?.event) {
    return false;
  }

  if (data.header.event === 'task-failed') {
    console.error('[Offscreen] DashScope realtime task failed:', data);
    sendError(
      state,
      `翻译任务失败: ${data.header.error_message || JSON.stringify(data)}`
    );
    return true;
  }

  if (data.header.event === 'task-started') {
    state.isDashScopeTaskReady = true;
    const socket = state.ws;
    if (socket?.readyState === WebSocket.OPEN) {
      for (const buffer of state.dashScopeAudioQueue) {
        socket.send(buffer);
      }
    }
    state.dashScopeAudioQueue = [];
    return true;
  }

  if (data.header.event !== 'result-generated') {
    return true;
  }

  const payload = data.payload || {};
  const output = payload.output || {};

  let text =
    readDashScopeText(output.transcription) ||
    readDashScopeText(output.source_text);
  let translation = readDashScopeTranslation(output);

  const combinedText = readDashScopeText(output.text);
  if (!text || !translation) {
    const parsed = splitRealtimeBilingualText(combinedText);
    text ||= parsed.en;
    translation ||= parsed.zh;
  }

  const isSentenceEnd = Boolean(
    output.transcription?.sentenceEnd ||
    output.transcription?.sentence_end ||
    output.translation?.sentenceEnd ||
    output.translation?.sentence_end ||
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

function applyRealtimeTextChunk(
  state: SessionState,
  text: string,
  eventType = ''
): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  if (
    eventType.includes('transcript') ||
    eventType.includes('transcription') ||
    eventType.includes('source')
  ) {
    const merged = mergeRealtimeTextWindow(state.currentEn, normalized, false);
    state.currentEn = merged.text;
    return merged.changed;
  }

  if (
    eventType.includes('translation') ||
    eventType.includes('translate') ||
    eventType.includes('target')
  ) {
    const parsed = splitRealtimeBilingualText(normalized);
    if (parsed.en) {
      state.currentEn = mergeRealtimeTextWindow(
        state.currentEn,
        parsed.en,
        false
      ).text;
    }
    const mergedZh = mergeRealtimeTextWindow(
      state.currentZh,
      parsed.zh || normalized,
      true
    );
    state.currentZh = mergedZh.text;
    return mergedZh.changed || Boolean(parsed.en);
  }

  const parsed = splitRealtimeBilingualText(normalized);
  if (parsed.en) {
    state.currentEn = mergeRealtimeTextWindow(
      state.currentEn,
      parsed.en,
      false
    ).text;
  }
  if (parsed.zh) {
    state.currentZh = mergeRealtimeTextWindow(
      state.currentZh,
      parsed.zh,
      true
    ).text;
  }
  return Boolean(parsed.en || parsed.zh);
}

function handleRealtimeMessage(state: SessionState, data: any): void {
  if (data.type === 'error') {
    clearRealtimeSessionFallback(state);
    const errorText =
      getRealtimeErrorText(data) || JSON.stringify(data.error || data);
    if (
      isDashScopeLiveTranslateRealtimeModel(state.model) &&
      isQwenRealtimeParameterErrorText(errorText) &&
      state.liveTranslateSessionAttempt <
        QWEN_LIVE_TRANSLATE_SESSION_VARIANTS.length - 1
    ) {
      const failedAttempt = state.liveTranslateSessionAttempt + 1;
      const failedVariant = getLiveTranslateSessionVariant(state);
      state.liveTranslateSessionAttempt += 1;
      state.realtimeSessionReady = false;
      state.networkProfileReady = false;
      state.protocolRequestSentAt = 0;
      const socket = state.ws;
      state.ws = null;
      try {
        socket?.close(1000, 'retry qwen session variant');
      } catch {
        // Closing the rejected socket is best effort.
      }
      sendDebug(state, 'Retrying Qwen live translate session variant.', {
        failedAttempt,
        failedLabel: failedVariant.label,
        error: errorText,
        nextAttempt: state.liveTranslateSessionAttempt + 1,
        nextLabel: getLiveTranslateSessionVariant(state).label
      });
      connectSessionSocket(state);
      return;
    }
    console.error('[Offscreen] API Error:', data.error);
    sendDebug(state, 'Realtime API error.', {
      error: errorText,
      type: data.error?.type,
      code: data.error?.code,
      param: data.error?.param
    });
    sendError(
      state,
      `翻译任务失败: ${data.error?.message || JSON.stringify(data.error)}`
    );
    return;
  }

  const isDone = isRealtimeDoneEvent(data.type);
  const doneText = isDone ? readRealtimeOutputText(data) : '';
  if (isDone && doneText && isDuplicateRealtimeDone(state, doneText)) {
    sendDebug(state, 'Skipped duplicate Qwen done event.', {
      type: data.type,
      textLength: doneText.length,
      textPreview: doneText.slice(0, 180)
    });
    return;
  }

  let hasDelta = false;

  if (
    data.type === 'response.content_part.added' ||
    data.type === 'response.content_part.done'
  ) {
    const partText = readRealtimeText(data.part);
    const seen = state.debugEventCounts['qwen-content-part-text'] || 0;
    state.debugEventCounts['qwen-content-part-text'] = seen + 1;
    if (seen < 6) {
      sendDebug(state, 'Qwen content part received.', {
        type: data.type,
        partType: data.part?.type,
        textLength: partText.length,
        textPreview: partText.slice(0, 180)
      });
    }
    if (applyRealtimeTextChunk(state, partText, data.type)) {
      hasDelta = true;
    }
  }

  if (
    !hasDelta &&
    (data.type === 'response.output_item.added' ||
      data.type === 'response.output_item.done')
  ) {
    const itemText = readRealtimeText(data.item);
    const seen = state.debugEventCounts['qwen-output-item-text'] || 0;
    state.debugEventCounts['qwen-output-item-text'] = seen + 1;
    if (seen < 6) {
      sendDebug(state, 'Qwen output item received.', {
        type: data.type,
        itemType: data.item?.type,
        textLength: itemText.length,
        textPreview: itemText.slice(0, 180)
      });
    }
    if (applyRealtimeTextChunk(state, itemText, data.type)) {
      hasDelta = true;
    }
  }

  if (
    data.type === 'response.audio_transcript.delta' ||
    data.type === 'conversation.item.input_audio_transcription.delta'
  ) {
    const delta = readRealtimeOutputText(data);
    if (delta) {
      const merged = mergeRealtimeTextWindow(state.currentEn, delta, false);
      state.currentEn = merged.text;
      hasDelta = merged.changed;
    }
  }

  if (
    data.type === 'conversation.item.input_audio_transcription.text'
  ) {
    const text = readRealtimeText(data.text) || readRealtimeText(data.stash);
    if (text) {
      state.currentEn = trimRealtimeWindow(text, false);
      hasDelta = true;
    }
  }

  if (
    data.type === 'response.text.delta' ||
    data.type === 'response.translation.delta' ||
    data.type === 'response.output_text.delta'
  ) {
    const delta = readRealtimeOutputText(data);
    const parsed = splitRealtimeBilingualText(delta);
    if (parsed.en || parsed.zh) {
      if (parsed.en) {
        state.currentEn = trimRealtimeWindow(
          state.currentEn + parsed.en,
          false
        );
      }
      if (parsed.zh) {
        state.currentZh = trimRealtimeWindow(
          state.currentZh + parsed.zh,
          true
        );
      }
      hasDelta = true;
    }
  }

  if (
    data.type === 'response.audio_transcript.text' ||
    data.type === 'response.text.text' ||
    data.type === 'response.translation.text' ||
    data.type === 'response.output_text.done' ||
    data.type === 'response.text.done' ||
    data.type === 'response.translation.done'
  ) {
    const fullText = readRealtimeOutputText(data);
    const stash = data.stash || '';
    let recentEn = '';
    let recentZh = '';

    try {
      const parts = fullText
        .split(/(?<=[。！？.!?])\s*/)
        .filter((part: string) => part.trim().length > 0);
      const lastPart = parts.slice(-1).join(' ') + stash;
      const parsed = splitRealtimeBilingualText(lastPart);
      if (parsed.en || parsed.zh) {
        recentEn = parsed.en;
        recentZh = parsed.zh;
      } else if (data.type === 'response.audio_transcript.text') {
        recentEn = lastPart;
      } else {
        recentZh = lastPart;
      }
    } catch {
      // Ignore malformed incremental text and wait for the next event.
    }

    if (recentEn || recentZh) {
      if (recentEn) {
        state.currentEn = trimRealtimeWindow(recentEn, false);
      }
      if (recentZh) {
        state.currentZh = trimRealtimeWindow(recentZh, true);
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
    state.currentEn = trimRealtimeWindow(
      readRealtimeText(data.transcript),
      false
    );
    hasDelta = true;
  }

  if (!hasDelta && typeof data.type === 'string' && data.type.includes('delta')) {
    const delta = readRealtimeOutputText(data);
    if (delta && !data.type.includes('audio.delta')) {
      if (
        data.type.includes('transcript') ||
        data.type.includes('transcription') ||
        data.type.includes('source')
      ) {
        state.currentEn = trimRealtimeWindow(state.currentEn + delta, false);
      } else {
        const parsed = splitRealtimeBilingualText(delta);
        if (parsed.en) {
          state.currentEn = trimRealtimeWindow(
            state.currentEn + parsed.en,
            false
          );
        }
        if (parsed.zh) {
          state.currentZh = trimRealtimeWindow(
            state.currentZh + parsed.zh,
            true
          );
        }
      }
      hasDelta = true;
    }
  }

  if (!hasDelta && typeof data.type === 'string') {
    const text = readRealtimeOutputText(data);
    if (
      text &&
      !data.type.includes('audio.delta') &&
      !data.type.includes('audio.done')
    ) {
      hasDelta = applyRealtimeTextChunk(state, text, data.type);
    }
  }

  if (hasDelta) {
    state.realtimeOutputCount += 1;
    state.lastRealtimeOutputAt = performance.now();
    if (state.currentZh.trim()) {
      state.realtimeTranslationOutputCount += 1;
      state.lastRealtimeTranslationOutputAt = state.lastRealtimeOutputAt;
    }
    sendSubtitle(
      state,
      `live-${state.sessionId}-ws-${state.currentSequence}`,
      state.currentEn,
      state.currentZh,
      false
    );
  }

  if (isDone) {
    const finalText = doneText || readRealtimeOutputText(data);
    if (finalText) {
      const parsed = splitRealtimeBilingualText(finalText);
      if (parsed.en || parsed.zh) {
        if (parsed.en) {
          state.currentEn = trimRealtimeWindow(parsed.en, false);
        }
        if (parsed.zh) {
          state.currentZh = trimRealtimeWindow(parsed.zh, true);
        }
      } else if (
        data.type.includes('transcript') ||
        data.type.includes('transcription') ||
        (finalText.length < 120 && /^[\x00-\x7F\s.,!?'"-]+$/.test(finalText))
      ) {
        state.currentEn = trimRealtimeWindow(finalText, false);
      } else {
        state.currentZh = trimRealtimeWindow(finalText, true);
      }
    }
    if (data.type === 'response.audio_transcript.done' && data.transcript) {
      state.currentEn = trimRealtimeWindow(data.transcript, false);
    }
    if (
      data.transcript &&
      data.type !== 'response.audio_transcript.done' &&
      !data.type.includes('input_audio_transcription')
    ) {
      state.currentZh = trimRealtimeWindow(data.transcript, true);
    }
    if (data.text) {
      state.currentZh = trimRealtimeWindow(readRealtimeText(data.text), true);
    }
    if (data.translation) {
      state.currentZh = trimRealtimeWindow(
        readRealtimeText(data.translation),
        true
      );
    }
    if (data.translations) {
      state.currentZh = trimRealtimeWindow(
        readRealtimeText(data.translations),
        true
      );
    }
    if (data.translated_text) {
      state.currentZh = trimRealtimeWindow(
        readRealtimeText(data.translated_text),
        true
      );
    }

    if (data.item?.content) {
      for (const content of data.item.content) {
        if (content.transcript) {
          state.currentEn = trimRealtimeWindow(content.transcript, false);
        }
        if (content.text) {
          state.currentZh = trimRealtimeWindow(content.text, true);
        }
      }
    }

    if (
      state.currentEn.trim() ||
      state.currentZh.trim()
    ) {
      state.realtimeOutputCount += 1;
      state.lastRealtimeOutputAt = performance.now();
      if (state.currentZh.trim()) {
        state.realtimeTranslationOutputCount += 1;
        state.lastRealtimeTranslationOutputAt = state.lastRealtimeOutputAt;
      }
      sendSubtitle(
        state,
        `live-${state.sessionId}-ws-${state.currentSequence}`,
        state.currentEn,
        state.currentZh,
        true
      );
      rememberRealtimeDone(state, finalText);
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
    const eventName = data.type || data.header?.event || 'unknown';
    const seen = state.debugEventCounts[eventName] || 0;
    state.debugEventCounts[eventName] = seen + 1;
    if (seen < 3) {
      sendDebug(state, 'Ignored realtime event.', {
        type: eventName,
        keys: Object.keys(data).slice(0, 12),
        sample: summarizeRealtimeEvent(data)
      });
    }
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
  model: string,
  wsUrl: string,
  apiKey: string
): SessionState {
  return {
    ws: null,
    sessionId,
    tabId,
    frameId,
    model,
    wsUrl,
    apiKey,
    liveTranslateAuthMode: 'header',
    retriedLiveTranslateHeaderAuth: false,
    taskId: crypto.randomUUID().replace(/-/g, ''),
    liveTranslateSessionAttempt: 0,
    isDashScopeTaskReady: false,
    dashScopeAudioQueue: [],
    pendingAudioQueue: [],
    currentSequence: 0,
    baseSequence: 0,
    currentEn: '',
    currentZh: '',
    lastItemId: '',
    debugEventCounts: {},
    liveTranslateAudioAppendCount: 0,
    liveTranslateAudioAppendsSinceCommit: 0,
    liveTranslateLastManualCommitAt: 0,
    realtimeOutputCount: 0,
    realtimeTranslationOutputCount: 0,
    lastRealtimeOutputAt: performance.now(),
    lastRealtimeTranslationOutputAt: performance.now(),
    lastRealtimeFinalText: '',
    lastRealtimeFinalAt: 0,
    lastSubtitleEn: '',
    lastSubtitleEnAt: 0,
    wsConnectStartedAt: performance.now(),
    measuredConnectLatencyMs: 0,
    protocolRequestSentAt: 0,
    networkProfileReady: false,
    realtimeSessionReady: false,
    realtimeSessionFallbackTimer: null,
    stopped: false,
    closeTimer: null
  };
}

function connectSessionSocket(
  state: SessionState,
  sendResponse?: (response?: any) => void
): void {
  try {
    console.log('[Offscreen] Connecting session:', state.sessionId, state.wsUrl);
    state.wsConnectStartedAt = performance.now();
    state.networkProfileReady = false;
    state.protocolRequestSentAt = 0;
    state.liveTranslateAudioAppendCount = 0;
    state.liveTranslateAudioAppendsSinceCommit = 0;
    state.liveTranslateLastManualCommitAt = 0;
    state.realtimeOutputCount = 0;
    state.realtimeTranslationOutputCount = 0;
    state.lastRealtimeOutputAt = performance.now();
    state.lastRealtimeTranslationOutputAt = performance.now();
    state.realtimeSessionReady = false;
    clearRealtimeSessionFallback(state);
    sendDebug(state, 'Offscreen runtime build active.', {
      runtime: ECHOX_RUNTIME_BUILD
    });

    const shouldUseSubprotocolAuth =
      isDashScopeLiveTranslateRealtimeModel(state.model) &&
      state.liveTranslateAuthMode === 'subprotocol';
    if (isDashScopeLiveTranslateRealtimeModel(state.model) && !state.apiKey) {
      sendError(state, 'Qwen 实时翻译缺少 API Key，请检查 DashScope / Qwen 配置。');
      sendResponse?.({ ok: false, error: 'Missing DashScope API Key.' });
      return;
    }
    sendDebug(state, 'Opening WebSocket connection.', {
      model: state.model,
      endpoint: isDashScopeTaskRealtimeModel(state.model)
        ? 'dashscope-task'
        : 'dashscope-realtime',
      authTransport: shouldUseSubprotocolAuth
        ? 'websocket-subprotocol'
        : 'header-rule',
      hasApiKey: Boolean(state.apiKey)
    });

    const socket =
      shouldUseSubprotocolAuth
        ? new WebSocket(state.wsUrl, [`access_token.${state.apiKey}`])
        : new WebSocket(state.wsUrl);
    state.ws = socket;
    sendResponse?.({ ok: true });

    socket.onopen = () => {
      if (!isCurrentSession(state) || state.ws !== socket) {
        socket.close();
        return;
      }

      console.log('[Offscreen] WebSocket connected. Session:', state.sessionId);
      sendDebug(state, 'WebSocket connected.', {
        model: state.model,
        endpoint: isDashScopeTaskRealtimeModel(state.model)
          ? 'dashscope-task'
          : 'dashscope-realtime',
        authTransport:
          isDashScopeLiveTranslateRealtimeModel(state.model) &&
          state.liveTranslateAuthMode === 'subprotocol'
            ? 'websocket-subprotocol'
            : 'header-rule'
      });
      state.measuredConnectLatencyMs = Math.max(
        0,
        performance.now() - state.wsConnectStartedAt
      );
      reportNetworkProfile(state);
      state.protocolRequestSentAt = performance.now();

      if (isDashScopeTaskRealtimeModel(state.model)) {
        state.dashScopeAudioQueue.push(
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

      if (
        isDashScopeLiveTranslateRealtimeModel(state.model) &&
        !shouldSendLiveTranslateSessionUpdate(state)
      ) {
        getLiveTranslateSessionUpdate(state);
        return;
      }

      socket.send(JSON.stringify({
        type: 'session.update',
        session: getRealtimeSessionUpdate(state)
      }));
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
            sendDebug(state, 'WebSocket protocol ready.', {
              type: data.type || data.header?.event || 'unknown'
            });
            reportNetworkProfile(
              state,
              state.protocolRequestSentAt
                ? Math.max(0, performance.now() - state.protocolRequestSentAt)
                : undefined
            );
          }
        }

        if (
          !isDashScopeTaskRealtimeModel(state.model) &&
          !state.realtimeSessionReady &&
          data.type === 'session.updated'
        ) {
          markRealtimeSessionReady(state, socket, 'session.updated');
        } else if (
          !isDashScopeTaskRealtimeModel(state.model) &&
          !state.realtimeSessionReady &&
          data.type === 'session.created'
        ) {
          if (
            isDashScopeLiveTranslateRealtimeModel(state.model) &&
            !shouldSendLiveTranslateSessionUpdate(state)
          ) {
            markRealtimeSessionReady(
              state,
              socket,
              'model default session.created'
            );
          } else {
            sendDebug(state, 'Realtime session created; waiting for update ack.', {
              pendingAudioChunks: state.pendingAudioQueue.length
            });
            scheduleRealtimeSessionFallback(state, socket);
          }
        }

        if (!handleDashScopeTaskMessage(state, data)) {
          handleRealtimeMessage(state, data);
        }
      } catch (error) {
        console.warn('[Offscreen] Failed to parse message', error, event.data);
      }
    };

    socket.onerror = (event) => {
      if (isCurrentSession(state)) {
        console.error(
          '[Offscreen] WebSocket error. Session:',
          state.sessionId,
          event
        );
      }
    };

    socket.onclose = (event) => {
      if (state.ws !== socket) {
        return;
      }
      state.ws = null;
      if (!isCurrentSession(state)) {
        return;
      }
      clearRealtimeSessionFallback(state);

      console.log(
        `[Offscreen] WebSocket closed. Session: ${state.sessionId}, Code: ${event.code}, Reason: ${event.reason}`
      );
      sendDebug(state, 'WebSocket closed.', {
        code: event.code,
        reason: event.reason || '',
        liveTranslateAttempt: state.liveTranslateSessionAttempt + 1,
        audioChunks: state.liveTranslateAudioAppendCount,
        outputs: state.realtimeOutputCount,
        translatedOutputs: state.realtimeTranslationOutputCount,
        authTransport:
          isDashScopeLiveTranslateRealtimeModel(state.model) &&
          state.liveTranslateAuthMode === 'subprotocol'
            ? 'websocket-subprotocol'
            : 'header-rule'
      });
      if (shouldRetryLiveTranslateHeaderAuth(state, event)) {
        state.liveTranslateAuthMode = 'header';
        state.retriedLiveTranslateHeaderAuth = true;
        console.warn(
          '[Offscreen] Retrying Qwen live translate session with header auth fallback.'
        );
        sendDebug(state, 'Retrying Qwen WebSocket with header auth fallback.', {
          previousCloseCode: event.code,
          previousCloseReason: event.reason || ''
        });
        connectSessionSocket(state);
        return;
      }
      activeSessions.delete(state.sessionId);
      clearSessionQueues(state);
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
      } else if (
        isDashScopeLiveTranslateRealtimeModel(state.model) &&
        !state.stopped &&
        state.realtimeTranslationOutputCount === 0
      ) {
        sendError(
          state,
          state.liveTranslateAudioAppendCount > 0
            ? `Qwen 实时翻译连接已关闭但没有返回字幕（Code ${event.code || 'unknown'}，已发送 ${state.liveTranslateAudioAppendCount} 个音频块）。请查看控制台 Offscreen 诊断日志。`
            : `Qwen 实时翻译连接已关闭但没有收到音频数据（Code ${event.code || 'unknown'}）。请点击视频画面后重新开始。`
        );
      }
    };
  } catch (error) {
    activeSessions.delete(state.sessionId);
    clearSessionQueues(state);
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Offscreen] Failed to create WebSocket:', error);
    sendError(state, `创建 WebSocket 失败: ${message}`);
    sendResponse?.({ ok: false, error: message });
  }
}

function startSession(msg: any, sendResponse: (response?: any) => void): void {
  const sessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
  if (!sessionId) {
    sendResponse({ ok: false, error: 'Missing sessionId.' });
    return;
  }

  const wsUrl = typeof msg.wsUrl === 'string' ? msg.wsUrl.trim() : '';
  if (!wsUrl) {
    sendResponse({ ok: false, error: 'Missing wsUrl.' });
    return;
  }
  const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '';

  const existing = activeSessions.get(sessionId);
  if (existing) {
    closeSession(existing, false);
  }

  const state = createSessionState(
    sessionId,
    typeof msg.tabId === 'number' ? msg.tabId : undefined,
    typeof msg.frameId === 'number' ? msg.frameId : undefined,
    typeof msg.model === 'string' ? msg.model : '',
    wsUrl,
    apiKey
  );
  activeSessions.set(sessionId, state);
  connectSessionSocket(state, sendResponse);
}

function verifyRealtimeSocketOnce(
  model: string,
  session: Record<string, unknown> | null
): Promise<'session.created' | 'session.updated'> {
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
    let settled = false;
    let socket: WebSocket | null = null;
    const timeoutId = window.setTimeout(() => {
      finish(false, new Error('WebSocket 握手超时（header-rule）。'));
    }, 8000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      if (
        socket &&
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close(1000, 'verification complete');
      }
    };

    const finish = (
      ok: boolean,
      value: 'session.created' | 'session.updated' | Error
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (ok) {
        resolve(value as 'session.created' | 'session.updated');
      } else {
        reject(value);
      }
    };

    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      finish(
        false,
        error instanceof Error ? error : new Error(String(error))
      );
      return;
    }

    socket.onopen = () => {
      if (!session) {
        return;
      }
      try {
        socket?.send(JSON.stringify({
          type: 'session.update',
          session
        }));
      } catch (error) {
        finish(
          false,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'error') {
          finish(
            false,
            new Error(
              getRealtimeErrorText(data) ||
                data.error?.code ||
                JSON.stringify(data.error)
            )
          );
          return;
        }
        if (data.type === 'session.created' || data.type === 'session.updated') {
          finish(true, data.type);
        }
      } catch (error) {
        finish(
          false,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    };

    socket.onerror = () => {
      // Chrome hides handshake details; onclose usually gives the useful code.
    };

    socket.onclose = (event) => {
      if (settled) {
        return;
      }
      finish(
        false,
        new Error(
          `WebSocket 连接关闭（header-rule，Code ${event.code || 'unknown'}）: ${event.reason || '无详细原因'}`
        )
      );
    };
  });
}

async function verifyRealtimeSocket(model: string): Promise<string> {
  if (!isDashScopeLiveTranslateRealtimeModel(model)) {
    const eventType = await verifyRealtimeSocketOnce(model, {
      modalities: ['text'],
      input_audio_format: 'pcm16'
    });
    return `header-rule 握手成功：${eventType}`;
  }

  const errors: string[] = [];
  for (const variant of QWEN_LIVE_TRANSLATE_SESSION_VARIANTS) {
    try {
      const eventType = await verifyRealtimeSocketOnce(model, variant.session);
      return `header-rule 握手成功，${variant.label}：${eventType}`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${variant.label}: ${detail}`);
      if (!isQwenRealtimeParameterErrorText(detail)) {
        throw error;
      }
    }
  }

  throw new Error(
    `Qwen 实时同传 WebSocket 已连接，但所有 session 参数均被拒绝：${errors.join(
      '；'
    )}`
  );
}

function verifySession(msg: any, sendResponse: (response?: any) => void): void {
  const model = typeof msg.model === 'string' ? msg.model.trim() : '';
  if (!model) {
    sendResponse({ ok: false, error: 'Missing model.' });
    return;
  }

  verifyRealtimeSocket(model)
    .then((message) => sendResponse({ ok: true, message }))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
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

  if (msg.action === 'verify_ws') {
    verifySession(msg, sendResponse);
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
      if (isDashScopeTaskRealtimeModel(state.model)) {
        const audioBuffer = decodeBase64Audio(msg.base64Audio);
        if (state.isDashScopeTaskReady) {
          socket.send(audioBuffer);
        } else {
          state.dashScopeAudioQueue.push(audioBuffer);
          if (state.dashScopeAudioQueue.length > MAX_PENDING_AUDIO_CHUNKS) {
            state.dashScopeAudioQueue.shift();
          }
        }
      } else {
        if (state.realtimeSessionReady) {
          sendRealtimeAudioAppend(state, socket, msg.base64Audio);
        } else {
          pushPendingAudio(state, msg.base64Audio);
        }
      }
    } else {
      state.isDashScopeTaskReady = false;
      pushPendingAudio(state, msg.base64Audio);
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
