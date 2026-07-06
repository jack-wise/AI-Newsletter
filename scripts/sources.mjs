// Feed fetchers: Google News RSS, Bing News RSS, SEC EDGAR JSON, Yahoo Finance
// RSS, CNBC section RSS, press-release wires (PR Newswire / GlobeNewswire), and
// Alpha Vantage NEWS_SENTIMENT (keyed).
// Dependency-free (Node 20+ global fetch); each fetcher returns normalized items:
//   { title, url, source, publishedAt, kind }
// Failures throw — the collector runs every source under Promise.allSettled and
// reports per-source errors instead of failing the whole run.

// SEC's WAF rejects parenthesized/URL-bearing agents; use their documented
// "Company Contact" format, which the other feeds accept too.
const UA = "AI Newsletter jack.wise@donoco.com";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);|&#39;/g, (m) => ENTITIES[m] ?? m);
}

// Minimal forgiving extraction of one tag's inner text from an XML fragment.
function tag(fragment, name) {
  const m = fragment.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"),
  );
  if (!m) return null;
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

// --- Google News RSS --------------------------------------------------------
// https://news.google.com/rss/search?q=... — keyless. Each <item> carries the
// publisher in <source>; the <link> is a Google redirect that resolves to the
// publisher, which is fine for a newsletter link-out.
export async function fetchGoogleNews(query) {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=en-US&gl=US&ceid=US:en";
  const xml = await fetchText(url);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = tag(it, "title");
    const link = tag(it, "link");
    if (!title || !link) continue;
    items.push({
      // Google News titles end with " - Publisher"; keep it, the dedupe key strips it.
      title,
      url: link,
      source: tag(it, "source") ?? "Google News",
      publishedAt: toIso(tag(it, "pubDate")),
      kind: "news",
    });
  }
  return items;
}

// --- SEC EDGAR company filings (data.sec.gov submissions API) ----------------
// Tier-0 primary source. The modern JSON API is used instead of the legacy
// browse-edgar atom feed, which 403s from some networks; SEC fair-use policy
// still requires a descriptive User-Agent. Returns the most recent filings
// (8-K, DFAN14A, Form 4, ...) with links to the primary document.
export async function fetchEdgarFilings(cik, limit = 25) {
  const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
  const res = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for SEC submissions CIK${padded}`);
  const data = await res.json();
  const recent = data?.filings?.recent ?? {};
  const company = data?.name ?? "company";
  const cikNum = String(Number(padded));
  const items = [];
  const n = Math.min(recent.form?.length ?? 0, limit);
  for (let i = 0; i < n; i++) {
    const accession = String(recent.accessionNumber?.[i] ?? "").replace(/-/g, "");
    const doc = recent.primaryDocument?.[i];
    if (!accession || !doc) continue;
    items.push({
      title: `SEC filing: ${recent.form?.[i] ?? "?"} — ${company}${
        recent.primaryDocDescription?.[i] ? ` (${recent.primaryDocDescription[i]})` : ""
      }`,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${doc}`,
      source: "SEC EDGAR",
      publishedAt: toIso(recent.acceptanceDateTime?.[i] ?? recent.filingDate?.[i]),
      kind: "filing",
    });
  }
  return items;
}

// --- Yahoo Finance per-ticker headlines --------------------------------------
export async function fetchYahooFinance(ticker) {
  const url =
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=" +
    encodeURIComponent(ticker) +
    "&region=US&lang=en-US";
  const xml = await fetchText(url);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = tag(it, "title");
    const link = tag(it, "link");
    if (!title || !link) continue;
    // Yahoo's <description> is a real article snippet — a free summary for the
    // on-site reader view, no extra fetch needed.
    const desc = tag(it, "description");
    items.push({
      title,
      url: link,
      source: "Yahoo Finance",
      publishedAt: toIso(tag(it, "pubDate")),
      kind: "news",
      ...(desc && desc.length > 30
        ? { summary: desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 480) }
        : {}),
    });
  }
  return items;
}

// --- Bing News RSS -------------------------------------------------------------
// Keyless like Google News, but with two things Google's feed no longer gives:
// a real per-item <description> snippet (an instant summary for the on-site
// reader) and a resolvable publisher URL (inside the apiclick redirect's url=
// param), which makes the article fetchable for Fermi-mention excerpts.
// Quirk: Bing's RSS chokes on quoted/OR query syntax — keep queries simple.
export async function fetchBingNews(query) {
  const url =
    "https://www.bing.com/news/search?q=" + encodeURIComponent(query) + "&format=rss";
  const xml = await fetchText(url);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = tag(it, "title");
    let link = tag(it, "link");
    if (!title || !link) continue;
    // Unwrap the apiclick redirect to the publisher's own URL.
    const real = /[?&]url=([^&]+)/.exec(link);
    if (real) {
      try {
        link = decodeURIComponent(real[1]);
      } catch {
        /* keep the redirect link */
      }
    }
    // The decoded redirect target is attacker-influenced; drop anything that
    // isn't an absolute http(s) URL so a javascript:/data: link never reaches
    // the site's href sink (the render-side safeUrl is the backstop).
    if (!/^https?:\/\//i.test(link)) continue;
    const source =
      tag(it, "News:Source") ??
      (() => {
        try {
          return new URL(link).hostname.replace(/^www\./, "");
        } catch {
          return "Bing News";
        }
      })();
    const desc = tag(it, "description");
    items.push({
      title,
      url: link,
      source,
      publishedAt: toIso(tag(it, "pubDate")),
      kind: "news",
      ...(desc && desc.length > 30
        ? { summary: desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 480) }
        : {}),
    });
  }
  return items;
}

// Shared helper: pull normalized items out of a standard RSS 2.0 feed. Each
// <item> is expected to carry <title>/<link>/<pubDate> and optionally
// <description> (used as the on-site reader summary, HTML stripped + capped).
function parseRssItems(xml, source, kind = "news") {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = tag(it, "title");
    const link = tag(it, "link");
    if (!title || !link) continue;
    // Only absolute http(s) links reach the site's href sink (mirrors safeUrl).
    if (!/^https?:\/\//i.test(link)) continue;
    const desc = tag(it, "description");
    items.push({
      title,
      url: link,
      source,
      publishedAt: toIso(tag(it, "pubDate")),
      kind,
      ...(desc && desc.length > 30
        ? { summary: desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 480) }
        : {}),
    });
  }
  return items;
}

// --- CNBC section RSS --------------------------------------------------------
// Keyless Tier-1 markets/tech coverage direct from CNBC (no Google redirect
// wrapper). Section feeds are curated (not a firehose), so items flow through the
// normal title->ticker matching: an NVDA/AI story lands in related/general, an
// FRMI mention in priority. Feed ids: 15839135=Markets, 19854910=Technology,
// 100003114=Top News.
export async function fetchCnbc(feedUrl) {
  const xml = await fetchText(feedUrl);
  return parseRssItems(xml, "CNBC");
}

// --- Press-release wires -----------------------------------------------------
// Primary-source releases (PR Newswire, GlobeNewswire) are keyless RSS but are
// firehoses, so they're filtered at ingestion to titles matching `patterns`
// (regex-source strings from config). This turns the wires into a targeted
// watcher — the real value for a thinly-covered small-cap like FRMI, whose own
// releases hit the wire before aggregators pick them up. Pass priority patterns
// for precision; widen to related patterns to also catch supplier/tenant PRs.
const WIRE_FEEDS = [
  { url: "https://www.prnewswire.com/rss/news-releases-list.rss", source: "PR Newswire" },
  {
    url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies",
    source: "GlobeNewswire",
  },
];

export async function fetchPressReleases(patterns, feeds = WIRE_FEEDS) {
  if (!patterns || patterns.length === 0) return []; // never dump an unfiltered firehose
  let matcher;
  try {
    matcher = new RegExp(patterns.join("|"), "i");
  } catch {
    return [];
  }
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const xml = await fetchText(f.url);
      return parseRssItems(xml, f.source).filter((it) => matcher.test(it.title));
    }),
  );
  // One flaky wire must not sink the others (mirrors the collector's allSettled).
  return results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
}

// --- Alpha Vantage NEWS_SENTIMENT -------------------------------------------
// Ticker-tagged news WITH sentiment, keyed (free tier: 25 req/day). The
// collector makes ONE combined multi-ticker call per run and fails open when the
// key is absent or the daily cap is hit (the API answers with an Information/Note
// blob and no `feed`), so coverage degrades to the keyless sources rather than
// erroring. `tickers` is an array; null/empty entries are dropped.
function alphaVantageTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S)).toISOString();
}

export async function fetchAlphaVantageNews(tickers, apiKey) {
  const list = (tickers ?? []).filter(Boolean);
  if (!apiKey || list.length === 0) return [];
  // Encode each ticker but keep the commas LITERAL: Alpha Vantage does not decode
  // a percent-encoded comma, so encodeURIComponent("NVDA,MSFT") -> "NVDA%2CMSFT"
  // is read as one invalid ticker and returns an empty feed with no error.
  // IMPORTANT: AV zeroes the ENTIRE response if any ticker in the list is one it
  // doesn't cover (verified: NVDA alone -> 50 items; NVDA + an uncovered symbol
  // like FRMI -> items:0, no error). So callers must pass only AV-covered US
  // tickers (see config.alphaVantageTickers). Encode each ticker, keep commas
  // literal (AV does not decode a percent-encoded comma).
  const url =
    "https://www.alphavantage.co/query?function=NEWS_SENTIMENT" +
    "&tickers=" + list.map((t) => encodeURIComponent(t)).join(",") +
    "&sort=LATEST&limit=50&apikey=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for Alpha Vantage NEWS_SENTIMENT`);
  const data = await res.json();
  // No `feed` -> rate-limited / bad key / no results. Fail open (keyless sources
  // still ran); the Information/Note text is not an item, so return nothing. Log
  // AV's own reason (Information/Note/Error Message) so the cause is diagnosable
  // rather than a silent zero — the message is generic, not secret.
  if (!Array.isArray(data?.feed)) {
    const reason =
      data?.Information ?? data?.Note ?? data?.["Error Message"] ?? JSON.stringify(data).slice(0, 200);
    console.warn(`[alphavantage] no feed returned: ${reason}`);
    return [];
  }
  const items = [];
  for (const f of data.feed) {
    const title = decodeEntities(f?.title);
    const link = f?.url;
    if (!title || typeof link !== "string" || !/^https?:\/\//i.test(link)) continue;
    const label = f?.overall_sentiment_label;
    const summary = f?.summary
      ? decodeEntities(f.summary).slice(0, 480) + (label ? ` [sentiment: ${label}]` : "")
      : undefined;
    items.push({
      title,
      url: link,
      source: f?.source || "Alpha Vantage",
      publishedAt: alphaVantageTime(f?.time_published),
      kind: "news",
      ...(summary ? { summary } : {}),
    });
  }
  return items;
}

function toIso(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
