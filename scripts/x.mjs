// X (Twitter) ingestion with account-credibility vetting.
//
// Uses the official X API v2 recent-search endpoint, which requires a PAID plan
// (Basic tier or above — the free tier cannot search). Provide the app's bearer
// token as the X_BEARER_TOKEN secret; with no token this module is skipped and
// the site notes that X coverage is off. Unofficial scraping is deliberately not
// implemented: it violates X's ToS and breaks without warning.
//
// Credibility model (the "verify validity" gate): every tweet is scored 0-100
// from its author's public signals — follower count, follower/following ratio,
// account age, verified status, stated location — plus the tweet's own
// engagement. Tweets below config.x.minCredibility are dropped entirely; the
// rest carry a trust label (high/medium) and the inputs that earned it, so the
// reader can judge the judgment.

const API = "https://api.twitter.com/2/tweets/search/recent";

export function credibilityScore(user, tweet, cfg) {
  const m = user?.public_metrics ?? {};
  const followers = m.followers_count ?? 0;
  const following = m.following_count ?? 0;
  const ageDays = user?.created_at
    ? (Date.now() - Date.parse(user.created_at)) / 86_400_000
    : 0;
  const t = tweet?.public_metrics ?? {};
  const engagement = (t.like_count ?? 0) + 2 * (t.retweet_count ?? 0) + (t.quote_count ?? 0);
  const location = String(user?.location ?? "").trim().toLowerCase();

  let score = 0;
  const reasons = [];

  // Reach: the strongest single signal.
  if (followers >= 100_000) score += 30;
  else if (followers >= 10_000) score += 22;
  else if (followers >= 1_000) score += 12;
  else if (followers >= (cfg.minFollowers ?? 200)) score += 5;
  reasons.push(`${followers.toLocaleString()} followers`);

  // Follower/following ratio: follow-back farms and bots skew low.
  const ratio = following > 0 ? followers / following : followers > 0 ? 99 : 0;
  if (ratio >= 2) score += 10;
  else if (ratio >= 0.5) score += 5;

  // Account age: brand-new accounts are the classic pump vector.
  if (ageDays >= 5 * 365) score += 15;
  else if (ageDays >= 2 * 365) score += 10;
  else if (ageDays >= 180) score += 5;
  else if (ageDays < (cfg.minAccountAgeDays ?? 90)) {
    score -= 20;
    reasons.push("account < 90 days old");
  }

  // Verification: org/government verification means an identity check; blue is weaker.
  if (user?.verified_type === "business" || user?.verified_type === "government") {
    score += 15;
    reasons.push(`verified (${user.verified_type})`);
  } else if (user?.verified) {
    score += 5;
    reasons.push("verified");
  }

  // Stated location: any disclosed base is a small positive; a configured region
  // (e.g. US for a US-listed ticker) earns a boost. Self-reported, so weighted low.
  if (location) {
    score += 5;
    if ((cfg.boostLocations ?? []).some((loc) => location.includes(loc))) score += 5;
    reasons.push(`based: ${user.location}`);
  }

  // The tweet's own traction.
  if (engagement >= 100) score += 10;
  else if (engagement >= 20) score += 5;
  if (engagement > 0) reasons.push(`${engagement} engagement`);

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export async function searchX(query, cfg, bearerToken) {
  if (!bearerToken) return { items: [], skipped: "no X_BEARER_TOKEN configured" };

  const params = new URLSearchParams({
    query,
    max_results: "50",
    expansions: "author_id",
    "tweet.fields": "created_at,public_metrics,lang",
    "user.fields": "created_at,location,public_metrics,verified,verified_type,username,name",
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`X API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));

  const items = [];
  for (const tweet of body.data ?? []) {
    const user = users.get(tweet.author_id);
    if (!user) continue;
    const { score, reasons } = credibilityScore(user, tweet, cfg);
    if (score < (cfg.minCredibility ?? 45)) continue; // vetting gate
    items.push({
      title: tweet.text.replace(/\s+/g, " ").slice(0, 240),
      url: `https://x.com/${user.username}/status/${tweet.id}`,
      source: `@${user.username} on X`,
      publishedAt: tweet.created_at ?? null,
      kind: "tweet",
      credibility: {
        score,
        trust: score >= 70 ? "high" : "medium",
        reasons,
      },
    });
  }
  return { items };
}
