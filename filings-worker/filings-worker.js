// SEC filing summarizer — Cloudflare Worker (Workers AI, keyless).
//
// The newsletter collector (scripts/enrich.mjs, running in GitHub Actions)
// POSTs a filing URL here; this Worker fetches the document from EDGAR, runs a
// Workers AI text model on it, and returns a short content summary. Using
// Workers AI means NO Anthropic API key is involved — inference runs on the
// Cloudflare account's neuron allowance (10k/day free).
//
// Secret (set with `wrangler secret put ...`):
//   FILINGS_SECRET  — required; the collector must send it as X-Filings-Secret.
// Binding (wrangler.toml):
//   AI              — Workers AI binding
// Vars (wrangler.toml [vars] or dashboard):
//   MODEL           — optional, defaults to @cf/meta/llama-3.1-8b-instruct

const SEC_UA = "AI Newsletter jack.wise@donoco.com"; // SEC requires a contact UA
const TEXT_CAP = 10_000; // chars of filing text fed to the model (bounds neurons)
const SYSTEM =
  "You summarize SEC filings for an investor-facing news site. Given a filing's " +
  "text, write 2-3 plain-text sentences stating what THIS filing discloses and " +
  "why it matters: the specific events, figures, parties, and actions. No " +
  "preamble, no markdown, do not begin with 'This filing'. If the document is " +
  "purely procedural with no material disclosure, say so in one sentence.";

// Only EDGAR documents may be fetched — prevents this endpoint being used as an
// open SSRF proxy.
function isSecUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" && (hostname === "sec.gov" || hostname.endsWith(".sec.gov"));
  } catch {
    return false;
  }
}

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_CAP);
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!env.FILINGS_SECRET) return json({ error: "worker not configured" }, 500);
    if (request.headers.get("X-Filings-Secret") !== env.FILINGS_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const { url, form } = body || {};
    if (!url || !isSecUrl(url)) return json({ error: "valid sec.gov url required" }, 400);

    let text;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": SEC_UA, Accept: "text/html,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return json({ error: `filing fetch ${res.status}` }, 502);
      text = toText(await res.text());
    } catch (e) {
      return json({ error: "filing fetch failed: " + e.message }, 502);
    }
    if (!text || text.length < 200) return json({ error: "filing text too short" }, 422);

    const model = env.MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    let out;
    try {
      const ai = await env.AI.run(model, {
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Form type: ${form || "filing"}\n\nFiling document:\n${text}` },
        ],
      });
      out = (ai && ai.response ? String(ai.response) : "").replace(/\s+/g, " ").trim();
    } catch (e) {
      return json({ error: "inference failed: " + e.message }, 502);
    }
    if (out.length < 20) return json({ error: "empty summary" }, 502);

    return json({ summary: out.slice(0, 700), model });
  },
};
