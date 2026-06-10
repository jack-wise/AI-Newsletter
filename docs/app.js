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
  if (e.key === "Escape") closeReader();
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
}

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
setInterval(load, 5 * 60 * 1000);
