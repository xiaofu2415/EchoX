/**
 * WsRealtimeClient - Content-script side WebSocket realtime translation engine.
 * 
 * ARCHITECTURE NOTE: The WebSocket is created HERE in the content script, NOT in the
 * background service worker. This is because Chrome's declarativeNetRequest can reliably
 * inject Authorization headers into WebSocket upgrade requests from content scripts,
 * but NOT from service workers (known Chromium bug).
 * 
 * Flow:
 * 1. Content script asks background to setup declarativeNetRequest auth rule
 * 2. Content script creates WebSocket directly (declarativeNetRequest injects auth header)
 * 3. Content script handles audio capture, encoding, and WS communication
 * 4. Content script dispatches subtitle updates to SubtitleManager
 */

export class WsRealtimeClient {
  private stream: MediaStream;
  private sessionId: string;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private ws: WebSocket | null = null;
  private wsSequence = 0;
  private currentEn = '';
  private currentZh = '';

  constructor(stream: MediaStream, sessionId: string) {
    this.stream = stream;
    this.sessionId = sessionId;
    this.setupMessageListener();
  }

  public async start(config: any) {
    console.log('[WsRealtimeClient] Starting WebSocket Realtime Engine via Offscreen Document...');
    
    const apiKey = config.openaiApiKey || config.vertexApiKey || config.geminiApiKey;

    // Ask background to initialize offscreen document and websocket
    await new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'START_OFFSCREEN_WS',
        apiKey: apiKey,
        model: config.openaiModel,
        sessionId: this.sessionId
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[WsRealtimeClient] Offscreen start warning:', chrome.runtime.lastError.message);
          this.dispatchSubtitle(`error-${this.sessionId}`, '', '后台服务无响应: ' + chrome.runtime.lastError.message, false);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && !response.ok) {
          console.warn('[WsRealtimeClient] Offscreen failed to start:', response.error);
          this.dispatchSubtitle(`error-${this.sessionId}`, '', '无法启动 WebSocket 引擎: ' + (response.error || '未知错误'), false);
          reject(new Error(response.error || 'Unknown error'));
          return;
        }
        resolve(); 
      });
    });
    
    // Step 3: Setup audio capture and encoding
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    if (this.audioContext.state === 'suspended') {
      console.log('[WsRealtimeClient] AudioContext suspended, resuming...');
      await this.audioContext.resume();
    }
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    
    // 1024 frames at 16kHz = 64ms per chunk
    this.processor = this.audioContext.createScriptProcessor(1024, 1, 1);
    
    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Convert Float32 to Int16
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      // Encode as Base64 and send to Offscreen
      const base64Audio = this.arrayBufferToBase64(pcm16.buffer);
      chrome.runtime.sendMessage({
        action: 'SEND_OFFSCREEN_AUDIO',
        base64Audio: base64Audio
      });
    };
    
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  public stop() {
    console.log('[WsRealtimeClient] Stopping WebSocket Realtime Engine...');
    chrome.runtime.sendMessage({ action: 'STOP_OFFSCREEN_WS' });
    
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  private setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'OFFSCREEN_WS_SUBTITLE') {
        this.dispatchSubtitle(msg.id, msg.textEn, msg.textZh, msg.isFinal);
      } else if (msg.action === 'OFFSCREEN_WS_ERROR' && msg.sessionId === this.sessionId) {
        this.dispatchSubtitle(`error-${this.sessionId}`, '', msg.message, false);
      }
    });
  }

  private dispatchSubtitle(id: string, textEn: string, textZh: string, isFinal: boolean) {
    // Dispatch directly to the content script's own message listener
    // (SubtitleManager listens via chrome.runtime.onMessage)
    window.dispatchEvent(new CustomEvent('ws-subtitle-update', {
      detail: { id, textEn, textZh, isFinal }
    }));
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
