// Fermi Watch pinger: GitHub's cron scheduler has proven unreliable for this
// repo (one schedule-event run in the first ~20 hours of an active 30-minute
// schedule), so this Cloudflare Worker owns the cadence instead. Each cron
// fire POSTs to the GitHub workflow_dispatch endpoint with a token stored as
// the GITHUB_TOKEN secret:
//
//   npx wrangler secret put GITHUB_TOKEN     (needs Actions write on the repo)
//
// Crons (wrangler.toml):
//   1,31 * * * *   -> update.yml   news collector, every 30 minutes
//   32 10 * * 1-5  -> reports.yml  daily news report, weekdays pre-market
//                     (report=news only — earnings stays on-demand)

const REPO = "jack-wise/AI-Newsletter";

async function dispatch(env, workflow, inputs) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        // trim(): a secret piped in via PowerShell can carry a trailing
        // newline, and fetch rejects header values containing CR/LF.
        Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "fermi-watch-pinger",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
    },
  );
  if (res.status !== 204) {
    // Throwing marks the cron invocation failed so it shows in Workers logs.
    throw new Error(`dispatch ${workflow}: HTTP ${res.status} ${await res.text()}`);
  }
}

export default {
  async scheduled(controller, env) {
    if (controller.cron === "32 10 * * 1-5") {
      await dispatch(env, "reports.yml", { report: "news" });
    } else {
      await dispatch(env, "update.yml");
    }
  },
  // No HTTP surface — the token only ever travels to api.github.com.
  fetch: () => new Response("Not found", { status: 404 }),
};
