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

// ---------------------------------------------------------------------------
// Invite codes (FIC-42) — the beta access gate.
//
// Codes are the single source of truth for who may create a fiction-app account
// during the beta. They are minted HERE (admin-only, from the waitlist or ad-hoc)
// and redeemed by the fiction-app signup path, which POSTs /api/invite/redeem and
// refuses to create the account unless it comes back `ok`.
// ---------------------------------------------------------------------------

/** Crockford base32 — omits I/L/O/U so a code is unambiguous when read aloud/retyped. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Mint one high-entropy, human-typable code: `FICT-XXXX-XXXX-XXXX` (12 symbols =
 * 60 bits). `byte & 31` is uniform because 32 divides 256, so no modulo bias.
 */
function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[bytes[i] & 31];
  return `FICT-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Canonical form for comparison: trimmed, upper-cased, inner whitespace stripped. */
function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function clampInt(value, dflt, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Parse a JSON or form-encoded body into a plain object. */
async function readBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) return await request.json();
  return Object.fromEntries((await request.formData()).entries());
}

/** Constant-time-ish string compare (length may leak; secret contents do not). */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Gate the admin invite endpoints on the `INVITE_ADMIN_TOKEN` secret (Bearer).
 * Fail-closed: with no secret set the endpoints 503 rather than run unguarded.
 */
function requireAdmin(request, env) {
  const token = env.INVITE_ADMIN_TOKEN;
  if (!token) return { ok: false, status: 503, error: 'invite_admin_unconfigured' };
  const header = request.headers.get('Authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !safeEqual(provided, token)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

/**
 * POST /api/invite/redeem — public. Body `{ code, email }`. Atomically consumes
 * one use of the code for that email and reports whether signup may proceed.
 *
 * Redemption is a single guarded UPDATE (atomic under D1's per-object
 * serialization) so two concurrent signups can't both consume the last use.
 * Per-email idempotency: a resubmitted signup from the SAME email that already
 * redeemed the code re-reads as `ok` instead of `code_used`, so a retried request
 * never strands a user. Errors are deliberately coarse (`invalid_code` covers
 * "no such code" and "bound to another email") so the endpoint can't be used to
 * probe which codes exist or who they were granted to.
 */
async function handleInviteRedeem(request, env) {
  const cors = corsHeaders(request);
  let payload;
  try {
    payload = await readBody(request);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400, cors);
  }

  const code = normalizeCode(payload.code);
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!code) return json({ ok: false, error: 'invalid_code' }, 400, cors);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid_email' }, 400, cors);

  const now = new Date().toISOString();
  try {
    const upd = await env.DB.prepare(
      `UPDATE invite_codes
          SET used_count = used_count + 1,
              redeemed_by_email = ?2,
              redeemed_at = COALESCE(redeemed_at, ?3)
        WHERE code = ?1
          AND revoked_at IS NULL
          AND used_count < max_uses
          AND (email IS NULL OR email = ?2)`
    )
      .bind(code, email, now)
      .run();

    if (upd.meta.changes > 0) {
      const row = await env.DB.prepare('SELECT role FROM invite_codes WHERE code = ?1')
        .bind(code)
        .first();
      return json({ ok: true, role: row?.role ?? 'author' }, 200, cors);
    }

    // Nothing changed — diagnose why (and honor per-email idempotency).
    const row = await env.DB.prepare(
      `SELECT role, email, redeemed_by_email, revoked_at FROM invite_codes WHERE code = ?1`
    )
      .bind(code)
      .first();
    if (!row) return json({ ok: false, error: 'invalid_code' }, 404, cors);
    if (row.revoked_at) return json({ ok: false, error: 'code_revoked' }, 410, cors);
    // Bound to a different email — report as not-found so bindings can't be probed.
    if (row.email && String(row.email).toLowerCase() !== email) {
      return json({ ok: false, error: 'invalid_code' }, 404, cors);
    }
    // Exhausted, but this same email already redeemed it → idempotent success.
    if (row.redeemed_by_email && String(row.redeemed_by_email).toLowerCase() === email) {
      return json({ ok: true, role: row.role, alreadyRedeemed: true }, 200, cors);
    }
    return json({ ok: false, error: 'code_used' }, 409, cors);
  } catch (err) {
    console.error('invite redeem failed', err);
    return json({ ok: false, error: 'server_error' }, 500, cors);
  }
}

/**
 * POST /api/invite/generate — admin (Bearer `INVITE_ADMIN_TOKEN`). Mints codes.
 * Body (all optional):
 * - `fromWaitlist: N` — mint one email-bound code for each of the N oldest
 *   waitlist signups of `role` that don't already have a code (the grant path).
 * - `email` — mint one code bound to that address.
 * - `count: N` — mint N unbound codes (anyone may redeem).
 * - `role` ('author'|'reader'), `note`, `maxUses`.
 * Returns `{ ok, count, codes: [{ code, email, role }] }`.
 */
async function handleInviteGenerate(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const role = body.role === 'reader' ? 'reader' : 'author';
  const note = body.note ? String(body.note).slice(0, 200) : null;
  const maxUses = clampInt(body.maxUses, 1, 1, 100000);

  let targets;
  if (body.fromWaitlist != null) {
    const n = clampInt(body.fromWaitlist, 1, 1, 500);
    const rows = await env.DB.prepare(
      `SELECT w.email FROM waitlist_signups w
        WHERE w.role = ?1
          AND NOT EXISTS (SELECT 1 FROM invite_codes i WHERE i.email = w.email)
        ORDER BY w.id ASC
        LIMIT ?2`
    )
      .bind(role, n)
      .all();
    targets = rows.results.map((r) => ({ email: String(r.email).toLowerCase() }));
  } else if (body.email) {
    const email = String(body.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid_email' }, 400);
    targets = [{ email }];
  } else {
    const count = clampInt(body.count, 1, 1, 100);
    targets = Array.from({ length: count }, () => ({ email: null }));
  }

  const minted = [];
  for (const target of targets) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        await env.DB.prepare(
          `INSERT INTO invite_codes (code, role, email, note, max_uses) VALUES (?1, ?2, ?3, ?4, ?5)`
        )
          .bind(code, role, target.email, note, maxUses)
          .run();
        minted.push({ code, email: target.email, role });
        break;
      } catch (err) {
        // Retry only on a code collision; surface anything else.
        if (String(err).toUpperCase().includes('UNIQUE')) continue;
        console.error('invite generate failed', err);
        return json({ ok: false, error: 'server_error' }, 500);
      }
    }
  }
  return json({ ok: true, count: minted.length, codes: minted }, 200);
}

/**
 * POST /api/invite/revoke — admin (Bearer `INVITE_ADMIN_TOKEN`). Body `{ code }`.
 * Soft-revokes: sets `revoked_at`, blocking further redemption. Idempotent.
 */
async function handleInviteRevoke(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const code = normalizeCode(body.code);
  if (!code) return json({ ok: false, error: 'invalid_code' }, 400);

  const upd = await env.DB.prepare(
    `UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, ?2) WHERE code = ?1`
  )
    .bind(code, new Date().toISOString())
    .run();
  if (upd.meta.changes === 0) return json({ ok: false, error: 'invalid_code' }, 404);
  return json({ ok: true }, 200);
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

    if (url.pathname === '/api/invite/redeem') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === 'POST') {
        return handleInviteRedeem(request, env);
      }
      return json({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders(request));
    }

    if (url.pathname === '/api/invite/generate') {
      if (request.method === 'POST') return handleInviteGenerate(request, env);
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/api/invite/revoke') {
      if (request.method === 'POST') return handleInviteRevoke(request, env);
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
