// Story enrichment: gives each priority item enough substance to read ON-SITE
// (the cards open an in-page overlay, not the publisher), via four routes:
//   - news:    resolve the Google News redirect to the real article URL, fetch
//              it once, and extract the page's own description plus the
//              sentences that mention Fermi ("what was said about Fermi").
//   - filing:  SEC form types map to plain-English explanations; the filing
//              document is also summarized (cached per URL — once, ever) when a
//              backend is configured: the keyless Cloudflare Workers AI worker
//              (FILINGS_WORKER_URL, preferred) or the Anthropic SDK
//              (ANTHROPIC_API_KEY). Neither set -> static explanation only.
//   - social:  the post text IS the content; the vetting reasons ride along.
// Fetched results are cached (docs/data/summaries.json) so each article is
// fetched at most once, with a small per-run budget as a politeness cap.

import { decodeEntities } from "./sources.mjs";

const UA =
  "Mozilla/5.0 (compatible; AI-Newsletter-unfurler; +https://github.com/jack-wise/AI-Newsletter)";

// --- Google News redirect resolution -------------------------------------------
// Two-stage: (1) the legacy base64 trick — older article ids embed the real URL
// directly; (2) for current ids (the AU_yqL format, no embedded URL), Google's
// own internal batchexecute endpoint, the same call the embedded article page
// makes: GET the article page for a per-id signature + timestamp, then POST a
// garturlreq envelope and parse the garturlres URL out of the response.
// Reverse-engineered (the googlenewsdecoder approach) — treated as best-effort
// and fail-open; a change on Google's side degrades to the unresolved link.
export function decodeGoogleNewsUrl(gnUrl) {
  try {
    const m = /news\.google\.com\/rss\/articles\/([^?/]+)/.exec(gnUrl);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const raw = Buffer.from(b64, "base64").toString("latin1");
    const urls = raw.match(/https?:\/\/[\x20-\x7e]+/g) ?? [];
    const real = urls.find((u) => !/news\.google\.com/.test(u));
    if (!real) return null;
    // The blob often runs the URL straight into trailing binary; trim at the
    // first character that can't appear in a URL.
    const clean = real.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+.*$/s, "");
    return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(clean) ? clean : null;
  } catch {
    return null;
  }
}

const BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
// Google's endpoints reject bot-styled agents; a plain browser UA is what the
// real article page sends for this exact call.
const GOOGLE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export async function resolveGoogleNewsId(id) {
  const page = await fetch(
    `https://news.google.com/articles/${encodeURIComponent(id)}?hl=en-US&gl=US&ceid=US:en`,
    { headers: { "User-Agent": GOOGLE_UA }, signal: AbortSignal.timeout(15_000) },
  );
  if (!page.ok) return null;
  const html = await page.text();
  const sg = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
  const ts = /data-n-a-ts="([^"]+)"/.exec(html)?.[1];
  if (!sg || !ts) return null;

  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id, Number(ts), sg,
  ]);
  const res = await fetch(BATCH_URL, {
    method: "POST",
    headers: {
      "User-Agent": GOOGLE_UA,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const text = await res.text(); // ")]}'" anti-JSON prefix, then the envelope
  try {
    const data = JSON.parse(text.slice(text.indexOf("[")));
    const payload = data.find((r) => Array.isArray(r) && r[0] === "wrb.fr" && r[1] === "Fbv4je")?.[2];
    const arr = JSON.parse(payload);
    return arr?.[0] === "garturlres" && typeof arr[1] === "string" && /^https?:\/\//.test(arr[1])
      ? arr[1]
      : null;
  } catch {
    return null;
  }
}

// --- HTML extraction -------------------------------------------------------------

export function extractSummary(html) {
  for (const re of [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,})["']/i,
    /<meta[^>]+content=["']([^"']{20,})["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{20,})["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,})["']/i,
    /<meta[^>]+content=["']([^"']{20,})["'][^>]+name=["']description["']/i,
  ]) {
    const m = re.exec(html);
    if (m) return decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 480);
  }
  return null;
}

// Pull the first sentences inside <p> blocks that mention the priority company —
// the "what was said about Fermi" excerpt.
export function extractMentions(html, patterns) {
  const res = patterns.map((p) => new RegExp(p, "i"));
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const out = [];
  for (const m of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 60 || text.length > 700) continue;
    if (res.some((re) => re.test(text))) {
      out.push(text);
      if (out.length === 2) break;
    }
  }
  return out.length ? out.join(" ").slice(0, 700) : null;
}

// --- SEC form explanations ---------------------------------------------------------

const SEC_FORMS = [
  [/^DFAN14A/i, "Proxy-fight material from a non-management participant — solicitation filings made outside the company's own proxy (in a control contest, each side's letters and presentations land here)."],
  [/^DEFA14A/i, "Additional definitive proxy material from the company — its side of an ongoing solicitation (responses, letters to shareholders, talking points)."],
  [/^DEF ?14A/i, "The company's definitive proxy statement — the formal voting document sent to shareholders ahead of a meeting."],
  [/^PRE[RC]?14A/i, "Preliminary proxy material — a draft of solicitation or revocation documents filed for SEC review before the definitive version goes to shareholders."],
  [/^PRRN14A/i, "Revised preliminary proxy material from a non-management participant — a dissident group's updated draft solicitation."],
  [/^8-K/i, "A current report — the form companies use to disclose material events between quarters (deals, leadership changes, results, financings)."],
  [/^10-Q/i, "The quarterly report — unaudited financial statements and management discussion for the quarter."],
  [/^10-K/i, "The annual report — audited financials, risk factors, and the fullest picture of the business."],
  [/^4\b/, "An insider transaction report — an officer, director, or 10% holder bought, sold, or was granted company stock."],
  [/^144/, "A notice of proposed sale — an insider's declaration of intent to sell restricted shares (filed before the sale)."],
  [/^SC ?13D/i, "An activist ownership filing — a holder above 5% with intent to influence control."],
  [/^SC ?13G/i, "A passive ownership filing — a holder above 5% without control intent."],
  [/^(S-1|424B)/i, "Offering documents — registration or prospectus material for selling securities."],
];

export function filingSummary(title) {
  const form = /^SEC filing:\s*([^—]+?)\s*—/.exec(title)?.[1]?.trim() ?? "";
  for (const [re, text] of SEC_FORMS) {
    if (re.test(form)) return text;
  }
  return "An SEC filing — primary-source disclosure straight from EDGAR.";
}

// --- AI filing summaries (Claude) ---------------------------------------------------
// The static filingSummary() above explains what a form TYPE is; this reads the
// actual document and summarizes what THIS filing discloses. Gated entirely on
// ANTHROPIC_API_KEY: with no key (the default for the 30-min collect cron) this
// path never runs and the static explanation stands. The SDK is imported
// dynamically so a missing dependency degrades to the static path instead of
// crashing the keyless cron.

const FILINGS_MODEL = process.env.FILINGS_MODEL || "claude-opus-4-8";
// SEC's WAF rejects parenthesized / URL-bearing agents — use the "Name email"
// contact format (same as scripts/sources.mjs).
const SEC_UA = "AI Newsletter jack.wise@donoco.com";
// Cap the document text sent to the model — a 10-K can be >1M chars; ~80k chars
// (~20k tokens) captures the substantive front matter while bounding cost.
const FILING_TEXT_CAP = 80_000;

// Form types worth a content summary. Form 4/144 (insider-transaction tables)
// and similar are tabular boilerplate where the static explanation is enough.
const AI_WORTHY_FORM =
  /^(8-K|10-K|10-Q|DEF ?14A|DEFA14A|DFAN14A|PRE[RC]?14A|PRRN14A|S-1|424B|SC ?13[DG]|6-K|20-F|425)/i;

export function isAiWorthyFiling(title) {
  const form = /^SEC filing:\s*([^—]+?)\s*—/.exec(title)?.[1]?.trim() ?? "";
  return AI_WORTHY_FORM.test(form);
}

// Strip an SEC HTML filing down to readable text.
function filingToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FILING_TEXT_CAP);
}

let _anthropic; // lazily constructed, reused across a run
async function getAnthropic() {
  if (_anthropic !== undefined) return _anthropic;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _anthropic = new Anthropic({ maxRetries: 2 });
  } catch {
    _anthropic = null; // SDK not installed — degrade to static explanations
  }
  return _anthropic;
}

const FILING_SYSTEM =
  "You summarize SEC filings for an investor-facing news site. Read the filing " +
  "and output 2-3 plain-text sentences stating what THIS filing actually " +
  "discloses and why it matters: the specific events, figures, parties, and " +
  "actions. No preamble, no markdown, no 'This filing...'; lead with the " +
  "substance. If the document is purely procedural with no material disclosure, " +
  "say that in one sentence.";

// Returns a content summary string, or null on any failure (caller falls back to
// the static form explanation). Never throws.
export async function aiSummarizeFiling(url, title) {
  const client = await getAnthropic();
  if (!client) return null;
  let text;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    text = filingToText(await res.text());
  } catch {
    return null;
  }
  if (!text || text.length < 200) return null;
  try {
    const form = /^SEC filing:\s*([^—]+?)\s*—/.exec(title)?.[1]?.trim() ?? "filing";
    // Thinking omitted for cost/latency on the cron; the system prompt pins the
    // output to the summary only (Opus 4.8 can otherwise narrate its reasoning
    // when thinking is off). Streamed because filing text can be large.
    const stream = client.messages.stream({
      model: FILINGS_MODEL,
      max_tokens: 500,
      system: FILING_SYSTEM,
      messages: [
        { role: "user", content: `Form type: ${form}\n\nFiling document:\n${text}` },
      ],
    });
    const message = await stream.finalMessage();
    const out = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return out.length > 20 ? out.slice(0, 700) : null;
  } catch {
    return null;
  }
}

// Keyless backend: summarize via the Cloudflare Workers AI worker
// (filings-worker/). The collector just POSTs the filing URL — the Worker
// fetches EDGAR and runs inference on the Cloudflare account, so no Anthropic
// key (and no SDK / npm install) is needed here. Env is read at call time.
// Returns a summary string, or null on any failure. Never throws.
export async function aiSummarizeViaWorker(url, title) {
  const endpoint = process.env.FILINGS_WORKER_URL;
  if (!endpoint) return null;
  const form = /^SEC filing:\s*([^—]+?)\s*—/.exec(title)?.[1]?.trim() ?? "filing";
  const secret = process.env.FILINGS_WORKER_SECRET;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Filings-Secret": secret } : {}),
      },
      body: JSON.stringify({ url, form }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = String(data?.summary ?? "").replace(/\s+/g, " ").trim();
    return out.length > 20 ? out.slice(0, 700) : null;
  } catch {
    return null;
  }
}

// Pick the configured summarization backend: the keyless Workers AI worker
// first, then the Anthropic SDK path if a key is set instead.
async function summarizeFilingContents(url, title) {
  if (process.env.FILINGS_WORKER_URL) return aiSummarizeViaWorker(url, title);
  return aiSummarizeFiling(url, title);
}

// --- enrichment driver ----------------------------------------------------------------

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, 400_000);
}

// Mutates items in place: adds .summary (and .excerpt / resolved .url where
// available). cache maps url -> { summary, excerpt, resolvedUrl, at, failed }.
export async function enrichItems(
  items,
  cache,
  { patterns = [], maxFetches = 12, maxAiSummaries = 6 } = {},
) {
  let budget = maxFetches;
  // AI filing summaries are enabled when EITHER backend is configured: the
  // keyless Workers AI worker (FILINGS_WORKER_URL) or the Anthropic key.
  const aiEnabled = !!(process.env.FILINGS_WORKER_URL || process.env.ANTHROPIC_API_KEY);
  let aiBudget = aiEnabled ? maxAiSummaries : 0;
  for (const item of items) {
    if (item.kind === "filing") {
      // Static "what this form type is" always available for the UI.
      item.formExplanation = filingSummary(item.title);
      const cached = cache[item.url];
      if (cached?.summary) {
        item.summary = cached.summary; // AI summary computed on a prior run
      } else if (aiBudget > 0 && isAiWorthyFiling(item.title)) {
        aiBudget--;
        const summary = await summarizeFilingContents(item.url, item.title);
        if (summary) {
          cache[item.url] = { at: new Date().toISOString(), summary, kind: "filing" };
          item.summary = summary;
        } else {
          item.summary = item.formExplanation; // fetch/model failed — fall back
        }
      } else {
        item.summary = item.formExplanation; // no key, budget spent, or tabular form
      }
      continue;
    }
    if (item.kind === "tweet" || item.kind === "social") {
      item.summary = item.title; // the post text is the full content
      continue;
    }
    if (item.summary) continue; // feed already carried one (e.g. Yahoo RSS)
    const cached = cache[item.url];
    if (cached) {
      if (cached.resolvedUrl) item.url = cached.resolvedUrl;
      if (cached.summary) item.summary = cached.summary;
      if (cached.excerpt) item.excerpt = cached.excerpt;
      continue;
    }
    if (budget <= 0) continue;
    budget--;
    const entry = { at: new Date().toISOString() };
    let real = decodeGoogleNewsUrl(item.url);
    if (!real && /news\.google\.com/.test(item.url)) {
      // Current ids don't embed the URL — resolve through Google's own
      // batchexecute endpoint (counts against the same per-run budget; the
      // result is cached so each article resolves at most once, ever).
      const id = /articles\/([^?/]+)/.exec(item.url)?.[1];
      try {
        real = id ? await resolveGoogleNewsId(id) : null;
      } catch {
        real = null;
      }
      if (!real) {
        cache[item.url] = { ...entry, failed: true };
        continue;
      }
    }
    try {
      const target = real ?? item.url;
      if (real) entry.resolvedUrl = real;
      const html = await fetchArticle(target);
      entry.summary = extractSummary(html);
      entry.excerpt = patterns.length ? extractMentions(html, patterns) : null;
    } catch {
      entry.failed = true; // cached so a blocked publisher isn't re-fetched every run
    }
    cache[item.url] = entry;
    if (entry.resolvedUrl) item.url = entry.resolvedUrl;
    if (entry.summary) item.summary = entry.summary;
    if (entry.excerpt) item.excerpt = entry.excerpt;
  }
  // Prune stale cache entries. Article enrichments track the feed's 7-day
  // horizon; filing AI summaries persist 30 days so a filing lingering in the
  // SEC feed (low-volume filers) isn't re-summarized (re-paid) every week.
  const now = Date.now();
  for (const [url, entry] of Object.entries(cache)) {
    const horizon = entry.kind === "filing" ? 30 : 7;
    if (!entry.at || Date.parse(entry.at) < now - horizon * 86_400_000) {
      delete cache[url];
    }
  }
}
