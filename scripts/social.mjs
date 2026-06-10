// Keyless social coverage — the no-X-API path.
//
// We never scrape x.com itself. Instead:
//   1. StockTwits' public symbol stream (free JSON) — finance chatter with real
//      author metadata (followers, join date, official badge), so the same
//      credibility-gate idea as the X module applies in full.
//   2. Reddit's public search JSON — discover posts discussing the ticker and
//      harvest any x.com/twitter.com status links people share.
//   3. X's official oEmbed endpoint (publish.twitter.com, keyless, built for
//      embedding) — hydrate discovered tweet links into text + author. oEmbed
//      exposes NO follower/location data, so these items are labeled
//      trust:"limited" with the Reddit-side signals that surfaced them; the
//      full X vetting gate only runs when the paid API token is configured.

const UA = "AI Newsletter jack.wise@donoco.com";

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// --- StockTwits ---------------------------------------------------------------

// Mirror of the X credibility model, mapped to StockTwits' author fields.
export function stocktwitsCredibility(user, likes, cfg) {
  const followers = user?.followers ?? 0;
  const joinDays = user?.join_date
    ? (Date.now() - Date.parse(user.join_date)) / 86_400_000
    : 0;
  let score = 0;
  const reasons = [];

  if (followers >= 10_000) score += 30;
  else if (followers >= 1_000) score += 20;
  else if (followers >= (cfg.minFollowers ?? 200)) score += 10;
  reasons.push(`${(followers).toLocaleString()} followers`);

  if (joinDays >= 5 * 365) score += 15;
  else if (joinDays >= 2 * 365) score += 10;
  else if (joinDays < (cfg.minAccountAgeDays ?? 90)) {
    score -= 20;
    reasons.push("account < 90 days old");
  }

  if (user?.official) {
    score += 20;
    reasons.push("official account");
  }
  if ((user?.like_count ?? 0) >= 1_000) score += 5;

  if (likes >= 20) score += 10;
  else if (likes >= 5) score += 5;
  if (likes > 0) reasons.push(`${likes} likes`);

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export async function fetchStockTwits(symbol, cfg) {
  const body = await getJson(
    `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`,
  );
  const items = [];
  for (const msg of body.messages ?? []) {
    const likes = msg.likes?.total ?? 0;
    const { score, reasons } = stocktwitsCredibility(msg.user, likes, cfg);
    if (score < (cfg.minCredibility ?? 45)) continue; // same vetting gate
    items.push({
      title: String(msg.body ?? "").replace(/\s+/g, " ").slice(0, 240),
      url: `https://stocktwits.com/${msg.user.username}/message/${msg.id}`,
      source: `@${msg.user.username} on StockTwits`,
      publishedAt: msg.created_at ? new Date(msg.created_at).toISOString() : null,
      kind: "social",
      credibility: { score, trust: score >= 70 ? "high" : "medium", reasons },
    });
  }
  return items;
}

// --- Reddit discovery + X oEmbed hydration -------------------------------------

const X_LINK_RE =
  /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(\w{1,15})\/status\/(\d+)/g;

// Decode XML/HTML entities (twice: the RSS wraps escaped HTML in XML).
function unescapeAll(s) {
  const once = (t) =>
    t
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  return once(once(String(s ?? "")));
}

export async function fetchRedditXLinks(query, cfg) {
  // Reddit's JSON search 403s without OAuth from most non-residential networks;
  // the Atom feed of the same search stays open. No upvote counts in the feed,
  // so the "limited" label leans on the subreddit context alone.
  const url =
    "https://www.reddit.com/search.rss?q=" +
    encodeURIComponent(query) +
    "&sort=new&t=week";
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/atom+xml, application/xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for reddit search.rss`);
  const xml = await res.text();

  // tweetId -> the Reddit context that surfaced it
  const found = new Map();
  for (const entry of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = unescapeAll(entry[1]);
    const subreddit =
      /<category[^>]*label="r\/([^"]+)"/.exec(entry[1])?.[1] ??
      /reddit\.com\/r\/([^/"]+)\//.exec(entry[1])?.[1] ??
      "?";
    for (const m of block.matchAll(X_LINK_RE)) {
      const [, handle, id] = m;
      if (!found.has(id)) found.set(id, { handle, id, subreddit });
    }
  }

  const items = [];
  const max = cfg.maxHydrations ?? 8; // politeness cap on oEmbed calls per run
  for (const link of [...found.values()].slice(0, max)) {
    try {
      const oembed = await getJson(
        "https://publish.twitter.com/oembed?omit_script=1&url=" +
          encodeURIComponent(`https://x.com/${link.handle}/status/${link.id}`),
      );
      // oEmbed html is the tweet blockquote; strip tags for a plain title.
      const text = String(oembed.html ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&mdash;.*$/s, "") // trailing "— Author (@handle) date"
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      if (!text) continue;
      items.push({
        title: text,
        url: `https://x.com/${link.handle}/status/${link.id}`,
        source: `@${link.handle} on X`,
        publishedAt: null, // oEmbed carries no timestamp; ranked by tier only
        kind: "tweet",
        credibility: {
          score: 25,
          trust: "limited",
          reasons: [
            "found via open web (no X API): follower/location vetting unavailable",
            `shared in r/${link.subreddit}`,
          ],
        },
      });
    } catch {
      continue; // deleted/protected tweet or oEmbed hiccup — skip quietly
    }
  }
  return items;
}
