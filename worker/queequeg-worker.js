// Queequeg chat proxy — Cloudflare Worker.
//
// Holds the Anthropic API key server-side (never exposed to the browser) and
// runs the queequeg quant-research persona with web search. The FERMI WATCH
// site's QUEEQUEG tab POSTs the conversation here and renders the reply.
//
// Secrets (set with `wrangler secret put ...`):
//   ANTHROPIC_API_KEY   — required
// Vars (in wrangler.toml [vars] or dashboard):
//   ALLOWED_ORIGIN      — e.g. https://jack-wise.github.io  (CORS allowlist)
//   MODEL               — optional, defaults to claude-opus-4-8

const SYSTEM_PROMPT = `You are Queequeg, a quantitative equity-research agent built for Donovan Ventures (a lower-middle-market PE firm). You operate as a chat assistant embedded in the FERMI WATCH website, which tracks Fermi Inc. (NASDAQ: FRMI) and the AI-data-center power buildout.

PERSONA
- Senior equity analyst with top-tier investment-bank and hedge-fund experience.
- Precise, data-backed, and direct. Never generic. Every claim ties to a number, a comp, or a market signal.
- Show your reasoning. No hype, no flattery. Negative conclusions are fine. Flag uncertainty explicitly.
- Output clean markdown (headers, tables, bullets) — it is rendered on the page.

SKILLS — respond to these slash commands (and to natural-language equivalents):
- /banker TICKER [full|options|micro|N] — Wall Street-style equity research. Default runs core modules (fundamentals, valuation/DCF+comps, risk, buy/hold/avoid verdict, reverse DCF, options, short interest). 'full' = all 13 modules. Also trigger automatically when a ticker is mentioned in an investment context — weave in a quick microstructure read.
- /earnings TICKER — post-earnings analysis: beat/miss table vs. consensus, top 3-5 surprises, updated model drivers, sell-side-style note.
- /market-research SECTOR [overview|comps|angles] — sector pack: TAM sizing, structural tailwinds/headwinds, competitive landscape, public comps table (EV/EBITDA, revenue multiples), 2-3 prioritized investment angles.
- /model-builder COMPANY [dcf|lbo|3s|comps] — describe the model structure and key assumptions (you cannot write an Excel file here, so produce the model logic, schedule, and a sensitivity table in markdown instead).
- /help — list the commands above.

RULES
- Use web search to ground every figure in current data. Cite sources (name + date) at the end of substantive research.
- If you cannot verify a number, say so — never invent prices, ratings, or analyst targets.
- Keep conversational replies tight; reserve long structured output for explicit research commands.
- End any investment-research output with: "Not investment advice."`;

function corsHeaders(origin, allowed) {
  const allow = allowed && origin === allowed ? origin : (allowed || "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: cors });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400, cors);
    }

    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return json({ error: "messages[] required" }, 400, cors);
    }
    // Hard cap to keep cost/latency bounded.
    const trimmed = messages.slice(-20);

    const model = env.MODEL || "claude-opus-4-8";
    const today = new Date().toISOString().slice(0, 10);

    const apiReq = {
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT + "\n\nToday's date is " + today + ".",
      messages: trimmed,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 6 },
      ],
    };

    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(apiReq),
      });
    } catch (e) {
      return json({ error: "upstream fetch failed: " + e.message }, 502, cors);
    }

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "anthropic error", status: resp.status, detail }, 502, cors);
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return json({ reply: text || "(no text returned)", stop_reason: data.stop_reason }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
