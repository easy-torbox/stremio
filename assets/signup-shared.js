(function () {
  const API_BASE = 'https://easytorbox-referrals-api.etapps.workers.dev';
  const DEBUG = false;
  const REQUEST_TIMEOUT_MS = 15000;
  const TORBOX_HOSTNAME = 'torbox.app';

  function logDebug(...args) {
    if (!DEBUG) return;
    console.debug('[etb-signup]', ...args);
  }

  function setStatusById(statusElementId, text, kind = 'info') {
    const el = document.getElementById(statusElementId);
    if (!el) return;

    el.textContent = text;
    el.classList.remove('text-gray-500', 'text-gray-600', 'text-green-700', 'text-red-700', 'text-amber-700', 'text-blue-700');

    if (kind === 'success') el.classList.add('text-green-700');
    else if (kind === 'error') el.classList.add('text-red-700');
    else if (kind === 'warn') el.classList.add('text-amber-700');
    else if (kind === 'loading') el.classList.add('text-blue-700');
    else el.classList.add('text-gray-600');
  }

  function setElementsDisabled(selector, disabled) {
    const els = selector ? Array.from(document.querySelectorAll(selector)) : [];
    els.forEach((el) => {
      if ('disabled' in el) el.disabled = disabled;
      el.classList.toggle('opacity-60', disabled);
      el.classList.toggle('pointer-events-none', disabled);
      if (disabled) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    });
  }

  function validateTorboxReferralUrl(rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || ''));
    } catch {
      return { ok: false, message: 'Referral service returned an invalid link.' };
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== TORBOX_HOSTNAME || parsed.pathname !== '/subscription') {
      return { ok: false, message: 'Referral service returned an unexpected destination.' };
    }

    if (!parsed.searchParams.get('referral')) {
      return { ok: false, message: 'Referral service returned a link without a referral code.' };
    }

    return { ok: true, url: parsed.toString() };
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function selectCommunityReferral(options = {}) {
    const { turnstileToken = '' } = options;
    const headers = turnstileToken ? { 'x-turnstile-token': turnstileToken } : {};
    const { res, data } = await fetchJsonWithTimeout(`${API_BASE}/referrals/random`, { method: 'GET', headers });
    logDebug('signup response', { status: res.status, ok: res.ok, hasUrl: Boolean(data?.url), source: data?.source });

    if (res.status === 429) {
      const retryAfter = Number(data?.retryAfter || 0);
      let suffix = '';
      if (retryAfter > 0 && retryAfter < 60) {
        suffix = ` Try again in about ${Math.ceil(retryAfter)} second${Math.ceil(retryAfter) === 1 ? '' : 's'}.`;
      } else if (retryAfter >= 60) {
        suffix = ` Try again in about ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? 's' : ''}.`;
      }
      return { ok: false, status: res.status, message: `${data.message || 'Please wait before trying again.'}${suffix}` };
    }

    if (!res.ok || !data?.url) {
      return { ok: false, status: res.status, message: data.message || 'No community referral link is available right now.' };
    }

    const validated = validateTorboxReferralUrl(data.url);
    if (!validated.ok) {
      return { ok: false, status: 502, message: validated.message };
    }

    return { ok: true, url: validated.url, source: data.source || 'pool' };
  }

  async function openCommunitySignup(options = {}) {
    const {
      event = null,
      statusElementId = 'signupStatus',
      disableSelector = '',
      turnstileToken = '',
      loadingMessage = 'Checking the community referral pool...',
      navigatingMessage = 'Referral selected. Opening Torbox...',
      sameTab = true
    } = options;

    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }

    const setStatus = (text, kind = 'info') => setStatusById(statusElementId, text, kind);
    setElementsDisabled(disableSelector, true);
    setStatus(loadingMessage, 'loading');

    try {
      const selected = await selectCommunityReferral({ turnstileToken });
      if (!selected.ok) {
        setStatus(selected.message, selected.status === 429 ? 'warn' : 'error');
        return selected;
      }

      setStatus(navigatingMessage, 'success');
      if (sameTab) {
        window.location.assign(selected.url);
      } else {
        window.open(selected.url, '_blank', 'noopener,noreferrer');
      }
      return selected;
    } catch (err) {
      logDebug('signup fetch error', err);
      const message = err?.name === 'AbortError'
        ? 'Referral lookup timed out. Please try again.'
        : 'Network error. Please try again later.';
      setStatus(message, 'error');
      return { ok: false, message };
    } finally {
      setElementsDisabled(disableSelector, false);
    }
  }

  window.ETB_SHARED = {
    API_BASE,
    setStatusById,
    selectCommunityReferral,
    openCommunitySignup,
    validateTorboxReferralUrl
  };

  window.openCommunitySignup = openCommunitySignup;
})();
