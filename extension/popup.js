(function () {
  const fields = {
    openai_enabled: document.getElementById('openai_enabled'),
    openai_api_key: document.getElementById('openai_api_key'),
    openai_models: document.getElementById('openai_models'),
    claude_enabled: document.getElementById('claude_enabled'),
    claude_api_key: document.getElementById('claude_api_key'),
    claude_models: document.getElementById('claude_models'),
  };

  const statusEl = document.getElementById('status');
  const saveButton = document.getElementById('save');

  function toModelArray(value) {
    return value
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  function toModelString(models) {
    return Array.isArray(models) ? models.join(', ') : '';
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#b91c1c' : '#047857';
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get([
      'openai_enabled',
      'openai_api_key',
      'openai_models',
      'claude_enabled',
      'claude_api_key',
      'claude_models',
    ]);

    fields.openai_enabled.checked = data.openai_enabled !== false;
    fields.openai_api_key.value = data.openai_api_key || '';
    fields.openai_models.value = toModelString(data.openai_models);

    fields.claude_enabled.checked = data.claude_enabled !== false;
    fields.claude_api_key.value = data.claude_api_key || '';
    fields.claude_models.value = toModelString(data.claude_models);
  }

  async function saveSettings() {
    saveButton.disabled = true;
    setStatus('Saving...', false);

    try {
      await chrome.storage.local.set({
        openai_enabled: fields.openai_enabled.checked,
        openai_api_key: fields.openai_api_key.value.trim(),
        openai_models: toModelArray(fields.openai_models.value),
        claude_enabled: fields.claude_enabled.checked,
        claude_api_key: fields.claude_api_key.value.trim(),
        claude_models: toModelArray(fields.claude_models.value),
      });
      setStatus('Settings saved.', false);
    } catch (err) {
      setStatus(`Save failed: ${err?.message || String(err)}`, true);
    } finally {
      saveButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', saveSettings);
  loadSettings().catch((err) => setStatus(`Load failed: ${err?.message || String(err)}`, true));
})();
