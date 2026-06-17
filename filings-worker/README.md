# Filings Summarizer Worker

A Cloudflare Worker that summarizes the **contents** of an SEC filing using
**Workers AI** — so the newsletter gets real filing summaries with **no Anthropic
API key**. Inference runs on your Cloudflare account's neuron allowance (10,000
neurons/day free; this model is ~200 neurons per summary).

The collector (`scripts/enrich.mjs`) POSTs `{ url, form }`; the Worker fetches the
document from EDGAR, runs the model, and returns `{ summary }`. The collector
caches the result per URL, so each filing is summarized once, ever.

## Deploy

```bash
cd filings-worker
npm install -g wrangler        # if not installed
wrangler login                 # opens browser, authorize Cloudflare
wrangler secret put FILINGS_SECRET   # paste a random string (the shared secret)
wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.
`https://fermi-filings-summarizer.<your-subdomain>.workers.dev`.

> First request to a model is a 1-3s cold start; subsequent ones are faster.
> Test locally with `wrangler dev --remote` (Workers AI has no local inference).

## Wire the collector to it

In the **repo** GitHub settings (Settings → Secrets and variables → Actions):

- **Variable** `FILINGS_WORKER_URL` = the deployed Worker URL above.
- **Secret** `FILINGS_WORKER_SECRET` = the same string you gave `FILINGS_SECRET`.

The `update-newsletter` workflow passes both to `collect.mjs`. When
`FILINGS_WORKER_URL` is set, filings are summarized via this Worker; absent, the
collector falls back to the static form-type explanation (and then to the
Anthropic path if `ANTHROPIC_API_KEY` is set instead). All paths fail open — a
Worker error never breaks the cron.

## Config

- `MODEL` (wrangler.toml) — any Workers AI text model; default
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. If you hit the free-tier daily
  neuron limit during a filing burst, switch to the cheaper
  `@cf/meta/llama-3.1-8b-instruct-fp8`. List current models with
  `wrangler ai models` (the catalog changes — older ids get deprecated).
- `FILINGS_SECRET` (secret) — required; requests without a matching
  `X-Filings-Secret` header get 401. The Worker only fetches `sec.gov` URLs.
