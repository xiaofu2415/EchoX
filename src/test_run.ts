/**
 * test_run.ts - Simulation test suite for checking VodInterceptor, LiveRecorder,
 * Background translators, SubtitleManager, Options, and ButtonInjector in a mocked environment.
 */
// 1. MUST import mock_globals first to register all browser mocks
import './mock_globals.js';

// 2. Import modules to verify
import { initializeVodInterceptor } from './content_script/VodInterceptor.js';
import { LiveRecorder } from './content_script/LiveRecorder.js';
import { initializeButtonInjector, stopButtonInjector } from './content_script/ButtonInjector.js';

// Mock the API Request in test context
let mockGeminiResponseText = '{"en": "Hello everyone, welcome to the show.", "zh": "大家好，欢迎来到节目。"}';

// Mock global fetch for Background.ts API calls
const originalGlobalFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string, init?: any) => {
  if (url.includes('chrome-extension://mock-extension-id/test-audio.mp3')) {
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([73, 68, 51, 4]).buffer
    } as any;
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    console.log('[Mock Gemini API] Intercepted translation request to:', url);
    if (init && init.body) {
      const parsedBody = JSON.parse(init.body);
      console.log('[Mock Gemini API] Prompt instruction check:', parsedBody.contents[0].parts[1].text);
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: mockGeminiResponseText
                }
              ]
            }
          }
        ]
      })
    } as any;
  }
  if (url.includes('aiplatform.googleapis.com')) {
    console.log('[Mock Vertex API] Intercepted request to:', url);
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: mockGeminiResponseText }]
            }
          }
        ]
      })
    } as any;
  }
  if (url.includes('/audio/transcriptions')) {
    console.log('[Mock STT API] Intercepted transcription request to:', url);
    return {
      ok: true,
      json: async () => ({
        text: 'Hello from the speech transcription service.'
      })
    } as any;
  }
  if (url.includes('api.deepseek.com')) {
    console.log('[Mock DeepSeek API] Intercepted text translation request to:', url);
    const parsedBody = JSON.parse(init.body);
    console.log(
      '[Mock DeepSeek API] Transcript:',
      parsedBody.messages[1].content
    );
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"en":"Hello from the speech transcription service.","zh":"你好，这段文字来自语音转写服务。"}'
            }
          }
        ]
      })
    } as any;
  }
  return originalGlobalFetch(url, init);
};

// Now import the remaining components
// Background will auto-register its listeners upon load
import './background/Background.js';
import { SubtitleManager } from './content_script/SubtitleManager.js';

// ----------------------------------------------------
// Test suite execution
// ----------------------------------------------------
async function runVerification() {
  console.log('====================================================');
  console.log('STARTING AUDIO RETRIEVAL & BILINGUAL SUBTITLE SYSTEM SIMULATION');
  console.log('====================================================');

  // Test 1: Initialize VodInterceptor
  console.log('\n>>> TEST 1: Initializing front-end engines');
  initializeVodInterceptor();

  // Test 2: Simulating Fetch Interception & VOD pipeline
  console.log('\n>>> TEST 2: Simulating VOD fetch flow');
  await (globalThis as any).window.fetch('https://x.com/i/api/audio_segment.m4s?token=123');

  // Wait for postMessage, background processing, Gemini API call, and final dispatch
  await new Promise(resolve => setTimeout(resolve, 150));

  // Test 3: Simulating Live recording pipeline
  console.log('\n>>> TEST 3: Simulating Live rolling window flow');
  const mockStream = new (globalThis as any).MediaStream();
  const recorder = new LiveRecorder(mockStream, 'test-session', {
    timeSliceMs: 20,
    windowDurationMs: 60
  });

  console.log('Starting LiveRecorder...');
  recorder.start();

  // Wait for 1 chunk to trigger live dispatch
  await new Promise(resolve => setTimeout(resolve, 75));
  recorder.stop();

  // Wait for all messages to finish dispatching
  await new Promise(resolve => setTimeout(resolve, 150));

  // Test 4: JSON Error Recovery test
  console.log('\n>>> TEST 4: Verifying JSON Parsing Error Handling in Background');
  mockGeminiResponseText = 'This is plain text, not JSON, which should trigger JSON.parse failure.';
  
  console.log('Triggering fetch with malformed API response...');
  await (globalThis as any).window.fetch('https://x.com/i/api/audio_segment.m4s?token=malformed');

  // Wait for background parsing & dispatch
  await new Promise(resolve => setTimeout(resolve, 150));

  // Test 5: Vertex AI Express mode
  console.log('\n>>> TEST 5: Verifying Vertex AI Express mode routing');
  mockGeminiResponseText =
    '{"en":"Vertex audio transcription works.","zh":"Vertex 音频转录工作正常。"}';
  await chrome.storage.local.set({
    provider: 'vertex',
    vertexAuthMode: 'apiKey',
    vertexApiKey: 'TEST_VERTEX_KEY',
    vertexModel: 'gemini-2.5-flash'
  });
  chrome.runtime.sendMessage({
    action: 'TRANSLATE_LIVE_AUDIO_CHUNK',
    audioData: 'U2xpZGluZ1dpbmRvdy1Nb2NrLUJhc2U2NA==',
    mimeType: 'audio/webm',
    sessionId: 'vertex-test',
    sequence: 1
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  // Test 6: DeepSeek text model with external STT
  console.log('\n>>> TEST 6: Verifying STT + DeepSeek text translation pipeline');
  await chrome.storage.local.set({
    provider: 'openai',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    openaiApiKey: 'TEST_DEEPSEEK_KEY',
    openaiModel: 'deepseek-v4-flash',
    openaiAudioMode: 'transcription',
    sttRequestFormat: 'openrouter-json',
    sttBaseUrl: 'https://openrouter.ai/api/v1',
    sttApiKey: 'TEST_OPENROUTER_KEY',
    sttModel: 'openai/gpt-4o-mini-transcribe'
  });
  chrome.runtime.sendMessage({
    action: 'TRANSLATE_LIVE_AUDIO_CHUNK',
    audioData: 'U2xpZGluZ1dpbmRvdy1Nb2NrLUJhc2U2NA==',
    mimeType: 'audio/webm',
    sessionId: 'deepseek-test',
    sequence: 1
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  // Test 7: Configuration verification diagnostics
  console.log('\n>>> TEST 7: Verifying staged configuration diagnostics');
  const verificationResult = await chrome.runtime.sendMessage({
    action: 'VERIFY_PROVIDER_CONFIG',
    config: {
      provider: 'openai',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiApiKey: 'TEST_DEEPSEEK_KEY',
      openaiModel: 'deepseek-v4-flash',
      openaiAudioMode: 'transcription',
      sttRequestFormat: 'openrouter-json',
      sttBaseUrl: 'https://openrouter.ai/api/v1',
      sttApiKey: 'TEST_OPENROUTER_KEY',
      sttModel: 'openai/gpt-4o-mini-transcribe'
    }
  });
  console.log(
    '[Verification Result]',
    JSON.stringify(verificationResult, null, 2)
  );
  if (
    !verificationResult?.ok ||
    verificationResult.stages?.some((stage: any) => !stage.ok)
  ) {
    throw new Error('Staged provider verification failed.');
  }

  // Test 8: Options settings changes & storage onChange listener test
  console.log('\n>>> TEST 8: Verifying Options configuration and SubtitleManager storage listener');
  
  // Wait a tiny bit for storage resolution
  await new Promise(resolve => setTimeout(resolve, 10));

  console.log('Simulating saving configuration in Options page: displayMode="chinese"...');
  chrome.storage.local.set({ displayMode: 'chinese' });

  // Wait for storage listener events to trigger
  await new Promise(resolve => setTimeout(resolve, 20));

  // Test 9: ButtonInjector test
  console.log('\n>>> TEST 9: Verifying ButtonInjector (Route guarding & button injection)');
  
  console.log('Starting ButtonInjector patrol loop...');
  initializeButtonInjector();
  
  // Path is '/' initially (non-detail page)
  (globalThis as any).window.location.pathname = '/home';
  // Establish mock video player on page
  (globalThis as any)._setMockVideo(true);
  
  // Wait 1.1 seconds for first poll tick
  console.log('Waiting for poll tick on non-detail page...');
  await new Promise(resolve => setTimeout(resolve, 1100));
  
  // Verify button was NOT created on home page
  let btn = document.querySelector('#x-translator-btn');
  console.log('Button exists on home page:', btn !== null ? 'Yes' : 'No (Pass)');

  // Change path to Twitter Status Detail page
  console.log('Simulating navigation to tweet status page...');
  (globalThis as any).window.location.pathname = '/username/status/17829871638';
  
  // Wait for poll tick
  console.log('Waiting for poll tick on details page...');
  await new Promise(resolve => setTimeout(resolve, 1100));
  
  // Verify button was created
  btn = document.querySelector('#x-translator-btn');
  console.log('Button exists on status page:', btn !== null ? 'Yes (Pass)' : 'No');
  
  if (btn) {
    console.log('Simulating button click (Starting Translation)...');
    const mockEvent = { stopPropagation: () => console.log('[Mock Event] stopPropagation called') };
    (btn as any).onclick(mockEvent);
    
    // Check button text state
    console.log('Button text after click:', (btn as any).innerText);
    
    // Simulate data recording from active video capture
    console.log('Simulating 2s audio slice generation during live translation...');
    await new Promise(resolve => setTimeout(resolve, 60)); // Wait for mock recorder chunk
    
    console.log('Simulating button click again (Stopping Translation)...');
    (btn as any).onclick(mockEvent);
    console.log('Button text after second click:', (btn as any).innerText);
  }

  // Simulate routing away (should trigger full cleanup)
  console.log('Simulating navigation back to home feed (should trigger cleanup)...');
  (globalThis as any).window.location.pathname = '/home';
  
  // Wait for poll tick
  await new Promise(resolve => setTimeout(resolve, 1100));
  
  // Check if button host is removed
  const host = document.querySelector('#x-translator-btn-host');
  console.log('Button exists after cleanup:', host !== null ? 'Yes' : 'No (Pass)');

  console.log('Stopping ButtonInjector...');
  stopButtonInjector();

  console.log('\n====================================================');
  console.log('BILINGUAL SYSTEM SIMULATION COMPLETED SUCCESSFULLY');
  console.log('====================================================');
}

runVerification().catch(console.error);
