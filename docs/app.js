// FERMI WATCH front end: fills the five tab panels from data/news.json, runs
// the tab switcher, count-up stats, and scroll reveals. Re-polls every 5
// minutes. All feed text is set via textContent (no HTML injection).

const TIER_LABELS = { 0: "Primary", 1: "Wire", 2: "Analysis", 3: "Web" };
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  a.href = item.url;
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

function briefRow(item) {
  const li = document.createElement("li");
  const a = storyLink(item);
  a.textContent = displayTitle(item);
  a.appendChild(el("span", "brief-meta", `${item.source ?? ""} · ${timeAgo(item.publishedAt)}`));
  li.appendChild(a);
  return li;
}

// ---- story reader overlay ------------------------------------------------------

function openReader(item) {
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

  document.getElementById("modal-source").href = item.url;
  document.getElementById("modal").hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("modal-close").focus();
}

function closeReader() {
  document.getElementById("modal").hidden = true;
  document.body.classList.remove("modal-open");
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

  // FRMI panel
  const priority = data.priority ?? [];
  document.getElementById("frmi-lead")
    .replaceChildren(...(priority.length ? [leadCard(priority[0])] : []));
  fill("frmi-list", "frmi-empty", priority.slice(1, 13).map(storyCard));
  document.getElementById("frmi-empty").hidden = priority.length > 0;

  // Ecosystem panel
  fill("eco-list", "eco-empty", (data.related ?? []).slice(0, 12).map(storyCard));

  // Filings panel (chronological)
  const filings = all
    .filter((i) => i.kind === "filing")
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  fill("filings-list", "filings-empty", filings.slice(0, 20).map(filingRow));

  // Social panel
  const social = all.filter((i) => i.kind === "tweet" || i.kind === "social");
  fill("social-list", "social-empty", social.slice(0, 12).map(storyCard));

  // AI brief panel
  fill("brief-list", "brief-empty", (data.general ?? []).slice(0, 16).map(briefRow));

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

function reportCard(meta, body) {
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
  content.appendChild(renderMarkdown(body.markdown ?? ""));
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
    const cards = [];
    for (const meta of index) {
      try {
        const r = await fetch(`data/reports/${meta.key}.json?ts=${Date.now()}`, { cache: "no-store" });
        if (r.ok) cards.push(reportCard(meta, await r.json()));
      } catch { /* skip a single broken report */ }
    }
    list.replaceChildren(...cards);
    empty.hidden = cards.length > 0;
  } catch {
    list.replaceChildren();
    empty.hidden = false;
  }
}

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

// ---- queequeg chat -------------------------------------------------------------

// Cloudflare Worker endpoint that proxies to the queequeg persona.
// After deploying worker/, paste the printed URL here (…workers.dev).
const QUEEQUEG_ENDPOINT = "https://transition-spread-need-smoke.trycloudflare.com";

const chatHistory = []; // {role:"user"|"assistant", content:string}

function chatBubble(role, node) {
  const wrap = el("div", `chat-msg chat-msg-${role === "user" ? "user" : "bot"}`);
  const bubble = el("div", "chat-bubble");
  bubble.appendChild(node);
  wrap.appendChild(bubble);
  return wrap;
}

function initChat() {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const log = document.getElementById("chat-log");
  const sendBtn = document.getElementById("chat-send");
  if (!form || !input || !log) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    // Render the user's message.
    log.appendChild(chatBubble("user", el("p", null, text)));
    chatHistory.push({ role: "user", content: text });
    input.value = "";
    log.scrollTop = log.scrollHeight;

    // Typing indicator.
    const thinking = chatBubble("bot", el("p", "chat-typing", "queequeg is researching…"));
    log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    input.disabled = true;
    sendBtn.disabled = true;

    if (QUEEQUEG_ENDPOINT.includes("REPLACE-ME")) {
      thinking.remove();
      const warn = el("p", null,
        "Chat backend not configured yet. Deploy worker/ and set QUEEQUEG_ENDPOINT in app.js.");
      log.appendChild(chatBubble("bot", warn));
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      return;
    }

    try {
      const res = await fetch(QUEEQUEG_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatHistory }),
      });
      const data = await res.json();
      thinking.remove();
      if (!res.ok || data.error) {
        const msg = el("p", null, `Error: ${data.error || res.status}`);
        log.appendChild(chatBubble("bot", msg));
      } else {
        const reply = data.reply || "(no response)";
        chatHistory.push({ role: "assistant", content: reply });
        log.appendChild(chatBubble("bot", renderMarkdown(reply)));
      }
    } catch (err) {
      thinking.remove();
      log.appendChild(chatBubble("bot", el("p", null, `Network error: ${err.message}`)));
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      log.scrollTop = log.scrollHeight;
    }
  });
}
initChat();

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
loadReports();
setInterval(load, 5 * 60 * 1000);
setInterval(loadReports, 30 * 60 * 1000);
