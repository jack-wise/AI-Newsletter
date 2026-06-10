// Renders data/news.json and re-polls every 5 minutes so an open tab tracks the
// 30-minute collector without a manual refresh.

const TIER_LABELS = { 0: "primary", 1: "wire/major", 2: "analysis", 3: "other" };

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

function itemNode(item) {
  const li = document.createElement("li");
  li.className = `item kind-${item.kind} tier-${item.tier}`;

  const a = document.createElement("a");
  a.href = item.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = item.title;
  li.appendChild(a);

  const meta = document.createElement("div");
  meta.className = "item-meta";

  const bits = [item.source, timeAgo(item.publishedAt), TIER_LABELS[item.tier] ?? "other"];
  for (const t of item.tickers ?? []) {
    const b = document.createElement("span");
    b.className = "badge ticker-badge";
    b.textContent = t;
    meta.appendChild(b);
  }
  if (item.kind === "filing") {
    const b = document.createElement("span");
    b.className = "badge filing-badge";
    b.textContent = "SEC";
    meta.appendChild(b);
  }
  if (item.credibility) {
    const b = document.createElement("span");
    b.className = `badge cred-badge cred-${item.credibility.trust}`;
    b.textContent = `X · ${item.credibility.trust} trust ${item.credibility.score}`;
    b.title = (item.credibility.reasons ?? []).join(" · ");
    meta.appendChild(b);
  }
  const span = document.createElement("span");
  span.textContent = bits.filter(Boolean).join(" · ");
  meta.appendChild(span);

  li.appendChild(meta);
  return li;
}

function renderList(elId, emptyId, items) {
  const list = document.getElementById(elId);
  const empty = document.getElementById(emptyId);
  list.replaceChildren(...(items ?? []).map(itemNode));
  empty.hidden = (items ?? []).length > 0;
}

async function load() {
  try {
    const res = await fetch(`data/news.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById("site-title").textContent = data.siteTitle ?? "AI Newsletter";
    document.getElementById("tagline").textContent = data.tagline ?? "";
    document.getElementById("priority-label").textContent =
      (data.priorityTickers ?? []).join(" · ") || "Priority";
    document.getElementById("updated").textContent =
      `Updated ${timeAgo(data.generatedAt)} (${new Date(data.generatedAt).toLocaleString()})`;
    document.getElementById("x-status").textContent = data.xStatus ?? "";

    renderList("priority-list", "priority-empty", data.priority);
    renderList("general-list", "general-empty", data.general);
    document.title = `${data.siteTitle ?? "AI Newsletter"} — ${(data.priorityTickers ?? []).join(", ")}`;
  } catch (e) {
    document.getElementById("updated").textContent =
      `Could not load data/news.json (${e.message}) — first collector run may still be pending.`;
  }
}

load();
setInterval(load, 5 * 60 * 1000);
