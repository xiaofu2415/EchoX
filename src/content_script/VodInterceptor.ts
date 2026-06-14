/**
 * VodInterceptor.ts - Fetch Interception Engine for VOD Audio Streams
 * 
 * This engine intercepts native `window.fetch` requests in the page's MAIN execution context.
 * It identifies media stream chunks (.m4s, .ts, or URLs with audio features), clones them,
 * and transfers them to the Content Script (ISOLATED context) via `window.postMessage`.
 * The Content Script then converts the data to Base64 and forwards it to the Background script.
 */

// Unique message type identifier
const MESSAGE_TYPE = 'X_VIDEO_TRANSLATION_VOD_CHUNK';

/**
 * Injected script logic that runs inside the MAIN (page) execution context.
 * This function is converted to a string and injected via a dynamic <script> tag.
 */
function injectMainWorldInterceptor() {
  const originalFetch = window.fetch;
  const TARGET_MESSAGE_TYPE = 'X_VIDEO_TRANSLATION_VOD_CHUNK';

  // Helper to determine if a URL targets media streams with audio features
  function isTargetAudioStream(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    // Match common video/audio segment extensions
    if (lowerUrl.includes('.m4s') || lowerUrl.includes('.ts')) {
      return true;
    }
    // Match common audio indicators in media stream segment queries/paths
    const audioKeywords = [
      'audio',
      'sound',
      'voice',
      'aac',
      'm4a',
      'mp3',
      'opus',
      'mime=audio',
      'select=audio',
      'kind=audio'
    ];
    return audioKeywords.some(keyword => lowerUrl.includes(keyword));
  }

  // Override window.fetch
  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const response = await originalFetch(input, init);

    // Parse the URL from the fetch request
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input === 'object' && 'url' in input) {
      url = (input as Request).url;
    }

    // Intercept if it matches target media/audio characteristics and the response is successful
    if (url && isTargetAudioStream(url) && response.ok) {
      try {
        // Clone the response to avoid consuming the original stream body
        const responseClone = response.clone();
        
        // Retrieve the binary stream as an ArrayBuffer
        const buffer = await responseClone.arrayBuffer();

        // Send to isolated Content Script via postMessage
        // Using transfer list [buffer] to pass the ArrayBuffer with zero-copy efficiency
        window.postMessage(
          {
            type: TARGET_MESSAGE_TYPE,
            url: url,
            data: buffer
          },
          '*',
          [buffer]
        );
      } catch (err) {
        console.error('[VodInterceptor] Error processing intercepted fetch response:', err);
      }
    }

    return response;
  };

  console.log('[VodInterceptor] MAIN world fetch hijack successfully initialized.');
}

/**
 * Converts an ArrayBuffer to a Base64 string safely, avoiding call stack size limits.
 * Uses a FileReader-based Blob read to run efficiently on large chunks.
 * 
 * @param buffer The ArrayBuffer containing binary audio data.
 * @returns A promise resolving to the Base64 representation.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer]);
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        // Extract base64 payload from data URL ("data:application/octet-stream;base64,...")
        const parts = reader.result.split(',');
        const base64 = parts.length > 1 ? parts[1] : '';
        resolve(base64);
      } else {
        reject(new Error('FileReader result is not a string'));
      }
    };
    reader.onerror = () => {
      reject(reader.error || new Error('FileReader failed to read ArrayBuffer'));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Set up the Content Script (ISOLATED context) fetch interception engine.
 * This injects the fetch wrapper into the MAIN world and sets up a message
 * listener to receive and forward intercepted audio segments to the Background script.
 */
export function initializeVodInterceptor(): void {
  // 1. Inject the fetch hijacking script into the MAIN execution environment
  try {
    const script = document.createElement('script');
    // Wrap the function in an IIFE string for direct execution
    script.textContent = `(${injectMainWorldInterceptor.toString()})();`;
    (document.head || document.documentElement).appendChild(script);
    // Remove the script tag immediately after execution to keep the DOM clean
    script.remove();
  } catch (err) {
    console.error('[VodInterceptor] Failed to inject interceptor script into MAIN world:', err);
  }

  // 2. Register postMessage listener to receive intercepted packets
  window.addEventListener('message', async (event) => {
    // Restrict listener to messages from the current page/window
    if (event.source !== window) return;

    const message = event.data;
    if (message && message.type === MESSAGE_TYPE) {
      const url: string = message.url;
      const data: ArrayBuffer = message.data;

      if (!data || data.byteLength === 0) {
        console.warn('[VodInterceptor] Received empty or invalid ArrayBuffer for url:', url);
        return;
      }

      try {
        // Convert the transferred ArrayBuffer to Base64
        const base64Audio = await arrayBufferToBase64(data);

        // Forward to the Background script using Chrome runtime messaging
        chrome.runtime.sendMessage({
          action: 'PROCESS_VOD_AUDIO_SEGMENT',
          url: url,
          audioData: base64Audio,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('[VodInterceptor] Failed to process and forward audio segment:', err);
      }
    }
  });

  console.log('[VodInterceptor] Content Script interceptor listener activated.');
}
