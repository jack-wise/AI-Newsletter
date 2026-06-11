// Shared archive writers. Two permanent records back the site's history UI:
//
// 1. News: docs/data/archive/<day>.json (written by collect.mjs) plus an
//    index.json of every day with its story count, so the History tab can
//    navigate the whole archive. No retention cap — once a story has appeared
//    on the site, it stays reachable here forever.
//
// 2. Reports: docs/data/reports/archive/<key>/<YYYY-MM-DD>.json — one snapshot
//    per edition (dated by the report's generatedAt), capped at the newest
//    KEEP_EDITIONS per key, plus an index.json mapping key -> edition dates so
//    the Reports tab can offer an edition picker.
//
// Both are dependency-free and exported so a harness can exercise them
// against a temp directory without running the collectors.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const KEEP_EDITIONS = 30;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

// The History tab is Fermi-only: index counts reflect priority-ticker matches
// (FRMI articles, filings, tweets), even though day files store every item.
const fermiCount = (items) => items.filter((i) => i.tickers?.length).length;

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Merge today's items into the day file (dedupe via keyFn so the file grows
// across runs without duplicates), then refresh the archive index.
export function updateDayArchive(archiveDir, day, items, keyFn) {
  mkdirSync(archiveDir, { recursive: true });
  const path = join(archiveDir, `${day}.json`);
  const existing = readJson(path, { day, items: [] });
  const merged = new Map(existing.items.map((i) => [keyFn(i), i]));
  for (const i of items) if (!merged.has(keyFn(i))) merged.set(keyFn(i), i);
  const out = { day, items: [...merged.values()] };
  writeFileSync(path, JSON.stringify(out, null, 2));
  return rebuildDayIndex(archiveDir, { [day]: fermiCount(out.items) });
}

// Index = every day file present, newest first, with Fermi story counts.
// Counts come from the previous index where possible; only unknown days are
// re-read.
export function rebuildDayIndex(archiveDir, knownCounts = {}) {
  const indexPath = join(archiveDir, "index.json");
  const prev = new Map(readJson(indexPath, []).map((e) => [e.day, e.count]));
  const index = readdirSync(archiveDir)
    .map((f) => DAY_FILE.exec(f)?.[1])
    .filter(Boolean)
    .sort()
    .reverse()
    .map((day) => ({
      day,
      count:
        knownCounts[day] ??
        prev.get(day) ??
        fermiCount(readJson(join(archiveDir, `${day}.json`), { items: [] }).items),
    }));
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return index;
}

// Snapshot every current report into the per-key archive. Sweeping the
// directory (rather than a fixed key list) also captures reports published by
// other writers committing <key>.json directly. A same-day re-run replaces
// that day's edition with the newer copy; older editions are never touched.
export function archiveReports(reportsDir, keep = KEEP_EDITIONS) {
  const archiveDir = join(reportsDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const keys = (existsSync(reportsDir) ? readdirSync(reportsDir) : [])
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => f.slice(0, -".json".length));

  const index = {};
  for (const key of keys) {
    const report = readJson(join(reportsDir, `${key}.json`), null);
    const keyDir = join(archiveDir, key);
    mkdirSync(keyDir, { recursive: true });

    const date = String(report?.generatedAt ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const editionPath = join(keyDir, `${date}.json`);
      const prior = readJson(editionPath, null);
      if (prior?.generatedAt !== report.generatedAt) {
        writeFileSync(editionPath, JSON.stringify(report, null, 2));
      }
    }

    const editions = readdirSync(keyDir)
      .map((f) => DAY_FILE.exec(f)?.[1])
      .filter(Boolean)
      .sort()
      .reverse();
    for (const stale of editions.slice(keep)) {
      unlinkSync(join(keyDir, `${stale}.json`));
    }
    index[key] = editions.slice(0, keep);
  }
  writeFileSync(join(archiveDir, "index.json"), JSON.stringify(index, null, 2));
  return index;
}
