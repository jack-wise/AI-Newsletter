# Brief Writer Worker

A Cloudflare Worker that writes **The Brief** — the 2-3 paragraph at-a-glance
summary at the top of the site — using **Workers AI**, so it needs **no Anthropic
API key**. Inference runs on your Cloudflare account's neuron allowance (10,000
neurons/day free; this model is ~250 neurons per brief, and the collector runs
~48×/day, so it stays well inside the free tier).

The collector (`scripts/brief.mjs`) POSTs `{ facts }` — a small pre-digested
object (price, recent headlines, filing/insider counts, social) — and the Worker
returns `{ text }`, the narrative paragraphs. This route fetches nothing (no SSRF
surface, unlike the filings worker).

## Deploy

```bash
cd brief-worker
npm install -g wrangler        # if not installed
wrangler login                 # opens browser, authorize Cloudflare
wrangler secret put BRIEF_SECRET   # paste a random string (the shared secret)
wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.
`https://fermi-brief-writer.<your-subdomain>.workers.dev`.

> First request to a model is a 1-3s cold start; subsequent ones are faster.
> Workers AI has no local inference — test with `wrangler dev --remote`.

## Wire the collector to it

In the **repo** GitHub settings (Settings → Secrets and variables → Actions):

- **Variable** `BRIEF_WORKER_URL` = the deployed Worker URL above.
- **Secret** `BRIEF_WORKER_SECRET` = the same string you gave `BRIEF_SECRET`.

The `update-newsletter` workflow passes both to `collect.mjs`. Backend selection
in `scripts/brief.mjs` is: **`BRIEF_WORKER_URL` (this keyless Worker) → else
`ANTHROPIC_API_KEY` (Claude Haiku) → else the deterministic template.** All paths
fail open — a Worker error never breaks the cron; the brief just falls back to
the template that cycle.

## Config

- `MODEL` (wrangler.toml) — any Workers AI text model; default
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. If you ever hit the free-tier daily
  neuron limit, switch to the cheaper `@cf/meta/llama-3.1-8b-instruct-fp8`. List
  current models with `wrangler ai models` (the catalog changes — older ids get
  deprecated).
- `BRIEF_SECRET` (secret) — required; requests without a matching
  `X-Brief-Secret` header get 401.
