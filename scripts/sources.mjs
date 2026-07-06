// Feed fetchers: Google News RSS, SEC EDGAR Atom, Yahoo Finance RSS.
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

function toIso(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
