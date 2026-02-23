# Development Guide

## Project Structure

```
extension/
├── manifest.json   — Manifest V3 configuration
├── background.js   — Service Worker (Ollama + cloud provider routing)
├── content.js      — Content Script (bridge between page and background)
└── injected.js     — Injected into page context, defines window.ai
```

## Architecture

Message flow: **Webpage → injected.js → content.js → background.js → Ollama / Cloud API**

- `injected.js` runs in the page's main world. It defines an immutable `window.ai` object and communicates with the content script via `postMessage`.
- `content.js` runs in Chrome's isolated world. It injects `injected.js` into the page and bridges `postMessage` (page side) with `chrome.runtime.sendMessage` (extension side).
- `background.js` is the Manifest V3 service worker. It handles all actual API calls to Ollama and cloud providers.

## Local Development

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder
4. Open any webpage's DevTools Console to test `window.ai`

```js
// Check available providers
const caps = await window.ai.getCapabilities();
console.log(caps);

// Generate text via local Ollama
const result = await window.ai.request({
  method: 'ai_generateText',
  params: {
    provider: 'local',
    model: 'llama3:8b',
    prompt: 'Hello, world!',
    max_tokens: 100,
  },
});
console.log(result);
```

## Packaging for Chrome Web Store

### Build the .zip

```bash
cd extension && zip -r ../universal-ai-bridge.zip . -x '.*'
```

### Required assets before submission

| Asset | Spec |
|---|---|
| `icon16.png` | 16×16 extension icon |
| `icon48.png` | 48×48 extension icon |
| `icon128.png` | 128×128 extension icon |
| Store screenshot | At least one, 1280×800 |
| Privacy policy | Required due to `host_permissions` |

Add icons to `manifest.json`:

```json
"icons": {
  "16": "icon16.png",
  "48": "icon48.png",
  "128": "icon128.png"
}
```

### Submit

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. First-time registration costs a one-time $5 USD fee
3. Upload the `.zip` file and fill in the listing details
