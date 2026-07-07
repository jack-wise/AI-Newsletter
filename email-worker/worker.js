// Fermi Watch email digest — Cloudflare Worker.
//
// Owns the newsletter list and the morning send for the static site. Flow:
//   POST /subscribe        {email}      -> stores a pending record, sends a
//                                          double-opt-in confirmation email
//   GET  /confirm?token=   (email link) -> promotes pending -> confirmed
//   GET  /unsubscribe?...  (email link) -> removes the subscriber
//   scheduled (cron)                    -> builds a digest from the site's own
//                                          data and emails every confirmed sub
//
// No Anthropic/paid infra: subscribers live in Workers KV (free tier), email is
// sent via the Brevo transactional API (free tier ~300/day). Double opt-in keeps
// the list clean and CAN-SPAM/GDPR-friendly (explicit consent + one-click unsub).
//
// Binding (wrangler.toml):  SUBSCRIBERS  — KV namespace
// Secret (wrangler secret put):  BREVO_API_KEY
// Vars (wrangler.toml [vars]):
//   FROM_EMAIL      verified Brevo sender address (required)
//   FROM_NAME       display name, default "Fermi Watch"
//   SITE_URL        the public site, default https://jack-wise.github.io/AI-Newsletter
//   ALLOWED_ORIGIN  CORS origin for the signup box, default the SITE_URL origin

const DEFAULTS = {
  FROM_NAME: "Fermi Watch",
  SITE_URL: "https://jack-wise.github.io/AI-Newsletter",
  ALLOWED_ORIGIN: "https://jack-wise.github.io",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PENDING_TTL = 60 * 60 * 48; // pending confirmations expire in 48h
const MAX_VERSIONS = 900; // Brevo messageVersions cap (headroom under 1000)

// ---------- small helpers ----------
const cfg = (env, key) => env[key] || DEFAULTS[key];

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": cfg(env, "ALLOWED_ORIGIN"),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function page(title, message) {
  // Minimal dark confirmation/landing page for the email link clicks.
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title} — Fermi Watch</title>` +
      `<body style="margin:0;background:#05080f;color:#f2f5fa;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">` +
      `<div style="max-width:460px;padding:32px"><h1 style="color:#38b6e3;font-size:22px;margin:0 0 12px">${title}</h1>` +
      `<p style="color:#97a3b8;margin:0 0 20px">${message}</p>` +
      `<a href="${DEFAULTS.SITE_URL}" style="color:#38b6e3;text-decoration:none;font-weight:600">← Back to Fermi Watch</a></div></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// Constant-time string compare (avoids a timing side-channel on the unsub token).
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ba, bb);
}

// ---------- Brevo transactional email ----------
async function brevoSend(env, payload) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY.trim(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

function sender(env) {
  return { name: cfg(env, "FROM_NAME"), email: env.FROM_EMAIL };
}

// ---------- email HTML ----------
function shell(bodyHtml, footerHtml) {
  return (
    `<div style="margin:0;padding:0;background:#05080f">` +
    `<div style="max-width:600px;margin:0 auto;background:#0c1220;border:1px solid #1b2436;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">` +
    `<div style="padding:22px 28px;border-bottom:1px solid #1b2436">` +
    `<span style="font-weight:800;letter-spacing:.04em;font-size:18px;color:#f2f5fa">FERMI<span style="color:#38b6e3">WATCH</span></span>` +
    `</div>` +
    `<div style="padding:24px 28px;color:#c7d0de">${bodyHtml}</div>` +
    `<div style="padding:18px 28px;border-top:1px solid #1b2436;color:#5e6a80;font-size:12px;line-height:1.5">${footerHtml}</div>` +
    `</div></div>`
  );
}

function confirmEmailHtml(confirmLink) {
  return shell(
    `<h1 style="color:#f2f5fa;font-size:20px;margin:0 0 12px">Confirm your subscription</h1>` +
      `<p style="margin:0 0 20px">You asked to get the Fermi Watch morning brief — the day's ranked FRMI news, filings, and research in one email. Confirm to start receiving it.</p>` +
      `<a href="${confirmLink}" style="display:inline-block;background:#38b6e3;color:#05080f;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:8px">Confirm subscription</a>` +
      `<p style="margin:20px 0 0;color:#5e6a80;font-size:13px">If you didn't request this, just ignore this email — no subscription is created without confirmation.</p>`,
    `Fermi Watch · independent coverage tracker, not affiliated with Fermi Inc.`,
  );
}

function digestHtml(env, items, reportLink, unsubLink) {
  const dateStr = "{{DATE}}"; // replaced per-send
  const rows =
    items.length === 0
      ? `<p style="color:#97a3b8">No new priority stories in the last cycle — the site keeps sweeping. Check <a href="${cfg(env, "SITE_URL")}" style="color:#38b6e3">Fermi Watch</a> anytime.</p>`
      : items
          .map(
            (it) =>
              `<a href="${it.url}" style="display:block;text-decoration:none;border:1px solid #1b2436;border-radius:8px;padding:14px 16px;margin:0 0 10px">` +
              `<div style="color:#f2f5fa;font-weight:600;font-size:15px;line-height:1.4">${it.title}</div>` +
              `<div style="color:#5e6a80;font-size:12px;margin-top:6px">${it.source}${it.tag ? " · " + it.tag : ""}</div>` +
              `</a>`,
          )
          .join("");
  return shell(
    `<div style="color:#5e6a80;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 6px">Morning Brief · ${dateStr}</div>` +
      `<h1 style="color:#f2f5fa;font-size:20px;margin:0 0 16px">Today in Fermi <span style="color:#38b6e3">(NASDAQ: FRMI)</span></h1>` +
      rows +
      (reportLink
        ? `<a href="${reportLink}" style="display:inline-block;margin-top:8px;color:#38b6e3;text-decoration:none;font-weight:600">Read today's AI research report →</a>`
        : ``) +
      `<div style="margin-top:22px"><a href="${cfg(env, "SITE_URL")}" style="display:inline-block;background:#38b6e3;color:#05080f;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px">Open Fermi Watch</a></div>`,
    `You're getting this because you confirmed a subscription at Fermi Watch. ` +
      `<a href="${unsubLink}" style="color:#5e6a80;text-decoration:underline">Unsubscribe</a>. ` +
      `Independent coverage tracker — not affiliated with Fermi Inc. Not investment advice.`,
  );
}

// ---------- route handlers ----------
// Best-effort per-IP throttle so the endpoint can't be used to email-bomb an
// address or drain the daily send quota. 3 attempts / 60s.
async function rateLimited(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = "rl:" + ip;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || "0", 10) || 0;
  if (n >= 3) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 60 });
  return false;
}

async function handleSubscribe(request, env) {
  if (await rateLimited(request, env)) {
    return json({ error: "Too many requests — try again in a minute." }, 429, env);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, env);
  }
  const email = String((body && body.email) || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "Enter a valid email address." }, 400, env);
  }
  if (!env.FROM_EMAIL || !env.BREVO_API_KEY) {
    return json({ error: "email service not configured" }, 500, env);
  }

  // Already confirmed? Idempotent success, no duplicate email.
  const existing = await env.SUBSCRIBERS.get("sub:" + email);
  if (existing) {
    return json({ ok: true, status: "already-subscribed" }, 200, env);
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  await env.SUBSCRIBERS.put(
    "pending:" + token,
    JSON.stringify({ email, createdAt: new Date().toISOString() }),
    { expirationTtl: PENDING_TTL },
  );

  const confirmLink = `${new URL(request.url).origin}/confirm?token=${token}`;
  try {
    await brevoSend(env, {
      sender: sender(env),
      to: [{ email }],
      subject: "Confirm your Fermi Watch subscription",
      htmlContent: confirmEmailHtml(confirmLink),
    });
  } catch (e) {
    return json({ error: "could not send confirmation email" }, 502, env);
  }
  return json({ ok: true, status: "check-your-email" }, 200, env);
}

async function handleConfirm(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const raw = token ? await env.SUBSCRIBERS.get("pending:" + token) : null;
  if (!raw) {
    return page("Link expired", "This confirmation link is invalid or has expired. Please subscribe again from the site.");
  }
  const { email } = JSON.parse(raw);
  const existing = await env.SUBSCRIBERS.get("sub:" + email);
  if (!existing) {
    const unsubToken = crypto.randomUUID().replace(/-/g, "");
    await env.SUBSCRIBERS.put(
      "sub:" + email,
      JSON.stringify({ email, unsubToken, confirmedAt: new Date().toISOString() }),
    );
  }
  await env.SUBSCRIBERS.delete("pending:" + token);
  return page("You're subscribed", "You'll get the Fermi Watch morning brief each day. You can unsubscribe anytime from the footer of any email.");
}

async function handleUnsubscribe(request, env) {
  const params = new URL(request.url).searchParams;
  const email = String(params.get("email") || "").trim().toLowerCase();
  const token = params.get("token") || "";
  const raw = email ? await env.SUBSCRIBERS.get("sub:" + email) : null;
  if (raw) {
    const rec = JSON.parse(raw);
    if (safeEqual(rec.unsubToken, token)) {
      await env.SUBSCRIBERS.delete("sub:" + email);
    }
  }
  // Always show success (don't reveal whether an address was on the list).
  return page("Unsubscribed", "You've been removed from the Fermi Watch morning brief. Sorry to see you go — you can resubscribe anytime.");
}

// ---------- digest build ----------
async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function buildDigestItems(env) {
  const site = cfg(env, "SITE_URL");
  const feed = await fetchJson(`${site}/data/fermi-feed.json`);
  const items = [];
  const seen = new Set();
  const push = (title, url, source, tag) => {
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    items.push({ title, url, source: source || "Fermi Watch", tag: tag || "" });
  };
  if (feed && Array.isArray(feed.articles)) {
    for (const a of feed.articles.slice(0, 6)) push(a.title, a.url, a.source, a.tab);
  }
  if (items.length < 5) {
    const news = await fetchJson(`${site}/data/news.json`);
    const pool = news ? [...(news.priority || []), ...(news.related || [])] : [];
    for (const it of pool) {
      if (items.length >= 6) break;
      push(it.title, it.url, it.source, (it.tickers && it.tickers[0]) || "");
    }
  }
  return items.slice(0, 6);
}

async function listConfirmed(env) {
  const subs = [];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const raw = await env.SUBSCRIBERS.get(k.name);
      if (raw) subs.push(JSON.parse(raw));
      if (subs.length >= MAX_VERSIONS) break;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && subs.length < MAX_VERSIONS);
  return subs;
}

async function sendDigest(env) {
  if (!env.FROM_EMAIL || !env.BREVO_API_KEY) throw new Error("email service not configured");
  const subs = await listConfirmed(env);
  if (subs.length === 0) return { sent: 0 };

  const items = await buildDigestItems(env);
  const site = cfg(env, "SITE_URL");
  const reportLink = `${site}/#coverage`;
  const workerOrigin = env.WORKER_ORIGIN || ""; // optional explicit origin for links
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York",
  });

  // One Brevo call with a per-subscriber messageVersion (each carries its own
  // unsubscribe link). Keeps the send to a single subrequest and never exposes
  // one subscriber's address to another.
  const baseHtml = digestHtml(env, items, reportLink, "{{UNSUB}}").replace("{{DATE}}", date);
  const messageVersions = subs.map((s) => {
    const unsub =
      `${workerOrigin}/unsubscribe?email=${encodeURIComponent(s.email)}&token=${encodeURIComponent(s.unsubToken)}`;
    return { to: [{ email: s.email }], htmlContent: baseHtml.replace("{{UNSUB}}", unsub) };
  });

  await brevoSend(env, {
    sender: sender(env),
    subject: `Fermi Watch — Morning Brief, ${date}`,
    htmlContent: baseHtml.replace("{{UNSUB}}", `${workerOrigin}/unsubscribe`),
    messageVersions,
  });
  return { sent: subs.length };
}

// ---------- entrypoints ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }
    if (url.pathname === "/confirm" && request.method === "GET") {
      return handleConfirm(request, env);
    }
    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      return handleUnsubscribe(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    // Run the send off the scheduled tick; a throw marks the invocation failed
    // and surfaces in Workers logs.
    ctx.waitUntil(
      sendDigest(env).then(
        (r) => console.log(`digest sent to ${r.sent} subscriber(s)`),
        (e) => { throw e; },
      ),
    );
  },
};
