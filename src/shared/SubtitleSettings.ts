export interface SubtitleDisplaySettings {
  subtitleEnglishFontSize: number;
  subtitleChineseFontSize: number;
  subtitleBottomPercent: number;
  subtitleBackgroundOpacity: number;
}

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleDisplaySettings = {
  subtitleEnglishFontSize: 15,
  subtitleChineseFontSize: 21,
  subtitleBottomPercent: 8,
  subtitleBackgroundOpacity: 65
};

export const SUBTITLE_SETTING_KEYS = Object.keys(
  DEFAULT_SUBTITLE_SETTINGS
) as Array<keyof SubtitleDisplaySettings>;

function readNumber(
  record: Record<string, unknown>,
  key: keyof SubtitleDisplaySettings,
  min: number,
  max: number
): number {
  const value = Number(record[key]);
  if (!Number.isFinite(value)) {
    return DEFAULT_SUBTITLE_SETTINGS[key];
  }
  return Math.min(max, Math.max(min, value));
}

export function readSubtitleSettings(
  record: Record<string, unknown>
): SubtitleDisplaySettings {
  return {
    subtitleEnglishFontSize: readNumber(
      record,
      'subtitleEnglishFontSize',
      12,
      30
    ),
    subtitleChineseFontSize: readNumber(
      record,
      'subtitleChineseFontSize',
      14,
      40
    ),
    subtitleBottomPercent: readNumber(
      record,
      'subtitleBottomPercent',
      4,
      55
    ),
    subtitleBackgroundOpacity: readNumber(
      record,
      'subtitleBackgroundOpacity',
      0,
      100
    )
  };
}
