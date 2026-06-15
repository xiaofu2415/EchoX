export function setupWsRealtimeServer() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'qwen-ws') return;

    let ws: WebSocket | null = null;
    let wsSessionId = '';
    let wsSequence = 0;
    
    // Accumulators for OpenAI protocol delta events
    let currentEn = '';
    let currentZh = '';
    
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId;

    if (tabId === undefined || frameId === undefined) {
      port.disconnect();
      return;
    }

    function sendUpdate(isFinal: boolean) {
      if (!currentEn.trim() || !currentZh.trim()) {
        return;
      }

      sendTabMessageSafely(
        tabId!,
        frameId!,
        {
          action: 'UPDATE_BILINGUAL_SUBTITLES',
          id: `live-${wsSessionId}`,
          textEn: currentEn,
          textZh: currentZh,
          isFinal
        }
      );
    }

    port.onMessage.addListener(async (msg) => {
      if (msg.action === 'start') {
        const config = msg.config;
        wsSessionId = msg.sessionId;

        // Get API key
        const apiKey = config.openaiApiKey || config.vertexApiKey || config.geminiApiKey;
        
        // IMPORTANT: Chrome's declarativeNetRequest does NOT reliably inject headers into 
        // WebSocket upgrade requests initiated from Service Workers (known Chromium bug).
        // We still set the rule as a fallback, but the PRIMARY auth mechanism is
        // Sec-WebSocket-Protocol subprotocol trick below.
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [1],
            addRules: [
              {
                id: 1,
                priority: 1,
                action: {
                  type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                  requestHeaders: [
                    {
                      header: 'Authorization',
                      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                      value: `Bearer ${apiKey}`
                    }
                  ]
                },
                condition: {
                  urlFilter: '*://dashscope.aliyuncs.com/api-ws/v1/realtime*',
                  resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET]
                }
              }
            ]
          });
        } catch (e) {
          console.warn('[WsRealtimeServer] declarativeNetRequest fallback setup failed (non-critical):', e);
        }

        // Establish WebSocket
        // PRIMARY AUTH: Use Sec-WebSocket-Protocol to pass Bearer token.
        // Browser WebSocket API cannot set custom headers, but it CAN set subprotocols,
        // which are sent as `Sec-WebSocket-Protocol` header. Many API gateways (including
        // DashScope/Alibaba Cloud) accept Bearer tokens via this mechanism.
        try {
          const wsUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${config.openaiModel}`;
          console.log('[WsRealtimeServer] Connecting to:', wsUrl);
          ws = new WebSocket(wsUrl, [`access_token.${apiKey}`]);
          
          ws.onopen = () => {
            console.log('[WsRealtimeServer] DashScope WebSocket connected! Sending session.update...');
            // Send session.update following OpenAI Realtime API format
            ws?.send(JSON.stringify({
              type: "session.update",
              session: {
                translation: {
                  target_language: "zh"
                }
              }
            }));
          };

          ws.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              
              if (data.type === 'error') {
                 console.error('[WsRealtimeServer] API Error:', data.error);
                 sendErrorSubtitle(tabId, frameId, wsSessionId, `翻译任务失败: ${data.error?.message || JSON.stringify(data.error)}`);
                 return;
              }

              let hasDelta = false;

              // DashScope / OpenAI Realtime API Text Delta
              if (data.type === 'response.text.delta' || data.type === 'response.translation.delta') {
                 currentZh += (data.delta || '');
                 hasDelta = true;
              }
              
              // Audio Transcript Delta (source language)
              if (data.type === 'response.audio_transcript.delta') {
                 currentEn += (data.delta || '');
                 hasDelta = true;
              }

              if (hasDelta) {
                 sendUpdate(false);
              }

              // When a text segment or response finishes, flush it
              if (
                data.type === 'response.text.done' || 
                data.type === 'response.translation.done' || 
                data.type === 'response.audio_transcript.done' ||
                data.type === 'response.done' || 
                data.type === 'item.completed'
              ) {
                 if (currentEn.trim() || currentZh.trim()) {
                    sendUpdate(true);
                    wsSequence++;
                    currentEn = '';
                    currentZh = '';
                 }
              }
            } catch (e) {
               console.warn('[WsRealtimeServer] Failed to parse message', e, event.data);
            }
          };

          ws.onerror = (e) => {
            console.error('[WsRealtimeServer] WebSocket Error:', e);
          };

          ws.onclose = (event) => {
            console.log(`[WsRealtimeServer] WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
            if (event.code === 1006) {
              // Abnormal closure - most likely auth failure
              sendErrorSubtitle(tabId, frameId, wsSessionId, 
                'WebSocket 连接被拒绝（Code 1006）。请确认：1) API Key 是否有效 2) 是否已在百炼控制台开通该模型权限。');
            } else if (event.code !== 1000 && event.code !== 1005) {
              sendErrorSubtitle(tabId, frameId, wsSessionId, 
                `WebSocket 连接关闭（Code ${event.code}）: ${event.reason || '未知原因'}`);
            }
          };

        } catch (e) {
          console.error('[WsRealtimeServer] Failed to connect:', e);
        }

      } else if (msg.action === 'audio' && ws && ws.readyState === WebSocket.OPEN) {
        // DashScope/OpenAI Realtime API requires Base64 JSON strings, not raw binary
        const pcm16 = new Int16Array(msg.pcm);
        const base64Audio = arrayBufferToBase64(pcm16.buffer);
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio
        }));
      } else if (msg.action === 'stop') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Send commit to signal end of stream
          ws.send(JSON.stringify({
             type: "input_audio_buffer.commit"
          }));
          setTimeout(() => ws?.close(), 500);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      ws?.close();
    });
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function sendErrorSubtitle(tabId: number, frameId: number, sessionId: string, msg: string) {
  sendTabMessageSafely(tabId, frameId, {
    action: 'UPDATE_BILINGUAL_SUBTITLES',
    id: `error-${sessionId}`,
    textEn: '',
    textZh: msg,
    isFinal: false
  });
}

function sendTabMessageSafely(
  tabId: number,
  frameId: number,
  message: unknown
): void {
  try {
    void chrome.tabs
      .sendMessage(tabId, message, { frameId })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (!/receiving end does not exist|message port closed|no tab with id/i.test(detail)) {
          console.warn('[WsRealtimeServer] Failed to send tab message:', error);
        }
      });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/receiving end does not exist|message port closed|no tab with id/i.test(detail)) {
      console.warn('[WsRealtimeServer] Failed to send tab message:', error);
    }
  }
}
