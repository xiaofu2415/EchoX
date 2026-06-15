export type SupportedSite = 'x' | 'youtube';

export interface PlayerContext {
  site: SupportedSite;
  video: HTMLVideoElement;
  container: HTMLElement;
  controlBar: HTMLElement | null;
  subtitleContainer: HTMLElement;
  isLive: boolean;
}

function isVisibleVideo(video: HTMLVideoElement): boolean {
  const rect = video.getBoundingClientRect();
  const viewportWidth =
    window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth
  );
}

function findLargestVisibleVideo(
  candidates: HTMLVideoElement[]
): HTMLVideoElement | null {
  const viewportWidth =
    window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const visibleVideos = candidates
    .filter(isVisibleVideo)
    .map((video) => ({ video, rect: video.getBoundingClientRect() }));

  visibleVideos.sort((left, right) => {
    const viewportArea = viewportWidth * viewportHeight;
    const score = (rect: DOMRect) => {
      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
      );
      const visibleArea = visibleWidth * visibleHeight;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const centerDistance =
        Math.abs(centerX - viewportWidth / 2) / viewportWidth +
        Math.abs(centerY - viewportHeight / 2) / viewportHeight;
      return (
        visibleArea / Math.max(1, viewportArea) - centerDistance * 0.05
      );
    };
    return score(right.rect) - score(left.rect);
  });

  return visibleVideos[0]?.video || null;
}

function findXContainer(video: HTMLVideoElement): HTMLElement | null {
  let current = video.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 6) {
    const testId = current.getAttribute('data-testid');
    if (testId === 'videoPlayer' || testId === 'videoComponent') {
      return current;
    }
    current = current.parentElement;
    depth++;
  }
  return video.parentElement?.parentElement || video.parentElement;
}

function findXControlBar(container: HTMLElement): HTMLElement | null {
  const containerRect = container.getBoundingClientRect();
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>('div, [role="group"]')
  );
  let bestMatch: { element: HTMLElement; score: number } | null = null;

  for (const element of candidates) {
    if (element.id === 'x-translator-btn-host') {
      continue;
    }

    const rect = element.getBoundingClientRect();
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>('button, [role="button"]')
    ).filter((control) => !control.closest('#x-translator-btn-host'));
    const style = window.getComputedStyle(element);
    const nearBottom =
      rect.bottom >=
      containerRect.bottom - Math.max(90, containerRect.height * 0.28);
    const horizontalLayout =
      style.display === 'flex' ||
      style.display === 'grid' ||
      style.flexDirection === 'row';

    if (
      controls.length < 2 ||
      !nearBottom ||
      !horizontalLayout ||
      rect.width < 150 ||
      rect.height < 24 ||
      rect.height > 72
    ) {
      continue;
    }

    const bottomDistance = Math.abs(containerRect.bottom - rect.bottom);
    const score =
      controls.length * 12 +
      (rect.width / Math.max(1, containerRect.width)) * 20 -
      bottomDistance / 8 -
      rect.height / 20;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { element, score };
    }
  }

  return bestMatch?.element || null;
}

function isYouTubeLive(
  video: HTMLVideoElement,
  player: HTMLElement
): boolean {
  if (video.duration === Infinity) {
    return true;
  }

  if (
    player.classList.contains('ytp-live') ||
    player.hasAttribute('data-is-live')
  ) {
    return true;
  }

  const liveBadge = player.querySelector<HTMLElement>('.ytp-live-badge');
  if (liveBadge) {
    const style = window.getComputedStyle(liveBadge);
    const rect = liveBadge.getBoundingClientRect();
    if (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0
    ) {
      return true;
    }
  }

  const liveMetadata = document.querySelector(
    'meta[itemprop="isLiveBroadcast"][content="True"], meta[itemprop="isLiveBroadcast"][content="true"]'
  );
  return Boolean(liveMetadata);
}

function findYouTubeContext(): PlayerContext | null {
  if (!location.hostname.endsWith('youtube.com')) {
    return null;
  }

  const video = findLargestVisibleVideo(
    Array.from(
      document.querySelectorAll<HTMLVideoElement>(
        '#movie_player video.html5-main-video, video.html5-main-video'
      )
    )
  );
  const container = video?.closest<HTMLElement>('.html5-video-player');
  if (!video || !container || !isYouTubeLive(video, container)) {
    return null;
  }

  return {
    site: 'youtube',
    video,
    container,
    controlBar: container.querySelector<HTMLElement>('.ytp-right-controls'),
    subtitleContainer: container,
    isLive: true
  };
}

function findXContext(): PlayerContext | null {
  if (
    !location.hostname.endsWith('x.com') &&
    !location.hostname.endsWith('twitter.com')
  ) {
    return null;
  }

  const video = findLargestVisibleVideo(
    Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
  );
  if (!video) {
    return null;
  }

  const container = findXContainer(video);
  if (!container) {
    return null;
  }

  return {
    site: 'x',
    video,
    container,
    controlBar: findXControlBar(container),
    subtitleContainer: video.parentElement || container,
    isLive: video.duration === Infinity
  };
}

export function findPlayerContext(): PlayerContext | null {
  return findYouTubeContext() || findXContext();
}

export function refreshPlayerContext(
  video: HTMLVideoElement
): PlayerContext | null {
  const context = findPlayerContext();
  return context?.video === video ? context : null;
}

export function attachButtonHost(
  host: HTMLElement,
  context: PlayerContext
): void {
  const { controlBar, container, site } = context;
  if (!controlBar) {
    if (host.parentElement !== container) {
      container.appendChild(host);
    }
    Object.assign(host.style, {
      position: 'absolute',
      display: 'none',
      pointerEvents: 'none'
    });
    return;
  }

  if (site === 'youtube') {
    const leftControls =
      controlBar.querySelector<HTMLElement>('.ytp-right-controls-left') ||
      controlBar;
    const anchor =
      leftControls.querySelector<HTMLElement>('.ytp-subtitles-button') ||
      leftControls.querySelector<HTMLElement>('.ytp-settings-button');

    if (anchor) {
      if (
        host.parentElement !== leftControls ||
        host.nextElementSibling !== anchor
      ) {
        leftControls.insertBefore(host, anchor);
      }
    } else if (host.parentElement !== leftControls) {
      leftControls.prepend(host);
    }

    host.classList.add('ytp-button');
    Object.assign(host.style, {
      position: 'relative',
      width: '44px',
      height: '48px',
      bottom: 'auto',
      right: 'auto',
      zIndex: '1',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 44px',
      marginLeft: '0',
      pointerEvents: 'auto',
      verticalAlign: 'top'
    });
    return;
  }

  if (host.parentElement !== controlBar) {
    controlBar.appendChild(host);
  }
  Object.assign(host.style, {
    position: 'relative',
    bottom: 'auto',
    right: 'auto',
    zIndex: '1',
    display: 'inline-flex',
    alignItems: 'center',
    flex: '0 0 auto',
    marginLeft: '6px',
    pointerEvents: 'auto'
  });
}

export function getButtonSize(site: SupportedSite): number {
  return site === 'youtube' ? 30 : 30;
}
