// Renders data/news.json into the editorial layout: a serif lead story +
// stacked cards for FRMI, a card grid for the ecosystem, and a numbered
// sidebar brief for general AI news. Re-polls every 5 minutes so an open tab
// tracks the 30-minute collector. All text is set via textContent (no HTML
// injection from feed data).

const TIER_LABELS = { 0: "Primary", 1: "Wire", 2: "Analysis", 3: "Web" };

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

// Strip Google News' " - Publisher" suffix for display; the publisher is
// already shown in the meta row.
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
  try {
    host = new URL(item.url).hostname;
  } catch {
    return null;
  }
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
  if (item.kind === "filing") out.push(el("span", "tag tag-sec", "SEC filing"));
  if (item.credibility) {
    const c = el(
      "span",
      `tag tag-x-${item.credibility.trust}`,
      `X · ${item.credibility.trust} trust`,
    );
    c.title = (item.credibility.reasons ?? []).join(" · ");
    out.push(c);
  }
  return out;
}

function metaRow(item, { withIcon = true } = {}) {
  const meta = el("div", "meta");
  if (withIcon) {
    const icon = favicon(item);
    if (icon) meta.appendChild(icon);
  }
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

function storyLink(href) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function leadCard(item) {
  const a = storyLink(item.url);
  a.className = "lead";
  const eyebrow = el("div", "lead-eyebrow");
  eyebrow.appendChild(el("span", null, "Top story"));
  a.appendChild(eyebrow);
  a.appendChild(el("h3", "lead-title", displayTitle(item)));
  a.appendChild(metaRow(item));
  return a;
}

function storyCard(item) {
  const a = storyLink(item.url);
  a.className = "card";
  a.appendChild(el("h3", "card-title", displayTitle(item)));
  a.appendChild(metaRow(item));
  return a;
}

function briefRow(item) {
  const li = document.createElement("li");
  const a = storyLink(item.url);
  a.textContent = displayTitle(item);
  const meta = el("span", "brief-meta", `${item.source ?? ""} · ${timeAgo(item.publishedAt)}`);
  a.appendChild(meta);
  li.appendChild(a);
  return li;
}

function setSkeletons() {
  document.getElementById("priority-lead").replaceChildren(el("div", "skeleton skeleton-lead"));
  document
    .getElementById("priority-list")
    .replaceChildren(el("div", "skeleton"), el("div", "skeleton"));
  document
    .getElementById("related-list")
    .replaceChildren(el("div", "skeleton"), el("div", "skeleton"));
}

function render(data) {
  // Masthead + dateline
  document.getElementById("updated").textContent =
    `Updated ${timeAgo(data.generatedAt)} — refreshes every 30 min`;
  document.getElementById("edition-date").textContent = new Date(
    data.generatedAt,
  ).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  if (data.tagline) document.getElementById("tagline").textContent = data.tagline;
  document.getElementById("x-status").textContent = data.xStatus ?? "";
  document.getElementById("priority-label").textContent =
    (data.priorityTickers ?? []).join(" · ") || "Priority";

  // Priority: serif lead + stacked cards
  const priority = data.priority ?? [];
  document
    .getElementById("priority-lead")
    .replaceChildren(...(priority.length ? [leadCard(priority[0])] : []));
  document
    .getElementById("priority-list")
    .replaceChildren(...priority.slice(1, 12).map(storyCard));
  document.getElementById("priority-empty").hidden = priority.length > 0;

  // Ecosystem: two-column card grid
  const related = data.related ?? [];
  document
    .getElementById("related-list")
    .replaceChildren(...related.slice(0, 12).map(storyCard));
  document.getElementById("related-empty").hidden = related.length > 0;

  // Sidebar brief
  const general = data.general ?? [];
  document
    .getElementById("general-list")
    .replaceChildren(...general.slice(0, 14).map(briefRow));
  document.getElementById("general-empty").hidden = general.length > 0;
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
    document.getElementById("updated").textContent =
      `Couldn't load the latest edition (${e.message}) — retrying shortly.`;
    if (!loadedOnce) {
      document.getElementById("priority-lead").replaceChildren();
      document.getElementById("priority-list").replaceChildren();
      document.getElementById("related-list").replaceChildren();
    }
  }
}

load();
setInterval(load, 5 * 60 * 1000);
