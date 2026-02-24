(function () {
  const params = new URLSearchParams(window.location.search);
  const origin = params.get('origin') || '';

  const originEl = document.getElementById('origin');
  const allowBtn = document.getElementById('allow');
  const denyBtn = document.getElementById('deny');

  originEl.textContent = origin;

  async function sendDecision(approved) {
    try {
      await chrome.runtime.sendMessage({
        type: 'APPROVAL_DECISION',
        origin,
        approved,
      });
    } finally {
      window.close();
    }
  }

  allowBtn.addEventListener('click', () => sendDecision(true));
  denyBtn.addEventListener('click', () => sendDecision(false));
})();
