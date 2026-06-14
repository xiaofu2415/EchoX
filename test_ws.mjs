const wsUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime`;
console.log('Connecting to', wsUrl);

const ws = new WebSocket(wsUrl); // Native node WebSocket doesn't easily support custom headers, but let's see if we get 401 or 404

ws.onopen = () => {
  console.log('Connected!');
  ws.close();
};

ws.onerror = (err) => {
  console.error('WebSocket Error:', err.message || err.error || err);
};

ws.onclose = (event) => {
  console.log('Closed:', event.code, event.reason);
};
