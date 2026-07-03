-- Waitlist signups for fiction.xxx.
-- Applied to the production D1 database `fiction-waitlist` and to local dev via
-- `wrangler d1 execute fiction-waitlist --local --file=schema.sql`.
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE,
  -- 'author' | 'reader' — the CTA targets authors but we capture reader interest too
  role TEXT NOT NULL DEFAULT 'author',
  -- free-form attribution (utm_source or referrer host), for later funnel analysis
  source TEXT,
  user_agent TEXT,
  -- salted SHA-256 of the connecting IP, truncated; abuse analysis without storing raw PII
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_signups (email);

-- Invite codes (FIC-42): the beta access gate. Codes are minted here (deliberately,
-- from the waitlist or ad-hoc) and redeemed by the fiction-app signup path, which
-- POSTs /api/invite/redeem before it will create an account. This table is the single
-- source of truth for issuance AND redemption so the two never drift.
--   `wrangler d1 execute fiction-waitlist --remote --file=schema.sql` applies it (idempotent).
CREATE TABLE IF NOT EXISTS invite_codes (
  -- High-entropy, human-typable code (e.g. FICT-4Q7K-9WZR-2H0X). COLLATE NOCASE so
  -- redemption is case-insensitive (users retype it from an email).
  code TEXT PRIMARY KEY COLLATE NOCASE,
  -- What signing up with this code grants. Mirrors waitlist_signups.role.
  role TEXT NOT NULL DEFAULT 'author',
  -- Optional pre-binding to a specific waitlist email; when set, only that email may
  -- redeem it (a granted code can't be forwarded to someone else).
  email TEXT COLLATE NOCASE,
  -- Free-form provenance ("first-10 waitlist", "conf demo") for auditing.
  note TEXT,
  -- Redemption budget. 1 = single-use (default). Shared beta codes can set >1.
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  -- First email to redeem + when; drives the audit trail and per-email idempotency
  -- (a resubmitted signup from the same email re-reads as ok rather than "used").
  redeemed_by_email TEXT COLLATE NOCASE,
  redeemed_at TEXT,
  -- Soft revoke: once set, redemption is refused. Kills a leaked code without losing
  -- its history.
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_invite_email ON invite_codes (email);
