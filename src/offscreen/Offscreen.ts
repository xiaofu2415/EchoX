let ws: WebSocket | null = null;
let currentSessionId = '';
let currentSequence = 0;
let currentEn = '';
let currentZh = '';
let currentTabId: number | undefined;
let currentModel = '';
let currentTaskId = '';
let isGummyReady = false;
let gummyAudioQueue: ArrayBuffer[] = [];
let baseSequence = 0;

// Notify background that we are loaded and ready
chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  if (msg.action === 'start_ws') {
    const { wsUrl, sessionId, config, tabId, model } = msg;
    currentSessionId = sessionId;
    currentSequence = 0;
    currentEn = '';
    currentZh = '';
    currentTabId = tabId;
    currentModel = model || '';
    currentTaskId = crypto.randomUUID().replace(/-/g, '');
    isGummyReady = false;
    gummyAudioQueue = [];
    baseSequence = 0;

    if (ws) {
      ws.close();
      ws = null;
    }

    try {
      console.log('[Offscreen] Connecting to:', wsUrl);
      ws = new WebSocket(wsUrl);
      
      // Reply immediately so the UI doesn't hang waiting for connection
      sendResponse({ ok: true });

      ws.onopen = () => {
        console.log('[Offscreen] WebSocket connected! Model:', currentModel);
        chrome.runtime.sendMessage({
          action: 'OFFSCREEN_WS_SUBTITLE',
          id: `live-${currentSessionId}-debug`,
          textEn: 'Connected to Server...',
          textZh: '已连接到服务器...',
          isFinal: false,
          tabId: currentTabId
        });

        if (currentModel && currentModel.includes('gummy')) {
          console.log('[Offscreen] Sending Gummy run-task...');
          ws?.send(JSON.stringify({
            header: {
              action: "run-task",
              task_id: currentTaskId,
              streaming: "duplex"
            },
            payload: {
              model: currentModel,
              task_group: "audio",
              task: "asr",
              function: "recognition",
              input: {},
              parameters: {
                sample_rate: 16000,
                format: "pcm",
                transcription_enabled: true,
                translation_enabled: true,
                translation_target_languages: ["zh"]
              }
            }
          }));
        } else {
          ws?.send(JSON.stringify({
            type: "session.update",
            session: {
              instructions: "You are a real-time speech translator. You must listen to the English audio and translate it to Chinese. Output your response EXACTLY in this format: first output the original English transcript, followed by a pipe character '|', followed by the Chinese translation. Example: Hello world! | 你好世界！",
              input_audio_transcription: {
                model: "qwen3-asr-flash-realtime", // Use DashScope's native ASR model
                language: "en"
              },
              translation: {
                language: "zh"
              }
            }
          }));
        }
      };
    } catch (e: any) {
      console.error('[Offscreen] Failed to create WebSocket:', e);
      chrome.runtime.sendMessage({
        action: 'OFFSCREEN_WS_ERROR',
        sessionId: currentSessionId,
        tabId: currentTabId,
        message: '创建 WebSocket 失败: ' + e.message
      });
      sendResponse({ ok: false, error: e.message });
      return false;
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Gummy Protocol Parsing
        if (data.header && data.header.event) {
          if (data.header.event === 'task-failed') {
            console.error('[Offscreen] Gummy API Error:', data);
            chrome.runtime.sendMessage({
              action: 'OFFSCREEN_WS_ERROR',
              sessionId: currentSessionId,
              tabId: currentTabId,
              message: `翻译任务失败: ${data.header.error_message || JSON.stringify(data)}`
            });
            return;
          }
          if (data.header.event === 'task-started') {
             isGummyReady = true;
             for (const buffer of gummyAudioQueue) {
               ws?.send(buffer);
             }
             gummyAudioQueue = [];
             return;
          }
          if (data.header.event === 'result-generated') {
             const payload = data.payload || {};
             const output = payload.output || {};
             
             // Extract transcription text robustly
             let text = '';
             if (output.transcription) {
                if (typeof output.transcription === 'string') {
                   text = output.transcription;
                } else if (typeof output.transcription.text === 'string') {
                   text = output.transcription.text;
                }
             }
             
             // Extract translation text robustly
             let translation = '';
             if (output.translations) {
                if (output.translations.translations) {
                   const tObj = output.translations.translations;
                   if (tObj.zh?.text) {
                      translation = tObj.zh.text;
                   } else {
                      const langs = Object.keys(tObj);
                      if (langs.length > 0) {
                         translation = tObj[langs[0]]?.text || '';
                      }
                   }
                } else if (Array.isArray(output.translations)) {
                   const zhItem = output.translations.find((t: any) => t.language === 'zh' || t.lang === 'zh');
                   translation = zhItem?.text || output.translations[0]?.text || '';
                } else if (output.translations.zh?.text) {
                   translation = output.translations.zh.text;
                } else {
                   const keys = Object.keys(output.translations);
                   for (const k of keys) {
                      if (output.translations[k]?.text) {
                         translation = output.translations[k].text;
                         break;
                      }
                   }
                }
             }

             const isSentenceEnd = !!(
                output.transcription?.sentenceEnd || 
                output.transcription?.sentence_end ||
                output.translations?.sentenceEnd ||
                output.translations?.sentence_end ||
                payload.sentence_end ||
                payload.sentenceEnd ||
                output.sentenceEnd ||
                output.sentence_end
             );
             
             if (typeof text === 'string' && text) currentEn = text;
             if (typeof translation === 'string' && translation) currentZh = translation;

             const enResult = splitIntoSentences(currentEn, false);
             const zhResult = splitIntoSentences(currentZh, true);

             const countEn = enResult.sentences.length;
             const countZh = zhResult.sentences.length;
             const M = Math.min(countEn, countZh);

             // 1. Send all matched completed sentences
             for (let i = 0; i < M; i++) {
                chrome.runtime.sendMessage({
                  action: 'OFFSCREEN_WS_SUBTITLE',
                  id: `live-${currentSessionId}-ws-${baseSequence + i}`,
                  textEn: enResult.sentences[i],
                  textZh: zhResult.sentences[i],
                  isFinal: true,
                  tabId: currentTabId
                });
             }

             // 2. Determine active remainder
             let activeEn = '';
             if (countEn > M) {
                activeEn = enResult.sentences.slice(M).join(' ') + ' ' + (enResult.active[0] || '');
             } else {
                activeEn = enResult.active[0] || '';
             }
             activeEn = activeEn.trim();

             let activeZh = '';
             if (countZh > M) {
                activeZh = zhResult.sentences.slice(M).join('') + (zhResult.active[0] || '');
             } else {
                activeZh = zhResult.active[0] || '';
             }
             activeZh = activeZh.trim();

             // 3. If there is active remainder, send it as active (isFinal = false)
             if (!isSentenceEnd && (activeEn || activeZh)) {
                chrome.runtime.sendMessage({
                  action: 'OFFSCREEN_WS_SUBTITLE',
                  id: `live-${currentSessionId}-ws-${baseSequence + M}`,
                  textEn: activeEn,
                  textZh: activeZh,
                  isFinal: false,
                  tabId: currentTabId
                });
             }

             // 4. Handle finalization
             if (isSentenceEnd) {
                const hasActive = !!(activeEn || activeZh);
                if (hasActive) {
                   chrome.runtime.sendMessage({
                     action: 'OFFSCREEN_WS_SUBTITLE',
                     id: `live-${currentSessionId}-ws-${baseSequence + M}`,
                     textEn: activeEn,
                     textZh: activeZh,
                     isFinal: true,
                     tabId: currentTabId
                   });
                }
                currentSequence = baseSequence + M + (hasActive ? 1 : 0);
                baseSequence = currentSequence;
                currentEn = '';
                currentZh = '';
             }
          }
          return; // Skip OpenAI parsing
        }

        // OpenAI Parsing
        if (data.type === 'error') {
          console.error('[Offscreen] API Error:', data.error);
          chrome.runtime.sendMessage({
            action: 'OFFSCREEN_WS_ERROR',
            sessionId: currentSessionId,
            tabId: currentTabId,
            message: `翻译任务失败: ${data.error?.message || JSON.stringify(data.error)}`
          });
          return;
        }

        let hasDelta = false;
        
        // OpenAI standard deltas (Assistant's output -> Chinese)
        if (data.type === 'response.text.delta' || data.type === 'response.translation.delta' || data.type === 'response.audio_transcript.delta') {
          currentZh += (data.delta || '');
          hasDelta = true;
        }

        // DashScope specific text events (Assistant's output -> Chinese/English)
        if (data.type === 'response.audio_transcript.text' || data.type === 'response.text.text' || data.type === 'response.translation.text') {
          const fullText = (data.text || '');
          const stash = (data.stash || '');
          
          let recentEn = '';
          let recentZh = '';
          
          try {
             // We instructed the model to output: English | Chinese
             // So we split the full accumulated text by the pipe symbol if it exists
             let processText = fullText;
             
             // Extract the last sentence block using punctuation
             const parts = processText.split(/(?<=[。！？.!?])\s*/).filter((p: string) => p.trim().length > 0);
             let lastPart = parts.slice(-1).join(' ') + stash;
             
             if (lastPart.includes('|')) {
               const segments = lastPart.split('|');
               recentEn = segments[0].trim();
               recentZh = segments[1].trim();
             } else {
               // If model failed to follow format, just put it all in Zh
               recentZh = lastPart;
             }
          } catch(e) {}
          
          if (recentZh || recentEn) {
             if (recentEn) currentEn = recentEn;
             if (recentZh) currentZh = recentZh;
             hasDelta = true;
          }
          
          // Detect new segment by item_id
          if (data.item_id && data.item_id !== (globalThis as any)._lastItemId) {
             if ((globalThis as any)._lastItemId) {
                // The previous item finished, advance sequence
                currentSequence++;
             }
             (globalThis as any)._lastItemId = data.item_id;
          }
        }

        // Detect user's input audio transcription for English subtitles (User's input -> English)
        if (data.type === 'conversation.item.input_audio_transcription.completed' && data.transcript) {
          // This event is fired when a segment of user audio is fully transcribed
          currentEn = data.transcript;
          hasDelta = true;
        }

        if (hasDelta) {
          chrome.runtime.sendMessage({
            action: 'OFFSCREEN_WS_SUBTITLE',
            id: `live-${currentSessionId}-ws-${currentSequence}`,
            textEn: currentEn,
            textZh: currentZh,
            isFinal: false,
            tabId: currentTabId
          });
        }

        if (
          data.type === 'response.text.done' || 
          data.type === 'response.translation.done' || 
          data.type === 'response.audio_transcript.done' ||
          data.type === 'response.done' || 
          data.type === 'item.completed'
        ) {
          // If the done event contains the full transcript, use it (Assistant's output -> Chinese)
          if (data.transcript) currentZh = data.transcript;
          if (data.text) currentZh = data.text;
          if (data.translation) currentZh = data.translation;
          
          if (data.item?.content) {
            for (const content of data.item.content) {
              if (content.transcript) currentZh = content.transcript;
              if (content.text) currentZh = content.text;
            }
          }

          if (currentEn.trim() || currentZh.trim() || data.type === 'item.completed') {
            chrome.runtime.sendMessage({
              action: 'OFFSCREEN_WS_SUBTITLE',
              id: `live-${currentSessionId}-ws-${currentSequence}`,
              textEn: currentEn,
              textZh: currentZh,
              isFinal: true,
              tabId: currentTabId
            });
            currentSequence++;
            currentEn = '';
            currentZh = '';
          }
        } else if (!hasDelta && data.type !== 'response.audio.delta' && data.type !== 'response.audio.done') {
          // Hide debug fallback events from the screen as they distract the user,
          // but log them to console so we can still debug if needed.
          try {
             const copy = { ...data };
             delete copy.item; // too large
             console.log('[Offscreen] Ignored event:', data.type, copy);
          } catch(e) {}
        }
      } catch (e) {
        console.warn('[Offscreen] Failed to parse message', e, event.data);
      }
    };

    ws.onerror = (e) => {
      console.error('[Offscreen] WebSocket Error:', e);
    };

    ws.onclose = (event) => {
      console.log(`[Offscreen] WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
      if (event.code === 1006) {
        chrome.runtime.sendMessage({
          action: 'OFFSCREEN_WS_ERROR',
          sessionId: currentSessionId,
          tabId: currentTabId,
          message: 'WebSocket 连接被拒绝（Code 1006）。请确认：1) API Key 是否有效 2) 是否已在百炼控制台开通该模型权限。'
        });
      } else if (event.code !== 1000 && event.code !== 1005) {
        chrome.runtime.sendMessage({
          action: 'OFFSCREEN_WS_ERROR',
          sessionId: currentSessionId,
          tabId: currentTabId,
          message: `WebSocket 连接关闭（Code ${event.code}）: ${event.reason || '未知原因'}`
        });
      }
    };

    return true; // keep channel open for async response
  }

  if (msg.action === 'send_audio') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (currentModel && currentModel.includes('gummy')) {
        const binaryString = window.atob(msg.base64Audio);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        if (isGummyReady) {
          ws.send(bytes.buffer);
        } else {
          gummyAudioQueue.push(bytes.buffer);
        }
      } else {
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.base64Audio
        }));
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'stop_ws') {
    console.log('[Offscreen] Stopping WebSocket...');
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (currentModel && currentModel.includes('gummy')) {
         ws.send(JSON.stringify({
            header: {
               action: "finish-task",
               task_id: currentTaskId
            },
            payload: {}
         }));
      } else {
         ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
      setTimeout(() => {
        ws?.close();
        ws = null;
      }, 500);
    } else {
      ws?.close();
      ws = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function splitIntoSentences(text: string, isChinese: boolean): { sentences: string[]; active: string[] } {
  if (!text) {
    return { sentences: [], active: [] };
  }
  
  if (isChinese) {
    // For Chinese, we split by 。！？
    // If text is very long (e.g. > 18 characters), we also allow splitting by ，
    const regex = text.length > 18 ? /[。！？，]/ : /[。！？]/;
    
    const sentences: string[] = [];
    let current = '';
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      current += char;
      if (regex.test(char)) {
        sentences.push(current);
        current = '';
      }
    }
    
    return {
      sentences: sentences,
      active: current ? [current] : []
    };
  } else {
    // For English, we split by .!? followed by space or end of string.
    // If text is very long (e.g. > 12 words), we also allow splitting by commas.
    const wordCount = text.trim().split(/\s+/).length;
    const splitRegex = wordCount > 12 ? /([.!?,])(\s+|$)/g : /([.!?])(\s+|$)/g;
    
    const sentences: string[] = [];
    let lastIndex = 0;
    let match;
    
    const regex = new RegExp(splitRegex);
    while ((match = regex.exec(text)) !== null) {
      const endPos = match.index + match[1].length;
      sentences.push(text.slice(lastIndex, endPos).trim());
      lastIndex = regex.lastIndex; // start of next sentence
    }
    
    const activeText = text.slice(lastIndex).trim();
    
    return {
      sentences: sentences,
      active: activeText ? [activeText] : []
    };
  }
}
