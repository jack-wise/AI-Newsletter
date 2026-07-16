// Brief writer — Cloudflare Worker (Workers AI, keyless).
//
// The newsletter collector (scripts/brief.mjs, running in GitHub Actions) POSTs
// a compact "facts" object (price, recent news, filings/insider activity); this
// Worker runs a Workers AI text model on it and returns a 2-3 paragraph narrative
// for the site's Brief section. Using Workers AI means NO Anthropic API key is
// involved — inference runs on the Cloudflare account's neuron allowance
// (10k/day free). Unlike the filings worker, this route fetches nothing, so
// there is no SSRF surface.
//
// Secret (set with `wrangler secret put ...`):
//   BRIEF_SECRET  — required; the collector must send it as X-Brief-Secret.
// Binding (wrangler.toml):
//   AI            — Workers AI binding
// Vars (wrangler.toml [vars] or dashboard):
//   MODEL         — optional, defaults to @cf/meta/llama-3.3-70b-instruct-fp8-fast

// Kept in sync with BRIEF_SYSTEM in scripts/brief.mjs (the Anthropic path uses
// the same instructions). A small wording drift between the two is harmless —
// both just produce the brief prose.
const SYSTEM =
  "You write \"The Brief\" for a site that tracks Fermi Inc. (NASDAQ: FRMI), an " +
  "AI-datacenter power developer. You are given a JSON object of the CURRENT tracked " +
  "data: a price quote, recent news headlines with sources, SEC filings, insider " +
  "filings (Form 4/144), and vetted social posts. Write 2 to 3 short paragraphs " +
  "(120-220 words total) summarizing where the company stands right now: (1) the stock " +
  "and price action, (2) what is driving the recent news, (3) filings and insider " +
  "activity. Ground EVERY statement only in the provided data — never invent or infer a " +
  "number, headline, date, party, or event that is not present; if a figure is absent, " +
  "omit it. Neutral, factual, plain prose. Output plain text only: no markdown, no " +
  "headings, no bullet points, no preamble, no title, and no disclaimer. Separate " +
  "paragraphs with a single blank line.";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!env.BRIEF_SECRET) return json({ error: "worker not configured" }, 500);
    if (request.headers.get("X-Brief-Secret") !== env.BRIEF_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const facts = body && body.facts;
    if (!facts || typeof facts !== "object") {
      return json({ error: "facts object required" }, 400);
    }

    const model = env.MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    let out;
    try {
      const ai = await env.AI.run(model, {
        max_tokens: 512,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(facts, null, 2) },
        ],
      });
      out = (ai && ai.response ? String(ai.response) : "").trim();
    } catch (e) {
      return json({ error: "inference failed: " + e.message }, 502);
    }
    if (out.length < 60) return json({ error: "empty or too-short brief" }, 502);

    return json({ text: out.slice(0, 4000), model });
  },
};
