// The 30-minute collector. Fetches every configured source, vets and tags the
// items, and writes docs/data/news.json (which the static site renders) plus a
// per-day archive. Designed to ALWAYS produce a payload: individual source
// failures are recorded in sourceErrors, never fatal.
//
// Run locally: node scripts/collect.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchGoogleNews, fetchEdgarFilings, fetchYahooFinance } from "./sources.mjs";
import { searchX } from "./x.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));

// Domain -> tier lookup from config.sourceTiers; unknown domains default to 3.
const tierByDomain = new Map();
for (const [tier, domains] of Object.entries(config.sourceTiers ?? {})) {
  for (const d of domains) tierByDomain.set(d, Number(tier));
}
function sourceTier(item) {
  if (item.kind === "filing") return 0;
  if (item.kind === "tweet") return 2;
  try {
    const host = new URL(item.url).hostname.replace(/^www\./, "");
    for (const [domain, tier] of tierByDomain) {
      if (host === domain || host.endsWith("." + domain)) return tier;
    }
  } catch {
    /* unparseable URL -> default tier */
  }
  // Google News links hide the publisher in the title suffix (" - Reuters").
  const pub = /-\s*([^-]+)$/.exec(item.title)?.[1]?.trim().toLowerCase() ?? "";
  for (const [domain, tier] of tierByDomain) {
    if (pub && domain.startsWith(pub.split(" ")[0])) return tier;
  }
  return 3;
}

// Ticker tagging: a priority item is anything matching a configured pattern.
const tickerMatchers = (config.priorityTickers ?? []).map((t) => ({
  ticker: t.ticker,
  res: t.patterns.map((p) => new RegExp(p, "i")),
}));
function matchTickers(text) {
  return tickerMatchers
    .filter((t) => t.res.some((re) => re.test(text)))
    .map((t) => t.ticker);
}

// Dedupe key: normalized title with the Google News " - Publisher" suffix and
// punctuation stripped, so wire reprints cluster to one item.
function dedupeKey(item) {
  return item.title
    .replace(/\s+-\s+[^-]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function freshnessScore(publishedAt) {
  if (!publishedAt) return 0;
  const hours = (Date.now() - Date.parse(publishedAt)) / 3_600_000;
  if (hours < 1) return 40;
  if (hours < 6) return 30;
  if (hours < 24) return 20;
  if (hours < 72) return 10;
  return 0;
}

async function main() {
  const tasks = [];
  const sourceErrors = [];
  const run = (label, promise) =>
    tasks.push(
      promise.then(
        (items) => ({ label, items: Array.isArray(items) ? items : items.items, skipped: items?.skipped }),
        (e) => {
          sourceErrors.push({ source: label, error: String(e?.message ?? e) });
          return { label, items: [] };
        },
      ),
    );

  // Priority tickers: news queries + SEC filings + Yahoo headlines + X.
  for (const t of config.priorityTickers ?? []) {
    for (const q of t.newsQueries ?? []) run(`google-news:${t.ticker}`, fetchGoogleNews(q));
    if (t.cik) run(`edgar:${t.ticker}`, fetchEdgarFilings(t.cik));
    run(`yahoo:${t.ticker}`, fetchYahooFinance(t.ticker));
    if (t.xQuery) {
      run(`x:${t.ticker}`, searchX(t.xQuery, config.x ?? {}, process.env.X_BEARER_TOKEN));
    }
  }
  // General AI coverage.
  for (const q of config.generalQueries ?? []) run(`google-news:general`, fetchGoogleNews(q));

  const settled = await Promise.all(tasks);
  const xSkipped = settled.find((s) => s.skipped)?.skipped ?? null;

  // Normalize, tag, tier, dedupe (keep the best-tier copy of each cluster).
  const byKey = new Map();
  for (const { items } of settled) {
    for (const raw of items ?? []) {
      const item = {
        ...raw,
        tier: sourceTier(raw),
        tickers: matchTickers(raw.title),
      };
      const key = dedupeKey(item);
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev || item.tier < prev.tier) byKey.set(key, item);
    }
  }

  const all = [...byKey.values()].map((item) => ({
    ...item,
    score:
      freshnessScore(item.publishedAt) +
      (3 - Math.min(item.tier, 3)) * 10 +
      (item.tickers.length ? 25 : 0) +
      (item.credibility ? item.credibility.score / 10 : 0),
  }));
  const byScore = (a, b) => b.score - a.score || String(b.publishedAt).localeCompare(String(a.publishedAt));

  const priority = all.filter((i) => i.tickers.length).sort(byScore).slice(0, config.limits.priorityItems);
  const general = all.filter((i) => !i.tickers.length).sort(byScore).slice(0, config.limits.generalItems);

  const payload = {
    generatedAt: new Date().toISOString(),
    siteTitle: config.siteTitle,
    tagline: config.tagline,
    priorityTickers: (config.priorityTickers ?? []).map((t) => t.ticker),
    xStatus: xSkipped ? `X coverage off — ${xSkipped}` : "X coverage on",
    priority,
    general,
    sourceErrors,
  };

  const dataDir = join(root, "docs", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "news.json"), JSON.stringify(payload, null, 2));

  // Per-day archive: merge today's items by dedupe key so the day file grows
  // across runs without duplicates (an honest record of what the day surfaced).
  const day = payload.generatedAt.slice(0, 10);
  const archiveDir = join(dataDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `${day}.json`);
  const existing = existsSync(archivePath)
    ? JSON.parse(readFileSync(archivePath, "utf8"))
    : { day, items: [] };
  const merged = new Map(existing.items.map((i) => [dedupeKey(i), i]));
  for (const i of [...priority, ...general]) {
    if (!merged.has(dedupeKey(i))) merged.set(dedupeKey(i), i);
  }
  writeFileSync(
    archivePath,
    JSON.stringify({ day, items: [...merged.values()] }, null, 2),
  );

  console.log(
    `collected: ${priority.length} priority + ${general.length} general ` +
      `(${sourceErrors.length} source errors)${xSkipped ? ` · ${xSkipped}` : ""}`,
  );
  for (const e of sourceErrors) console.warn(`  source error: ${e.source}: ${e.error}`);
}

await main();
