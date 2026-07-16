// Builds "The Brief" — a couple of plain-English paragraphs summarizing where
// Fermi stands right now (price, recent news, filings/insider activity), written
// to docs/data/brief.json each collector run and rendered in the site's Brief
// section.
//
// Two producers, chosen at runtime (mirrors enrich.mjs's fail-open pattern):
//   - generateBrief(): when ANTHROPIC_API_KEY is set, an AI narrative written by
//     Claude Haiku from the collected facts. Falls back to the template on any
//     failure, so a missing key / SDK / API error never breaks the collector.
//   - buildBrief(): a deterministic, keyless synthesis of the same facts. Pure
//     (price + clock passed in) so it can be unit tested; also the fallback.
// Every claim is grounded in the data it's handed; neither producer asserts a
// figure it wasn't given.

const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000; // mirrors the site's live-feed window

const isFresh = (item, now) => {
  const t = Date.parse(item.publishedAt);
  return Number.isFinite(t) && now - t < FRESH_WINDOW_MS;
};

// "SEC filing: DFAN14A — Fermi Inc. (…)" -> "DFAN14A"
const formOf = (title) =>
  /^SEC filing:\s*([^—]+?)\s*—/.exec(title ?? "")?.[1]?.trim() ?? "";

// Strip a Google-News " - Publisher" suffix for cleaner in-brief quoting.
const cleanTitle = (item) => {
  const m = /^(.*\S)\s+-\s+[^-]{2,60}$/.exec(item.title ?? "");
  return (item.kind === "news" && m ? m[1] : item.title ?? "").trim();
};

const dayLabel = (iso) => (iso ? String(iso).slice(0, 10) : "an earlier date");

// "a"/"an" for a form code by its spoken first sound: letters pronounced with a
// leading vowel (A, E, F, H, I, L, M, N, O, R, S, X → "ay/ee/eff/… /ess/ex") and
// numbers said with one (8 "eight", 11 "eleven", 18 "eighteen") take "an".
const artFor = (s) => {
  const t = (s ?? "").trim();
  if (/^(8|11|18)/.test(t)) return "an";
  return /^[aefhilmnorsx]/i.test(t) ? "an" : "a";
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Shared categorization of the priority (FRMI) set, used by both producers.
function analyze(priority, now) {
  const byDateDesc = (a, b) =>
    String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));
  const news = priority.filter((i) => i.kind === "news");
  const filings = priority.filter((i) => i.kind === "filing");
  const social = priority.filter((i) => i.kind === "tweet" || i.kind === "social");
  return {
    news,
    filings,
    social,
    freshNews: news.filter((i) => isFresh(i, now)).sort(byDateDesc),
    freshSocial: social.filter((i) => isFresh(i, now)),
    recentFilings: [...filings].sort(byDateDesc),
    form4: filings.filter((i) => /^4\b/.test(formOf(i.title))),
    form144: filings.filter((i) => /^144/.test(formOf(i.title))),
    proxy: filings.filter((i) =>
      /^(DFAN14A|DEFA14A|DEF ?14A|PRE[RC]?14A|PRRN14A)/i.test(formOf(i.title)),
    ),
  };
}

function pulseFor(a, priorityTotal) {
  return {
    stories24h: a.freshNews.length,
    filings: a.filings.length,
    social24h: a.freshSocial.length,
    priorityTotal,
  };
}

export function buildBrief({ priority = [], price = null, now = Date.now() } = {}) {
  const a = analyze(priority, now);
  const paragraphs = [];

  // --- Paragraph 1: market -----------------------------------------------------
  if (price && Number.isFinite(price.price)) {
    let p = `Fermi Inc. (NASDAQ: FRMI) last traded around $${price.price.toFixed(2)}`;
    if (price.changePct != null) {
      const dir = price.changePct >= 0 ? "up" : "down";
      p += `, ${dir} ${Math.abs(price.changePct).toFixed(1)}% from the prior close`;
    }
    if (price.asOf) p += ` (as of ${price.asOf}, end-of-day data)`;
    p += ".";
    if (price.windowChangePct != null && price.windowDays >= 5) {
      const dir = price.windowChangePct >= 0 ? "up" : "down";
      p += ` Over the last ${price.windowDays} sessions it is ${dir} ${Math.abs(price.windowChangePct).toFixed(1)}%.`;
    }
    p += " Live price and charts are in the panel above.";
    paragraphs.push(p);
  } else {
    paragraphs.push(
      "The live FRMI price and interactive charts are in the panel above; " +
        "end-of-day quote data was unavailable for this brief.",
    );
  }

  // --- Paragraph 2: recent news ------------------------------------------------
  if (a.freshNews.length) {
    const lead = a.freshNews[0];
    let p =
      `In the last 24 hours, this tracker surfaced ${plural(a.freshNews.length, "priority Fermi story", "priority Fermi stories")}. ` +
      `The most recent: “${cleanTitle(lead)}”${lead.source ? ` (${lead.source})` : ""}.`;
    if (a.freshNews[1]) {
      const second = a.freshNews[1];
      p += ` Also new: “${cleanTitle(second)}”${second.source ? ` (${second.source})` : ""}.`;
    }
    paragraphs.push(p);
  } else if (a.news.length) {
    const latest = [...a.news].sort((x, y) =>
      String(y.publishedAt ?? "").localeCompare(String(x.publishedAt ?? "")),
    )[0];
    paragraphs.push(
      `No new priority Fermi news broke in the last 24 hours. The most recent item on file is ` +
        `“${cleanTitle(latest)}”${latest.source ? ` (${latest.source})` : ""}, from ${dayLabel(latest.publishedAt)}.`,
    );
  } else {
    paragraphs.push("No priority Fermi news is in the current window.");
  }

  // --- Paragraph 3: filings & insider activity ---------------------------------
  if (a.filings.length) {
    let p = `On the regulatory side, ${plural(a.filings.length, "Fermi SEC filing is", "Fermi SEC filings are")} in the current feed`;
    const latest = a.recentFilings[0];
    const latestForm = formOf(latest?.title);
    if (latestForm) p += `, most recently ${artFor(latestForm)} ${latestForm}${latest.publishedAt ? ` (${dayLabel(latest.publishedAt)})` : ""}`;
    p += ".";

    const insiderBits = [];
    if (a.form4.length) insiderBits.push(plural(a.form4.length, "Form 4 insider-transaction report", "Form 4 insider-transaction reports"));
    if (a.form144.length) insiderBits.push(plural(a.form144.length, "Form 144 proposed-sale notice", "Form 144 proposed-sale notices"));
    if (insiderBits.length) {
      p += ` Insider activity: ${insiderBits.join(" and ")} in the feed — open the Filings tab for the specifics.`;
    }
    if (a.proxy.length) {
      p += ` The founder-versus-board proxy contest remains visible in the record (${plural(a.proxy.length, "proxy-solicitation filing", "proxy-solicitation filings")}).`;
    }
    paragraphs.push(p);
  } else {
    paragraphs.push("No Fermi SEC filings are in the current feed.");
  }

  return {
    generatedAt: new Date(now).toISOString(),
    generator: "template",
    stock: price,
    pulse: pulseFor(a, priority.length),
    paragraphs,
  };
}

// --- AI narrative (Claude Haiku) --------------------------------------------------
// Gated on ANTHROPIC_API_KEY. The SDK is imported dynamically so a missing
// dependency degrades to the deterministic template instead of crashing the
// keyless cron. Never throws.

const BRIEF_MODEL = process.env.BRIEF_MODEL || "claude-haiku-4-5";

const BRIEF_SYSTEM =
  "You write \"The Brief\" for a site that tracks Fermi Inc. (NASDAQ: FRMI), an " +
  "AI-datacenter power developer. You are given a JSON object of the CURRENT tracked " +
  "data: a price quote, recent news headlines with sources, SEC filings, insider " +
  "filings (Form 4/144), and vetted social posts. Write 2 to 3 short paragraphs " +
  "(120-220 words total) summarizing where the company stands right now: (1) the stock " +
  "and price action, (2) what is driving the recent news, (3) filings and insider " +
  "activity. Ground EVERY statement only in the provided data — never invent or infer a " +
  "number, headline, date, party, or event that is not present; if a figure is absent, " +
  "omit it. Neutral, factual, plain prose. Output plain text only: no markdown, no " +
  "headings, no bullet points, no preamble, no title, and no disclaimer. Separate " +
  "paragraphs with a single blank line.";

// Build the compact facts payload the model summarizes from. Kept small and
// pre-digested so the model doesn't have to parse raw feed objects.
function factsForPrompt({ priority, price, now }) {
  const a = analyze(priority, now);
  const clip = (s, n) => (s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) : null);
  const newsList = (a.freshNews.length ? a.freshNews : a.news.slice().sort((x, y) =>
    String(y.publishedAt ?? "").localeCompare(String(x.publishedAt ?? "")),
  )).slice(0, 6);
  return {
    asOf: new Date(now).toISOString().slice(0, 10),
    newNewsInLast24h: a.freshNews.length,
    price: price
      ? {
          last: price.price,
          changePctVsPriorClose: price.changePct,
          changePctOverWindow: price.windowChangePct,
          windowSessions: price.windowDays,
          asOfDate: price.asOf,
        }
      : null,
    recentNews: newsList.map((i) => ({
      headline: cleanTitle(i),
      source: i.source ?? null,
      date: i.publishedAt ? dayLabel(i.publishedAt) : null,
      summary: clip(i.summary, 240),
    })),
    filings: {
      totalInFeed: a.filings.length,
      form4Count: a.form4.length,
      form144Count: a.form144.length,
      proxySolicitationCount: a.proxy.length,
      recent: a.recentFilings.slice(0, 5).map((i) => ({
        form: formOf(i.title),
        date: i.publishedAt ? dayLabel(i.publishedAt) : null,
        summary: clip(i.summary ?? i.formExplanation, 240),
      })),
    },
    social: {
      new24h: a.freshSocial.length,
      samples: a.freshSocial.slice(0, 2).map((i) => clip(i.title, 200)),
    },
  };
}

let _anthropic; // lazily constructed, reused across a run
async function getAnthropic() {
  if (_anthropic !== undefined) return _anthropic;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _anthropic = new Anthropic({ maxRetries: 2 });
  } catch {
    _anthropic = null; // SDK not installed — degrade to the template
  }
  return _anthropic;
}

// Returns the brief object. Uses the AI narrative when a key + SDK are available
// and the model returns usable prose; otherwise the deterministic template.
export async function generateBrief({ priority = [], price = null, now = Date.now() } = {}) {
  const base = buildBrief({ priority, price, now });
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[brief] no ANTHROPIC_API_KEY — using deterministic template");
    return base;
  }
  const client = await getAnthropic();
  if (!client) {
    console.log("[brief] @anthropic-ai/sdk not available — using template");
    return base;
  }
  try {
    const facts = factsForPrompt({ priority, price, now });
    // Haiku 4.5 does not support the effort parameter or adaptive thinking; a
    // plain request is correct here. Streamed to match the repo's SDK idiom.
    const stream = client.messages.stream({
      model: BRIEF_MODEL,
      max_tokens: 700,
      system: BRIEF_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
    });
    const message = await stream.finalMessage();
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const paragraphs = text
      .split(/\n{2,}/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (paragraphs.length >= 2 && paragraphs.join(" ").length > 120) {
      console.log(`[brief] AI narrative via ${BRIEF_MODEL} (${paragraphs.length} paras)`);
      return { ...base, generator: "ai", model: BRIEF_MODEL, paragraphs };
    }
    console.log(`[brief] ${BRIEF_MODEL} returned unusable output — using template`);
  } catch (e) {
    console.warn(`[brief] AI generation failed (${e?.message ?? e}) — using template`);
  }
  return base;
}
