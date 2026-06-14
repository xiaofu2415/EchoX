import React, { useState, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';

export interface SubtitleItem {
  id: string;
  textEn: string;
  textZh: string;
  isFinal: boolean;
  startTime?: number;
  endTime?: number;
  receivedAt: number;
}

interface SubtitleManagerProps {
  video: HTMLVideoElement;
}

/**
 * SubtitleManager Component
 * 
 * Renders bilingual subtitles overlay (English top, Chinese bottom) on top of the video.
 * Handles dynamic hot-overwriting when receiving updates with the same subtitle ID.
 */
export const SubtitleManager: React.FC<SubtitleManagerProps> = ({ video }) => {
  const [subtitles, setSubtitles] = useState<SubtitleItem[]>([]);
  const [currentTime, setCurrentTime] = useState(video.currentTime || 0);
  const [displayMode, setDisplayMode] = useState<'bilingual' | 'chinese'>('bilingual');

  useEffect(() => {
    // 1. Fetch initial configuration
    chrome.storage.local.get('displayMode', (res: { [key: string]: any }) => {
      if (res.displayMode) {
        setDisplayMode(res.displayMode as 'bilingual' | 'chinese');
      }
    });

    // 2. Listen to dynamic configuration updates (e.g. from the Options page)
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes.displayMode) {
        setDisplayMode((changes.displayMode.newValue as 'bilingual' | 'chinese') || 'bilingual');
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);

    const updateSubtitles = (id: string, textEn: string, textZh: string, isFinal: boolean, startTime?: number, endTime?: number) => {
      const updatedItem: SubtitleItem = {
        id, textEn, textZh, isFinal, startTime, endTime, receivedAt: Date.now()
      };
      setSubtitles((prev) => {
        const index = prev.findIndex((item) => item.id === id);
        const nextSubtitles = [...prev];
        if (index !== -1) {
          nextSubtitles[index] = updatedItem;
        } else {
          nextSubtitles.push(updatedItem);
        }
        nextSubtitles.sort((left, right) =>
          (left.startTime ?? Number.MAX_SAFE_INTEGER) - (right.startTime ?? Number.MAX_SAFE_INTEGER)
        );
        if (nextSubtitles.length > 12) {
          nextSubtitles.splice(0, nextSubtitles.length - 12);
        }
        return nextSubtitles;
      });
    };

    const handleMessage = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      if (message.action === 'UPDATE_BILINGUAL_SUBTITLES') {
        updateSubtitles(message.id, message.textEn, message.textZh, message.isFinal, message.startTime, message.endTime);
      } else if (message.action === 'CLEAR_BILINGUAL_SUBTITLES') {
        setSubtitles([]);
      }
    };

    const handleWsMessage = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        const { id, textEn, textZh, isFinal, startTime, endTime } = customEvent.detail;
        updateSubtitles(id, textEn, textZh, isFinal, startTime, endTime);
      }
    };

    // Add listeners
    chrome.runtime.onMessage.addListener(handleMessage);
    window.addEventListener('ws-subtitle-update', handleWsMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      chrome.storage.onChanged.removeListener(handleStorageChange);
      window.removeEventListener('ws-subtitle-update', handleWsMessage);
    };
  }, []);

  useEffect(() => {
    let animationFrameId = 0;
    const updateTime = () => {
      setCurrentTime(video.currentTime || 0);
      animationFrameId = window.requestAnimationFrame(updateTime);
    };
    updateTime();
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [video]);

  const now = Date.now();
  const activeSubtitles = subtitles.filter((subtitle) => {
    if (!subtitle.isFinal && now - subtitle.receivedAt <= 6500) {
      return true;
    }
    if (
      typeof subtitle.startTime !== 'number' ||
      typeof subtitle.endTime !== 'number'
    ) {
      // For realtime subtitles without timestamps, expire them 5 seconds after they are marked as final
      if (subtitle.isFinal) {
        return now - subtitle.receivedAt <= 5000;
      }
      return true;
    }
    const showFrom = Math.max(0, subtitle.startTime - 0.2);
    // Reduced from +2.8 to +1.8 to ensure older subtitles expire naturally as new ones stack
    const showUntil = subtitle.endTime + 1.8;
    return currentTime >= showFrom && currentTime <= showUntil;
  });

  const visibleSubtitles =
    activeSubtitles.length > 0
      ? activeSubtitles.slice(-2)
      : subtitles
          .filter(
            (subtitle) =>
              (!subtitle.isFinal && now - subtitle.receivedAt <= 6500) ||
              (typeof subtitle.endTime === 'number' &&
                currentTime < subtitle.endTime + 5)
          )
          .slice(-1);

  if (visibleSubtitles.length === 0) {
    return null;
  }

  // Visual Styling constants for clean rendering on top of arbitrary video screens
  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '8%',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '85%',
    maxWidth: '800px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    pointerEvents: 'none',
    zIndex: 9999,
    fontFamily: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    textAlign: 'center'
  };

  const textShadowStyle = 
    '2px 2px 4px rgba(0, 0, 0, 0.9), -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';

  const subtitleBoxStyle: React.CSSProperties = {
    background: 'rgba(0, 0, 0, 0.65)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    borderRadius: '12px',
    padding: '8px 18px',
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    transition: 'all 0.2s ease-in-out'
  };

  const englishStyle: React.CSSProperties = {
    fontSize: '15px', // Approximately 70% of Chinese size (22px)
    color: 'rgba(255, 255, 255, 0.75)', // Light grey / semi-transparent
    marginBottom: '4px',
    textShadow: textShadowStyle,
    wordBreak: 'break-word',
    lineHeight: '1.4',
    minHeight: '21px' // Ensure stable height even if empty
  };

  const chineseStyle: React.CSSProperties = {
    fontSize: '21px', // Main subtitle
    color: '#FFFFFF', // Pure white
    fontWeight: 'bold', // Bolded
    textShadow: textShadowStyle,
    wordBreak: 'break-word',
    lineHeight: '1.4',
    minHeight: '29px' // Ensure stable height even if empty
  };

  return (
    <div style={containerStyle}>
      {visibleSubtitles.map((sub) => (
        <div key={sub.id} style={subtitleBoxStyle}>
          {/* Sub-subtitle (Upper row): English - only render in bilingual mode */}
          {displayMode === 'bilingual' && (
            <div style={englishStyle}>{sub.textEn || '\u00A0'}</div>
          )}
          
          {/* Main subtitle (Lower row): Chinese */}
          <div style={chineseStyle}>{sub.textZh || '\u00A0'}</div>
        </div>
      ))}
    </div>
  );
};

// Map of roots to prevent double-mounting on the same video element container
const mountedRoots = new Map<HTMLElement, Root>();

/**
 * Helper function to mount the SubtitleManager onto a specific video element overlay container.
 * 
 * @param video The target HTMLVideoElement to overlay subtitles on.
 */
export function mountSubtitleManager(video: HTMLVideoElement): HTMLElement {
  // Find or create container overlay
  const videoParent = video.parentElement;
  if (!videoParent) {
    throw new Error('[SubtitleManager] Video element has no parent container.');
  }

  // Ensure parent layout is relative/absolute to correctly position absolute subtitles
  const parentStyle = window.getComputedStyle(videoParent);
  if (parentStyle.position === 'static') {
    videoParent.style.position = 'relative';
  }

  // Check if overlay container already exists
  let overlay = videoParent.querySelector('.x-video-translation-subtitle-overlay') as HTMLElement;
  if (overlay) {
    return overlay;
  }

  // Create new overlay container
  overlay = document.createElement('div');
  overlay.className = 'x-video-translation-subtitle-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '9998';

  videoParent.appendChild(overlay);

  // Mount React Component inside Shadow DOM to isolate styles from webpage CSS
  const shadow = overlay.attachShadow({ mode: 'open' });
  const shadowContainer = document.createElement('div');
  shadowContainer.style.width = '100%';
  shadowContainer.style.height = '100%';
  shadowContainer.style.position = 'relative';
  shadowContainer.style.pointerEvents = 'none';
  shadow.appendChild(shadowContainer);

  const root = (globalThis as any).createRoot
    ? (globalThis as any).createRoot(shadowContainer)
    : createRoot(shadowContainer);
  root.render(<SubtitleManager video={video} />);
  mountedRoots.set(overlay, root);

  console.log('[SubtitleManager] React component successfully mounted inside Shadow DOM over video player.');
  return overlay;
}

/**
 * Helper function to unmount and cleanup the SubtitleManager overlay.
 * 
 * @param overlay The overlay container element.
 */
export function unmountSubtitleManager(overlay: HTMLElement): void {
  const root = mountedRoots.get(overlay);
  if (root) {
    root.unmount();
    mountedRoots.delete(overlay);
  }
  overlay.remove();
  console.log('[SubtitleManager] React component unmounted and container removed.');
}
