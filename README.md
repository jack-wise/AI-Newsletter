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
- **X (Twitter) — optional, key needed:** the official X API v2 recent search.
  The **free tier cannot search**; this needs Basic ($200/mo) or above. Add the
  app bearer token as the `X_BEARER_TOKEN` repo secret and X coverage switches
  on automatically. Unofficial scraping is deliberately not implemented (ToS +
  breakage). The site shows whether X coverage is on or off.
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
