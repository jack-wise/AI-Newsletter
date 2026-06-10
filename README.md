# AI Newsletter

A self-updating AI-news website. A GitHub Actions cron runs every 30 minutes,
scans the configured sources, vets and ranks the items, and publishes a static
dashboard via GitHub Pages. **Priority ticker: FRMI (Fermi Inc.)** — anything
matching its patterns is pinned to the top section.

## How it works

```
GitHub Actions (cron */30) ──► scripts/collect.mjs ──► docs/data/news.json ──► GitHub Pages (docs/)
                                                   └──► docs/data/archive/YYYY-MM-DD.json
```

- **Sources (no keys needed):**
  - Google News RSS — per-query searches (FRMI queries + general AI queries)
  - SEC EDGAR Atom — every Fermi Inc. filing (8-K, DFAN14A, Form 4 …), Tier 0
  - Yahoo Finance RSS — FRMI headlines
- **Social — keyless (default):** two free channels, no X API spend:
  - **StockTwits** public symbol stream — finance chatter where the API
    exposes author followers, join date, and official badges, so the **full
    credibility gate applies** (same thresholds as X vetting).
  - **Reddit-discovered X links** — Reddit's search Atom feed (the JSON API
    403s without OAuth) surfaces posts sharing `x.com/...status/...` links,
    which are hydrated through **X's official oEmbed endpoint**
    (publish.twitter.com, keyless, built for embedding). oEmbed exposes no
    author metadata, so these render with an honest **"limited" trust badge**
    — content without follower/location vetting. We never scrape x.com.
- **X official API — optional upgrade:** API v2 recent search under X's
  **pay-per-use pricing** (Feb 2026: ~$0.005 per post read; console.x.com,
  set a monthly spend cap). Add the bearer token as the `X_BEARER_TOKEN` repo
  secret and full-vetting X search switches on automatically. Cost control is
  built in: a per-ticker `since_id` watermark (persisted in
  `docs/data/x-state.json`) means each run reads only NEW tweets — a quiet
  cycle bills zero — and vetted tweets carry forward for 7 days. Expected
  cost at FRMI volume: a few dollars per month.
- **X credibility vetting:** every tweet's author is scored 0–100 on follower
  count, follower/following ratio, account age, verified status, stated
  location (configurable region boost), and the tweet's engagement. Tweets
  below `x.minCredibility` (default 45) are dropped; survivors carry a
  high/medium trust badge with the reasons on hover.
- **Ranking:** freshness + source tier (SEC > wires > analysis > other) +
  priority-ticker boost + X credibility. Wire reprints are deduped by
  normalized title, keeping the best-tier copy.
- **Resilience:** every source runs independently; a failing feed lands in
  `sourceErrors` in the payload instead of failing the run.

## Configuration — `config.json`

- `priorityTickers[]` — ticker, company, SEC CIK, match patterns, news queries,
  X query. Add more tickers here; the site renders them all in the priority
  section.
- `generalQueries[]` — Google News searches for the general AI section.
- `x` — credibility thresholds and location boosts.
- `sourceTiers` — domain → tier map.

## Operating it

- **Force a refresh:** Actions → `update-newsletter` → Run workflow.
- **Enable X:** repo Settings → Secrets and variables → Actions → new secret
  `X_BEARER_TOKEN`.
- **Local run:** `node scripts/collect.mjs` (Node 20+), then open
  `docs/index.html` via any static server.
- **Cron realities:** GitHub schedules are best-effort (runs may start late);
  scheduled workflows pause after ~60 days of repo inactivity, which the
  collector's own commits prevent.

*Generated content is informational; X vetting is heuristic, not an
endorsement. Not investment advice.*
