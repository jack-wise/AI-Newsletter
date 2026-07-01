// The 30-minute collector. Fetches every configured source, vets and tags the
// items, and writes docs/data/news.json (which the static site renders) plus a
// per-day archive. Designed to ALWAYS produce a payload: individual source
// failures are recorded in sourceErrors, never fatal.
//
// Run locally: node scripts/collect.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchBingNews,
  fetchEdgarFilings,
  fetchGoogleNews,
  fetchYahooFinance,
} from "./sources.mjs";
import { searchX } from "./x.mjs";
import { fetchStockTwits, fetchRedditXLinks } from "./social.mjs";
import { enrichItems } from "./enrich.mjs";
import { updateDayArchive } from "./archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));

// Domain -> tier lookup from config.sourceTiers; unknown domains default to 3.
const tierByDomain = new Map();
for (const [tier, domains] of Object.entries(config.sourceTiers ?? {})) {
  for (const d of domains) tierByDomain.set(d, Number(tier));
}
function sourceTier(item) {
  if (item.kind === "filing") return 0;
  if (item.kind === "tweet" || item.kind === "social") return 2;
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

// Tagging: priority tickers (e.g. FRMI) pin to the top section; related
// tickers/companies (Fermi's ecosystem — suppliers, potential tenants) get
// their own section. A label falls back to the company name for ticker-less
// entries (e.g. OpenAI). Priority wins when an item matches both.
function buildMatchers(list) {
  return (list ?? []).map((t) => ({
    label: t.ticker ?? t.company,
    res: t.patterns.map((p) => new RegExp(p, "i")),
  }));
}
const priorityMatchers = buildMatchers(config.priorityTickers);
const relatedMatchers = buildMatchers(config.relatedTickers);
function matchLabels(matchers, text) {
  return matchers
    .filter((t) => t.res.some((re) => re.test(text)))
    .map((t) => t.label);
}

// Dedupe key: normalized title with the Google News " - Publisher" suffix and
// punctuation stripped, so wire reprints cluster to one item.
function dedupeKey(item) {
  // SEC filings dedupe by URL, never by title: EDGAR's form + description fields
  // produce byte-identical titles for distinct filings (Toby's June 10/11/12
  // DFAN14As all read the same), and title-clustering made each new filing
  // silently swallow the previous one. Each accession has a unique URL.
  if (item.kind === "filing") return item.url;
  return item.title
    .replace(/\s+-\s+[^-]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// Map an internal item.kind to the News Channel tab the journal scanner's
// fermi-feed contract expects (filings / social / news). Unknown kinds fall
// back to "news".
function feedTab(kind) {
  if (kind === "filing") return "filings";
  if (kind === "tweet" || kind === "social") return "social";
  return "news";
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

  // X state (pay-per-use cost control + continuity): since_id watermarks mean
  // each run reads only NEW tweets, so previously vetted tweets are persisted
  // here and carried forward for 7 days (the recent-search window) — otherwise
  // they would vanish from the site one cycle after arriving.
  const xStatePath = join(root, "docs", "data", "x-state.json");
  const xState = existsSync(xStatePath)
    ? JSON.parse(readFileSync(xStatePath, "utf8"))
    : { sinceId: {}, tweets: [] };
  let xSkippedMsg = null;
  async function collectX(t) {
    try {
      const out = await searchX(
        t.xQuery,
        config.x ?? {},
        process.env.X_BEARER_TOKEN,
        xState.sinceId?.[t.ticker] ?? null,
      );
      if (out.skipped) {
        xSkippedMsg = out.skipped;
        return [];
      }
      if (out.newestId) {
        xState.sinceId = { ...(xState.sinceId ?? {}), [t.ticker]: out.newestId };
      }
      return out.items;
    } catch (e) {
      sourceErrors.push({ source: `x:${t.ticker}`, error: String(e?.message ?? e) });
      return [];
    }
  }

  // Priority tickers: news queries + SEC filings + Yahoo headlines + X.
  const xTasks = [];
  for (const t of config.priorityTickers ?? []) {
    for (const q of t.newsQueries ?? []) run(`google-news:${t.ticker}`, fetchGoogleNews(q));
    for (const q of t.bingQueries ?? []) run(`bing-news:${t.ticker}`, fetchBingNews(q));
    if (t.cik) run(`edgar:${t.ticker}`, fetchEdgarFilings(t.cik));
    run(`yahoo:${t.ticker}`, fetchYahooFinance(t.ticker));
    if (t.xQuery) xTasks.push(collectX(t));
  }
  // Keyless social coverage (no X API needed): StockTwits per symbol (full
  // credibility gate — the API exposes author followers/age/official badge),
  // and Reddit-discovered X links hydrated via X's official oEmbed (labeled
  // trust:"limited" since oEmbed exposes no author metadata to vet).
  const socialCfg = { ...(config.x ?? {}), ...(config.social ?? {}) };
  for (const sym of config.social?.stocktwitsSymbols ?? []) {
    run(`stocktwits:${sym}`, fetchStockTwits(sym, socialCfg));
  }
  for (const q of config.social?.redditQueries ?? []) {
    run(`reddit-x`, fetchRedditXLinks(q, socialCfg));
  }

  // Related ecosystem (suppliers / potential tenants): news queries only, so the
  // big names don't swamp the run; their patterns also catch general-feed items.
  for (const t of config.relatedTickers ?? []) {
    const label = t.ticker ?? t.company;
    for (const q of t.newsQueries ?? []) run(`google-news:${label}`, fetchGoogleNews(q));
  }
  // General AI coverage.
  for (const q of config.generalQueries ?? []) run(`google-news:general`, fetchGoogleNews(q));

  const settled = await Promise.all(tasks);

  // Merge new tweets into the persisted 7-day set (dedupe by tweet URL) and
  // feed the MERGED set into the pipeline, so X items persist across runs.
  const newTweets = (await Promise.all(xTasks)).flat();
  const tweetCutoff = Date.now() - 7 * 86_400_000;
  const tweetsByUrl = new Map(
    (xState.tweets ?? [])
      .filter((tw) => tw.publishedAt && Date.parse(tw.publishedAt) > tweetCutoff)
      .map((tw) => [tw.url, tw]),
  );
  for (const tw of newTweets) tweetsByUrl.set(tw.url, tw);
  xState.tweets = [...tweetsByUrl.values()];
  settled.push({ label: "x:merged", items: xState.tweets });
  const xSkipped = xSkippedMsg;

  // Normalize, tag, tier, dedupe (keep the best-tier copy of each cluster).
  const byKey = new Map();
  for (const { items } of settled) {
    for (const raw of items ?? []) {
      const item = {
        ...raw,
        tier: sourceTier(raw),
        tickers: matchLabels(priorityMatchers, raw.title),
        related: matchLabels(relatedMatchers, raw.title),
      };
      const key = dedupeKey(item);
      if (!key) continue;
      const prev = byKey.get(key);
      // Better tier wins; on a tie, prefer the copy that carries a summary and
      // a direct publisher URL (Bing/Yahoo) over a bare redirect (Google News).
      const better =
        !prev ||
        item.tier < prev.tier ||
        (item.tier === prev.tier && Boolean(item.summary) && !prev.summary);
      if (better) byKey.set(key, item);
    }
  }

  const all = [...byKey.values()].map((item) => ({
    ...item,
    score:
      freshnessScore(item.publishedAt) +
      (3 - Math.min(item.tier, 3)) * 10 +
      (item.tickers.length ? 25 : item.related.length ? 15 : 0) +
      (item.credibility ? item.credibility.score / 10 : 0),
  }));
  const byScore = (a, b) => b.score - a.score || String(b.publishedAt).localeCompare(String(a.publishedAt));

  // Section routing: priority beats related beats general.
  const priority = all.filter((i) => i.tickers.length).sort(byScore).slice(0, config.limits.priorityItems);
  const related = all
    .filter((i) => !i.tickers.length && i.related.length)
    .sort(byScore)
    .slice(0, config.limits.relatedItems ?? 30);
  const general = all
    .filter((i) => !i.tickers.length && !i.related.length)
    .sort(byScore)
    .slice(0, config.limits.generalItems);

  // On-site reader enrichment: priority (FRMI) stories get article summaries +
  // Fermi-mention excerpts (one cached fetch each), filings get a plain-English
  // form explanation plus — when ANTHROPIC_API_KEY is set — an AI content
  // summary of the actual document, social posts carry their own text. Cache
  // persists across runs so each article is fetched and each filing summarized
  // at most once.
  const summariesPath = join(root, "docs", "data", "summaries.json");
  const summaries = existsSync(summariesPath)
    ? JSON.parse(readFileSync(summariesPath, "utf8"))
    : {};
  const fermiPatterns = (config.priorityTickers ?? []).flatMap((t) => t.patterns);
  await enrichItems(priority, summaries, {
    patterns: fermiPatterns,
    maxFetches: 12,
    maxAiSummaries: 8, // AI filing summaries — no-op unless FILINGS_WORKER_URL or ANTHROPIC_API_KEY is set
  });
  // Related-ticker items are news only (no SEC filings configured), so no AI budget.
  await enrichItems(related, summaries, {
    patterns: fermiPatterns,
    maxFetches: 4,
    maxAiSummaries: 0,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    siteTitle: config.siteTitle,
    tagline: config.tagline,
    priorityTickers: (config.priorityTickers ?? []).map((t) => t.ticker),
    relatedTickers: (config.relatedTickers ?? []).map((t) => t.ticker ?? t.company),
    xStatus: xSkipped
      ? "X via open-web discovery (oEmbed) + StockTwits — official X API off"
      : "X coverage on (official API)",
    priority,
    related,
    general,
    sourceErrors,
  };

  const dataDir = join(root, "docs", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "news.json"), JSON.stringify(payload, null, 2));

  // Fermi top-story feed: a stable JSON endpoint the journal scanner
  // (scripts/editor-in-chief.js) fetch()es once per daily run and passes as
  // structured facts to its LLM grader, so high-signal FRMI articles (proxy
  // filings, partner announcements) compete for the top story slot instead of
  // staying trapped in the iframe embed. Derived from the already-enriched
  // `priority` (FRMI-tagged) set, so summaries/resolved URLs come for free.
  //   https://jack-wise.github.io/AI-Newsletter/data/fermi-feed.json
  //
  // Freshness: Google News keeps re-surfacing months-old PR Newswire releases
  // for the FRMI query, which land in `priority`. The site hides them via its
  // 24h isFresh() filter, but this feed must too — otherwise a stale April
  // press release could reach the daily scan's top-story grader. Mirror the
  // site's convention: filings are always included (high-value; the scanner
  // decays them itself), but news/social age out after a rolling window. The
  // window is 7 days (wider than the site's 24h) because the scanner runs once
  // daily and shouldn't miss a story that broke ~25h before the scan.
  const FEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const feedFresh = (i) => {
    if (i.kind === "filing") return true;
    const t = Date.parse(i.publishedAt);
    return Number.isFinite(t) && Date.now() - t < FEED_MAX_AGE_MS;
  };
  const fermiFeed = {
    generatedAt: payload.generatedAt,
    articles: priority
      .filter((i) => i.url && i.title)
      .filter(feedFresh)
      .map((i) => ({
        title: i.title,
        url: i.url,
        source: i.source,
        tab: feedTab(i.kind),
        publishedAt: i.publishedAt ?? null,
        summary: i.summary ?? i.formExplanation ?? null,
      })),
  };
  writeFileSync(join(dataDir, "fermi-feed.json"), JSON.stringify(fermiFeed, null, 2));

  writeFileSync(xStatePath, JSON.stringify(xState, null, 2));
  writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));

  // Per-day archive: merge today's items by dedupe key so the day file grows
  // across runs without duplicates (an honest record of what the day surfaced).
  // Also maintains archive/index.json, which the History tab navigates by.
  const day = payload.generatedAt.slice(0, 10);
  updateDayArchive(
    join(dataDir, "archive"),
    day,
    [...priority, ...related, ...general],
    dedupeKey,
  );

  console.log(
    `collected: ${priority.length} priority + ${related.length} related + ${general.length} general ` +
      `(${sourceErrors.length} source errors)${xSkipped ? ` · ${xSkipped}` : ""}`,
  );
  for (const e of sourceErrors) console.warn(`  source error: ${e.source}: ${e.error}`);
}

await main();
