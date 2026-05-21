(function () {
  const API_BASE = 'https://easytorbox-referrals-api.etapps.workers.dev';
  const DEBUG = false;

  function logDebug(...args) {
    if (!DEBUG) return;
    console.debug('[etb-signup]', ...args);
  }

  function setStatusById(statusElementId, text, kind = 'info') {
    const el = document.getElementById(statusElementId);
    if (!el) return;

    el.textContent = text;
    el.classList.remove('text-gray-500', 'text-gray-600', 'text-green-700', 'text-red-700', 'text-amber-700');

    if (kind === 'success') el.classList.add('text-green-700');
    else if (kind === 'error') el.classList.add('text-red-700');
    else if (kind === 'warn') el.classList.add('text-amber-700');
    else el.classList.add('text-gray-600');
  }

  async function openCommunitySignup(options = {}) {
    const {
      event = null,
      statusElementId = 'signupStatus',
      disableSelector = '',
      turnstileToken = '',
      loadingMessage = 'Finding a random link...',
      emptyMessage = 'No active referral link is available right now.',
      networkErrorMessage = 'Network error. Please try again later.'
    } = options;

    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }

    const setStatus = (text, kind = 'info') => setStatusById(statusElementId, text, kind);

    const disableEls = disableSelector
      ? Array.from(document.querySelectorAll(disableSelector))
      : [];

    disableEls.forEach((el) => {
      el.classList.add('opacity-60', 'pointer-events-none');
      el.setAttribute('aria-disabled', 'true');
    });

    const popup = window.open('', '_blank');
    if (!popup) {
      setStatus('Popup was blocked. Please allow pop-ups and try again.', 'warn');
      disableEls.forEach((el) => {
        el.classList.remove('opacity-60', 'pointer-events-none');
        el.removeAttribute('aria-disabled');
      });
      return;
    }

    popup.opener = null;
    popup.document.write('<!doctype html><title>Opening referral...</title><p style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; padding: 16px;">Opening referral link...</p>');
    setStatus(loadingMessage, 'info');

    try {
      const headers = turnstileToken ? { 'x-turnstile-token': turnstileToken } : {};
      const res = await fetch(`${API_BASE}/referrals/random`, { method: 'GET', headers });
      const data = await res.json().catch(() => ({}));
      logDebug('signup response', { status: res.status, ok: res.ok, hasUrl: Boolean(data?.url), source: data?.source });

      if (res.status === 429) {
        popup.close();
        setStatus(data.message || 'Please wait a moment before trying again.', 'warn');
        return;
      }

      if (!res.ok || !data?.url) {
        popup.close();
        setStatus(data.message || emptyMessage, 'warn');
        return;
      }

      setStatus(
        data.source === 'fallback'
          ? 'Community list unavailable. Opening backup link...'
          : 'Opening a random community link...',
        'success'
      );
      popup.location.replace(data.url);
    } catch (err) {
      logDebug('signup fetch error', err);
      popup.close();
      setStatus(networkErrorMessage, 'error');
    } finally {
      disableEls.forEach((el) => {
        el.classList.remove('opacity-60', 'pointer-events-none');
        el.removeAttribute('aria-disabled');
      });
    }
  }

  window.ETB_SHARED = {
    API_BASE,
    setStatusById,
    openCommunitySignup
  };

  window.openCommunitySignup = openCommunitySignup;
})();
