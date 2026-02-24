const OLLAMA_BASE_URL = 'http://localhost:11434';
const TRUSTED_ORIGINS_STORAGE_KEY = 'trusted_origins';

const CLOUD_PROVIDERS = {
  openAI: {
    name: 'openAI',
    baseUrl: 'https://api.openai.com/v1',
    chatEndpoint: '/chat/completions',
    keyStorageField: 'openai_api_key',
    modelsStorageField: 'openai_models',
    enabledStorageField: 'openai_enabled',
  },
  claude: {
    name: 'claude',
    baseUrl: 'https://api.anthropic.com/v1',
    chatEndpoint: '/messages',
    keyStorageField: 'claude_api_key',
    modelsStorageField: 'claude_models',
    enabledStorageField: 'claude_enabled',
  },
};

const ERROR_CODES = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  USER_REJECTED: 'USER_REJECTED',
  HARDWARE_LIMIT: 'HARDWARE_LIMIT',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  REQUEST_FAILED: 'REQUEST_FAILED',
  INVALID_METHOD: 'INVALID_METHOD',
};

function makeError(code, message) {
  return { code, message };
}

const pendingOriginApprovals = new Map();
const approvalWindowToOrigin = new Map();

// ── Ollama helpers ──────────────────────────────────────────────────────────

function getValidatedOllamaUrl(path) {
  const url = new URL(path, OLLAMA_BASE_URL);
  const isValid =
    url.protocol === 'http:' &&
    url.hostname === 'localhost' &&
    url.port === '11434';
  if (!isValid) {
    throw makeError(ERROR_CODES.REQUEST_FAILED, 'Local isolation violation: Ollama must be localhost:11434.');
  }
  return url.toString();
}

async function ollamaFetch(path, options = {}) {
  const ollamaUrl = getValidatedOllamaUrl(path);
  const res = await fetch(ollamaUrl, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body}`);
  }
  return res.json();
}

async function getOllamaModels() {
  try {
    const data = await ollamaFetch('/api/tags');
    return (data.models || []).map((m) => m.name);
  } catch {
    return null;
  }
}

async function ollamaGenerate(model, prompt, maxTokens) {
  try {
    const body = {
      model,
      prompt,
      stream: false,
    };
    if (maxTokens) body.options = { num_predict: maxTokens };

    const data = await ollamaFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return {
      text: data.response,
      model,
      provider: 'local',
      usage: {
        prompt_tokens: data.prompt_eval_count || 0,
        completion_tokens: data.eval_count || 0,
      },
    };
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      throw makeError(ERROR_CODES.MODEL_NOT_FOUND, `Model "${model}" is not available in Ollama. Pull it first.`);
    }
    if (err.message && /insufficient|memory|ram/i.test(err.message)) {
      throw makeError(ERROR_CODES.HARDWARE_LIMIT, `Not enough RAM to run "${model}". Try a smaller model.`);
    }
    throw makeError(ERROR_CODES.REQUEST_FAILED, err.message);
  }
}

// ── Cloud helpers ───────────────────────────────────────────────────────────

function parseOrigin(origin) {
  if (!origin || typeof origin !== 'string') return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function isExtensionPageSender(sender) {
  return Boolean(sender?.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`));
}

async function getTrustedOrigins() {
  const data = await chrome.storage.local.get([TRUSTED_ORIGINS_STORAGE_KEY]);
  const trustedOrigins = data[TRUSTED_ORIGINS_STORAGE_KEY];
  return trustedOrigins && typeof trustedOrigins === 'object' ? trustedOrigins : {};
}

async function saveTrustedOrigin(origin) {
  const trustedOrigins = await getTrustedOrigins();
  trustedOrigins[origin] = Date.now();
  await chrome.storage.local.set({ [TRUSTED_ORIGINS_STORAGE_KEY]: trustedOrigins });
}

async function isOriginTrusted(origin) {
  const trustedOrigins = await getTrustedOrigins();
  return Boolean(trustedOrigins[origin]);
}

async function ensureOriginApproval(origin) {
  const normalizedOrigin = parseOrigin(origin);
  if (!normalizedOrigin) {
    throw makeError(ERROR_CODES.USER_REJECTED, 'Invalid request origin.');
  }

  if (await isOriginTrusted(normalizedOrigin)) return;

  const existing = pendingOriginApprovals.get(normalizedOrigin);
  if (existing) {
    return existing.promise;
  }

  let resolveApproval;
  let rejectApproval;
  const promise = new Promise((resolve, reject) => {
    resolveApproval = resolve;
    rejectApproval = reject;
  });

  pendingOriginApprovals.set(normalizedOrigin, {
    promise,
    resolveApproval,
    rejectApproval,
    windowId: null,
  });

  try {
    const approvalUrl = chrome.runtime.getURL(`approval.html?origin=${encodeURIComponent(normalizedOrigin)}`);
    const win = await chrome.windows.create({
      url: approvalUrl,
      type: 'popup',
      width: 420,
      height: 540,
    });

    const pending = pendingOriginApprovals.get(normalizedOrigin);
    if (!pending) return;
    pending.windowId = win.id ?? null;
    if (win.id !== undefined) approvalWindowToOrigin.set(win.id, normalizedOrigin);
  } catch (err) {
    pendingOriginApprovals.delete(normalizedOrigin);
    throw makeError(ERROR_CODES.USER_REJECTED, err?.message || 'Unable to open approval popup.');
  }

  return promise;
}

function resolveOriginApproval(origin, approved, reason) {
  const pending = pendingOriginApprovals.get(origin);
  if (!pending) return;

  pendingOriginApprovals.delete(origin);
  if (pending.windowId !== null) {
    approvalWindowToOrigin.delete(pending.windowId);
  }

  if (approved) {
    saveTrustedOrigin(origin)
      .then(() => pending.resolveApproval())
      .catch(() => pending.resolveApproval());
    return;
  }

  pending.rejectApproval(makeError(ERROR_CODES.USER_REJECTED, reason || 'User rejected this site.'));
}

async function getCloudProviderConfig(providerName) {
  const provider = CLOUD_PROVIDERS[providerName];
  if (!provider) return null;

  const stored = await chrome.storage.local.get([
    provider.keyStorageField,
    provider.modelsStorageField,
    provider.enabledStorageField,
  ]);

  const apiKey = stored[provider.keyStorageField];
  const models = stored[provider.modelsStorageField];
  const enabled = stored[provider.enabledStorageField] !== false;
  if (!enabled || !apiKey) return null;

  return { ...provider, apiKey, models: models || [] };
}

async function cloudGenerate(providerName, model, prompt, maxTokens) {
  const config = await getCloudProviderConfig(providerName);
  if (!config) {
    throw makeError(ERROR_CODES.PROVIDER_NOT_FOUND, `Provider "${providerName}" is not configured.`);
  }

  if (providerName === 'openAI') {
    return openAIGenerate(config, model, prompt, maxTokens);
  }
  if (providerName === 'claude') {
    return claudeGenerate(config, model, prompt, maxTokens);
  }

  throw makeError(ERROR_CODES.PROVIDER_NOT_FOUND, `Unknown cloud provider "${providerName}".`);
}

async function openAIGenerate(config, model, prompt, maxTokens) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(`${config.baseUrl}${config.chatEndpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw makeError(ERROR_CODES.INSUFFICIENT_FUNDS, err.error?.message || 'Invalid or expired API key.');
    }
    if (res.status === 429) {
      throw makeError(ERROR_CODES.INSUFFICIENT_FUNDS, err.error?.message || 'Rate limit or insufficient quota.');
    }
    if (res.status === 404) {
      throw makeError(ERROR_CODES.MODEL_NOT_FOUND, `Model "${model}" not found on OpenAI.`);
    }
    throw makeError(ERROR_CODES.REQUEST_FAILED, err.error?.message || `OpenAI ${res.status}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];

  return {
    text: choice?.message?.content || '',
    model,
    provider: 'openAI',
    usage: {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

async function claudeGenerate(config, model, prompt, maxTokens) {
  const body = {
    model,
    max_tokens: maxTokens || 1024,
    messages: [{ role: 'user', content: prompt }],
  };

  const res = await fetch(`${config.baseUrl}${config.chatEndpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw makeError(ERROR_CODES.INSUFFICIENT_FUNDS, err.error?.message || 'Invalid or expired API key.');
    }
    if (res.status === 429) {
      throw makeError(ERROR_CODES.INSUFFICIENT_FUNDS, err.error?.message || 'Rate limit or insufficient quota.');
    }
    if (res.status === 404) {
      throw makeError(ERROR_CODES.MODEL_NOT_FOUND, `Model "${model}" not found on Anthropic.`);
    }
    throw makeError(ERROR_CODES.REQUEST_FAILED, err.error?.message || `Anthropic ${res.status}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text,
    model,
    provider: 'claude',
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
    },
  };
}

// ── Handler: getCapabilities ────────────────────────────────────────────────

async function handleGetCapabilities() {
  const providers = {};

  const ollamaModels = await getOllamaModels();
  providers.local = {
    available: ollamaModels !== null,
    models: ollamaModels || [],
  };

  for (const [name, _provider] of Object.entries(CLOUD_PROVIDERS)) {
    const config = await getCloudProviderConfig(name);
    providers[name] = {
      available: config !== null,
      models: config?.models || [],
    };
  }

  return { status: 'ready', providers };
}

// ── Handler: ai_generateText ────────────────────────────────────────────────

async function handleGenerateText(params) {
  const { provider, model, prompt, max_tokens } = params;

  if (!provider) throw makeError(ERROR_CODES.PROVIDER_NOT_FOUND, '"provider" is required.');
  if (!model) throw makeError(ERROR_CODES.MODEL_NOT_FOUND, '"model" is required.');
  if (!prompt) throw makeError(ERROR_CODES.REQUEST_FAILED, '"prompt" is required.');

  if (provider === 'local') {
    return ollamaGenerate(model, prompt, max_tokens);
  }

  return cloudGenerate(provider, model, prompt, max_tokens);
}

// ── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'APPROVAL_DECISION') {
    const normalizedOrigin = parseOrigin(message.origin);
    const approved = Boolean(message.approved);
    if (!normalizedOrigin) {
      sendResponse({ error: makeError(ERROR_CODES.REQUEST_FAILED, 'Invalid origin in approval response.') });
      return true;
    }

    if (!isExtensionPageSender(_sender)) {
      sendResponse({ error: makeError(ERROR_CODES.USER_REJECTED, 'Only extension pages can submit approval decisions.') });
      return true;
    }

    resolveOriginApproval(
      normalizedOrigin,
      approved,
      approved ? '' : 'User denied trust for this site.'
    );
    sendResponse({ result: { ok: true } });
    return true;
  }

  if (message?.type === 'AI_BRIDGE') {
    handleBridgeMessage(message)
      .then((result) => sendResponse({ result }))
      .catch((err) => {
        const error =
          err && err.code
            ? err
            : makeError(ERROR_CODES.REQUEST_FAILED, err?.message || String(err));
        sendResponse({ error });
      });
    return true; // keep channel open for async response
  }
});

async function handleBridgeMessage(message) {
  const { method, params, origin } = message;

  switch (method) {
    case 'getCapabilities':
      return handleGetCapabilities();

    case 'ai_generateText':
      await ensureOriginApproval(origin);
      return handleGenerateText(params || {});

    default:
      throw makeError(ERROR_CODES.INVALID_METHOD, `Unknown method "${method}".`);
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  const origin = approvalWindowToOrigin.get(windowId);
  if (!origin) return;
  resolveOriginApproval(origin, false, 'Approval popup was closed.');
});
