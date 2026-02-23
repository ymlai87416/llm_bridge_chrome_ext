// Inject the window.ai provider script into the page context.
// Content scripts run in an isolated world and cannot modify `window` directly,
// so we inject injected.js as a <script> tag that runs in the main world.

(function () {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();

// Bridge: forward messages from the page (injected.js) to the background service worker.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'AI_BRIDGE_REQUEST') return;

  const { id, method, params } = event.data;

  chrome.runtime.sendMessage(
    { type: 'AI_BRIDGE', method, params, origin: location.origin },
    (response) => {
      window.postMessage(
        {
          type: 'AI_BRIDGE_RESPONSE',
          id,
          ...(response || { error: { code: 'REQUEST_FAILED', message: 'No response from extension.' } }),
        },
        '*'
      );
    }
  );
});
