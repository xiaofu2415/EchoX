import { setupWsRealtimeServer } from './WsRealtimeServer';
import {
  audioFormatFromMimeType,
  getUnsupportedDashScopeModelReason,
  isDashScopeRealtimeModel,
  joinApiUrl,
  PROVIDER_STORAGE_KEYS,
  readProviderConfig,
  validateProviderConfig,
  type ProviderConfig
} from '../shared/ProviderConfig.js';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    delta?: {
      content?: unknown;
    };
  }>;
  output_text?: unknown;
  output?: unknown;
  text?: unknown;
}

interface AudioTranslationMessage {
  action: 'PROCESS_VOD_AUDIO_SEGMENT' | 'TRANSLATE_LIVE_AUDIO_CHUNK';
  audioData: string;
  mimeType?: string;
  url?: string;
  timestamp?: number;
  startTime?: number;
  endTime?: number;
  playbackTime?: number;
  sessionId?: string;
  sequence?: number;
}

const TRANSLATION_TIMEOUT_MS = 15000;
const OPENAI_TIMEOUT_MS = 25000;
const POLLING_INTERVAL_MS = 1000;

setupWsRealtimeServer();

interface AbortTranslationMessage {
  action: 'ABORT_TRANSLATION';
  sessionId?: string;
}

interface ClearSubtitlesMessage {
  action: 'CLEAR_BILINGUAL_SUBTITLES';
}

interface VerifyProviderMessage {
  action: 'VERIFY_PROVIDER_CONFIG';
  config: ProviderConfig;
}

interface OpenOptionsPageMessage {
  action: 'OPEN_OPTIONS_PAGE';
}

interface VerificationStage {
  name: string;
  ok: boolean;
  message: string;
  latencyMs: number;
}

interface VerificationResult {
  ok: boolean;
  message: string;
  stages: VerificationStage[];
}

interface ActiveRequest {
  controller: AbortController;
  sequence: number;
}

interface PendingLiveRequest {
  message: AudioTranslationMessage;
  tabId: number;
  frameId: number;
}

interface TranslationContext {
  previousEn?: string;
  previousZh?: string;
}

const BILINGUAL_SYSTEM_PROMPT =
  '你是一个专业的同声传译。请只处理当前音频片段中真实听到的英文，不要重复上一段。精确转录英文原文，并翻译为自然流畅的中文。只返回 JSON，格式必须是：{"en":"英文原文","zh":"中文翻译"}。不要输出 Markdown 或其他解释。';

const TEXT_TRANSLATION_PROMPT =
  '你是专业的英中字幕翻译。输入是一段语音转写文本。请纠正明显的转写错误并翻译成自然、简洁的中文字幕。只返回 JSON，格式必须是：{"en":"修正后的英文原文","zh":"中文翻译"}。';

const activeRequests = new Map<string, ActiveRequest>();
const pendingLiveRequests = new Map<string, PendingLiveRequest>();
const translationContexts = new Map<string, TranslationContext>();
let offscreenCreationPromise: Promise<void> | null = null;
let resolveOffscreenReady: (() => void) | null = null;
let realtimeStartQueue: Promise<void> = Promise.resolve();
const pendingRealtimeStarts = new Set<string>();
const cancelledRealtimeStarts = new Set<string>();
const EXPECTED_MESSAGE_ERRORS =
  /receiving end does not exist|message port closed|no tab with id/i;

function reportUnexpectedMessageError(
  context: string,
  error: unknown
): void {
  const detail = error instanceof Error ? error.message : String(error);
  if (!EXPECTED_MESSAGE_ERRORS.test(detail)) {
    console.warn(`[Background] ${context} failed:`, error);
  }
}

function sendRuntimeMessageSafely(
  message: Record<string, unknown>,
  context: string
): void {
  try {
    void chrome.runtime
      .sendMessage(message)
      .catch((error: unknown) => reportUnexpectedMessageError(context, error));
  } catch (error) {
    reportUnexpectedMessageError(context, error);
  }
}

function sendTabMessageSafely(
  tabId: number,
  message: unknown,
  frameId?: number
): void {
  try {
    const request =
      typeof frameId === 'number'
        ? chrome.tabs.sendMessage(tabId, message, { frameId })
        : chrome.tabs.sendMessage(tabId, message);
    void request.catch((error: unknown) =>
      reportUnexpectedMessageError('Tab message', error)
    );
  } catch (error) {
    reportUnexpectedMessageError('Tab message', error);
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  if (existingContexts.length > 0) {
    return;
  }

  if (!offscreenCreationPromise) {
    offscreenCreationPromise = (async () => {
      let readyTimer: number | undefined;
      const readyPromise = new Promise<void>((resolve) => {
        let settled = false;
        resolveOffscreenReady = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (readyTimer !== undefined) {
            clearTimeout(readyTimer);
          }
          resolve();
        };
        readyTimer = setTimeout(() => {
          console.warn('[Background] OFFSCREEN_READY timeout.');
          resolveOffscreenReady?.();
        }, 5000);
      });

      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification:
            'Manage WebSocket connections outside of content script CSP restrictions.'
        });
      } catch (error) {
        const contextsAfterError = await chrome.runtime.getContexts({
          contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
        });
        if (contextsAfterError.length === 0) {
          if (readyTimer !== undefined) {
            clearTimeout(readyTimer);
          }
          throw error;
        }
      }

      await readyPromise;
    })().finally(() => {
      offscreenCreationPromise = null;
      resolveOffscreenReady = null;
    });
  }

  await offscreenCreationPromise;
}

function sendOffscreenStartMessage(
  payload: Record<string, unknown>,
  retries = 15
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (remaining: number) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          if (remaining > 0) {
            setTimeout(() => attempt(remaining - 1), 200);
          } else {
            reject(new Error(chrome.runtime.lastError.message));
          }
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || 'Offscreen session failed to start.'));
          return;
        }
        resolve();
      });
    };
    attempt(retries);
  });
}

function enqueueRealtimeStart(task: () => Promise<void>): Promise<void> {
  const result = realtimeStartQueue.catch(() => undefined).then(task);
  realtimeStartQueue = result.catch(() => undefined);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userFacingError(error: unknown): string {
  const message = errorMessage(error);
  if (message.startsWith('CONFIG_ERROR:')) {
    return message.slice('CONFIG_ERROR:'.length);
  }
  if (/DashScope|qwen/i.test(message) && /403|permission|forbidden/i.test(message)) {
    return summarizeApiError(
      message,
      'DashScope 返回 403：请检查阿里云百炼是否已开通该模型、API Key 是否属于有权限的账号，以及模型是否已授权调用。'
    );
  }
  if (/401|unauthorized|invalid.*key|api key not valid/i.test(message)) {
    return summarizeApiError(message, '认证失败，请检查 API Key 或 Access Token。');
  }
  if (/403|permission|forbidden/i.test(message)) {
    return summarizeApiError(
      message,
      '没有访问权限，请检查 API 是否启用、项目权限或模型授权。'
    );
  }
  if (/404|not found|model.*not.*found/i.test(message)) {
    return summarizeApiError(message, '接口或模型不存在，请检查 Base URL 和模型名称。');
  }
  if (/429|quota|rate limit|resource exhausted/i.test(message)) {
    return summarizeApiError(message, '请求额度不足或频率受限，请检查配额和账单状态。');
  }
  if (/failed to fetch|network|load failed/i.test(message)) {
    return '网络请求失败，请检查网络、代理或接口域名权限。';
  }
  return message.length > 220 ? `${message.slice(0, 220)}...` : message;
}

function summarizeApiError(message: string, fallback: string): string {
  const statusMatch = message.match(/API\s+\d+:\s*([\s\S]*)$/);
  const rawPayload = statusMatch?.[1]?.trim();
  if (!rawPayload) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawPayload) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
      code?: unknown;
    };
    const apiMessage =
      typeof parsed.error?.message === 'string'
        ? parsed.error.message
        : typeof parsed.message === 'string'
          ? parsed.message
          : '';
    const apiCode =
      typeof parsed.error?.code === 'string'
        ? parsed.error.code
        : typeof parsed.code === 'string'
          ? parsed.code
          : '';
    const detail = [apiCode, apiMessage].filter(Boolean).join('：');
    if (detail) {
      const combined = `${fallback}接口返回：${detail}`;
      return combined.length > 260 ? `${combined.slice(0, 260)}...` : combined;
    }
  } catch {
    const combined = `${fallback}接口返回：${rawPayload}`;
    return combined.length > 260 ? `${combined.slice(0, 260)}...` : combined;
  }

  return fallback;
}

function getRequestKey(
  tabId: number,
  frameId: number,
  sessionId: string
): string {
  return `${tabId}:${frameId}:${sessionId}`;
}

async function getProviderConfig(): Promise<ProviderConfig> {
  const stored = await chrome.storage.local.get(PROVIDER_STORAGE_KEYS);
  return readProviderConfig(stored);
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  providerName: string
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `${providerName} API ${response.status}: ${errorText.slice(0, 800)}`
    );
  }
  return response.json() as Promise<T>;
}

function createGeminiBody(
  base64Audio: string,
  mimeType: string,
  context?: TranslationContext
) {
  return {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: mimeType.split(';')[0] || 'audio/webm',
              data: base64Audio
            }
          },
          {
            text: createBilingualPrompt(context)
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json'
    }
  };
}

function extractGeminiText(data: GeminiResponse, providerName: string): string {
  const resultText = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('');
  if (!resultText) {
    throw new Error(`${providerName} returned an empty response.`);
  }
  return resultText;
}

async function requestGeminiAiStudio(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  context: TranslationContext | undefined,
  signal: AbortSignal
): Promise<string> {
  const apiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const data = await fetchJson<GeminiResponse>(
    apiUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createGeminiBody(base64Audio, mimeType, context)),
      signal
    },
    'Gemini AI Studio'
  );
  return extractGeminiText(data, 'Gemini AI Studio');
}

async function requestVertexAi(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  context: TranslationContext | undefined,
  signal: AbortSignal
): Promise<string> {
  let apiUrl: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (config.vertexAuthMode === 'apiKey') {
    apiUrl =
      `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(config.vertexModel)}:generateContent?key=${encodeURIComponent(config.vertexApiKey)}`;
  } else {
    const location = encodeURIComponent(config.vertexLocation || 'global');
    const host =
      config.vertexLocation === 'global'
        ? 'aiplatform.googleapis.com'
        : `${config.vertexLocation}-aiplatform.googleapis.com`;
    apiUrl =
      `https://${host}/v1/projects/${encodeURIComponent(config.vertexProjectId)}/locations/${location}/publishers/google/models/${encodeURIComponent(config.vertexModel)}:generateContent`;
    headers.Authorization = `Bearer ${config.vertexAccessToken}`;
  }

  const data = await fetchJson<GeminiResponse>(
    apiUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(createGeminiBody(base64Audio, mimeType, context)),
      signal
    },
    'Vertex AI'
  );
  return extractGeminiText(data, 'Vertex AI');
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractTextFromUnknown).join('');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const directText = [
    record.text,
    record.output_text,
    record.transcript,
    record.translation,
    record.content
  ]
    .map(extractTextFromUnknown)
    .join('');
  if (directText.trim()) {
    return directText;
  }

  return [record.message, record.delta, record.output]
    .map(extractTextFromUnknown)
    .join('');
}

function extractOpenAiText(data: OpenAiResponse, providerName: string): string {
  const content =
    data.choices?.[0]?.message?.content ||
    data.choices?.[0]?.delta?.content ||
    data.output_text ||
    data.output ||
    data.text;
  const extracted = extractTextFromUnknown(content);
  if (extracted.trim()) {
    return extracted;
  }
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  throw new Error(`${providerName} returned an empty response.`);
}

function extractOpenAiStreamText(streamText: string, providerName: string): string {
  const chunks: string[] = [];
  const lines = streamText.split(/\r?\n/);
  const payloads: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }

    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    payloads.push(payload);

    try {
      chunks.push(extractOpenAiText(JSON.parse(payload) as OpenAiResponse, providerName));
    } catch {
      // Some stream frames only carry metadata; ignore frames without text.
    }
  }

  if (payloads.length === 0 && streamText.trim()) {
    try {
      chunks.push(extractOpenAiText(JSON.parse(streamText) as OpenAiResponse, providerName));
    } catch {
      // Keep the raw preview in the final error below.
    }
  }

  const text = chunks.join('').trim();
  if (!text) {
    const previewSource = payloads.length > 0 ? payloads.join('\n') : streamText;
    const preview = previewSource.replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(
      `${providerName} returned an empty streamed response. 原始响应预览：${preview || '空响应'}`
    );
  }
  return text;
}

async function fetchOpenAiChatText(
  url: string,
  body: unknown,
  apiKey: string,
  providerName: string,
  signal: AbortSignal,
  stream: boolean,
  onPartialResponse?: (partialText: string) => void
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: createOpenAiHeaders(apiKey),
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `${providerName} API ${response.status}: ${errorText.slice(0, 800)}`
    );
  }

  if (stream && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let accumulatedText = '';
    const payloads: string[] = [];
    const chunks: string[] = [];

    while (!done) {
      const { value, done: readerDone } = await reader.read().catch(() => ({ value: undefined, done: true }));
      done = !!readerDone;
      if (value) {
        accumulatedText += decoder.decode(value, { stream: !done });
        const lines = accumulatedText.split(/\r?\n/);
        accumulatedText = lines.pop() || '';

        let partialChanged = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          payloads.push(payload);
          try {
            const text = extractOpenAiText(JSON.parse(payload) as OpenAiResponse, providerName);
            chunks.push(text);
            partialChanged = true;
          } catch {
            // ignore partial json errors
          }
        }
        if (partialChanged && onPartialResponse) {
          onPartialResponse(chunks.join('').trim());
        }
      }
    }
    const finalResult = chunks.join('').trim();
    if (!finalResult) {
       const preview = payloads.join('\\n').replace(/\s+/g, ' ').slice(0, 500);
       throw new Error(`${providerName} returned an empty streamed response. 原始响应预览：${preview || '空响应'}`);
    }
    return finalResult;
  }

  return extractOpenAiText((await response.json()) as OpenAiResponse, providerName);
}

function createOpenAiHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

function isDashScopeQwen(config: ProviderConfig): boolean {
  return config.openaiBaseUrl.includes('dashscope.aliyuncs.com');
}

function getOpenAiProviderName(config: ProviderConfig): string {
  if (isDashScopeQwen(config)) {
    return 'DashScope Qwen';
  }
  if (config.openaiBaseUrl.includes('minimax.io')) {
    return 'MiniMax';
  }
  if (config.openaiBaseUrl.includes('deepseek.com')) {
    return 'DeepSeek';
  }
  if (config.openaiBaseUrl.includes('openrouter.ai')) {
    return 'OpenRouter';
  }
  return 'OpenAI-compatible';
}

function trimContextTail(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(-maxLength);
}

function createBilingualPrompt(context?: TranslationContext): string {
  if (!context?.previousEn && !context?.previousZh) {
    return BILINGUAL_SYSTEM_PROMPT;
  }

  const previousEn = context.previousEn
    ? trimContextTail(context.previousEn, 140)
    : '';
  const previousZh = context.previousZh
    ? trimContextTail(context.previousZh, 80)
    : '';

  return `${BILINGUAL_SYSTEM_PROMPT}

上一段字幕末尾仅供断句参考，禁止在输出中重复：
英文末尾：${previousEn || '无'}
中文末尾：${previousZh || '无'}

请结合上述上下文修正当前片段开头/结尾可能被切断的断句，但输出只包含当前音频片段应该显示的字幕。`;
}

function createNativeAudioBody(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  context?: TranslationContext
) {
  const audioMimeType = mimeType.split(';')[0] || 'audio/mpeg';
  return {
    model: config.openaiModel,
    modalities: isDashScopeQwen(config) ? ['text'] : undefined,
    stream: isDashScopeQwen(config) ? true : undefined,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: createBilingualPrompt(context)
          },
          {
            type: 'input_audio',
            input_audio: {
              data: isDashScopeQwen(config)
                ? `data:${audioMimeType};base64,${base64Audio}`
                : base64Audio,
              format: audioFormatFromMimeType(mimeType)
            }
          }
        ]
      }
    ]
  };
}

async function requestOpenAiNativeAudio(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  context: TranslationContext | undefined,
  signal: AbortSignal,
  onPartialResponse?: (partialText: string) => void
): Promise<string> {
  const dashScopeQwen = isDashScopeQwen(config);
  const unsupportedDashScopeReason = dashScopeQwen
    ? getUnsupportedDashScopeModelReason(config.openaiModel)
    : null;
  if (unsupportedDashScopeReason) {
    throw new Error(`${unsupportedDashScopeReason}请选择 qwen3.5-omni-plus 或 Qwen Omni Flash 系列。`);
  }

  return fetchOpenAiChatText(
    joinApiUrl(config.openaiBaseUrl, 'chat/completions'),
    createNativeAudioBody(config, base64Audio, mimeType, context),
    config.openaiApiKey,
    `${getOpenAiProviderName(config)} audio model`,
    signal,
    dashScopeQwen,
    onPartialResponse
  );
}

function base64ToBlob(base64Audio: string, mimeType: string): Blob {
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType.split(';')[0] || 'audio/webm' });
}

async function transcribeWithOpenAiMultipart(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  const format = audioFormatFromMimeType(mimeType);
  const form = new FormData();
  form.append('file', base64ToBlob(base64Audio, mimeType), `audio.${format}`);
  form.append('model', config.sttModel);

  const response = await fetch(
    joinApiUrl(config.sttBaseUrl, 'audio/transcriptions'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.sttApiKey}`
      },
      body: form,
      signal
    }
  );
  if (!response.ok) {
    throw new Error(
      `STT API ${response.status}: ${(await response.text()).slice(0, 800)}`
    );
  }
  const data = (await response.json()) as { text?: string };
  if (!data.text?.trim()) {
    throw new Error('STT API returned an empty transcript.');
  }
  return data.text;
}

async function transcribeWithOpenRouterJson(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  const data = await fetchJson<{ text?: string }>(
    joinApiUrl(config.sttBaseUrl, 'audio/transcriptions'),
    {
      method: 'POST',
      headers: createOpenAiHeaders(config.sttApiKey),
      body: JSON.stringify({
        model: config.sttModel,
        input_audio: {
          data: base64Audio,
          format: audioFormatFromMimeType(mimeType)
        }
      }),
      signal
    },
    'STT'
  );
  if (!data.text?.trim()) {
    throw new Error('STT API returned an empty transcript.');
  }
  return data.text;
}

async function requestTextTranslation(
  config: ProviderConfig,
  transcript: string,
  context: TranslationContext | undefined,
  signal: AbortSignal
): Promise<string> {
  const contextPrompt =
    context?.previousEn || context?.previousZh
      ? `${TEXT_TRANSLATION_PROMPT}

上一段字幕末尾仅供断句参考，禁止在输出中重复：
英文末尾：${context.previousEn ? trimContextTail(context.previousEn, 140) : '无'}
中文末尾：${context.previousZh ? trimContextTail(context.previousZh, 80) : '无'}`
      : TEXT_TRANSLATION_PROMPT;
  const data = await fetchJson<OpenAiResponse>(
    joinApiUrl(config.openaiBaseUrl, 'chat/completions'),
    {
      method: 'POST',
      headers: createOpenAiHeaders(config.openaiApiKey),
      body: JSON.stringify({
        model: config.openaiModel,
        messages: [
          {
            role: 'system',
            content: contextPrompt
          },
          {
            role: 'user',
            content: transcript
          }
        ],
        temperature: 0.1
      }),
      signal
    },
    `${getOpenAiProviderName(config)} text model`
  );
  return extractOpenAiText(data, `${getOpenAiProviderName(config)} text model`);
}

async function requestOpenAiPipeline(
  config: ProviderConfig,
  base64Audio: string,
  mimeType: string,
  context: TranslationContext | undefined,
  signal: AbortSignal
): Promise<string> {
  const transcript =
    config.sttRequestFormat === 'openrouter-json'
      ? await transcribeWithOpenRouterJson(
          config,
          base64Audio,
          mimeType,
          signal
        )
      : await transcribeWithOpenAiMultipart(
          config,
          base64Audio,
          mimeType,
          signal
        );
  return requestTextTranslation(config, transcript, context, signal);
}

async function requestTranslation(
  base64Audio: string,
  mimeType: string,
  context: TranslationContext | undefined,
  signal: AbortSignal,
  onPartialResponse?: (partialText: string) => void
): Promise<string> {
  const config = await getProviderConfig();
  const validationError = validateProviderConfig(config);
  if (validationError) {
    throw new Error(`CONFIG_ERROR:${validationError}`);
  }

  if (config.provider === 'gemini') {
    return requestGeminiAiStudio(config, base64Audio, mimeType, context, signal);
  }
  if (config.provider === 'vertex') {
    return requestVertexAi(config, base64Audio, mimeType, context, signal);
  }
  return config.openaiAudioMode === 'native'
    ? requestOpenAiNativeAudio(config, base64Audio, mimeType, context, signal, onPartialResponse)
    : requestOpenAiPipeline(config, base64Audio, mimeType, context, signal);
}

async function loadVerificationAudio(): Promise<{
  audioData: string;
  mimeType: string;
}> {
  const response = await fetch(chrome.runtime.getURL('test-audio.mp3'));
  if (!response.ok) {
    throw new Error('无法读取插件内置的验证音频。');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return {
    audioData: btoa(binary),
    mimeType: 'audio/mpeg'
  };
}

function assertTranslationJson(rawResponse: string): void {
  const parsed = parseTranslation(rawResponse);
  if (!parsed.textEn || !parsed.textZh || parsed.textZh === '（翻译结果格式异常）') {
    throw new Error('模型已响应，但没有返回插件要求的双语 JSON。');
  }
}

async function verifyStage<T>(
  name: string,
  stages: VerificationStage[],
  operation: () => Promise<T>,
  successMessage: (value: T) => string
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await operation();
    stages.push({
      name,
      ok: true,
      message: successMessage(value),
      latencyMs: Date.now() - startedAt
    });
    return value;
  } catch (error) {
    stages.push({
      name,
      ok: false,
      message: userFacingError(error),
      latencyMs: Date.now() - startedAt
    });
    throw error;
  }
}

async function verifyProviderConfig(
  config: ProviderConfig
): Promise<VerificationResult> {
  const stages: VerificationStage[] = [];
  const validationError = validateProviderConfig(config);
  if (validationError) {
    return {
      ok: false,
      message: validationError,
      stages: [
        {
          name: '配置检查',
          ok: false,
          message: validationError,
          latencyMs: 0
        }
      ]
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const openAiProviderName = getOpenAiProviderName(config);

  try {
    const verificationAudio = await verifyStage(
      '测试音频',
      stages,
      loadVerificationAudio,
      () => '内置英语测试音频已加载。'
    );

    if (config.provider === 'gemini') {
      await verifyStage(
        'Gemini 音频模型',
        stages,
        async () => {
          const response = await requestGeminiAiStudio(
            config,
            verificationAudio.audioData,
            verificationAudio.mimeType,
            undefined,
            controller.signal
          );
          assertTranslationJson(response);
          return response;
        },
        () => 'API Key、模型和音频输入均可用。'
      );
    } else if (config.provider === 'vertex') {
      await verifyStage(
        'Vertex AI 音频模型',
        stages,
        async () => {
          const response = await requestVertexAi(
            config,
            verificationAudio.audioData,
            verificationAudio.mimeType,
            undefined,
            controller.signal
          );
          assertTranslationJson(response);
          return response;
        },
        () => '认证、模型和音频输入均可用。'
      );
    } else if (config.openaiAudioMode === 'native') {
      await verifyStage(
        `${openAiProviderName} 音频模型`,
        stages,
        async () => {
          if (config.openaiModel && isDashScopeRealtimeModel(config.openaiModel)) {
            return JSON.stringify({ en: 'WS validation skipped', zh: '实时流模型（WebSocket）无需进行 HTTP 接口音频测试，API Key 有效即可使用。' });
          }
          const response = await requestOpenAiNativeAudio(
            config,
            verificationAudio.audioData,
            verificationAudio.mimeType,
            undefined,
            controller.signal
          );
          assertTranslationJson(response);
          return response;
        },
        () =>
          config.openaiModel && isDashScopeRealtimeModel(config.openaiModel)
            ? '实时模型（WebSocket）已跳过 HTTP 音频测试。'
            : isDashScopeQwen(config)
              ? '接口、模型和 input_audio 音频输入均可用。'
              : '接口、模型和 input_audio 输入均可用。'
      );
    } else {
      const transcript = await verifyStage(
        '语音转写 STT',
        stages,
        () =>
          config.sttRequestFormat === 'openrouter-json'
            ? transcribeWithOpenRouterJson(
                config,
                verificationAudio.audioData,
                verificationAudio.mimeType,
                controller.signal
              )
            : transcribeWithOpenAiMultipart(
                config,
                verificationAudio.audioData,
                verificationAudio.mimeType,
                controller.signal
              ),
        (text) => `转写成功：${text.slice(0, 80)}`
      );
      await verifyStage(
        `${openAiProviderName} 文本翻译模型`,
        stages,
        async () => {
          const response = await requestTextTranslation(
            config,
            transcript,
            undefined,
            controller.signal
          );
          assertTranslationJson(response);
          return response;
        },
        () => '接口、API Key、模型和文本翻译均可用。'
      );
    }

    return {
      ok: true,
      message: '验证通过，当前配置可以用于视频翻译。',
      stages
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof DOMException && error.name === 'AbortError'
          ? '验证超时，请检查网络或 API 服务状态。'
          : userFacingError(error),
      stages
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseTranslation(rawResponse: string): {
  textEn: string;
  textZh: string;
} {
  const withoutThinking = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const withoutFences = withoutThinking
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const firstBrace = withoutFences.indexOf('{');
  const lastBrace = withoutFences.lastIndexOf('}');
  const jsonCandidate =
    firstBrace >= 0 && lastBrace > firstBrace
      ? withoutFences.slice(firstBrace, lastBrace + 1)
      : withoutFences;

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      en?: unknown;
      zh?: unknown;
    };
    return {
      textEn: typeof parsed.en === 'string' ? parsed.en : '',
      textZh: typeof parsed.zh === 'string' ? parsed.zh : ''
    };
  } catch (error) {
    // Attempt to extract partial strings using Regex for streaming updates
    let textEn = '';
    let textZh = '';
    
    const decodePartial = (str: string) => {
      try { return JSON.parse(`"${str}"`) as string; } 
      catch { return str.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); }
    };

    const enMatch = jsonCandidate.match(/"en"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (enMatch) textEn = decodePartial(enMatch[1]);
    
    const zhMatch = jsonCandidate.match(/"zh"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (zhMatch) textZh = decodePartial(zhMatch[1]);

    if (!textEn && !textZh) {
      // If no valid keys found but text exists, return raw text as English temporarily
      return {
        textEn: jsonCandidate.replace(/^\{\s*/, '').replace(/"/g, ''),
        textZh: ''
      };
    }

    return {
      textEn,
      textZh
    };
  }
}

async function dispatchBilingualSubtitle(
  tabId: number,
  frameId: number,
  subtitleData: {
    id: string;
    textEn: string;
    textZh: string;
    isFinal: boolean;
    startTime?: number;
    endTime?: number;
  }
): Promise<void> {
  await chrome.tabs.sendMessage(
    tabId,
    {
      action: 'UPDATE_BILINGUAL_SUBTITLES',
      ...subtitleData
    },
    { frameId }
  );
}

async function getCurrentPlaybackTime(
  tabId: number,
  frameId: number,
  fallbackTime?: number
): Promise<number | undefined> {
  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      { action: 'GET_TRANSLATION_PLAYBACK_TIME' },
      { frameId }
    )) as { currentTime?: unknown };
    return typeof response?.currentTime === 'number'
      ? response.currentTime
      : fallbackTime;
  } catch {
    return fallbackTime;
  }
}

function abortSession(tabId: number, frameId: number, sessionId?: string): void {
  const prefix = `${tabId}:${frameId}:`;
  for (const [key, request] of activeRequests) {
    if (
      key.startsWith(prefix) &&
      (!sessionId || key === `${prefix}${sessionId}`)
    ) {
      request.controller.abort();
      activeRequests.delete(key);
      translationContexts.delete(key);
    }
  }
  for (const key of Array.from(pendingLiveRequests.keys())) {
    if (key.startsWith(prefix) && (!sessionId || key === `${prefix}${sessionId}`)) {
      pendingLiveRequests.delete(key);
      translationContexts.delete(key);
    }
  }
  for (const key of Array.from(translationContexts.keys())) {
    if (key.startsWith(prefix) && (!sessionId || key === `${prefix}${sessionId}`)) {
      translationContexts.delete(key);
    }
  }
}

async function processAudioTranslationMessage(
  message: AudioTranslationMessage,
  tabId: number,
  frameId: number,
  requestKey: string,
  sessionId: string,
  sequence: number,
  sendResponse?: (response?: unknown) => void
): Promise<void> {
  const controller = new AbortController();
  activeRequests.set(requestKey, { controller, sequence });

  try {
    const subtitleId =
      message.action === 'PROCESS_VOD_AUDIO_SEGMENT'
        ? `vod-${message.timestamp || sequence}`
        : `live-${sessionId}`;

    const rawResponse = await requestTranslation(
      message.audioData,
      message.mimeType || 'audio/webm',
      translationContexts.get(requestKey),
      controller.signal,
      (partialText: string) => {
        const { textEn, textZh } = parseTranslation(partialText);
        if (textEn.trim() && textZh.trim()) {
          void dispatchBilingualSubtitle(tabId, frameId, {
            id: subtitleId,
            textEn,
            textZh,
            isFinal: false,
            startTime: message.startTime,
            endTime: message.endTime
          });
        }
      }
    );

    const current = activeRequests.get(requestKey);
    if (
      controller.signal.aborted ||
      !current ||
      current.controller !== controller ||
      current.sequence !== sequence
    ) {
      return;
    }

    const { textEn, textZh } = parseTranslation(rawResponse);
    const currentPlaybackTime = await getCurrentPlaybackTime(
      tabId,
      frameId,
      message.playbackTime
    );
    if (
      message.action === 'TRANSLATE_LIVE_AUDIO_CHUNK' &&
      typeof message.endTime === 'number' &&
      typeof currentPlaybackTime === 'number' &&
      currentPlaybackTime - message.endTime > 6
    ) {
      sendResponse?.({ ok: false, stale: true });
      return;
    }
    const hasBilingualText = Boolean(textEn.trim() && textZh.trim());
    if (hasBilingualText) {
      translationContexts.set(requestKey, {
        previousEn: textEn,
        previousZh: textZh
      });
    }

    if (
      message.action === 'PROCESS_VOD_AUDIO_SEGMENT' ||
      hasBilingualText
    ) {
      await dispatchBilingualSubtitle(tabId, frameId, {
        id: subtitleId,
        textEn,
        textZh,
        isFinal: message.action === 'PROCESS_VOD_AUDIO_SEGMENT',
        startTime: message.startTime,
        endTime: message.endTime
      });
    }
    sendResponse?.({ ok: true });
  } catch (error) {
    if (controller.signal.aborted) {
      sendResponse?.({ ok: false, aborted: true });
      return;
    }

    console.error('[Background] Translation request failed:', error);
    const messageText = errorMessage(error);
    const configError = messageText.startsWith('CONFIG_ERROR:')
      ? messageText.slice('CONFIG_ERROR:'.length)
      : null;
    await dispatchBilingualSubtitle(tabId, frameId, {
      id: `error-${sessionId}`,
      textEn: '',
      textZh: configError || `翻译失败：${userFacingError(error)}`,
      isFinal: false,
      startTime: message.startTime,
      endTime: message.endTime
    });
    sendResponse?.({ ok: false, error: messageText });
  } finally {
    const current = activeRequests.get(requestKey);
    if (current?.controller === controller) {
      activeRequests.delete(requestKey);
    }

    const pending = pendingLiveRequests.get(requestKey);
    if (pending) {
      pendingLiveRequests.delete(requestKey);
      const pendingSequence =
        pending.message.sequence || pending.message.timestamp || Date.now();
      void processAudioTranslationMessage(
        pending.message,
        pending.tabId,
        pending.frameId,
        requestKey,
        sessionId,
        pendingSequence
      );
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    message:
      | AudioTranslationMessage
      | AbortTranslationMessage
      | ClearSubtitlesMessage
      | VerifyProviderMessage
      | OpenOptionsPageMessage,
    sender,
    sendResponse
  ) => {
    if (message.action === 'VERIFY_PROVIDER_CONFIG') {
      void verifyProviderConfig(
        readProviderConfig(
          (message as VerifyProviderMessage).config as unknown as Record<
            string,
            unknown
          >
        )
      ).then(sendResponse);
      return true;
    }

    if (message.action === 'OPEN_OPTIONS_PAGE') {
      if (chrome.runtime.openOptionsPage) {
        void chrome.runtime
          .openOptionsPage()
          .then(() => sendResponse({ ok: true }))
          .catch((error: unknown) =>
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
          );
        return true;
      }
      sendResponse({ ok: false, error: 'openOptionsPage unavailable' });
      return false;
    }

    if ((message as any).action === 'OFFSCREEN_READY') {
      console.log('[Background] Received OFFSCREEN_READY');
      resolveOffscreenReady?.();
      return false;
    }

    if ((message as any).action === 'START_OFFSCREEN_WS') {
      const { apiKey, model, sessionId } = message as any;
      const tabId = sender.tab?.id;
      const frameId = sender.frameId ?? 0;

      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        typeof tabId !== 'number'
      ) {
        sendResponse({ ok: false, error: 'Invalid realtime session.' });
        return false;
      }

      pendingRealtimeStarts.add(sessionId);
      cancelledRealtimeStarts.delete(sessionId);
      void enqueueRealtimeStart(async () => {
        if (cancelledRealtimeStarts.has(sessionId)) {
          throw new Error('Realtime session start was cancelled.');
        }

        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [1],
          addRules: [
            {
              id: 1,
              priority: 1,
              action: {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                requestHeaders: [
                  {
                    header: 'Authorization',
                    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                    value: `Bearer ${apiKey}`
                  }
                ]
              },
              condition: {
                urlFilter: '*dashscope.aliyuncs.com/api-ws/v1/*',
                resourceTypes: [
                  chrome.declarativeNetRequest.ResourceType.WEBSOCKET
                ]
              }
            }
          ]
        });

        await ensureOffscreenDocument();
        if (cancelledRealtimeStarts.has(sessionId)) {
          throw new Error('Realtime session start was cancelled.');
        }
        const isGummy =
          typeof model === 'string' && model.includes('gummy');
        const wsUrl = isGummy
          ? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
          : `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model || '')}`;

        await sendOffscreenStartMessage({
            target: 'offscreen',
            action: 'start_ws',
            wsUrl,
            sessionId,
            tabId,
            frameId,
            model,
            config: {} 
        });
      })
        .finally(() => {
          pendingRealtimeStarts.delete(sessionId);
          cancelledRealtimeStarts.delete(sessionId);
        })
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          console.error('[Background] Failed to start offscreen session:', error);
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      return true;
    }

    if ((message as any).action === 'SEND_OFFSCREEN_AUDIO') {
      sendRuntimeMessageSafely({
        target: 'offscreen',
        action: 'send_audio',
        base64Audio: (message as any).base64Audio,
        sessionId: (message as any).sessionId
      }, 'Offscreen audio message');
      return false;
    }

    if ((message as any).action === 'STOP_OFFSCREEN_WS') {
      const sessionId = (message as any).sessionId;
      if (
        typeof sessionId === 'string' &&
        pendingRealtimeStarts.has(sessionId)
      ) {
        cancelledRealtimeStarts.add(sessionId);
      }
      sendRuntimeMessageSafely({
        target: 'offscreen',
        action: 'stop_ws',
        sessionId
      }, 'Offscreen stop message');
      return false;
    }

    // Forward messages from Offscreen back to the correct Content Script
    if (
      (message as any).action === 'OFFSCREEN_WS_SUBTITLE' ||
      (message as any).action === 'OFFSCREEN_WS_ERROR' ||
      (message as any).action === 'OFFSCREEN_WS_NETWORK_PROFILE'
    ) {
      const targetTabId = (message as any).tabId;
      const targetFrameId = (message as any).frameId;
      if (typeof targetTabId === 'number') {
        sendTabMessageSafely(targetTabId, message, targetFrameId);
      }
      return false;
    }

    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;

    if (message.action === 'ABORT_TRANSLATION') {
      if (tabId !== undefined) {
        abortSession(tabId, frameId, message.sessionId);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === 'CLEAR_BILINGUAL_SUBTITLES') {
      if (tabId !== undefined) {
        sendTabMessageSafely(
          tabId,
          { action: 'CLEAR_BILINGUAL_SUBTITLES' },
          frameId
        );
      }
      sendResponse({ ok: true });
      return false;
    }

    if (
      message.action !== 'PROCESS_VOD_AUDIO_SEGMENT' &&
      message.action !== 'TRANSLATE_LIVE_AUDIO_CHUNK'
    ) {
      return false;
    }

    if (tabId === undefined) {
      sendResponse({ ok: false, error: 'Missing sender tab.' });
      return false;
    }

    const sessionId =
      message.sessionId ||
      (message.action === 'PROCESS_VOD_AUDIO_SEGMENT'
        ? `vod:${message.url || message.timestamp || 'unknown'}`
        : 'live:legacy');
    const sequence = message.sequence || message.timestamp || Date.now();
    const requestKey = getRequestKey(tabId, frameId, sessionId);

    const activeRequest = activeRequests.get(requestKey);
    if (activeRequest && message.action === 'TRANSLATE_LIVE_AUDIO_CHUNK') {
      pendingLiveRequests.set(requestKey, { message, tabId, frameId });
      sendResponse({ ok: false, queued: true });
      return false;
    }
    if (activeRequest) {
      sendResponse({ ok: false, skipped: true });
      return false;
    }

    void processAudioTranslationMessage(
      message,
      tabId,
      frameId,
      requestKey,
      sessionId,
      sequence,
      sendResponse
    );

    return true;
  }
);

console.log('[Background] Service worker successfully initialized.');
