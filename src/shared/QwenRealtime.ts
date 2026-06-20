export interface QwenLiveTranslateSessionVariant {
  label: string;
  session: Record<string, unknown> | null;
}

const qwenLiveTranslateRealtimeDefaults = {
  modalities: ['text'],
  input_audio_format: 'pcm16',
  turn_detection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 220,
    silence_duration_ms: 320
  }
};

export const QWEN_LIVE_TRANSLATE_SESSION_VARIANTS: QwenLiveTranslateSessionVariant[] = [
  {
    label: 'bilingual transcript plus zh text output with low-latency VAD',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        language: 'en'
      },
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'bilingual transcript plus zh text output',
    session: {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        language: 'en'
      },
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'transcript language plus zh text output with low-latency VAD',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      input_audio_transcription: {
        language: 'en'
      },
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'transcript language plus zh text output',
    session: {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      input_audio_transcription: {
        language: 'en'
      },
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'zh text output',
    session: {
      modalities: ['text'],
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'zh text audio output',
    session: {
      modalities: ['text', 'audio'],
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'translation language zh only',
    session: {
      translation: {
        language: 'zh'
      }
    }
  },
  {
    label: 'model default session (no session.update)',
    session: null
  },
  {
    label: 'model defaults',
    session: {
      ...qwenLiveTranslateRealtimeDefaults
    }
  },
  {
    label: 'minimal model defaults',
    session: {
      input_audio_format: 'pcm16'
    }
  },
  {
    label: 'top-level source/target language',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      source_language: 'en',
      target_language: 'zh'
    }
  },
  {
    label: 'top-level source/target lang',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      source_lang: 'en',
      target_lang: 'zh'
    }
  },
  {
    label: 'translation target_language',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        target_language: 'zh'
      }
    }
  },
  {
    label: 'translation source target_language',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        source_language: 'en',
        target_language: 'zh'
      }
    }
  },
  {
    label: 'transcription and translation target_language',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        language: 'en'
      },
      translation: {
        target_language: 'zh'
      }
    }
  },
  {
    label: 'top-level translation_target_languages',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      source_language: 'en',
      translation_target_languages: ['zh']
    }
  },
  {
    label: 'translation translation_target_languages',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        source_language: 'en',
        translation_target_languages: ['zh']
      }
    }
  },
  {
    label: 'en-US to zh-CN',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        source_language: 'en-US',
        target_language: 'zh-CN'
      }
    }
  },
  {
    label: 'English to Chinese',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        source_language: 'English',
        target_language: 'Chinese'
      }
    }
  },
  {
    label: 'source_lang target_lang',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        source_lang: 'en',
        target_lang: 'zh'
      }
    }
  },
  {
    label: 'language only',
    session: {
      ...qwenLiveTranslateRealtimeDefaults,
      translation: {
        language: 'zh'
      }
    }
  }
];

export function getQwenLiveTranslateSessionVariant(
  attempt: number
): QwenLiveTranslateSessionVariant {
  const index = Math.min(
    Math.max(0, attempt),
    QWEN_LIVE_TRANSLATE_SESSION_VARIANTS.length - 1
  );
  return QWEN_LIVE_TRANSLATE_SESSION_VARIANTS[index];
}

export function getRealtimeErrorText(data: any): string {
  if (!data) {
    return '';
  }
  if (typeof data.error === 'string') {
    return data.error;
  }
  if (data.error && typeof data.error === 'object') {
    return [
      data.error.message,
      data.error.code,
      data.error.type,
      data.error.param
    ]
      .filter(Boolean)
      .join(' ');
  }
  return typeof data.message === 'string' ? data.message : '';
}

export function isQwenRealtimeParameterErrorText(text: string): boolean {
  return /invalid\b[\s\S]*\bparameter/i.test(text);
}
