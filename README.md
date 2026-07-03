# fiction.xxx — landing page + author waitlist

Pre-launch landing page for **fiction** (AI fiction writing + reading), with an
author early-access waitlist stored durably in Cloudflare D1.

## Architecture

- `public/index.html` — the static landing page (no build step).
- `src/worker.js` — Cloudflare Worker: serves `public/` and handles
  `POST /api/waitlist` (validation, honeypot, dedup) → D1.
- `schema.sql` — D1 schema. Already applied to the production database
  `fiction-waitlist` (`ee9aca6f-ded9-47ec-b8ff-e9e0735bd68c`).
- `.github/workflows/deploy-worker.yml` — deploys the Worker on push to `main`
  **once the `CLOUDFLARE_API_TOKEN` repo secret is set** (skips gracefully until then).
- `.github/workflows/deploy-pages.yml` — publishes `public/` to GitHub Pages as a
  preview host (the form there needs `WORKER_ORIGIN` set in `index.html` once the
  Worker is live).

## Local development

```bash
npx wrangler d1 execute fiction-waitlist --local --file=schema.sql
npx wrangler dev          # serves page + API at http://localhost:8787
```

## Deploying

1. Create a Cloudflare API token (template “Edit Cloudflare Workers” + **D1:Edit**).
2. `gh secret set CLOUDFLARE_API_TOKEN --repo <this repo>` (and optionally
   `CLOUDFLARE_ACCOUNT_ID` if the token spans multiple accounts).
3. Push to `main` (or re-run the *Deploy Worker* workflow). The Worker lands at
   `https://fiction-landing.<account-subdomain>.workers.dev`.
4. After the first deploy, set `WORKER_ORIGIN` in `public/index.html` so the
   GitHub Pages preview posts to the live API.

## Exporting waitlist emails

Any of:

- `npx wrangler d1 execute fiction-waitlist --remote --command "SELECT email, role, created_at FROM waitlist_signups ORDER BY id"`
- Cloudflare dashboard → D1 → `fiction-waitlist` (browse/export).
- Cloudflare MCP `d1_database_query` with database id `ee9aca6f-ded9-47ec-b8ff-e9e0735bd68c`.

## Invite codes — the beta access gate (FIC-42)

During the beta, **fiction-app refuses to create an account without a redeemed
invite code**. This Worker is the single source of truth for issuance *and*
redemption (table `invite_codes`), so the two can never drift.

- `POST /api/invite/redeem` — **public**. Body `{ code, email }`. Called by the
  fiction-app signup route before it creates the account. Atomic + single-use;
  a resubmit from the *same* email is idempotent (`ok: true, alreadyRedeemed`).
- `POST /api/invite/generate` — **admin** (`Authorization: Bearer $INVITE_ADMIN_TOKEN`).
  Mints codes. Body options: `fromWaitlist: N` (bind one code to each of the N
  oldest un-coded waitlist authors — the grant path), `email` (bind one code),
  `count: N` (unbound), plus `role`, `note`, `maxUses`.
- `POST /api/invite/revoke` — **admin**. Body `{ code }`. Soft-revokes a leaked code.

The admin token is the `INVITE_ADMIN_TOKEN` Worker secret (`wrangler secret put
INVITE_ADMIN_TOKEN`); with it unset the admin endpoints fail closed (503). A copy
lives in the Paperclip company secret store so the team can mint codes.

```bash
# Grant invites to the 10 oldest waitlist authors:
curl -sX POST https://fiction.xxx/api/invite/generate \
  -H "Authorization: Bearer $INVITE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"fromWaitlist":10}'

# List outstanding (unredeemed, un-revoked) codes:
npx wrangler d1 execute fiction-waitlist --remote --command \
  "SELECT code, email, note, used_count, max_uses FROM invite_codes WHERE redeemed_at IS NULL AND revoked_at IS NULL ORDER BY created_at"
```

fiction-app enables the gate with `INVITE_REQUIRED=true` + `INVITE_REDEEM_URL`
pointing at `https://fiction.xxx/api/invite/redeem` (see that repo's signup path).

## Domain (fiction.xxx)

- Registered at **GoDaddy**, expires **2026-12-30**; nameservers currently point
  at **Vercel DNS** (`ns1/ns2.vercel-dns.com`), so DNS records are managed from a
  Vercel account.
- To serve fiction.xxx from this Worker: move the zone to Cloudflare (add site on
  the Cloudflare account, update nameservers at GoDaddy), then uncomment the
  `routes` entry in `wrangler.jsonc` and redeploy.
- Alternative: keep DNS on Vercel and host there instead — requires Vercel access.
