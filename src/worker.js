/**
 * fiction.xxx landing worker.
 * - Serves the static landing page from `public/` (Workers Static Assets).
 * - `POST /api/waitlist` stores signups in the `fiction-waitlist` D1 database.
 *
 * <agent>Export signups with: wrangler d1 execute fiction-waitlist --remote
 * --command "SELECT email, role, created_at FROM waitlist_signups ORDER BY id"
 * or via the Cloudflare MCP d1_database_query tool (db id in wrangler.jsonc).</agent>
 */

/**
 * Origins allowed to POST cross-origin. Same-origin production traffic
 * (fiction.xxx / *.workers.dev) never sends a cross-origin request; this list
 * exists for the GitHub Pages preview deployment.
 */
const ALLOWED_ORIGINS = new Set([
  'https://braden-reap.github.io',
  'https://fiction.xxx',
  'https://www.fiction.xxx',
]);

/** Static salt for coarse IP hashing — abuse triage, not security. */
const IP_SALT = 'fiction-waitlist-2026';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && (ALLOWED_ORIGINS.has(origin) || origin.endsWith('.workers.dev'))) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function hashIp(ip) {
  if (!ip) return null;
  const data = new TextEncoder().encode(`${IP_SALT}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function handleWaitlist(request, env) {
  const cors = corsHeaders(request);

  let payload;
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.includes('application/json')) {
      payload = await request.json();
    } else {
      payload = Object.fromEntries((await request.formData()).entries());
    }
  } catch {
    return json({ ok: false, error: 'Could not read the form submission.' }, 400, cors);
  }

  // Honeypot: bots fill the hidden `website` field — report success, store nothing.
  if (typeof payload.website === 'string' && payload.website.trim() !== '') {
    return json({ ok: true }, 200, cors);
  }

  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400, cors);
  }

  const role = payload.role === 'reader' ? 'reader' : 'author';
  const source = String(payload.source ?? '').slice(0, 200) || null;
  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 300) || null;
  const ipHash = await hashIp(request.headers.get('CF-Connecting-IP'));

  try {
    await env.DB.prepare(
      `INSERT INTO waitlist_signups (email, role, source, user_agent, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (email) DO NOTHING`
    )
      .bind(email, role, source, userAgent, ipHash)
      .run();
  } catch (err) {
    console.error('waitlist insert failed', err);
    return json(
      { ok: false, error: 'Something went wrong on our end — please try again in a minute.' },
      500,
      cors
    );
  }

  // Duplicates also get `ok` — joining twice is a no-op, and we don't leak membership.
  return json({ ok: true }, 200, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/waitlist') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === 'POST') {
        return handleWaitlist(request, env);
      }
      return json({ ok: false, error: 'Method not allowed.' }, 405, corsHeaders(request));
    }

    return env.ASSETS.fetch(request);
  },
};
