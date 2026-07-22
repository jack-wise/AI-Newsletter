// Keyless social coverage — the no-X-API path.
//
// We never scrape x.com itself. Instead:
//   1. StockTwits' public symbol stream (free JSON) — finance chatter with real
//      author metadata (followers, join date, official badge), so the same
//      credibility-gate idea as the X module applies in full.
//   2. Reddit search — discover posts discussing the ticker and harvest any
//      x.com/twitter.com status links people share. Two paths:
//        - OAuth'd search.json when REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are
//          configured (a registered "script" app, client-credentials grant):
//          carries real post scores, restoring score-weighted vetting.
//        - search.rss fallback (keyless): the JSON endpoint 403s without OAuth
//          from non-residential IPs; the Atom feed stays open but carries no
//          upvote counts.
//      Either way, corroboration is a strength signal: the same tweet shared
//      across several distinct subreddits outranks a single drive-by post.
//   3. X's official oEmbed endpoint (publish.twitter.com, keyless, built for
//      embedding) — hydrate discovered tweet links into text + author. oEmbed
//      exposes NO follower/location data, so these items are labeled
//      trust:"limited" with the Reddit-side signals that surfaced them; the
//      full X vetting gate only runs when the paid API token is configured.

import { decodeEntities } from "./sources.mjs";

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
      // StockTwits bodies carry HTML entities (&#39; &amp;) — decode for display.
      title: decodeEntities(String(msg.body ?? "")).replace(/\s+/g, " ").slice(0, 240),
      url: `https://stocktwits.com/${msg.user.username}/message/${msg.id}`,
      source: `@${msg.user.username} on StockTwits`,
      publishedAt: msg.created_at ? new Date(msg.created_at).toISOString() : null,
      kind: "social",
      credibility: { score, trust: score >= 70 ? "high" : "medium", reasons },
    });
  }
  return items;
}

// --- Reddit subreddit feed ---------------------------------------------------
// Surface a dedicated subreddit's OWN posts as social items (distinct from the
// discovery path below, which only harvests x.com links shared on Reddit). The
// Atom feed stays open keylessly where the JSON API 403s from non-residential
// IPs. Posts in a ticker-specific sub (e.g. r/FRMI) are inherently on-topic, so
// the caller passes the ticker to force-tag them into that ticker's section even
// when the post title doesn't name the company (a shared "OpenAI data center"
// headline is FRMI-relevant by virtue of living in r/FRMI). The RSS feed exposes
// no upvote count, so items are labeled trust:"limited" — not score-vetted.
function atomTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : null;
}

export async function fetchRedditSubreddit(subreddit, ticker, cfg = {}) {
  const limit = cfg.subredditLimit ?? 25;
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.rss?limit=${limit}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/atom+xml, application/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for r/${subreddit} feed`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = atomTag(e, "title");
    // Reddit's Atom <link> is the post permalink (its own domain); gate to
    // http(s) like every other source before it reaches the render href sink.
    const link = /<link[^>]*href="([^"]+)"/i.exec(e)?.[1];
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    const author = atomTag(e, "name"); // "/u/username"
    const when = atomTag(e, "published") ?? atomTag(e, "updated");
    const t = when ? Date.parse(when) : NaN;
    items.push({
      title: title.replace(/\s+/g, " ").slice(0, 240),
      url: link,
      source: `r/${subreddit}`,
      publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      kind: "social",
      ...(ticker ? { tickers: [ticker] } : {}),
      credibility: {
        score: 30,
        trust: "limited",
        reasons: [
          `posted in r/${subreddit}${author ? ` by ${author}` : ""}`,
          "Reddit RSS exposes no upvote count — not score-vetted",
        ],
      },
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

// Merge one sighting of a tweet link into the per-tweet discovery context.
// The SAME tweet shared again (another post / another subreddit) accumulates
// rather than being dropped, because corroboration is the strength signal.
function noteSighting(found, handle, id, subreddit, postScore) {
  const ctx =
    found.get(id) ??
    found
      .set(id, { handle, id, subreddits: new Set(), posts: 0, maxScore: null })
      .get(id);
  ctx.posts += 1;
  if (subreddit && subreddit !== "?") ctx.subreddits.add(subreddit);
  if (typeof postScore === "number") {
    ctx.maxScore = Math.max(ctx.maxScore ?? 0, postScore);
  }
}

// tweetId -> context, from the keyless Atom feed (no scores available).
export function extractXLinksFromRss(xml) {
  const found = new Map();
  for (const entry of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = unescapeAll(entry[1]);
    const subreddit =
      /<category[^>]*label="r\/([^"]+)"/.exec(entry[1])?.[1] ??
      /reddit\.com\/r\/([^/"]+)\//.exec(entry[1])?.[1] ??
      "?";
    for (const m of block.matchAll(X_LINK_RE)) {
      noteSighting(found, m[1], m[2], subreddit, null);
    }
  }
  return found;
}

// tweetId -> context, from OAuth'd search.json children (real post scores).
export function extractXLinksFromJson(children) {
  const found = new Map();
  for (const child of children ?? []) {
    const d = child?.data ?? {};
    const text = `${String(d.url ?? "")} ${String(d.selftext ?? "")}`;
    for (const m of text.matchAll(X_LINK_RE)) {
      noteSighting(
        found,
        m[1],
        m[2],
        d.subreddit ?? "?",
        typeof d.score === "number" ? d.score : null,
      );
    }
  }
  return found;
}

// The discovered-tweet score: a base for "we could read it but not vet the
// author", lifted by corroboration (distinct subreddits) and — when the OAuth
// path supplied them — Reddit post scores. trust stays "limited" regardless:
// oEmbed exposes no author metadata, and no amount of Reddit enthusiasm
// substitutes for follower/age/location vetting. Capped below the vetted
// sources so a viral-on-Reddit tweet never outranks a vetted account.
export function discoveredTweetCredibility(ctx) {
  let score = 25;
  const reasons = [
    "found via open web (no X API): follower/location vetting unavailable",
  ];
  const subs = [...(ctx.subreddits ?? [])];
  if (subs.length >= 3) score += 15;
  else if (subs.length === 2) score += 10;
  const postsNote = ctx.posts > 1 ? ` (${String(ctx.posts)} posts)` : "";
  reasons.push(
    subs.length
      ? `shared in ${subs.map((s) => `r/${s}`).join(", ")}${postsNote}`
      : "shared on Reddit",
  );
  if (typeof ctx.maxScore === "number") {
    if (ctx.maxScore >= 100) score += 15;
    else if (ctx.maxScore >= 20) score += 10;
    else if (ctx.maxScore >= 5) score += 5;
    reasons.push(`top Reddit post score ${String(ctx.maxScore)}`);
  }
  return { score: Math.min(60, score), trust: "limited", reasons };
}

// Client-credentials token for a registered Reddit "script" app. Cached for
// the process (one collector run); Reddit tokens last ~1h, a run lasts seconds.
let redditTokenCache = null;
const REDDIT_UA = "script:fermi-watch-collector:1.0 (contact jack.wise@donoco.com)";

async function redditOAuthToken(clientId, clientSecret) {
  if (redditTokenCache && Date.now() < redditTokenCache.expiresAt - 60_000) {
    return redditTokenCache.token;
  }
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_UA,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`reddit token HTTP ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error("reddit token response missing access_token");
  redditTokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return redditTokenCache.token;
}

async function discoverViaOAuth(query, clientId, clientSecret) {
  const token = await redditOAuthToken(clientId, clientSecret);
  const body = await getJson(
    "https://oauth.reddit.com/search.json?raw_json=1&limit=50&sort=new&t=week&q=" +
      encodeURIComponent(query),
    { Authorization: `bearer ${token}`, "User-Agent": REDDIT_UA },
  );
  return extractXLinksFromJson(body?.data?.children);
}

async function discoverViaRss(query) {
  const url =
    "https://www.reddit.com/search.rss?q=" +
    encodeURIComponent(query) +
    "&sort=new&t=week";
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/atom+xml, application/xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for reddit search.rss`);
  return extractXLinksFromRss(await res.text());
}

export async function fetchRedditXLinks(query, cfg, env = process.env) {
  // OAuth json (real post scores) when the script-app secrets are configured;
  // an OAuth failure FALLS BACK to the keyless feed rather than losing the
  // cycle's discovery — the secrets activating is an upgrade, never a new
  // point of failure.
  let found;
  const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET } = env;
  if (REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET) {
    try {
      found = await discoverViaOAuth(query, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET);
    } catch (e) {
      console.warn(
        `reddit oauth search failed (${e instanceof Error ? e.message : String(e)}); falling back to search.rss`,
      );
    }
  }
  found ??= await discoverViaRss(query);

  const items = [];
  const max = cfg.maxHydrations ?? 8; // politeness cap on oEmbed calls per run
  for (const link of [...found.values()].slice(0, max)) {
    try {
      const oembed = await getJson(
        "https://publish.twitter.com/oembed?omit_script=1&url=" +
          encodeURIComponent(`https://x.com/${link.handle}/status/${link.id}`),
      );
      // oEmbed html is the tweet blockquote; strip tags, then decode the HTML
      // entities (&#39; etc.) so raw codes never reach the ticker or cards.
      const text = decodeEntities(
        String(oembed.html ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&mdash;.*$/s, ""), // trailing "— Author (@handle) date"
      )
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
        credibility: discoveredTweetCredibility(link),
      });
    } catch {
      continue; // deleted/protected tweet or oEmbed hiccup — skip quietly
    }
  }
  return items;
}
