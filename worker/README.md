# Queequeg Chat Worker

A Cloudflare Worker that powers the **QUEEQUEG** tab on FERMI WATCH. It holds the
Anthropic API key server-side and runs the queequeg quant-research persona with
web search, so the static site can chat with it without exposing any secret.

## Deploy

```bash
cd worker
npm install -g wrangler        # if not installed
wrangler login                 # opens browser, authorize Cloudflare
wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic key when prompted
wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.
`https://queequeg-chat.<your-subdomain>.workers.dev`.

## Wire the site to it

Put that URL into `docs/app.js` as `QUEEQUEG_ENDPOINT` (search for it), commit,
and push. The QUEEQUEG tab will start talking to the Worker.

## Config

- `ALLOWED_ORIGIN` (wrangler.toml) — CORS allowlist; set to your Pages origin.
- `MODEL` (wrangler.toml) — defaults to `claude-opus-4-8`.
- `ANTHROPIC_API_KEY` (secret) — required; never commit it.
