// Scheduled research reports: runs the site's research skills (news,
// earnings-reviewer, banker, market-researcher — adapted in prompts/*.md)
// through the Claude API with web search, and publishes the output as
// docs/data/reports/<key>.json for the site's Reports tab.
//
// Requires the ANTHROPIC_API_KEY repo secret; with no key this exits 0 with a
// note so the workflow stays green until the secret is configured.
// Model is overridable via REPORTS_MODEL (default claude-opus-4-8).
//
// Run locally: ANTHROPIC_API_KEY=... node scripts/reports.mjs [key]

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveReports } from "./archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// banker + market were handed off to the queequeg agent, which commits
// docs/data/reports/<key>.json directly (#2) — they're out of this list so two
// writers never race on the same files. The index merge and archive sweep
// below still carry and snapshot them.
const REPORTS = [
  { key: "news",     title: "FRMI News & Price Impact", prompt: "news.md"     },
  { key: "earnings", title: "FRMI Earnings Review",     prompt: "earnings.md" },
];

const MODEL = process.env.REPORTS_MODEL || "claude-opus-4-8";
const MAX_SEARCHES_PER_REPORT = 10;
const MAX_CONTINUATIONS = 5; // pause_turn resume cap

// Exported for the offline smoke test: the exact request body for one report.
export function buildRequest(promptText, today, priorMessages = null) {
  return {
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system:
      "You are a research engine publishing to an automated finance site. " +
      "Today's date is " + today + ". Output ONLY the markdown report — no preamble, " +
      "no meta-commentary about searching. Ground every claim in your searches.",
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES_PER_REPORT },
    ],
    messages: priorMessages ?? [{ role: "user", content: promptText }],
  };
}

function extractText(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function runReport(client, def, today) {
  const promptText = readFileSync(join(root, "prompts", def.prompt), "utf8");
  let messages = [{ role: "user", content: promptText }];
  let message;
  let usage = { input_tokens: 0, output_tokens: 0 };

  // Server-side tool loops can stop with pause_turn; append the assistant turn
  // and re-send — the API resumes where it left off (no extra user message).
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = client.messages.stream(buildRequest(promptText, today, messages));
    message = await stream.finalMessage();
    usage.input_tokens += message.usage.input_tokens ?? 0;
    usage.output_tokens += message.usage.output_tokens ?? 0;
    if (message.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: message.content }];
  }

  const markdown = extractText(message);
  if (!markdown || markdown.length < 200) {
    throw new Error(`report '${def.key}' came back empty (stop: ${message.stop_reason})`);
  }
  return {
    key: def.key,
    title: def.title,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    stopReason: message.stop_reason,
    usage,
    markdown,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Low API tiers allow ~10k input tokens/minute: pace the reports apart and,
// on a 429, wait out the minute window and retry rather than giving up.
async function runReportPaced(client, def, today) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runReport(client, def, today);
    } catch (e) {
      const rateLimited = e?.status === 429 || /rate_limit/i.test(String(e?.message ?? ""));
      if (!rateLimited || attempt >= 4) throw e;
      console.log(`reports: '${def.key}' rate-limited; waiting 90s (attempt ${attempt}/4)...`);
      await sleep(90_000);
    }
  }
}

async function main() {
  const outDir = join(root, "docs", "data", "reports");
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("reports: skipped — no ANTHROPIC_API_KEY configured");
    // Still snapshot current editions (including reports committed directly by
    // other writers) so nothing is lost while generation is off.
    archiveReports(outDir);
    return;
  }
  // Optional arg: comma-separated report keys (e.g. "earnings,banker,market").
  const only = process.argv[2] ? process.argv[2].split(",").map((s) => s.trim()) : null;
  const client = new Anthropic({ maxRetries: 3 });
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(outDir, { recursive: true });

  const index = [];
  let failed = 0;
  let ranAny = false;
  for (const def of REPORTS) {
    if (only && !only.includes(def.key)) continue;
    if (ranAny) {
      console.log("reports: pacing 75s between reports (per-minute rate limits)...");
      await sleep(75_000);
    }
    ranAny = true;
    try {
      console.log(`reports: running '${def.key}' (${MODEL})...`);
      const report = await runReportPaced(client, def, today);
      writeFileSync(join(outDir, `${def.key}.json`), JSON.stringify(report, null, 2));
      index.push({
        key: report.key,
        title: report.title,
        generatedAt: report.generatedAt,
        model: report.model,
      });
      console.log(
        `reports: '${def.key}' done — ${report.markdown.length} chars, ` +
          `${report.usage.input_tokens} in / ${report.usage.output_tokens} out tokens`,
      );
    } catch (e) {
      failed++;
      console.error(`reports: '${def.key}' FAILED: ${e?.message ?? e}`);
      // Keep the previous edition of this report on the site; continue with the rest.
    }
  }
  if (index.length) {
    // Merge with any existing index entries for reports not run this time.
    let existing = [];
    try {
      existing = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
    } catch {
      /* first run */
    }
    const byKey = new Map(existing.map((r) => [r.key, r]));
    for (const r of index) byKey.set(r.key, r);
    // Keep index entries for reports other writers own (banker/market).
    const merged = [
      ...REPORTS.map((d) => byKey.get(d.key)).filter(Boolean),
      ...existing.filter((r) => !REPORTS.some((d) => d.key === r.key)),
    ];
    writeFileSync(join(outDir, "index.json"), JSON.stringify(merged, null, 2));
  }
  // Snapshot this run's editions (and any externally committed ones) into the
  // per-key archive that backs the Reports tab's edition picker.
  archiveReports(outDir);
  if (failed && !index.length) process.exit(1); // total failure should show red
}

await main();
