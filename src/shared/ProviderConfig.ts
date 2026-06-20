export type AiProvider = 'gemini' | 'vertex' | 'openai';
export type VertexAuthMode = 'apiKey' | 'accessToken';
export type OpenAiAudioMode = 'native' | 'transcription';
export type SttRequestFormat = 'openai-multipart' | 'openrouter-json';

export interface ProviderConfig {
  provider: AiProvider;
  geminiApiKey: string;
  geminiModel: string;
  vertexAuthMode: VertexAuthMode;
  vertexApiKey: string;
  vertexAccessToken: string;
  vertexProjectId: string;
  vertexLocation: string;
  vertexModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiAudioMode: OpenAiAudioMode;
  sttRequestFormat: SttRequestFormat;
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: 'gemini',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  vertexAuthMode: 'apiKey',
  vertexApiKey: '',
  vertexAccessToken: '',
  vertexProjectId: '',
  vertexLocation: 'global',
  vertexModel: 'gemini-2.5-flash',
  openaiBaseUrl: 'https://openrouter.ai/api/v1',
  openaiApiKey: '',
  openaiModel: 'google/gemini-2.5-flash',
  openaiAudioMode: 'native',
  sttRequestFormat: 'openrouter-json',
  sttBaseUrl: 'https://openrouter.ai/api/v1',
  sttApiKey: '',
  sttModel: 'openai/gpt-4o-mini-transcribe'
};

export const PROVIDER_STORAGE_KEYS = Object.keys(
  DEFAULT_PROVIDER_CONFIG
) as Array<keyof ProviderConfig>;

export const AUTO_TRANSLATE_ON_PLAY_KEY = 'autoTranslateOnPlay';

function readString(
  record: Record<string, unknown>,
  key: keyof ProviderConfig
): string {
  const value = record[key];
  return typeof value === 'string'
    ? value.trim()
    : String(DEFAULT_PROVIDER_CONFIG[key]);
}

export function readProviderConfig(
  record: Record<string, unknown>
): ProviderConfig {
  const provider = readString(record, 'provider');
  const vertexAuthMode = readString(record, 'vertexAuthMode');
  const openaiAudioMode = readString(record, 'openaiAudioMode');
  const sttRequestFormat = readString(record, 'sttRequestFormat');

  return {
    provider:
      provider === 'vertex' || provider === 'openai' ? provider : 'gemini',
    geminiApiKey: readString(record, 'geminiApiKey'),
    geminiModel:
      readString(record, 'geminiModel') ||
      DEFAULT_PROVIDER_CONFIG.geminiModel,
    vertexAuthMode:
      vertexAuthMode === 'accessToken' ? 'accessToken' : 'apiKey',
    vertexApiKey: readString(record, 'vertexApiKey'),
    vertexAccessToken: readString(record, 'vertexAccessToken'),
    vertexProjectId: readString(record, 'vertexProjectId'),
    vertexLocation:
      readString(record, 'vertexLocation') ||
      DEFAULT_PROVIDER_CONFIG.vertexLocation,
    vertexModel:
      readString(record, 'vertexModel') ||
      DEFAULT_PROVIDER_CONFIG.vertexModel,
    openaiBaseUrl:
      readString(record, 'openaiBaseUrl') ||
      DEFAULT_PROVIDER_CONFIG.openaiBaseUrl,
    openaiApiKey: readString(record, 'openaiApiKey'),
    openaiModel:
      readString(record, 'openaiModel') ||
      DEFAULT_PROVIDER_CONFIG.openaiModel,
    openaiAudioMode:
      openaiAudioMode === 'transcription' ? 'transcription' : 'native',
    sttRequestFormat:
      sttRequestFormat === 'openai-multipart'
        ? 'openai-multipart'
        : 'openrouter-json',
    sttBaseUrl:
      readString(record, 'sttBaseUrl') ||
      DEFAULT_PROVIDER_CONFIG.sttBaseUrl,
    sttApiKey: readString(record, 'sttApiKey'),
    sttModel:
      readString(record, 'sttModel') || DEFAULT_PROVIDER_CONFIG.sttModel
  };
}

export function validateProviderConfig(config: ProviderConfig): string | null {
  if (config.provider === 'gemini') {
    return config.geminiApiKey ? null : '请填写 Gemini AI Studio API Key。';
  }

  if (config.provider === 'vertex') {
    if (config.vertexAuthMode === 'apiKey') {
      return config.vertexApiKey
        ? null
        : '请填写 Vertex AI Express Mode API Key。';
    }
    if (!config.vertexAccessToken) {
      return '请填写 Vertex AI OAuth Access Token。';
    }
    if (!config.vertexProjectId) {
      return '请填写 Google Cloud Project ID。';
    }
    return null;
  }

  if (!config.openaiBaseUrl || !config.openaiApiKey || !config.openaiModel) {
    return '请完整填写 OpenAI 兼容接口地址、API Key 和模型名称。';
  }

  if (
    config.openaiAudioMode === 'transcription' &&
    (!config.sttBaseUrl || !config.sttApiKey || !config.sttModel)
  ) {
    return '文本模型需要先配置语音转写（STT）接口。';
  }

  return null;
}

export function joinApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function audioFormatFromMimeType(mimeType: string): string {
  const normalized = mimeType.split(';')[0].toLowerCase();
  const formats: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm'
  };
  return formats[normalized] || 'webm';
}

export function isDashScopeRealtimeModel(model: string): boolean {
  return model.toLowerCase().includes('realtime');
}

export function isDashScopeTaskRealtimeModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized === 'gummy-realtime-v1';
}

export function isDashScopeLiveTranslateRealtimeModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized === 'qwen3-livetranslate-flash-realtime' ||
    normalized === 'qwen3.5-livetranslate-flash-realtime'
  );
}

export function getUnsupportedDashScopeModelReason(model: string): string | null {
  const normalized = model.toLowerCase();
  // We now fully support DashScope realtime WebSocket models!
  if (normalized === 'qwen3-livetranslate-flash') {
    return 'Qwen3 音视频文件翻译需要单独的文件翻译接口。';
  }
  if (normalized === 'gummy-realtime-v1') {
    return 'Gummy 实时语音模型需要单独的实时语音接口。';
  }
  return null;
}
