import { sendRuntimeMessageSafely } from './RuntimeMessaging.js';
import { ECHOX_RUNTIME_BUILD } from '../shared/RuntimeVersion.js';

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
  private static readonly OUTPUT_SAMPLE_RATE = 16000;
  private static readonly DEFAULT_BATCH_MS = 128;
  private stream: MediaStream;
  private sessionId: string;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;
  private trackReader: ReadableStreamDefaultReader<any> | null = null;
  private currentEn = '';
  private currentZh = '';
  private targetBatchMs = WsRealtimeClient.DEFAULT_BATCH_MS;
  private pendingPcmChunks: Int16Array[] = [];
  private pendingSampleCount = 0;
  private messageListener: ((msg: any) => void) | null = null;
  private resumeListener: (() => void) | null = null;
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
    console.log(
      `[WsRealtimeClient] Starting WebSocket Realtime Engine via Offscreen Document. runtime=${ECHOX_RUNTIME_BUILD}`
    );
    
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
    
    // Step 3: Setup audio capture and encoding. Prefer direct track reads
    // because auto-played videos can keep a new AudioContext suspended until
    // the next user gesture.
    if (this.startTrackProcessorCapture()) {
      console.log(
        '[WsRealtimeClient] Audio capture pipeline ready. MediaStreamTrackProcessor=running.'
      );
      return;
    }

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    
    // 512 frames at 16kHz is 32ms. Several samples may be merged
    // into one network packet after the WebSocket latency profile arrives.
    this.processor = this.audioContext.createScriptProcessor(512, 1, 1);
    
    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      this.enqueueFloat32Audio(
        inputData,
        e.inputBuffer.sampleRate ||
          this.audioContext?.sampleRate ||
          WsRealtimeClient.OUTPUT_SAMPLE_RATE
      );
    };
    
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);
    this.installResumeListeners();

    if (this.audioContext.state === 'suspended') {
      console.log('[WsRealtimeClient] AudioContext suspended, resuming...');
      await this.resumeAudioContextWithTimeout();
    }
    console.log(
      `[WsRealtimeClient] Audio capture pipeline ready. AudioContext=${this.audioContext.state}.`
    );
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
    this.removeResumeListeners();
    if (this.trackReader) {
      const reader = this.trackReader;
      this.trackReader = null;
      void reader.cancel().catch(() => undefined);
    }
    
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.silentGain) {
      this.silentGain.disconnect();
      this.silentGain = null;
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
      } else if (msg.action === 'OFFSCREEN_WS_DEBUG') {
        const detail =
          msg.detail && typeof msg.detail === 'object'
            ? JSON.stringify(msg.detail)
            : String(msg.detail || '');
        console.log(`[WsRealtimeClient][Offscreen] ${msg.message} ${detail}`);
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

  private startTrackProcessorCapture(): boolean {
    const TrackProcessor = (
      window as typeof window & {
        MediaStreamTrackProcessor?: new (init: {
          track: MediaStreamTrack;
        }) => { readable: ReadableStream<any> };
      }
    ).MediaStreamTrackProcessor;
    const audioTrack = this.stream.getAudioTracks()[0];
    if (!TrackProcessor || !audioTrack) {
      return false;
    }

    try {
      const processor = new TrackProcessor({ track: audioTrack });
      this.trackReader = processor.readable.getReader();
      void this.pumpTrackProcessorAudio(this.trackReader);
      return true;
    } catch (error) {
      console.debug(
        '[WsRealtimeClient] MediaStreamTrackProcessor unavailable; falling back to Web Audio.',
        error
      );
      this.trackReader = null;
      return false;
    }
  }

  private async pumpTrackProcessorAudio(
    reader: ReadableStreamDefaultReader<any>
  ): Promise<void> {
    while (!this.stopped && this.trackReader === reader) {
      let frame: any = null;
      try {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        frame = result.value;
        const audio = this.readAudioFrame(frame);
        if (audio) {
          this.enqueueFloat32Audio(audio.samples, audio.sampleRate);
        }
      } catch (error) {
        if (!this.stopped) {
          console.warn(
            '[WsRealtimeClient] Audio track processor failed.',
            error
          );
          this.dispatchSubtitle(
            `audio-track-${this.sessionId}`,
            'Audio track capture failed.',
            '音频轨道读取中断，请暂停后重新播放或手动重启翻译。',
            false
          );
        }
        break;
      } finally {
        frame?.close?.();
      }
    }
  }

  private readAudioFrame(
    frame: any
  ): { samples: Float32Array; sampleRate: number } | null {
    if (
      !frame ||
      typeof frame.copyTo !== 'function' ||
      typeof frame.numberOfFrames !== 'number'
    ) {
      return null;
    }

    const frameCount = frame.numberOfFrames;
    if (frameCount <= 0) {
      return null;
    }

    const channelCount = Math.max(1, Number(frame.numberOfChannels) || 1);
    const mixed = new Float32Array(frameCount);
    const scratch = new Float32Array(frameCount);
    let copiedChannels = 0;

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
      try {
        scratch.fill(0);
        frame.copyTo(scratch, { planeIndex: channelIndex });
      } catch {
        break;
      }

      for (let i = 0; i < frameCount; i++) {
        mixed[i] += scratch[i];
      }
      copiedChannels++;
    }

    if (copiedChannels === 0) {
      return null;
    }

    if (copiedChannels > 1) {
      for (let i = 0; i < mixed.length; i++) {
        mixed[i] /= copiedChannels;
      }
    }

    return {
      samples: mixed,
      sampleRate:
        Number(frame.sampleRate) || WsRealtimeClient.OUTPUT_SAMPLE_RATE
    };
  }

  private enqueueFloat32Audio(
    inputData: Float32Array,
    inputSampleRate: number
  ): void {
    if (this.stopped || inputData.length === 0) {
      return;
    }

    const resampled =
      Math.round(inputSampleRate) === WsRealtimeClient.OUTPUT_SAMPLE_RATE
        ? inputData
        : this.resampleFloat32(
            inputData,
            inputSampleRate,
            WsRealtimeClient.OUTPUT_SAMPLE_RATE
          );
    const pcm16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const s = Math.max(-1, Math.min(1, resampled[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    this.pendingPcmChunks.push(pcm16);
    this.pendingSampleCount += pcm16.length;

    const targetSamples = Math.ceil(
      WsRealtimeClient.OUTPUT_SAMPLE_RATE * (this.targetBatchMs / 1000)
    );
    if (this.pendingSampleCount >= targetSamples) {
      this.flushAudioBuffer();
    }
  }

  private resampleFloat32(
    input: Float32Array,
    inputSampleRate: number,
    outputSampleRate: number
  ): Float32Array {
    if (
      inputSampleRate <= 0 ||
      outputSampleRate <= 0 ||
      Math.round(inputSampleRate) === Math.round(outputSampleRate)
    ) {
      return input;
    }

    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i * ratio;
      const leftIndex = Math.floor(sourceIndex);
      const rightIndex = Math.min(leftIndex + 1, input.length - 1);
      const weight = sourceIndex - leftIndex;
      output[i] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
    }

    return output;
  }

  private async resumeAudioContextWithTimeout(): Promise<void> {
    const context = this.audioContext;
    if (!context || context.state !== 'suspended') {
      return;
    }

    try {
      await Promise.race([
        context.resume(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 800))
      ]);
    } catch (error) {
      console.warn('[WsRealtimeClient] AudioContext resume failed:', error);
    }

    if (context.state === 'suspended') {
      console.warn(
        '[WsRealtimeClient] AudioContext is still suspended; waiting for browser audio activation.'
      );
      this.dispatchSubtitle(
        `audio-context-${this.sessionId}`,
        'Waiting for browser audio capture activation.',
        '正在等待浏览器允许音频采集，请点击视频画面，或暂停后再播放。',
        false
      );
    } else {
      this.dispatchSubtitle(
        `audio-context-${this.sessionId}`,
        'Browser audio capture is active.',
        '浏览器音频采集已启动。',
        true
      );
    }
  }

  private installResumeListeners(): void {
    if (this.resumeListener) {
      return;
    }
    this.resumeListener = () => {
      if (this.stopped || this.audioContext?.state !== 'suspended') {
        return;
      }
      void this.resumeAudioContextWithTimeout();
    };
    window.addEventListener('pointerdown', this.resumeListener, true);
    window.addEventListener('keydown', this.resumeListener, true);
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener?.('unmute', this.resumeListener);
    }
  }

  private removeResumeListeners(): void {
    if (!this.resumeListener) {
      return;
    }
    window.removeEventListener('pointerdown', this.resumeListener, true);
    window.removeEventListener('keydown', this.resumeListener, true);
    for (const track of this.stream.getAudioTracks()) {
      track.removeEventListener?.('unmute', this.resumeListener);
    }
    this.resumeListener = null;
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
      } else if (nextZh) {
        textEn = nextEn || this.currentEn;
        textZh = nextZh;
        this.currentZh = nextZh;
      } else {
        if (nextEn) {
          this.currentEn = nextEn;
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
