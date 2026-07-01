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
