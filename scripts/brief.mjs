// Builds "The Brief" — a couple of plain-English paragraphs summarizing where
// Fermi stands right now (price, recent news, filings/insider activity), written
// to docs/data/brief.json each collector run and rendered in the site's Brief
// section. Deterministic and keyless: it synthesizes the already-collected
// `priority` (FRMI-tagged) items plus the optional price quote — no API tokens,
// so it refreshes every 30 minutes for free.
//
// buildBrief is a pure function (price + clock passed in) so it can be unit
// tested against a fixed dataset. All prose is grounded in the data it's given;
// it never asserts a figure it wasn't handed.

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

export function buildBrief({ priority = [], price = null, now = Date.now() } = {}) {
  const news = priority.filter((i) => i.kind === "news");
  const filings = priority.filter((i) => i.kind === "filing");
  const social = priority.filter((i) => i.kind === "tweet" || i.kind === "social");

  const byDateDesc = (a, b) =>
    String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));

  const freshNews = news.filter((i) => isFresh(i, now)).sort(byDateDesc);
  const freshSocial = social.filter((i) => isFresh(i, now));
  const recentFilings = [...filings].sort(byDateDesc);

  const form4 = filings.filter((i) => /^4\b/.test(formOf(i.title)));
  const form144 = filings.filter((i) => /^144/.test(formOf(i.title)));
  const proxy = filings.filter((i) =>
    /^(DFAN14A|DEFA14A|DEF ?14A|PRE[RC]?14A|PRRN14A)/i.test(formOf(i.title)),
  );

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
  if (freshNews.length) {
    const lead = freshNews[0];
    let p =
      `In the last 24 hours, this tracker surfaced ${plural(freshNews.length, "priority Fermi story", "priority Fermi stories")}. ` +
      `The most recent: “${cleanTitle(lead)}”${lead.source ? ` (${lead.source})` : ""}.`;
    if (freshNews[1]) {
      const second = freshNews[1];
      p += ` Also new: “${cleanTitle(second)}”${second.source ? ` (${second.source})` : ""}.`;
    }
    paragraphs.push(p);
  } else if (news.length) {
    const latest = [...news].sort(byDateDesc)[0];
    paragraphs.push(
      `No new priority Fermi news broke in the last 24 hours. The most recent item on file is ` +
        `“${cleanTitle(latest)}”${latest.source ? ` (${latest.source})` : ""}, from ${dayLabel(latest.publishedAt)}.`,
    );
  } else {
    paragraphs.push("No priority Fermi news is in the current window.");
  }

  // --- Paragraph 3: filings & insider activity ---------------------------------
  if (filings.length) {
    let p = `On the regulatory side, ${plural(filings.length, "Fermi SEC filing is", "Fermi SEC filings are")} in the current feed`;
    const latest = recentFilings[0];
    const latestForm = formOf(latest?.title);
    if (latestForm) p += `, most recently ${artFor(latestForm)} ${latestForm}${latest.publishedAt ? ` (${dayLabel(latest.publishedAt)})` : ""}`;
    p += ".";

    const insiderBits = [];
    if (form4.length) insiderBits.push(plural(form4.length, "Form 4 insider-transaction report", "Form 4 insider-transaction reports"));
    if (form144.length) insiderBits.push(plural(form144.length, "Form 144 proposed-sale notice", "Form 144 proposed-sale notices"));
    if (insiderBits.length) {
      p += ` Insider activity: ${insiderBits.join(" and ")} ${insiderBits.length === 1 && (form4.length === 1 || form144.length === 1) ? "appears" : "appear"} in the feed — open the Filings tab for the specifics.`;
    }
    if (proxy.length) {
      p += ` The founder-versus-board proxy contest remains visible in the record (${plural(proxy.length, "proxy-solicitation filing", "proxy-solicitation filings")}).`;
    }
    paragraphs.push(p);
  } else {
    paragraphs.push("No Fermi SEC filings are in the current feed.");
  }

  return {
    generatedAt: new Date(now).toISOString(),
    stock: price,
    pulse: {
      stories24h: freshNews.length,
      filings: filings.length,
      social24h: freshSocial.length,
      priorityTotal: priority.length,
    },
    paragraphs,
  };
}
