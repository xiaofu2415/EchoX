import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PROVIDER_CONFIG,
  PROVIDER_STORAGE_KEYS,
  isDashScopeRealtimeModel,
  readProviderConfig,
  validateProviderConfig,
  type AiProvider,
  type ProviderConfig
} from '../shared/ProviderConfig';
import './options.css';

type DisplayMode = 'bilingual' | 'chinese';
type OpenAiPreset =
  | 'openrouter'
  | 'deepseek'
  | 'minimax'
  | 'qwen'
  | 'custom';
type TranslationService =
  | 'gemini'
  | 'vertex'
  | 'qwen'
  | 'openrouter'
  | 'deepseek'
  | 'minimax'
  | 'custom';
type QwenModel =
  | 'qwen3.5-omni-plus'
  | 'qwen3.5-omni-flash'
  | 'qwen3-omni-flash'
  | 'qwen3.5-livetranslate-flash-realtime'
  | 'qwen3-livetranslate-flash-realtime'
  | 'qwen3-livetranslate-flash'
  | 'gummy-realtime-v1'
  | 'qwen3.7-max'
  | 'qwen3.7-plus';

interface OptionsProps {
  variant?: 'popup' | 'page';
}

interface VerificationResult {
  ok: boolean;
  message: string;
  stages: Array<{
    name: string;
    ok: boolean;
    message: string;
    latencyMs: number;
  }>;
}

const translationServiceOptions: Array<{
  value: TranslationService;
  title: string;
  group: string;
  description: string;
}> = [
  {
    value: 'gemini',
    group: '原生音频模型',
    title: 'Gemini AI Studio',
    description: 'API Key，配置最简单'
  },
  {
    value: 'vertex',
    group: '原生音频模型',
    title: 'Google Vertex AI',
    description: 'Google Cloud / Express Mode'
  },
  {
    value: 'qwen',
    group: '原生音频模型',
    title: 'DashScope / Qwen',
    description: '通义千问音频与实时翻译模型'
  },
  {
    value: 'minimax',
    group: 'OpenAI 兼容',
    title: 'MiniMax M3',
    description: 'MiniMax 多模态模型'
  },
  {
    value: 'deepseek',
    group: 'OpenAI 兼容',
    title: 'DeepSeek',
    description: '文本模型，默认搭配 STT'
  },
  {
    value: 'openrouter',
    group: 'OpenAI 兼容',
    title: 'OpenRouter',
    description: '可路由多家模型'
  },
  {
    value: 'custom',
    group: '其他/自定义',
    title: '自定义接口',
    description: '手动填写兼容接口'
  }
];

const providerPresets: Record<
  Exclude<OpenAiPreset, 'custom'>,
  Partial<ProviderConfig>
> = {
  openrouter: {
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiModel: 'google/gemini-2.5-flash',
    openaiAudioMode: 'native',
    sttRequestFormat: 'openrouter-json',
    sttBaseUrl: 'https://openrouter.ai/api/v1',
    sttModel: 'openai/gpt-4o-mini-transcribe'
  },
  deepseek: {
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    openaiModel: 'deepseek-v4-flash',
    openaiAudioMode: 'transcription',
    sttRequestFormat: 'openrouter-json',
    sttBaseUrl: 'https://openrouter.ai/api/v1',
    sttModel: 'openai/gpt-4o-mini-transcribe'
  },
  minimax: {
    openaiBaseUrl: 'https://api.minimax.io/v1',
    openaiModel: 'MiniMax-M3',
    openaiAudioMode: 'native',
    sttRequestFormat: 'openrouter-json',
    sttBaseUrl: 'https://openrouter.ai/api/v1',
    sttModel: 'openai/gpt-4o-mini-transcribe'
  },
  qwen: {
    openaiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openaiModel: 'qwen3.5-livetranslate-flash-realtime',
    openaiAudioMode: 'native',
    sttRequestFormat: 'openrouter-json',
    sttBaseUrl: 'https://openrouter.ai/api/v1',
    sttModel: 'openai/gpt-4o-mini-transcribe'
  }
};

const qwenModelOptions: Array<{
  value: QwenModel;
  title: string;
  group: string;
  description: string;
  audioMode: ProviderConfig['openaiAudioMode'];
  disabledReason?: string;
}> = [
  {
    value: 'qwen3.5-livetranslate-flash-realtime',
    title: 'Qwen3.5 实时语音翻译',
    group: '当前推荐',
    description: '极低延迟双工同传，需 WebSocket',
    audioMode: 'native'
  },
  {
    value: 'qwen3-livetranslate-flash-realtime',
    title: 'Qwen3 实时语音翻译',
    group: '备选实时流翻译',
    description: '双工同传，需 WebSocket',
    audioMode: 'native'
  },
  {
    value: 'gummy-realtime-v1',
    title: 'Gummy 原生同传双语模型',
    group: '双语专属',
    description: '原生支持中英双语输出',
    audioMode: 'native'
  }
];

const modeOptions: Array<{
  value: DisplayMode;
  title: string;
  description: string;
  preview: string;
}> = [
  {
    value: 'bilingual',
    title: '双语对照',
    description: '英文原文与中文翻译同时显示',
    preview: 'EN / 中'
  },
  {
    value: 'chinese',
    title: '仅中文',
    description: '隐藏英文，专注中文翻译',
    preview: '中文'
  }
];

function detectPreset(config: ProviderConfig): OpenAiPreset {
  if (config.openaiBaseUrl.includes('openrouter.ai')) return 'openrouter';
  if (config.openaiBaseUrl.includes('deepseek.com')) return 'deepseek';
  if (config.openaiBaseUrl.includes('minimax.io')) return 'minimax';
  if (config.openaiBaseUrl.includes('dashscope.aliyuncs.com')) {
    return 'qwen';
  }
  return 'custom';
}

function isQwenService(config: ProviderConfig): boolean {
  return config.openaiBaseUrl.includes('dashscope.aliyuncs.com');
}

function getQwenModelOption(model: string) {
  return qwenModelOptions.find((option) => option.value === model);
}

function isUnsupportedQwenModel(model: string): boolean {
  return Boolean(getQwenModelOption(model)?.disabledReason);
}

function detectTranslationService(config: ProviderConfig): TranslationService {
  if (config.provider === 'gemini') return 'gemini';
  if (config.provider === 'vertex') return 'vertex';
  return detectPreset(config);
}

function InputField({
  label,
  value,
  placeholder,
  secret = false,
  onChange
}: {
  label: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="api-input-wrap">
        <input
          type={secret && !visible ? 'password' : 'text'}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {secret && (
          <button
            className="visibility-button"
            type="button"
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? '隐藏' : '显示'}
          </button>
        )}
      </div>
    </label>
  );
}

export const Options: React.FC<OptionsProps> = ({ variant = 'page' }) => {
  const [config, setConfig] = useState<ProviderConfig>(
    DEFAULT_PROVIDER_CONFIG
  );
  const [displayMode, setDisplayMode] =
    useState<DisplayMode>('bilingual');
  const [translationService, setTranslationService] =
    useState<TranslationService>('gemini');
  const [serviceMenuOpen, setServiceMenuOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] =
    useState<VerificationResult | null>(null);
  const serviceSelectRef = useRef<HTMLDivElement | null>(null);
  const selectedService =
    translationServiceOptions.find(
      (option) => option.value === translationService
    ) || translationServiceOptions[0];
  const qwenModelGroups = Array.from(
    new Set(qwenModelOptions.map((option) => option.group))
  );

  const updateConfig = <Key extends keyof ProviderConfig>(
    key: Key,
    value: ProviderConfig[Key]
  ) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setError('');
    setSaved(false);
    setVerification(null);
  };

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    chrome.storage.local.get(
      [...PROVIDER_STORAGE_KEYS, 'displayMode'],
      (result: Record<string, unknown>) => {
        const nextConfig = readProviderConfig(result);
        setConfig(nextConfig);
        setTranslationService(detectTranslationService(nextConfig));
        if (
          result.displayMode === 'bilingual' ||
          result.displayMode === 'chinese'
        ) {
          setDisplayMode(result.displayMode);
        }
      }
    );
  }, []);

  useEffect(() => {
    if (!serviceMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        serviceSelectRef.current &&
        !serviceSelectRef.current.contains(event.target as Node)
      ) {
        setServiceMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [serviceMenuOpen]);

  const selectTranslationService = (service: TranslationService) => {
    setTranslationService(service);
    setServiceMenuOpen(false);
    if (service === 'gemini' || service === 'vertex') {
      setConfig((current) => ({
        ...current,
        provider: service
      }));
    } else if (service !== 'custom') {
      setConfig((current) => ({
        ...current,
        provider: 'openai',
        ...providerPresets[service]
      }));
    } else {
      setConfig((current) => ({
        ...current,
        provider: 'openai'
      }));
    }
    setError('');
    setVerification(null);
  };

  const requestCustomHostPermissions = async (): Promise<boolean> => {
    if (
      typeof chrome === 'undefined' ||
      !chrome.permissions ||
      config.provider !== 'openai'
    ) {
      return true;
    }

    const endpoints = [config.openaiBaseUrl];
    if (config.openaiAudioMode === 'transcription') {
      endpoints.push(config.sttBaseUrl);
    }

    const origins = Array.from(
      new Set(
        endpoints.flatMap((endpoint) => {
          try {
            const url = new URL(endpoint);
            const knownHosts = new Set([
              'api.openai.com',
              'api.deepseek.com',
              'api.minimax.io',
              'dashscope.aliyuncs.com',
              'openrouter.ai'
            ]);
            return knownHosts.has(url.hostname) ? [] : [`${url.origin}/*`];
          } catch {
            return [];
          }
        })
      )
    );

    if (origins.length === 0) return true;
    return chrome.permissions.request({ origins });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);

    const validationError = validateProviderConfig(config);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSaving(true);
    try {
      const permissionGranted = await requestCustomHostPermissions();
      if (!permissionGranted) {
        setError('需要允许访问所填写的 API 域名，插件才能发送请求。');
        return;
      }

      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({
          ...config,
          displayMode
        });
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : '保存设置失败。'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleVerify = async () => {
    setSaved(false);
    setError('');
    setVerification(null);

    const validationError = validateProviderConfig(config);
    if (validationError) {
      setVerification({
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
      });
      return;
    }

    const qwenModel = getQwenModelOption(config.openaiModel);
    if (isQwenService(config) && qwenModel?.disabledReason) {
      setVerification({
        ok: false,
        message: `${qwenModel.title} 暂未接入：${qwenModel.disabledReason}。`,
        stages: [
          {
            name: 'Qwen 模型能力',
            ok: false,
            message: '请选择当前推荐或 HTTP 音频模型进行验证。',
            latencyMs: 0
          }
        ]
      });
      return;
    }

    setIsVerifying(true);
    try {
      const permissionGranted = await requestCustomHostPermissions();
      if (!permissionGranted) {
        setVerification({
          ok: false,
          message: '未授予 API 域名访问权限。',
          stages: [
            {
              name: '域名权限',
              ok: false,
              message: '需要允许访问所填写的 API 域名。',
              latencyMs: 0
            }
          ]
        });
        return;
      }

      if (
        typeof chrome === 'undefined' ||
        !chrome.runtime?.sendMessage
      ) {
        throw new Error('请在已安装的扩展配置页中执行验证。');
      }

      const result = (await chrome.runtime.sendMessage({
        action: 'VERIFY_PROVIDER_CONFIG',
        config
      })) as VerificationResult;
      setVerification(result);
    } catch (verifyError) {
      setVerification({
        ok: false,
        message:
          verifyError instanceof Error
            ? verifyError.message
            : '验证请求失败。',
        stages: []
      });
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <main className={`options-shell options-shell--${variant}`}>
      <div className="options-glow options-glow--top" />
      <div className="options-glow options-glow--bottom" />

      <section className="options-card options-card--wide">
        <header className="options-header">
          <div className="brand-mark" aria-hidden="true">
            <span>译</span>
          </div>
          <div className="options-heading">
            <div className="eyebrow">
              <span className="status-dot" />
              EchoX Translator
            </div>
            <h1>视频翻译设置</h1>
            <p>选择音频模型或 STT + 文本模型组合</p>
          </div>
        </header>

        <form className="options-form" onSubmit={handleSubmit}>
          <section className="settings-section">
            <div className="section-heading">
              <div>
                <h2>模型服务</h2>
                <p>请选择 API 来源</p>
              </div>
              <span className="privacy-badge">密钥仅本地保存</span>
            </div>

            <label className="service-select-row">
              <span className="service-select-label">翻译服务</span>
              <div className="service-select-control" ref={serviceSelectRef}>
                <span className="service-icon" aria-hidden="true">译</span>
                <button
                  className="service-select-button"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={serviceMenuOpen}
                  onClick={() => setServiceMenuOpen((current) => !current)}
                >
                  <span>{selectedService.title}</span>
                  <small>{selectedService.description}</small>
                </button>
                <span className="select-arrow" aria-hidden="true">⌄</span>
                {serviceMenuOpen && (
                  <div className="service-menu" role="listbox">
                    {['原生音频模型', 'OpenAI 兼容', '其他/自定义'].map(
                      (group) => (
                        <div className="service-menu-group" key={group}>
                          <div className="service-menu-heading">{group}</div>
                          {translationServiceOptions
                            .filter((option) => option.group === group)
                            .map((option) => {
                              const active = option.value === translationService;
                              return (
                                <button
                                  className={`service-menu-item${
                                    active ? ' service-menu-item--active' : ''
                                  }`}
                                  type="button"
                                  role="option"
                                  aria-selected={active}
                                  key={option.value}
                                  onClick={() =>
                                    selectTranslationService(option.value)
                                  }
                                >
                                  <span className="service-menu-check">
                                    {active ? '✓' : ''}
                                  </span>
                                  <span className="service-menu-copy">
                                    <strong>{option.title}</strong>
                                    <small>{option.description}</small>
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            </label>
          </section>

          {config.provider === 'gemini' && (
            <section className="settings-section settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Gemini AI Studio</h2>
                  <p>音频直接转录并翻译</p>
                </div>
                <span className="capability-badge">原生音频</span>
              </div>
              <InputField
                label="API Key"
                value={config.geminiApiKey}
                placeholder="AIza..."
                secret
                onChange={(value) => updateConfig('geminiApiKey', value)}
              />
              <InputField
                label="模型"
                value={config.geminiModel}
                placeholder="gemini-2.5-flash"
                onChange={(value) => updateConfig('geminiModel', value)}
              />
            </section>
          )}

          {config.provider === 'vertex' && (
            <section className="settings-section settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Google Cloud Vertex AI</h2>
                  <p>Express Mode API Key 或标准 OAuth</p>
                </div>
                <span className="capability-badge">原生音频</span>
              </div>

              <div className="segmented-control">
                <button
                  type="button"
                  className={
                    config.vertexAuthMode === 'apiKey' ? 'is-active' : ''
                  }
                  onClick={() => updateConfig('vertexAuthMode', 'apiKey')}
                >
                  Express API Key
                </button>
                <button
                  type="button"
                  className={
                    config.vertexAuthMode === 'accessToken' ? 'is-active' : ''
                  }
                  onClick={() =>
                    updateConfig('vertexAuthMode', 'accessToken')
                  }
                >
                  OAuth Token
                </button>
              </div>

              {config.vertexAuthMode === 'apiKey' ? (
                <InputField
                  label="Google Cloud API Key"
                  value={config.vertexApiKey}
                  placeholder="Vertex AI Express Mode API Key"
                  secret
                  onChange={(value) => updateConfig('vertexApiKey', value)}
                />
              ) : (
                <>
                  <InputField
                    label="OAuth Access Token"
                    value={config.vertexAccessToken}
                    placeholder="ya29..."
                    secret
                    onChange={(value) =>
                      updateConfig('vertexAccessToken', value)
                    }
                  />
                  <div className="field-row">
                    <InputField
                      label="Project ID"
                      value={config.vertexProjectId}
                      placeholder="my-gcp-project"
                      onChange={(value) =>
                        updateConfig('vertexProjectId', value)
                      }
                    />
                    <InputField
                      label="Location"
                      value={config.vertexLocation}
                      placeholder="global"
                      onChange={(value) =>
                        updateConfig('vertexLocation', value)
                      }
                    />
                  </div>
                </>
              )}
              <InputField
                label="模型"
                value={config.vertexModel}
                placeholder="gemini-2.5-flash"
                onChange={(value) => updateConfig('vertexModel', value)}
              />
              {config.vertexAuthMode === 'accessToken' && (
                <p className="inline-note">
                  Access Token 通常会过期，过期后需要重新填写。
                </p>
              )}
            </section>
          )}

          {config.provider === 'openai' && (
            <section className="settings-section settings-panel">
              <div className="section-heading">
                <div>
                  <h2>OpenAI 兼容接口</h2>
                  <p>可使用预设，也可填写自定义接口</p>
                </div>
              </div>

              <InputField
                label="Base URL"
                value={config.openaiBaseUrl}
                placeholder="https://example.com/v1"
                onChange={(value) => {
                  updateConfig('openaiBaseUrl', value);
                  setTranslationService('custom');
                }}
              />
              <InputField
                label="API Key"
                value={config.openaiApiKey}
                placeholder="sk-..."
                secret
                onChange={(value) => updateConfig('openaiApiKey', value)}
              />
              {isQwenService(config) ? (
                <label className="field">
                  <span>模型</span>
                  <select
                    className="model-select"
                    value={
                      qwenModelOptions.some(
                        (option) => option.value === config.openaiModel
                      )
                        ? config.openaiModel
                        : 'qwen3.5-livetranslate-flash-realtime'
                    }
                    onChange={(event) => {
                      const option = getQwenModelOption(event.target.value);
                      updateConfig('openaiModel', event.target.value);
                      if (option) {
                        updateConfig('openaiAudioMode', option.audioMode);
                      }
                    }}
                  >
                    {qwenModelGroups.map((group) => (
                      <optgroup label={group} key={group}>
                        {qwenModelOptions
                          .filter((option) => option.group === group)
                          .map((option) => (
                            <option
                              value={option.value}
                              key={option.value}
                              disabled={isUnsupportedQwenModel(option.value)}
                            >
                              {option.title} - {option.description}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ) : (
                <InputField
                  label="模型"
                  value={config.openaiModel}
                  placeholder="模型 ID"
                  onChange={(value) => updateConfig('openaiModel', value)}
                />
              )}

              <div className="section-heading compact-heading">
                <div>
                  <h2>音频处理方式</h2>
                  <p>文本模型必须选择“先语音转写”</p>
                </div>
              </div>
              <div className="segmented-control">
                <button
                  type="button"
                  className={
                    config.openaiAudioMode === 'native' ? 'is-active' : ''
                  }
                  onClick={() => updateConfig('openaiAudioMode', 'native')}
                >
                  模型原生音频
                </button>
                <button
                  type="button"
                  className={
                    config.openaiAudioMode === 'transcription'
                      ? 'is-active'
                      : ''
                  }
                  onClick={() =>
                    updateConfig('openaiAudioMode', 'transcription')
                  }
                >
                  STT + 文本模型
                </button>
              </div>

              {config.openaiAudioMode === 'native' ? (
                <p className="inline-note inline-note--warning">
                  Qwen 当前已全量接入 WebSocket 实时语音流大模型，为您带来零延迟的双工同传体验。
                </p>
              ) : (
                <div className="stt-panel">
                  <div className="section-heading">
                    <div>
                      <h2>语音转写（STT）</h2>
                      <p>先把视频声音转成文字，再交给文本模型翻译</p>
                    </div>
                    <span className="capability-badge">两阶段</span>
                  </div>
                  <label className="field">
                    <span>请求格式</span>
                    <select
                      value={config.sttRequestFormat}
                      onChange={(event) =>
                        updateConfig(
                          'sttRequestFormat',
                          event.target.value as ProviderConfig['sttRequestFormat']
                        )
                      }
                    >
                      <option value="openrouter-json">
                        OpenRouter JSON Base64
                      </option>
                      <option value="openai-multipart">
                        OpenAI Multipart
                      </option>
                    </select>
                  </label>
                  <InputField
                    label="STT Base URL"
                    value={config.sttBaseUrl}
                    placeholder="https://openrouter.ai/api/v1"
                    onChange={(value) => updateConfig('sttBaseUrl', value)}
                  />
                  <InputField
                    label="STT API Key"
                    value={config.sttApiKey}
                    placeholder="语音转写服务的 API Key"
                    secret
                    onChange={(value) => updateConfig('sttApiKey', value)}
                  />
                  <InputField
                    label="STT 模型"
                    value={config.sttModel}
                    placeholder="openai/gpt-4o-mini-transcribe"
                    onChange={(value) => updateConfig('sttModel', value)}
                  />
                </div>
              )}
            </section>
          )}

          <section className="settings-section">
            <div className="section-heading">
              <div>
                <h2>字幕显示</h2>
                <p>播放时可以随时切换</p>
              </div>
            </div>
            <div className="mode-grid" role="radiogroup">
              {modeOptions.map((option) => {
                const active = displayMode === option.value;
                return (
                  <button
                    className={`mode-card${active ? ' mode-card--active' : ''}`}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    key={option.value}
                    onClick={() => setDisplayMode(option.value)}
                  >
                    <span className="mode-preview">{option.preview}</span>
                    <span className="mode-copy">
                      <strong>{option.title}</strong>
                      <small>{option.description}</small>
                    </span>
                    <span className="radio-indicator">
                      <span />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {error && <div className="form-error">{error}</div>}

          {verification && (
            <section
              className={`verification-result ${
                verification.ok
                  ? 'verification-result--success'
                  : 'verification-result--error'
              }`}
              aria-live="polite"
            >
              <div className="verification-summary">
                <span className="verification-icon">
                  {verification.ok ? '✓' : '!'}
                </span>
                <div>
                  <strong>
                    {verification.ok ? '配置验证通过' : '配置验证失败'}
                  </strong>
                  <p>{verification.message}</p>
                </div>
              </div>
              {verification.stages.length > 0 && (
                <div className="verification-stages">
                  {verification.stages.map((stage, index) => (
                    <div
                      className="verification-stage"
                      key={`${stage.name}-${index}`}
                    >
                      <span
                        className={`stage-dot ${
                          stage.ok ? 'stage-dot--ok' : 'stage-dot--error'
                        }`}
                      />
                      <div>
                        <strong>{stage.name}</strong>
                        <small>{stage.message}</small>
                      </div>
                      <time>
                        {stage.latencyMs > 0
                          ? `${stage.latencyMs}ms`
                          : '--'}
                      </time>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <div className="action-row">
            <button
              className="verify-button"
              type="button"
              disabled={isSaving || isVerifying}
              onClick={handleVerify}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3a9 9 0 1 0 9 9M12 7v5l3 2M17 3h4v4" />
              </svg>
              <span>{isVerifying ? '正在验证...' : '验证当前配置'}</span>
            </button>

            <button
              className="save-button"
              type="submit"
              disabled={isSaving || isVerifying}
            >
              <span>
                {saved
                  ? '设置已保存'
                  : isSaving
                    ? '正在保存...'
                    : '保存设置'}
              </span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {saved ? (
                  <path d="m5 12 4 4L19 6" />
                ) : (
                  <path d="M5 12h14m-5-5 5 5-5 5" />
                )}
              </svg>
            </button>
          </div>
        </form>

        <footer className="options-footer">
          <span>音频密钥与配置仅保存在本地浏览器</span>
          <span className="footer-version">v1.1</span>
        </footer>
      </section>
    </main>
  );
};

export default Options;
