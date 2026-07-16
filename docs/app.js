// FERMI WATCH front end: fills the coverage tab panels from data/news.json, runs
// the tab switcher, count-up stats, and scroll reveals. Re-polls every 5
// minutes. All feed text is set via textContent (no HTML injection).
//
// Live tabs (FRMI / Ecosystem / Social) only show stories from the last 24h
// (see isFresh); older stories live in the History archive. The Filings tab is
// exempt and keeps the full SEC record. Ecosystem merges the old Ecosystem and
// AI-brief feeds into one.

const TIER_LABELS = { 0: "Primary", 1: "Wire", 2: "Analysis", 3: "Web" };
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Embed mode (?embed=1): the Donoco Journal iframes this site, so hide the
// marketing chrome (topbar, hero, photo strip, site plan, mission band) and
// lead with the ticker + coverage tabs. The class gates the CSS rules.
if (new URLSearchParams(location.search).get("embed") === "1") {
  document.documentElement.classList.add("embed");
}

function timeAgo(iso) {
  if (!iso) return "undated";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "undated";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Live-feed freshness window. A story shows in the live tabs (FRMI, Ecosystem,
// Social) only for its first 24h; after that it rotates out of every tab and
// lives on in the History archive. SEC filings are EXEMPT — the Filings tab is
// a chronological record kept regardless of age (filtered separately). Undated
// items can't be proven fresh, so they're treated as stale (still archived).
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
function isFresh(item) {
  const t = Date.parse(item.publishedAt);
  return Number.isFinite(t) && Date.now() - t < FRESH_WINDOW_MS;
}

function displayTitle(item) {
  const m = /^(.*\S)\s+-\s+[^-]{2,60}$/.exec(item.title);
  return item.kind === "news" && m ? m[1] : item.title;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Feed-supplied URLs are placed into href attributes; a `javascript:` (or other
// non-web) URL that survived ingestion would execute on click / open-in-new-tab.
// Collapse anything that isn't an absolute http(s) URL to "#" so an href is never
// a script sink.
function safeUrl(url) {
  if (typeof url !== "string") return "#";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "#";
  } catch {
    return "#";
  }
}

function favicon(item) {
  let host = null;
  try { host = new URL(item.url).hostname; } catch { return null; }
  const img = el("img", "favicon");
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.remove());
  return img;
}

function tags(item) {
  const out = [];
  for (const t of item.tickers ?? []) out.push(el("span", "tag tag-ticker", t));
  for (const t of item.related ?? []) out.push(el("span", "tag tag-eco", t));
  if (item.kind === "filing") out.push(el("span", "tag tag-sec", "SEC"));
  if (item.credibility) {
    const c = el("span", `tag tag-x-${item.credibility.trust}`, `${item.credibility.trust} trust`);
    c.title = (item.credibility.reasons ?? []).join(" · ");
    out.push(c);
  }
  return out;
}

function metaRow(item) {
  const meta = el("div", "meta");
  const icon = favicon(item);
  if (icon) meta.appendChild(icon);
  meta.appendChild(el("span", "src", item.source ?? "Unknown source"));
  meta.appendChild(el("span", "dot"));
  const when = el("span", null, timeAgo(item.publishedAt));
  if (item.publishedAt) when.title = new Date(item.publishedAt).toLocaleString();
  meta.appendChild(when);
  meta.appendChild(el("span", "dot"));
  meta.appendChild(el("span", null, TIER_LABELS[item.tier] ?? "Web"));
  for (const t of tags(item)) meta.appendChild(t);
  return meta;
}

// Story clicks stay ON-SITE: every card opens the reader overlay instead of
// navigating away. The href is kept so middle-click / open-in-new-tab still
// reaches the original source for readers who want it.
function storyLink(item, className) {
  const a = document.createElement("a");
  a.href = safeUrl(item.url);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  if (className) a.className = className;
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    openReader(item);
  });
  return a;
}

function leadCard(item) {
  const a = storyLink(item, "lead");
  a.appendChild(el("div", "lead-eyebrow", "TOP STORY — FRMI"));
  a.appendChild(el("h3", "lead-title", displayTitle(item)));
  a.appendChild(metaRow(item));
  return a;
}

function storyCard(item) {
  const a = storyLink(item, "card");
  a.appendChild(el("h3", "card-title", displayTitle(item)));
  a.appendChild(metaRow(item));
  return a;
}

function filingRow(item) {
  const a = storyLink(item, "row");
  // "SEC filing: DFAN14A — Fermi Inc. (desc)" -> form + remainder
  const m = /^SEC filing:\s*([^—]+)—\s*(.*)$/.exec(item.title);
  a.appendChild(el("span", "row-form", (m?.[1] ?? "FILING").trim()));
  a.appendChild(el("span", "row-title", (m?.[2] ?? item.title).trim()));
  a.appendChild(el("span", "row-date", item.publishedAt ? item.publishedAt.slice(0, 10) : ""));
  return a;
}

// ---- story reader overlay ------------------------------------------------------

// The element focused before the modal opened, so focus can return to it on close
// (a11y: keyboard / screen-reader users land back on the card they came from).
let readerLastFocused = null;

// Keep Tab focus inside the open dialog (role="dialog" aria-modal="true"). Without
// this, Tab walks out of the modal to the page behind it.
function trapModalFocus(e) {
  if (e.key !== "Tab") return;
  const modal = document.getElementById("modal");
  const focusables = modal.querySelectorAll(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function openReader(item) {
  readerLastFocused = document.activeElement;
  const eyebrow = [item.source, timeAgo(item.publishedAt), TIER_LABELS[item.tier] ?? "Web"]
    .filter(Boolean)
    .join(" · ");
  document.getElementById("modal-eyebrow").textContent = eyebrow;
  document.getElementById("modal-title").textContent = displayTitle(item);
  document.getElementById("modal-tags").replaceChildren(...tags(item));

  const summaryEl = document.getElementById("modal-summary");
  if (item.summary) {
    summaryEl.textContent = item.summary;
  } else {
    summaryEl.textContent =
      `${item.source ?? "This source"} hasn't been summarized yet — the collector ` +
      "captures descriptions on its next pass when the publisher allows it. " +
      "The original is one click below.";
  }

  const excerptBlock = document.getElementById("modal-excerpt-block");
  const hasExcerpt = item.excerpt && item.excerpt !== item.summary;
  excerptBlock.hidden = !hasExcerpt;
  if (hasExcerpt) document.getElementById("modal-excerpt").textContent = `“${item.excerpt}”`;

  document.getElementById("modal-source").href = safeUrl(item.url);
  const modal = document.getElementById("modal");
  modal.hidden = false;
  document.body.classList.add("modal-open");
  modal.addEventListener("keydown", trapModalFocus);
  document.getElementById("modal-close").focus();
}

function closeReader() {
  const modal = document.getElementById("modal");
  modal.removeEventListener("keydown", trapModalFocus);
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  // Return focus to the element that opened the reader (a11y).
  if (readerLastFocused && typeof readerLastFocused.focus === "function") {
    readerLastFocused.focus();
  }
  readerLastFocused = null;
}

for (const id of ["modal-close", "modal-done", "modal-backdrop"]) {
  document.getElementById(id)?.addEventListener("click", closeReader);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeReader();
    closeLightbox();
  }
});

function fill(listId, emptyId, nodes) {
  document.getElementById(listId).replaceChildren(...nodes);
  document.getElementById(emptyId).hidden = nodes.length > 0;
}

// ---- count-up stats ----------------------------------------------------------

function countUp(node, target) {
  if (REDUCED || target <= 0) { node.textContent = String(target); return; }
  const dur = 900;
  const t0 = performance.now();
  function tick(t) {
    const p = Math.min(1, (t - t0) / dur);
    node.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---- render -------------------------------------------------------------------

function render(data) {
  const all = [...(data.priority ?? []), ...(data.related ?? []), ...(data.general ?? [])];

  document.getElementById("updated").textContent =
    `LIVE · UPDATED ${timeAgo(data.generatedAt).toUpperCase()}`;
  document.getElementById("edition-date").textContent = new Date(data.generatedAt)
    .toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  document.getElementById("x-status").textContent = data.xStatus ?? "";

  // FRMI panel — fresh priority stories only (<24h). Older items, INCLUDING
  // filings, rotate out of priority into the History archive; old filings still
  // live in the Filings tab below.
  const priority = (data.priority ?? []).filter(isFresh);
  document.getElementById("frmi-lead")
    .replaceChildren(...(priority.length ? [leadCard(priority[0])] : []));
  fill("frmi-list", "frmi-empty", priority.slice(1, 13).map(storyCard));
  document.getElementById("frmi-empty").hidden = priority.length > 0;

  // Ecosystem panel = the merged Ecosystem + AI-field feed: fresh stories only,
  // newest first, de-duped across the two source buckets.
  const ecoSeen = new Set();
  const ecosystem = [...(data.related ?? []), ...(data.general ?? [])]
    .filter(isFresh)
    .filter((i) => {
      if (ecoSeen.has(i.url)) return false;
      ecoSeen.add(i.url);
      return true;
    })
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  fill("eco-list", "eco-empty", ecosystem.slice(0, 24).map(storyCard));

  // Filings panel (chronological) — EXEMPT from the 24h window: the full SEC
  // record stays here regardless of age.
  const filings = all
    .filter((i) => i.kind === "filing")
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  fill("filings-list", "filings-empty", filings.slice(0, 20).map(filingRow));

  // Social panel — fresh only.
  const social = all.filter(
    (i) => (i.kind === "tweet" || i.kind === "social") && isFresh(i),
  );
  fill("social-list", "social-empty", social.slice(0, 12).map(storyCard));

  // Stat band
  countUp(document.getElementById("stat-stories"), all.length);
  countUp(document.getElementById("stat-filings"), filings.length);
  countUp(document.getElementById("stat-sources"), new Set(all.map((i) => i.source)).size);

  // Headline ticker: top priority stories on a seamless marquee (content is
  // rendered twice; the keyframe translates -50% so the loop never jumps).
  const tickerItems = priority.slice(0, 8);
  const track = document.getElementById("ticker-track");
  const half = () =>
    tickerItems.flatMap((item) => {
      const a = storyLink(item, "tk-item");
      a.textContent = displayTitle(item);
      return [a, el("span", "tk-sep", "◆")];
    });
  track.replaceChildren(...half(), ...half());
}

// ---- research reports ----------------------------------------------------------

// Minimal injection-safe markdown renderer: builds DOM nodes (never innerHTML
// with feed text). Supports headings, paragraphs, bold/code/links inline,
// bullet/numbered lists, tables, blockquotes, and rules — enough for the
// generated research notes.
function mdInline(text) {
  const out = [];
  // links, bold, inline code
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const a = document.createElement("a");
      a.href = m[2];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = m[1];
      out.push(a);
    } else if (m[3]) {
      out.push(el("strong", null, m[3]));
    } else {
      out.push(el("code", null, m[4]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderMarkdown(md) {
  const container = el("div", "md-body");
  const lines = md.split(/\r?\n/);
  let i = 0;
  const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const node = el(`h${Math.min(h[1].length + 1, 5)}`, "md-h");
      node.append(...mdInline(h[2]));
      container.appendChild(node);
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { container.appendChild(el("hr")); i++; continue; }
    if (isTableRow(line)) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(lines[i]); i++; }
      const table = el("table", "md-table");
      rows
        .filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)) // drop separator row
        .forEach((r, idx) => {
          const tr = el("tr");
          r.trim().replace(/^\||\|$/g, "").split("|").forEach((cell) => {
            const td = el(idx === 0 ? "th" : "td");
            td.append(...mdInline(cell.trim()));
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
      container.appendChild(table);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const list = el(ordered ? "ol" : "ul", "md-list");
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        const li = el("li");
        li.append(...mdInline(lines[i].replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+\.\s+/, "")));
        list.appendChild(li);
        i++;
      }
      container.appendChild(list);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = el("blockquote", "md-quote");
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        const p = el("p");
        p.append(...mdInline(lines[i].replace(/^\s*>\s?/, "")));
        quote.appendChild(p);
        i++;
      }
      container.appendChild(quote);
      continue;
    }
    // paragraph: gather until blank line / block start
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) && !isTableRow(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])
    ) { para.push(lines[i].trim()); i++; }
    const p = el("p", "md-p");
    p.append(...mdInline(para.join(" ")));
    container.appendChild(p);
  }
  return container;
}

// Edition picker: each report keeps up to 30 archived editions under
// data/reports/archive/<key>/<date>.json (indexed in archive/index.json), so
// readers can pull up yesterday's note or compare workups over time.
function editionPicker(meta, body, editions, mdHost) {
  const bar = el("div", "edition-bar");
  bar.appendChild(el("label", "picker-label", "EDITION"));
  const select = document.createElement("select");
  select.className = "picker-select";
  select.setAttribute("aria-label", `${meta.title} edition`);
  editions.forEach((date, i) => {
    const opt = document.createElement("option");
    opt.value = date;
    opt.textContent = i === 0 ? `${date} — latest` : date;
    select.appendChild(opt);
  });
  bar.querySelector("label").htmlFor = select.id = `edition-${meta.key}`;
  const cache = new Map([[String(body.generatedAt ?? "").slice(0, 10), body]]);
  select.addEventListener("change", async () => {
    const date = select.value;
    let edition = cache.get(date);
    if (!edition) {
      try {
        const r = await fetch(`data/reports/archive/${meta.key}/${date}.json?ts=${Date.now()}`, { cache: "no-store" });
        if (r.ok) {
          edition = await r.json();
          cache.set(date, edition);
        }
      } catch { /* fall through to the error note */ }
    }
    mdHost.replaceChildren(
      edition
        ? renderMarkdown(edition.markdown ?? "")
        : el("p", "empty", `Couldn't load the ${date} edition.`),
    );
  });
  bar.appendChild(select);
  return bar;
}

function reportCard(meta, body, editions = []) {
  const card = el("article", "report");
  const head = el("button", "report-head");
  head.setAttribute("aria-expanded", "false");
  head.appendChild(el("span", "report-title", meta.title));
  const metaText = meta.agent
    ? `${timeAgo(meta.generatedAt)} · ${meta.model ?? ""} · ${meta.agent}`
    : `${timeAgo(meta.generatedAt)} · ${meta.model ?? ""}`;
  head.appendChild(el("span", "report-meta", metaText));
  head.appendChild(el("span", "report-toggle", "+"));
  const content = el("div", "report-body");
  content.hidden = true;
  const mdHost = el("div");
  mdHost.appendChild(renderMarkdown(body.markdown ?? ""));
  if (editions.length > 1) content.appendChild(editionPicker(meta, body, editions, mdHost));
  content.appendChild(mdHost);
  head.addEventListener("click", () => {
    content.hidden = !content.hidden;
    head.setAttribute("aria-expanded", String(!content.hidden));
    head.querySelector(".report-toggle").textContent = content.hidden ? "+" : "−";
  });
  card.appendChild(head);
  card.appendChild(content);
  return card;
}

async function loadReports() {
  const list = document.getElementById("reports-list");
  const empty = document.getElementById("reports-empty");
  try {
    const res = await fetch(`data/reports/index.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("no reports yet");
    const index = await res.json();
    let editions = {};
    try {
      const a = await fetch(`data/reports/archive/index.json?ts=${Date.now()}`, { cache: "no-store" });
      if (a.ok) editions = await a.json();
    } catch { /* no archive yet — cards render without a picker */ }
    const cards = [];
    for (const meta of index) {
      try {
        const r = await fetch(`data/reports/${meta.key}.json?ts=${Date.now()}`, { cache: "no-store" });
        if (r.ok) cards.push(reportCard(meta, await r.json(), editions[meta.key] ?? []));
      } catch { /* skip a single broken report */ }
    }
    list.replaceChildren(...cards);
    empty.hidden = cards.length > 0;
  } catch {
    list.replaceChildren();
    empty.hidden = false;
  }
}

// ---- the brief (daily at-a-glance read) ----------------------------------------

// Renders data/brief.json into the Brief section: a price line, pulse chips, and
// the synthesized paragraphs. All text is set via textContent (no HTML injection).
// Polled on the same 5-minute cadence as the feed; fails quietly (the section
// keeps its last content, and the live TradingView chart above is unaffected).
function renderBrief(brief) {
  const upd = document.getElementById("brief-updated");
  if (upd) {
    const when = brief.generatedAt ? `Updated ${timeAgo(brief.generatedAt)}.` : "";
    // Flag AI-written editions so readers know the prose is model-generated.
    const ai = brief.generator === "ai" ? " AI-written summary — verify before acting." : "";
    upd.textContent = `${when}${ai}`;
  }

  // Price line
  const quote = document.getElementById("brief-quote");
  const s = brief.stock;
  if (s && Number.isFinite(s.price)) {
    document.getElementById("brief-price").textContent = `$${s.price.toFixed(2)}`;
    const changeEl = document.getElementById("brief-change");
    if (s.changePct != null) {
      const up = s.changePct >= 0;
      changeEl.textContent = `${up ? "▲" : "▼"} ${up ? "+" : "−"}${Math.abs(s.changePct).toFixed(2)}%`;
      changeEl.className = `dq-change ${up ? "is-up" : "is-down"}`;
    } else {
      changeEl.textContent = "";
    }
    document.getElementById("brief-asof").textContent = s.asOf ? `EOD ${s.asOf}` : "";
    quote.hidden = false;
  } else {
    quote.hidden = true;
  }

  // Pulse chips
  const pulse = brief.pulse ?? {};
  const chips = [
    ["News · 24h", pulse.stories24h],
    ["Filings", pulse.filings],
    ["Social · 24h", pulse.social24h],
    ["Tracked now", pulse.priorityTotal],
  ].filter(([, v]) => Number.isFinite(v));
  document.getElementById("brief-pulse").replaceChildren(
    ...chips.map(([label, value]) => {
      const chip = el("span", "pulse-chip");
      chip.appendChild(el("span", "pulse-num", String(value)));
      chip.appendChild(el("span", "pulse-label", label));
      return chip;
    }),
  );

  // Paragraphs
  const body = document.getElementById("brief-body");
  const paras = (brief.paragraphs ?? []).map((t) => el("p", "daybrief-p", t));
  body.replaceChildren(...(paras.length ? paras : [el("p", "daybrief-loading", "No brief available yet.")]));
}

async function loadBrief() {
  try {
    const res = await fetch(`data/brief.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderBrief(await res.json());
  } catch {
    /* keep whatever is already shown; the collector writes it next cycle */
  }
}

// ---- news history (permanent per-day archive) ------------------------------------

// The collector merges every cycle's stories into data/archive/<day>.json and
// indexes the days in data/archive/index.json. The History tab navigates that
// record — stories stay reachable after they rotate out of the live feed. The
// tab shows FERMI stories only (priority-ticker matches: articles, filings,
// tweets); the day files still store everything, so nothing is ever lost.
let historyIndex = null;
const historyDayCache = new Map();

function historyRow(item) {
  const li = document.createElement("li");
  const a = storyLink(item);
  a.textContent = displayTitle(item);
  const when = item.publishedAt
    ? new Date(item.publishedAt).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : "undated";
  a.appendChild(el("span", "brief-meta", `${item.source ?? ""} · ${when}`));
  li.appendChild(a);
  return li;
}

async function renderHistoryDay(day) {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  let data = historyDayCache.get(day);
  if (!data) {
    try {
      const r = await fetch(`data/archive/${day}.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error();
      data = await r.json();
      historyDayCache.set(day, data);
    } catch {
      list.replaceChildren();
      empty.textContent = `Couldn't load the archive for ${day}.`;
      empty.hidden = false;
      return;
    }
  }
  const items = (data.items ?? [])
    .filter((i) => i.tickers?.length) // Fermi stories only
    .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));
  list.replaceChildren(...items.map(historyRow));
  empty.hidden = items.length > 0;
}

async function loadHistory() {
  if (historyIndex) return; // already populated this visit
  const select = document.getElementById("history-day");
  const empty = document.getElementById("history-empty");
  try {
    const res = await fetch(`data/archive/index.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error();
    historyIndex = await res.json();
  } catch {
    historyIndex = null; // retried on the next tab visit
    empty.hidden = false;
    return;
  }
  select.replaceChildren(
    ...historyIndex.map((e) => {
      const opt = document.createElement("option");
      opt.value = e.day;
      opt.textContent = `${e.day} — ${e.count} ${e.count === 1 ? "story" : "stories"}`;
      return opt;
    }),
  );
  if (historyIndex.length) renderHistoryDay(historyIndex[0].day);
  else empty.hidden = false;
}

document.getElementById("history-day")?.addEventListener("change", (e) =>
  renderHistoryDay(e.target.value),
);

// ---- image lightbox (site plan) -------------------------------------------------

function openLightbox(src, caption) {
  document.getElementById("lightbox-img").src = src;
  document.getElementById("lightbox-caption").textContent = caption ?? "";
  document.getElementById("lightbox").hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("lightbox-close").focus();
}

function closeLightbox() {
  document.getElementById("lightbox").hidden = true;
  document.body.classList.remove("modal-open");
}

for (const id of ["lightbox-close", "lightbox-backdrop"]) {
  document.getElementById(id)?.addEventListener("click", closeLightbox);
}
document.querySelector(".map-frame")?.addEventListener("click", (e) => {
  e.preventDefault();
  openLightbox(
    "assets/fermi-campus-map.jpg",
    "Fermi America — Advanced Energy and AI Campus site plan (~7,570 acres)",
  );
});

// ---- tabs ----------------------------------------------------------------------

function activateTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
  if (name === "history") loadHistory(); // lazy: the archive only loads when viewed
  if (name === "reports") loadReports(); // refresh on view: a publish between the
  // 30-min polls shows as soon as the reader opens the tab, not only on reload.
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
}
// Nav links + hero CTAs carry data-nav: jump to coverage AND switch the tab.
for (const link of document.querySelectorAll("[data-nav]")) {
  link.addEventListener("click", () => activateTab(link.dataset.nav));
}

// ---- scroll reveals -------------------------------------------------------------

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        observer.unobserve(e.target);
      }
    }
  },
  { threshold: 0.12 },
);
for (const node of document.querySelectorAll(".reveal")) {
  if (REDUCED) node.classList.add("in");
  else observer.observe(node);
}

// ---- load loop ------------------------------------------------------------------

function setSkeletons() {
  document.getElementById("frmi-lead").replaceChildren(el("div", "skeleton skeleton-lead"));
  document.getElementById("frmi-list").replaceChildren(el("div", "skeleton"), el("div", "skeleton"));
  document.getElementById("eco-list").replaceChildren(el("div", "skeleton"), el("div", "skeleton"));
}

let loadedOnce = false;

async function load() {
  if (!loadedOnce) setSkeletons();
  try {
    const res = await fetch(`data/news.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    loadedOnce = true;
  } catch (e) {
    document.getElementById("updated").textContent = `OFFLINE · RETRYING (${e.message})`;
    if (!loadedOnce) {
      for (const id of ["frmi-lead", "frmi-list", "eco-list"]) {
        document.getElementById(id).replaceChildren();
      }
    }
  }
}

load();
loadBrief();
loadReports();
setInterval(load, 5 * 60 * 1000);
setInterval(loadBrief, 5 * 60 * 1000);
setInterval(loadReports, 30 * 60 * 1000);
