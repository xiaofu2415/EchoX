import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AUTO_TRANSLATE_ON_PLAY_KEY,
  PROVIDER_STORAGE_KEYS,
  readProviderConfig,
  validateProviderConfig,
  type ProviderConfig
} from '../shared/ProviderConfig';
import './options.css';

type DisplayMode = 'bilingual' | 'chinese';

function getProviderLabel(config: ProviderConfig): string {
  if (config.provider === 'gemini') return 'Gemini AI Studio';
  if (config.provider === 'vertex') return 'Google Vertex AI';
  if (config.openaiBaseUrl.includes('dashscope.aliyuncs.com')) {
    return 'DashScope / Qwen';
  }
  if (config.openaiBaseUrl.includes('minimax.io')) return 'MiniMax';
  if (config.openaiBaseUrl.includes('deepseek.com')) return 'DeepSeek';
  if (config.openaiBaseUrl.includes('openrouter.ai')) return 'OpenRouter';
  return 'OpenAI 兼容接口';
}

function getModelLabel(config: ProviderConfig): string {
  if (config.provider === 'gemini') return config.geminiModel;
  if (config.provider === 'vertex') return config.vertexModel;
  return config.openaiModel;
}

export const Popup: React.FC = () => {
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('bilingual');
  const [autoStartTranslation, setAutoStartTranslation] = useState(false);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    chrome.storage.local.get(
      [
        ...PROVIDER_STORAGE_KEYS,
        'displayMode',
        AUTO_TRANSLATE_ON_PLAY_KEY,
        'autoStartTranslation'
      ],
      (result: Record<string, unknown>) => {
        setConfig(readProviderConfig(result));
        if (
          result.displayMode === 'bilingual' ||
          result.displayMode === 'chinese'
        ) {
          setDisplayMode(result.displayMode);
        }
        setAutoStartTranslation(
          result[AUTO_TRANSLATE_ON_PLAY_KEY] === true ||
            result.autoStartTranslation === true
        );
      }
    );
  }, []);

  const toggleAutoStart = async () => {
    const nextValue = !autoStartTranslation;
    setAutoStartTranslation(nextValue);
    await chrome.storage.local.set({
      [AUTO_TRANSLATE_ON_PLAY_KEY]: nextValue,
      autoStartTranslation: nextValue
    });
  };

  const openSettings = async () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
      window.close();
      return;
    }
    window.open('options.html', '_blank');
  };

  const validationError = config ? validateProviderConfig(config) : null;

  return (
    <main className="popup-shell">
      <section className="popup-panel">
        <header className="popup-header">
          <div className="brand-mark" aria-hidden="true">
            <span>译</span>
          </div>
          <div className="popup-heading">
            <div className="eyebrow">
              <span className="status-dot" />
              EchoX Translator
            </div>
            <h1>视频翻译</h1>
          </div>
        </header>

        <div className="popup-status">
          <div>
            <span>当前服务</span>
            <strong>{config ? getProviderLabel(config) : '读取中...'}</strong>
          </div>
          <div>
            <span>当前模型</span>
            <strong>{config ? getModelLabel(config) : '--'}</strong>
          </div>
          <div>
            <span>字幕模式</span>
            <strong>{displayMode === 'bilingual' ? '双语对照' : '仅中文'}</strong>
          </div>
          <label className="popup-toggle-row">
            <span>
              <small>自动开启</small>
              <strong>视频播放后自动翻译</strong>
            </span>
            <input
              type="checkbox"
              checked={autoStartTranslation}
              onChange={toggleAutoStart}
            />
          </label>
        </div>

        {validationError && (
          <div className="popup-warning">
            <strong>配置未完成</strong>
            <span>{validationError}</span>
          </div>
        )}

        <button className="popup-settings-button" type="button" onClick={openSettings}>
          <span>打开设置</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.36a1.7 1.7 0 0 0-1 .57 1.7 1.7 0 0 0-.43 1.15V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.14 15a1.7 1.7 0 0 0-.57-1 1.7 1.7 0 0 0-1.15-.43H2.3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 3.9 8.5a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.5 4.14a1.7 1.7 0 0 0 1-.57A1.7 1.7 0 0 0 9.93 2.4V2.3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 3.9a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 8c.33.31.52.73.57 1.17H20a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
        </button>
      </section>
    </main>
  );
};

export default Popup;

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <Popup />
    </React.StrictMode>
  );
}
