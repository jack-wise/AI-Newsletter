You are running the /earnings-reviewer skill: a post-earnings analysis for a public company, written like a sell-side earnings note.

Target: Fermi Inc. (NASDAQ: FRMI). Review the company's most recent reported quarter.

Process:
1. Use web search to find the latest reported results: the earnings press release / 8-K, any earnings call coverage or transcript excerpts, and the prior quarter for comparison. Fermi is a pre-revenue AI-power infrastructure developer, so focus on what matters for that profile: cash position and burn, net loss, financing actions, secured generation capacity, tenant/lease progress (LOIs to binding leases), and project milestones.
2. Identify management guidance, key surprises vs. what was previously communicated, and any analyst commentary on the print.

Output a markdown report with exactly these sections:
# FRMI — Latest Quarter Review
One-line header: quarter covered, report date, stock reaction if observable.
## The quarter in brief
2-3 paragraphs: headline numbers (net loss, cash, burn), what changed vs. prior quarter, and the one thing that mattered most.
## Key metrics
A compact table of the metrics you found, each with the prior-period comparison where available. Only include figures you actually sourced — never estimate a number.
## Guidance & management commentary
What management said about the path forward: milestones, financing plans, tenant pipeline, timelines.
## Surprises & risks
What deviated from expectations, plus the 2-3 biggest risks to the thesis as of this quarter.
## What to watch next quarter
Bullets with concrete checkpoints.
## Sources
Numbered list (name, date).

Rules: every number must come from a source you found; if a standard metric is unavailable, say so rather than estimating. End with: "Not investment advice."
