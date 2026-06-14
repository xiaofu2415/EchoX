/**
 * LiveRecorder.ts - Sliding Window Slice Engine for Live Audio Streams
 * 
 * This engine captures audio from a MediaStream (usually obtained via video.captureStream()),
 * processes it in short rolling windows and transmits the latest audio segment.
 * and transmits the combined audio segment to the Background script as a Base64 string.
 */

export class LiveRecorder {
  private mediaStream: MediaStream;
  private audioOnlyStream: MediaStream | null = null;
  private activeRecorders = new Set<MediaRecorder>();
  private stopTimers = new Map<MediaRecorder, number>();
  private launchIntervalId: number | null = null;
  private isRunning = false;
  private sequence = 0;
  private readonly timeSliceMs: number;
  private readonly windowDurationMs: number;
  private readonly sessionId: string;
  private readonly getCurrentTime: () => number;
  private readonly startupOnly: boolean;
  private readonly includeStartupWindows: boolean;
  private mimeType: string = '';

  /**
   * Constructs a new LiveRecorder instance.
   * 
   * @param stream The source MediaStream containing the audio track.
   */
  constructor(
    stream: MediaStream,
    sessionId?: string,
    timing: {
      timeSliceMs?: number;
      windowDurationMs?: number;
      getCurrentTime?: () => number;
      startupOnly?: boolean;
      includeStartupWindows?: boolean;
    } = {}
  ) {
    this.mediaStream = stream;
    this.sessionId = sessionId || this.createSessionId();
    this.timeSliceMs = timing.timeSliceMs || 1800;
    this.windowDurationMs = timing.windowDurationMs || 3600;
    this.getCurrentTime = timing.getCurrentTime || (() => 0);
    this.startupOnly = Boolean(timing.startupOnly);
    this.includeStartupWindows = Boolean(timing.includeStartupWindows);
  }

  private createSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Detects the best supported audio MIME type for the browser's MediaRecorder.
   * 
   * @returns The supported MIME type string.
   */
  private getSupportedMimeType(): string {
    const candidateTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/aac'
    ];

    for (const type of candidateTypes) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  /**
   * Converts a Blob to a Base64 string using FileReader.
   * 
   * @param blob The input Blob to convert.
   * @returns A promise resolving to the Base64 representation.
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          // Extract base64 payload from data URL ("data:...;base64,...")
          const parts = reader.result.split(',');
          const base64 = parts.length > 1 ? parts[1] : '';
          resolve(base64);
        } else {
          reject(new Error('FileReader result is not a string'));
        }
      };
      reader.onerror = () => {
        reject(reader.error || new Error('FileReader failed to read Blob'));
      };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Starts the recording engine.
   * It extracts the audio tracks, configures the MediaRecorder,
   * and starts processing timeslices.
   */
  public start(): void {
    if (this.isRunning) {
      console.warn('[LiveRecorder] Recorder is already running.');
      return;
    }

    // Extract audio-only tracks to minimize payload size and avoid capturing video frames
    const audioTracks = this.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('[LiveRecorder] No audio tracks found in the media stream.');
    }

    this.audioOnlyStream = new MediaStream(audioTracks);

    // Determine target mimeType
    this.mimeType = this.getSupportedMimeType();
    const options: MediaRecorderOptions = {};
    if (this.mimeType) {
      options.mimeType = this.mimeType;
      console.log(`[LiveRecorder] Using MIME type: ${this.mimeType}`);
    } else {
      console.warn('[LiveRecorder] No specific audio MIME type supported by browser. Falling back to default.');
    }

    this.isRunning = true;
    this.sequence = 0;

    if (this.includeStartupWindows || this.startupOnly) {
      this.launchRecordingWindow(1400, options);
      this.launchRecordingWindow(2400, options);
    }

    if (!this.startupOnly) {
      this.launchRecordingWindow(this.windowDurationMs, options);

      this.launchIntervalId = window.setInterval(() => {
        this.launchRecordingWindow(this.windowDurationMs, options);
      }, this.timeSliceMs);
    }

    console.log(
      this.startupOnly
        ? '[LiveRecorder] Started startup subtitle buffer windows.'
        : `[LiveRecorder] Started independent ${this.windowDurationMs}ms rolling windows every ${this.timeSliceMs}ms.`
    );
  }

  private launchRecordingWindow(
    durationMs: number,
    options: MediaRecorderOptions
  ): void {
    if (!this.isRunning || !this.audioOnlyStream) {
      return;
    }

    const chunks: Blob[] = [];
    const sequence = ++this.sequence;
    const startTime = this.getCurrentTime();
    let recorder: MediaRecorder;

    try {
      recorder = new MediaRecorder(this.audioOnlyStream, options);
    } catch (err) {
      this.stop();
      throw err;
    }

    this.activeRecorders.add(recorder);
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data?.size) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event: Event) => {
      console.error('[LiveRecorder] MediaRecorder error event:', event);
    };
    recorder.onstop = () => {
      this.clearRecorder(recorder);
      if (!this.isRunning || chunks.length === 0) {
        return;
      }
      const blob = new Blob(chunks, {
        type: recorder.mimeType || this.mimeType || chunks[0].type
      });
      void this.dispatchWindow(
        blob,
        durationMs,
        sequence,
        startTime,
        this.getCurrentTime()
      );
    };

    recorder.start();
    const timerId = window.setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }, durationMs);
    this.stopTimers.set(recorder, timerId);
  }

  private clearRecorder(recorder: MediaRecorder): void {
    const timerId = this.stopTimers.get(recorder);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.stopTimers.delete(recorder);
    }
    this.activeRecorders.delete(recorder);
  }

  private async dispatchWindow(
    blob: Blob,
    durationMs: number,
    sequence: number,
    startTime: number,
    endTime: number
  ): Promise<void> {
    try {
      const base64Audio = await this.blobToBase64(blob);
      if (!this.isRunning) {
        return;
      }

      chrome.runtime.sendMessage({
        action: 'TRANSLATE_LIVE_AUDIO_CHUNK',
        audioData: base64Audio,
        mimeType: (blob.type || this.mimeType || 'audio/webm').split(';')[0],
        windowDurationMs: durationMs,
        startTime,
        endTime,
        playbackTime: this.getCurrentTime(),
        sessionId: this.sessionId,
        sequence,
        timestamp: Date.now()
      });

      console.log(
        `[LiveRecorder] Dispatched valid audio window: size=${blob.size} bytes, duration=${durationMs}ms, sequence=${sequence}`
      );
    } catch (err) {
      console.error('[LiveRecorder] Error processing audio window:', err);
    }
  }

  /**
   * Stops the recording engine and releases media track resources.
   */
  public stop(): void {
    if (!this.isRunning) {
      console.warn('[LiveRecorder] Recorder is not active.');
      return;
    }

    this.isRunning = false;
    if (this.launchIntervalId !== null) {
      window.clearInterval(this.launchIntervalId);
      this.launchIntervalId = null;
    }

    for (const recorder of Array.from(this.activeRecorders)) {
      const timerId = this.stopTimers.get(recorder);
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }
    this.stopTimers.clear();
    this.activeRecorders.clear();
    this.audioOnlyStream = null;
    console.log('[LiveRecorder] All recording windows stopped.');
  }

  /**
   * Checks if the recorder is currently capturing audio.
   * 
   * @returns True if recording is in progress, false otherwise.
   */
  public isActive(): boolean {
    return this.isRunning;
  }
}
