// This script runs in the **page context** (main world).
// It defines `window.ai` and communicates with the content script via postMessage.

(function () {
  if (window.ai) return; // already injected

  const pendingRequests = new Map();
  let requestCounter = 0;

  function generateId() {
    return `ai_bridge_${Date.now()}_${++requestCounter}`;
  }

  function sendToExtension(method, params) {
    return new Promise((resolve, reject) => {
      const id = generateId();

      pendingRequests.set(id, { resolve, reject });

      window.postMessage(
        { type: 'AI_BRIDGE_REQUEST', id, method, params },
        '*'
      );

      // Timeout after 2 minutes to avoid hanging promises
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject({ code: 'REQUEST_FAILED', message: 'Request timed out.' });
        }
      }, 120_000);
    });
  }

  // Listen for responses from the content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'AI_BRIDGE_RESPONSE') return;

    const { id, result, error } = event.data;
    const pending = pendingRequests.get(id);
    if (!pending) return;

    pendingRequests.delete(id);

    if (error) {
      pending.reject(error);
    } else {
      pending.resolve(result);
    }
  });

  // ── Public API ──────────────────────────────────────────────────────────

  const ai = Object.freeze({
    /**
     * Returns available providers and their models.
     * @returns {Promise<{status: string, providers: Object}>}
     */
    getCapabilities() {
      return sendToExtension('getCapabilities');
    },

    /**
     * Send an intent-based request to an AI provider.
     * @param {Object} payload - { method, params }
     * @param {string} payload.method - e.g. "ai_generateText"
     * @param {Object} payload.params - { provider, model, prompt, max_tokens, ... }
     * @returns {Promise<Object>}
     */
    request(payload) {
      if (!payload || !payload.method) {
        return Promise.reject({
          code: 'INVALID_METHOD',
          message: '"method" is required in the request payload.',
        });
      }
      return sendToExtension(payload.method, payload.params);
    },
  });

  Object.defineProperty(window, 'ai', {
    value: ai,
    writable: false,
    configurable: false,
    enumerable: true,
  });
})();
