function json(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function parseIntEnv(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseRetentionDays(env) {
  return parseIntEnv(env, 'RETENTION_DAYS', 30);
}

function parseLimits(env) {
  return {
    maxSubmitPerHour: parseIntEnv(env, 'MAX_SUBMIT_PER_HOUR', 5),
    maxSubmitPerDay: parseIntEnv(env, 'MAX_SUBMIT_PER_DAY', 20),
    maxFailuresPerHour: parseIntEnv(env, 'MAX_FAILURES_PER_HOUR', 12),
    blockMinutes: parseIntEnv(env, 'BLOCK_MINUTES', 60),
    tokenTtlSeconds: parseIntEnv(env, 'TOKEN_TTL_SECONDS', 600),
    maxBodyBytes: parseIntEnv(env, 'MAX_BODY_BYTES', 4096)
  };
}

async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashWithSecret(value, secret) {
  return sha256Hex(`${secret}::${value}`);
}

function normalizeReferral(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, message: 'Referral is required.' };

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (uuidRegex.test(raw)) {
    const code = raw.toLowerCase();
    return {
      ok: true,
      normalizedCode: code,
      referralUrl: `https://torbox.app/subscription?referral=${encodeURIComponent(code)}`
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: 'Invalid referral input format.' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, message: 'Referral URL must use HTTPS.' };
  if (parsed.hostname !== 'torbox.app') return { ok: false, message: 'Only torbox.app referral URLs are allowed.' };
  if (parsed.pathname !== '/subscription') return { ok: false, message: 'Only /subscription referral path is allowed.' };

  const params = parsed.searchParams;
  const referral = (params.get('referral') || '').trim();
  if (!uuidRegex.test(referral)) return { ok: false, message: 'Referral code must be a valid UUID.' };

  const code = referral.toLowerCase();
  return {
    ok: true,
    normalizedCode: code,
    referralUrl: `https://torbox.app/subscription?referral=${encodeURIComponent(code)}`
  };
}

async function verifyReferralUpstream(referralUrl) {
  try {
    const resp = await fetch(referralUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': 'stremio-referral-validator/1.0'
      }
    });

    if ([400, 404, 410].includes(resp.status)) {
      return { ok: false, message: 'Referral code was not recognized by Torbox.' };
    }

    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not verify referral right now. Please retry.' };
  }
}

async function verifyTurnstile(token, env, ip) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, message: 'Server misconfiguration: missing Turnstile secret.' };
  if (!token) return { ok: false, message: 'Turnstile token is required.' };

  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (ip) formData.append('remoteip', ip);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData
  });

  if (!resp.ok) return { ok: false, message: 'Turnstile verification failed.' };

  const data = await resp.json();
  if (!data.success) return { ok: false, message: 'Turnstile challenge not valid.' };
  return { ok: true };
}

async function ensureSecurityTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS submit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_hash TEXT NOT NULL,
      success INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_submit_events_ip_created ON submit_events(ip_hash, created_at)'
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS used_turnstile_tokens (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_used_tokens_expires ON used_turnstile_tokens(expires_at)'
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS blocked_ips (
      ip_hash TEXT PRIMARY KEY,
      blocked_until INTEGER NOT NULL,
      reason TEXT,
      updated_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_referrals_active_pool ON referrals(status, expires_at, selection_count, last_selected_at)'
  ).run();
}

async function cleanExpiredSecurityRows(env, now) {
  await env.DB.prepare('DELETE FROM used_turnstile_tokens WHERE expires_at <= ?').bind(now).run();
}

async function isBlocked(env, ipHash, now) {
  const row = await env.DB.prepare('SELECT blocked_until FROM blocked_ips WHERE ip_hash = ? LIMIT 1').bind(ipHash).first();
  return !!row && Number(row.blocked_until) > now;
}

async function registerFailureAndMaybeBlock(env, ipHash, now, limits, reason = 'too_many_failures') {
  await env.DB.prepare(
    'INSERT INTO submit_events (ip_hash, success, created_at) VALUES (?, 0, ?)'
  ).bind(ipHash, now).run();

  const failuresLastHour = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM submit_events WHERE ip_hash = ? AND success = 0 AND created_at >= ?'
  ).bind(ipHash, now - 3600).first();

  if (Number(failuresLastHour?.c || 0) >= limits.maxFailuresPerHour) {
    const blockedUntil = now + (limits.blockMinutes * 60);
    await env.DB.prepare(
      `INSERT INTO blocked_ips (ip_hash, blocked_until, reason, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ip_hash) DO UPDATE SET blocked_until = excluded.blocked_until, reason = excluded.reason, updated_at = excluded.updated_at`
    ).bind(ipHash, blockedUntil, reason, now).run();
  }
}

async function checkAndRecordRateLimit(env, ipHash, now, limits) {
  const hourCountRow = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM submit_events WHERE ip_hash = ? AND created_at >= ?'
  ).bind(ipHash, now - 3600).first();

  const dayCountRow = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM submit_events WHERE ip_hash = ? AND created_at >= ?'
  ).bind(ipHash, now - 86400).first();

  const hourCount = Number(hourCountRow?.c || 0);
  const dayCount = Number(dayCountRow?.c || 0);

  if (hourCount >= limits.maxSubmitPerHour || dayCount >= limits.maxSubmitPerDay) {
    return { ok: false, message: 'Rate limit reached. Please try again later.' };
  }

  return { ok: true };
}

async function markTokenUsed(env, tokenHash, now, ttlSeconds) {
  const expiresAt = now + ttlSeconds;
  await env.DB.prepare(
    'INSERT INTO used_turnstile_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)'
  ).bind(tokenHash, now, expiresAt).run();
}

async function isTokenUsed(env, tokenHash) {
  const row = await env.DB.prepare('SELECT token_hash FROM used_turnstile_tokens WHERE token_hash = ? LIMIT 1').bind(tokenHash).first();
  return !!row;
}

async function handleSubmit(request, env, origin) {
  const limits = parseLimits(env);
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > limits.maxBodyBytes) {
    return json({ message: 'Request too large.' }, 413, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hashSecret = String(env.IP_HASH_SECRET || '').trim();
  if (!hashSecret) {
    return json({ message: 'Server misconfiguration: missing IP_HASH_SECRET.' }, 500, origin);
  }

  const now = nowEpochSeconds();
  await ensureSecurityTables(env);
  await cleanExpiredSecurityRows(env, now);

  const ipHash = await hashWithSecret(ip, hashSecret);
  if (await isBlocked(env, ipHash, now)) {
    return json({ message: 'Temporarily blocked due to repeated abuse. Try again later.' }, 429, origin);
  }

  const rateCheck = await checkAndRecordRateLimit(env, ipHash, now, limits);
  if (!rateCheck.ok) {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'rate_limit');
    return json({ message: rateCheck.message }, 429, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'invalid_json');
    return json({ message: 'Invalid JSON body.' }, 400, origin);
  }

  const referralInput = body?.referral;
  const turnstileToken = body?.turnstileToken;

  if (typeof referralInput !== 'string' || typeof turnstileToken !== 'string') {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'invalid_fields');
    return json({ message: 'Invalid request fields.' }, 400, origin);
  }

  const tokenHash = await hashWithSecret(turnstileToken, hashSecret);
  if (await isTokenUsed(env, tokenHash)) {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'turnstile_replay');
    return json({ message: 'Turnstile token was already used. Please retry challenge.' }, 409, origin);
  }

  const parsed = normalizeReferral(referralInput);
  if (!parsed.ok) {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'invalid_referral');
    return json({ message: parsed.message }, 400, origin);
  }

  const upstreamCheck = await verifyReferralUpstream(parsed.referralUrl);
  if (!upstreamCheck.ok) {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'invalid_referral_upstream');
    return json({ message: upstreamCheck.message }, 400, origin);
  }

  const turnstile = await verifyTurnstile(turnstileToken, env, ip);
  if (!turnstile.ok) {
    await registerFailureAndMaybeBlock(env, ipHash, now, limits, 'turnstile_failed');
    return json({ message: turnstile.message }, 403, origin);
  }

  await markTokenUsed(env, tokenHash, now, limits.tokenTtlSeconds);

  const retentionDays = parseRetentionDays(env);
  const expiresAt = now + (retentionDays * 24 * 60 * 60);

  const existing = await env.DB.prepare(
    'SELECT id, status, expires_at FROM referrals WHERE normalized_code = ? LIMIT 1'
  ).bind(parsed.normalizedCode).first();

  if (existing && existing.status === 'active' && Number(existing.expires_at) > now) {
    await env.DB.prepare('INSERT INTO submit_events (ip_hash, success, created_at) VALUES (?, 1, ?)').bind(ipHash, now).run();
    return json({ message: 'This referral is already active in the pool.' }, 409, origin);
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE referrals
       SET referral_url = ?, status = 'active', created_at = ?, expires_at = ?
       WHERE id = ?`
    ).bind(parsed.referralUrl, now, expiresAt, existing.id).run();

    await env.DB.prepare('INSERT INTO submit_events (ip_hash, success, created_at) VALUES (?, 1, ?)').bind(ipHash, now).run();

    return json({
      message: `Referral reactivated for ${retentionDays} days.`,
      expiresAt
    }, 200, origin);
  }

  await env.DB.prepare(
    `INSERT INTO referrals (normalized_code, referral_url, status, created_at, expires_at, submitter_hash)
     VALUES (?, ?, 'active', ?, ?, ?)`
  ).bind(parsed.normalizedCode, parsed.referralUrl, now, expiresAt, ipHash).run();

  await env.DB.prepare('INSERT INTO submit_events (ip_hash, success, created_at) VALUES (?, 1, ?)').bind(ipHash, now).run();

  return json({
    message: `Referral accepted for ${retentionDays} days.`,
    expiresAt
  }, 201, origin);
}

async function handleRandom(env, origin) {
  const now = nowEpochSeconds();

  const preferredCode = String(env.PREFERRED_REFERRAL_CODE || '').trim().toLowerCase();

  const row = await env.DB.prepare(
    `WITH preferred AS (
       SELECT id, referral_url, COALESCE(selection_count, 0) AS sc
       FROM referrals
       WHERE status = 'active' AND expires_at > ? AND normalized_code = ?
       LIMIT 1
     ), base_candidates AS (
       SELECT id, referral_url, COALESCE(selection_count, 0) AS sc
       FROM referrals
       WHERE status = 'active' AND expires_at > ?
       ORDER BY COALESCE(selection_count, 0) ASC, COALESCE(last_selected_at, 0) ASC
       LIMIT 200
     ), candidates AS (
       SELECT id, referral_url, sc FROM base_candidates
       UNION
       SELECT id, referral_url, sc FROM preferred
     ), scored AS (
       SELECT
         id,
         referral_url,
         (1.0 / (sc + 1.0)) AS weight,
         (ABS(RANDOM()) / 9223372036854775807.0) AS r
       FROM candidates
     )
     SELECT id, referral_url
     FROM scored
     ORDER BY (r / weight) ASC
     LIMIT 1`
  ).bind(now, preferredCode, now).first();

  if (!row) {
    const fallbackUrl = String(env.FALLBACK_TORBOX_URL || '').trim();
    if (fallbackUrl) {
      return json({
        url: fallbackUrl,
        source: 'fallback',
        message: 'No active community referral found. Using fallback.'
      }, 200, origin);
    }

    return json({ message: 'No active referrals are available right now.' }, 404, origin);
  }

  await env.DB.prepare(
    `UPDATE referrals
     SET selection_count = selection_count + 1,
         last_selected_at = ?
     WHERE id = ?`
  ).bind(now, row.id).run();

  return json({
    url: row.referral_url,
    source: 'pool'
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const allowedOrigins = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const requestOrigin = request.headers.get('origin') || '';
    const isOriginAllowed = !allowedOrigins.length || (requestOrigin && allowedOrigins.includes(requestOrigin));
    const corsOrigin = requestOrigin && isOriginAllowed
      ? requestOrigin
      : (allowedOrigins[0] || '*');

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': corsOrigin,
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type'
        }
      });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/referrals/submit') {
      if (!isOriginAllowed) {
        return json({ message: 'Origin not allowed.' }, 403, corsOrigin);
      }
      return handleSubmit(request, env, corsOrigin);
    }

    if (request.method === 'GET' && url.pathname === '/referrals/random') {
      return handleRandom(env, corsOrigin);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true }, 200, corsOrigin);
    }

    return json({ message: 'Not found.' }, 404, corsOrigin);
  }
};
