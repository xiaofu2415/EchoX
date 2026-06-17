<div align="center">
  <img src="icons/icon-128.png" width="112" height="112" alt="Live Video Translator">
  <h1>Live Video Translator</h1>
  <p>English | <a href="README.md">简体中文</a></p>
  <p><strong>Real-time bilingual subtitles for X videos/live streams and YouTube Live.</strong></p>
  <p>Built for foreign-language broadcasts, from World Cup matches to interviews and breaking news.</p>
</div>

## World Cup and Live Translation

From World Cup matches to product launches, interviews, and news broadcasts, Live Video Translator adds real-time bilingual subtitles directly to the player. On YouTube Live and X, the translation control sits inside the native player toolbar, so you can follow the action and understand foreign-language commentary without leaving the stream.

- **YouTube Live:** automatic live-stream detection with regular, theater, and fullscreen modes.
- **X videos and live streams:** works with embedded post players, compact players, page players, and fullscreen.
- **Bilingual subtitles:** display the original English and Chinese translation together, or switch to Chinese only.
- **Low-latency audio:** automatically adapts the audio packet interval to measured network latency.
- **Flexible layout:** independently adjust subtitle sizes, position, and background opacity.

## Features

- Full support for X (Twitter) videos, X live streams, and YouTube Live.
- Real-time English and Chinese subtitles with bilingual and Chinese-only modes.
- Translation control integrated into the native player toolbar and hidden with the toolbar.
- Separate English and Chinese font-size controls.
- Adjustable subtitle position and background opacity.
- Responsive layouts for compact players and fullscreen playback.
- Optional automatic translation when video playback starts.
- Built-in API verification for permissions, connectivity, model access, and request results.
- Adaptive `32 / 64 / 128 / 192 / 256 ms` audio packet intervals.
- Native media capture with a Web Audio fallback.
- API keys and configuration are stored locally in the browser.

## Supported Platforms

| Platform | Status | Notes |
| --- | --- | --- |
| X videos / live streams | Fully supported | Post players, compact players, page players, and fullscreen |
| YouTube Live | Fully supported | Automatic live detection; regular, theater, and fullscreen modes |
| Regular YouTube videos | Not yet supported | The current release only activates on live streams |

## Supported Model Providers

| Provider | Audio pipeline | Notes |
| --- | --- | --- |
| **DashScope / Qwen (recommended)** | **Real-time WebSocket audio** | **Qwen real-time multimodal/speech models offer the lowest latency for live interpretation** |
| Gemini AI Studio | Native audio | Simple setup with a Gemini API key |
| Google Cloud Vertex AI | Native audio | Express Mode API key or OAuth access token |
| MiniMax | Native audio or compatible API | Capabilities depend on the selected model |
| DeepSeek | STT + text model | DeepSeek does not accept audio directly and requires a speech-to-text service |
| OpenRouter | Native audio or STT | Use an audio-capable model or combine STT with a text model |
| Custom endpoint | OpenAI-compatible | Configure a custom base URL, API key, and model ID |

### Recommended: DashScope / Qwen

For low-latency WebSocket streaming translation, DashScope's Qwen real-time multimodal and speech models are the recommended choice. The extension currently integrates:

| Qwen model | Role | Best for |
| --- | --- | --- |
| `qwen3.5-livetranslate-flash-realtime` | Recommended default | Chinese-English live translation with bilingual audio+text output, ideal for World Cup matches, interviews, and live news |
| `qwen3-livetranslate-flash-realtime` | Alternative bilingual model | Chinese-English live translation with bilingual audio+text output |
| `gummy-realtime-v1` | Legacy model | Expected to be retired starting in September; not recommended for new setups |

A WebSocket pipeline continuously sends player audio to the model. The selected model must therefore accept and understand audio streams directly. Text-only models cannot run this pipeline on their own and require a separate STT stage. Qwen3.5 / Qwen3 real-time bilingual translation models natively support audio streams and bilingual text output, making them the preferred configuration for live translation.

> DeepSeek is not a multimodal audio model. The extension must first transcribe the audio through an STT provider and then send the resulting text to DeepSeek for translation.

## Installation

The extension is currently installed from source as an unpacked Chrome extension.

### 1. Clone the repository

```bash
git clone https://github.com/xiaofu2415/EchoX.git
cd EchoX
```

### 2. Install dependencies and build

A recent Node.js LTS release is recommended.

```bash
npm ci
npm run build
```

The production extension is generated in `dist/`.

### 3. Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `dist/` directory.
5. After rebuilding, select **Reload** on the extension card.

## Configuration

Select the extension icon in the browser toolbar and open the settings page.

1. Select a model provider.
2. Enter the API key, model name, and endpoint information.
3. Select **Verify current configuration**.
4. Save the configuration after every verification stage succeeds.

### Gemini AI Studio

Enter a Gemini AI Studio API key and an audio-capable model. The default model is:

```text
gemini-2.5-flash
```

### Google Cloud Vertex AI

Two authentication modes are supported:

- **Express API Key:** enter a Vertex AI Express Mode API key.
- **OAuth Token:** enter an access token, Google Cloud project ID, and location.

OAuth access tokens usually expire and must be replaced when no longer valid.

### OpenAI-Compatible Endpoints

Configure:

- Base URL
- API key
- Model ID
- Audio processing mode

If the selected model cannot process audio directly, choose **STT + text model** and configure the STT base URL, API key, model, and request format.

## Usage

1. Open an X video, X live stream, or YouTube Live broadcast, such as a World Cup match.
2. Start playback.
3. Move the pointer over the player to reveal its controls.
4. Select the blue-purple translation icon in the player toolbar.
5. Select **Start** in the translation panel.

The player panel also provides:

- Automatic translation
- English subtitle size
- Chinese subtitle size
- Subtitle position
- Subtitle background opacity
- Reset to defaults

## Permissions and Privacy

The extension uses these primary permissions:

- `storage`: stores provider configuration and subtitle settings locally.
- `offscreen`: maintains real-time WebSocket audio sessions.
- `declarativeNetRequest`: sets required request headers for selected real-time APIs.
- X, Twitter, and YouTube access: detects players and renders translation controls.
- Model API host access: sends requests to the translation or STT provider selected by the user.

Audio segments are sent to the third-party model providers you configure. Review their privacy policies and pricing before use, and never share your API keys.

## Development

```bash
# TypeScript type checking
npm test

# Production build
npm run build
```

Project structure:

```text
src/background/       API requests, session management, and background messaging
src/content_script/   Player adapters, audio capture, controls, and subtitles
src/offscreen/        Real-time WebSocket connections
src/options/          Settings page and popup
src/shared/           Shared provider and subtitle configuration
icons/                Extension and player icons
```

## Known Limitations

- YouTube support is currently limited to live streams.
- DRM, cross-origin media policies, or browser restrictions may prevent audio capture on some streams.
- Translation latency and quality depend on the network, model, audio quality, and provider load.
- Text-only models require a separate STT service.
- Third-party APIs may incur charges.

## Feedback

Report bugs and feature requests through [GitHub Issues](https://github.com/xiaofu2415/EchoX/issues).

## License

ISC
