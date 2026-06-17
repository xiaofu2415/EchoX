import { sendRuntimeMessageSafely } from './RuntimeMessaging.js';

/**
 * WsRealtimeClient - Content-script side WebSocket realtime translation engine.
 * 
 * The content script captures and batches PCM audio. A singleton offscreen document owns
 * the WebSockets, with each browser tab isolated by sessionId.
 * 
 * Flow:
 * 1. Content script asks background to setup declarativeNetRequest auth rule
 * 2. Background creates/uses the offscreen document
 * 3. Content script captures and encodes audio for its session
 * 4. Content script dispatches subtitle updates to SubtitleManager
 */

export class WsRealtimeClient {
  private static readonly DEFAULT_BATCH_MS = 128;
  private stream: MediaStream;
  private sessionId: string;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private currentEn = '';
  private currentZh = '';
  private targetBatchMs = WsRealtimeClient.DEFAULT_BATCH_MS;
  private pendingPcmChunks: Int16Array[] = [];
  private pendingSampleCount = 0;
  private messageListener: ((msg: any) => void) | null = null;
  private stopped = false;

  constructor(stream: MediaStream, sessionId: string) {
    this.stream = stream;
    this.sessionId = sessionId;
    this.setupMessageListener();
  }

  public async start(config: any) {
    if (this.stopped) {
      throw new Error('WebSocket realtime client has already been stopped.');
    }
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
    
    // 512 frames at 16kHz is 32ms. Several samples may be merged
    // into one network packet after the WebSocket latency profile arrives.
    this.processor = this.audioContext.createScriptProcessor(512, 1, 1);
    
    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Convert Float32 to Int16
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      this.pendingPcmChunks.push(pcm16);
      this.pendingSampleCount += pcm16.length;

      const sampleRate = this.audioContext?.sampleRate || 16000;
      const targetSamples = Math.ceil(
        sampleRate * (this.targetBatchMs / 1000)
      );
      if (this.pendingSampleCount >= targetSamples) {
        this.flushAudioBuffer();
      }
    };
    
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  public stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    console.log('[WsRealtimeClient] Stopping WebSocket Realtime Engine...');
    this.flushAudioBuffer();
    sendRuntimeMessageSafely({
      action: 'STOP_OFFSCREEN_WS',
      sessionId: this.sessionId
    }, 'WsRealtimeClient');

    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }
    
    if (this.processor) {
      this.processor.onaudioprocess = null;
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
    this.pendingPcmChunks = [];
    this.pendingSampleCount = 0;
  }

  private setupMessageListener() {
    this.messageListener = (msg: any) => {
      if (msg.sessionId !== this.sessionId) {
        return;
      }

      if (msg.action === 'OFFSCREEN_WS_SUBTITLE') {
        this.dispatchSubtitle(msg.id, msg.textEn, msg.textZh, msg.isFinal);
      } else if (msg.action === 'OFFSCREEN_WS_NETWORK_PROFILE') {
        this.applyNetworkProfile(msg);
      } else if (msg.action === 'OFFSCREEN_WS_ERROR') {
        this.dispatchSubtitle(`error-${this.sessionId}`, '', msg.message, false);
      }
    };
    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  private applyNetworkProfile(profile: {
    connectLatencyMs?: number;
    protocolLatencyMs?: number;
  }) {
    const measuredLatency =
      typeof profile.protocolLatencyMs === 'number' &&
      profile.protocolLatencyMs > 0
        ? profile.protocolLatencyMs
        : profile.connectLatencyMs || 0;
    const nextBatchMs = this.selectBatchDuration(measuredLatency);

    if (nextBatchMs !== this.targetBatchMs) {
      this.flushAudioBuffer();
      this.targetBatchMs = nextBatchMs;
    }

    console.log(
      `[WsRealtimeClient] Network latency=${Math.round(measuredLatency)}ms, audio batch=${this.targetBatchMs}ms.`
    );

    this.dispatchSubtitle(
      `network-${this.sessionId}`,
      `Network latency: ${Math.round(measuredLatency)}ms · Audio batch: ${this.targetBatchMs}ms`,
      `网络延迟约 ${Math.round(measuredLatency)}ms · 音频发送间隔 ${this.targetBatchMs}ms`,
      true
    );
  }

  private selectBatchDuration(latencyMs: number): number {
    if (latencyMs <= 45) return 32;
    if (latencyMs <= 80) return 64;
    if (latencyMs <= 160) return 128;
    if (latencyMs <= 300) return 192;
    return 256;
  }

  private flushAudioBuffer() {
    if (this.pendingSampleCount === 0) {
      return;
    }

    const merged = new Int16Array(this.pendingSampleCount);
    let offset = 0;
    for (const chunk of this.pendingPcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    this.pendingPcmChunks = [];
    this.pendingSampleCount = 0;
    sendRuntimeMessageSafely({
      action: 'SEND_OFFSCREEN_AUDIO',
      base64Audio: this.arrayBufferToBase64(merged.buffer),
      sessionId: this.sessionId
    }, 'WsRealtimeClient');
  }

  private dispatchSubtitle(id: string, textEn: string, textZh: string, isFinal: boolean) {
    if (id.startsWith(`live-${this.sessionId}`)) {
      const nextEn = textEn.trim();
      const nextZh = textZh.trim();

      if (nextEn && nextZh) {
        textEn = nextEn;
        textZh = nextZh;
      } else {
        if (nextEn) {
          this.currentEn = nextEn;
        }
        if (nextZh) {
          this.currentZh = nextZh;
        }

        if (!this.currentEn || !this.currentZh) {
          return;
        }

        textEn = this.currentEn;
        textZh = this.currentZh;
      }

      if (isFinal) {
        this.currentEn = '';
        this.currentZh = '';
      }
    }

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
