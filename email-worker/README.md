# Fermi Watch — Email Digest Worker

Owns the newsletter signup list and the daily "morning brief" send for the static
site. No paid infra: subscribers live in **Workers KV** (free tier), email goes
out via the **Brevo** transactional API (free tier ~300 emails/day). Uses
**double opt-in** (a confirmation click) so the list is consent-based and every
email carries a one-click unsubscribe.

## Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/subscribe` | POST `{email}` | Store a pending record + send a confirmation email |
| `/confirm?token=…` | GET | Promote pending → confirmed (from the email link) |
| `/unsubscribe?email=…&token=…` | GET | Remove a subscriber (from the email footer) |
| `/run-digest?key=…` | GET | Manually fire the digest now (guarded by the `ADMIN_KEY` secret) — for testing or an ad-hoc send |
| _cron_ `0 11 * * *` | — | Build a digest from the site's data and email all confirmed subs |

To enable the manual trigger: `npx wrangler secret put ADMIN_KEY` (any random
string), redeploy, then open
`https://fermi-watch-email.<subdomain>.workers.dev/run-digest?key=<that string>`.
It sends to all **confirmed** subscribers and returns `{ ok, sent }`.

The signup box on the site (`docs/index.html` → `app.js`) POSTs to `/subscribe`.

## One-time setup

```bash
cd email-worker

# 1. Create the KV namespace, then paste the printed id into wrangler.toml
npx wrangler kv namespace create SUBSCRIBERS

# 2. Get a free Brevo account (brevo.com), verify a sender address, create an
#    API key (SMTP & API -> API Keys), then:
npx wrangler secret put BREVO_API_KEY

# 3. Edit wrangler.toml vars:
#    FROM_EMAIL      = the verified Brevo sender
#    WORKER_ORIGIN   = leave as-is for now; fix after the first deploy

# 4. Deploy
npx wrangler deploy
```

After the first deploy, wrangler prints the worker URL
(`https://fermi-watch-email.<subdomain>.workers.dev`). Put that in
`WORKER_ORIGIN` in `wrangler.toml`, set the same origin as `ALLOWED_ORIGIN`'s
counterpart in the site's signup fetch (`app.js` `EMAIL_WORKER` constant), and
`npx wrangler deploy` again.

## Notes / limits

- **Brevo free tier ~300 emails/day.** The digest is a single API call using
  `messageVersions` (one personalized copy per subscriber, capped at 900) so it
  costs one subrequest regardless of list size — but you're still bounded by the
  daily send quota. Upgrade Brevo, or add a domain + Cloudflare Email Service,
  when the list outgrows it.
- **Confirm/unsub tokens** are `crypto.randomUUID()`; the unsub token is compared
  with `crypto.subtle.timingSafeEqual`.
- **Privacy:** subscribers never see each other's addresses; unsubscribe never
  reveals whether an address was on the list.
- The digest pulls `fermi-feed.json` (falling back to `news.json`) from the live
  site — the same ranked data the site shows — so it stays in sync automatically.
