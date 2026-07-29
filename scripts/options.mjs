// Keyless FRMI options snapshot for the site's Options panel. Uses Cboe's public
// delayed-quotes CDN (no API key, no crumb/cookie) with a browser User-Agent.
// Returns a compact summary object, or null on any failure — the collector
// writes options.json only when a snapshot is produced, and the panel degrades
// gracefully (it keeps its last content, and the live TradingView chart above is
// unaffected).
//
// Cboe endpoint: https://cdn.cboe.com/api/global/delayed_quotes/options/<SYM>.json
//   data.current_price / price_change / price_change_percent / prev_day_close
//   data.iv30 (+ iv30_change_percent)          — 30-day implied volatility, %
//   data.options[]: { option, bid, ask, last_trade_price, volume, open_interest,
//                     iv, delta, ... }          — one row per listed contract
// Contract symbols are OSI-encoded: FRMI 260731 C 00001000  ->  root, YYMMDD,
// C/P, strike*1000. Data is EXCHANGE-DELAYED (~15 min); used for an at-a-glance
// positioning read only, never for anything actionable.
//
// Split like brief.mjs: fetchFrmiOptions() does I/O (fail-open, returns null),
// buildOptionsSummary() is pure (raw Cboe data + clock in) so it can be tested.

const CBOE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const round = (n, d = 2) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Parse an OSI contract symbol -> { type, strike, expiry } or null.
// e.g. "FRMI260731C00001000" -> { type:"call", strike:1, expiry:"2026-07-31" }
export function parseOsi(symbol) {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(symbol ?? ""));
  if (!m) return null;
  const [, , yy, mm, dd, cp, strike] = m;
  return {
    type: cp === "C" ? "call" : "put",
    strike: Number(strike) / 1000,
    expiry: `20${yy}-${mm}-${dd}`,
  };
}

// Whole days from `now` to an expiry date (YYYY-MM-DD), floored at 0.
function daysTo(expiry, now) {
  const t = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - now) / 86_400_000));
}

// A P/C ratio is only meaningful once there's real two-sided interest; below
// this the ratio swings wildly on a single contract, so we suppress it.
const PC_MIN_BASE = 5;
function pcRatio(calls, puts) {
  return calls >= PC_MIN_BASE || puts >= PC_MIN_BASE ? round(puts / (calls || 1), 2) : null;
}

// Deterministic positioning read from the OI put/call ratio + IV30. Descriptive
// only — never a recommendation. Mirrors brief.mjs's grounded, keyless tone.
function readSentiment(pcOI, iv30) {
  let label, note;
  if (pcOI == null) {
    label = "Thin";
    note = "Too little open interest for a meaningful put/call read.";
  } else if (pcOI < 0.7) {
    label = "Call-heavy";
    note = `More open interest in calls than puts (put/call ${pcOI.toFixed(2)}) — positioning leans bullish.`;
  } else if (pcOI <= 1.0) {
    label = "Balanced · call lean";
    note = `Roughly balanced open interest, slightly more calls (put/call ${pcOI.toFixed(2)}).`;
  } else if (pcOI <= 1.3) {
    label = "Balanced · put lean";
    note = `Roughly balanced open interest, slightly more puts (put/call ${pcOI.toFixed(2)}).`;
  } else {
    label = "Put-heavy";
    note = `More open interest in puts than calls (put/call ${pcOI.toFixed(2)}) — positioning leans defensive.`;
  }
  if (Number.isFinite(iv30)) {
    note +=
      iv30 >= 100
        ? ` 30-day implied volatility is very high (${Math.round(iv30)}%), so options are pricing large moves.`
        : ` 30-day implied volatility is ${Math.round(iv30)}%.`;
  }
  return { label, note };
}

// Pure: turn the raw Cboe payload into the compact object the panel renders.
// Returns null if the payload has no usable contracts.
export function buildOptionsSummary(cboe, now = Date.now()) {
  const d = cboe?.data;
  if (!d || !Array.isArray(d.options) || d.options.length === 0) return null;

  const spot = num(d.current_price) || num(d.close) || num(d.prev_day_close);

  // Decorate each contract with its parsed OSI fields; drop the unparseable.
  const rows = [];
  for (const o of d.options) {
    const p = parseOsi(o.option);
    if (!p) continue;
    rows.push({
      contract: o.option,
      type: p.type,
      strike: p.strike,
      expiry: p.expiry,
      last: round(num(o.last_trade_price), 2),
      bid: round(num(o.bid), 2),
      ask: round(num(o.ask), 2),
      volume: Math.round(num(o.volume)),
      openInterest: Math.round(num(o.open_interest)),
      iv: round(num(o.iv) * 100, 1), // Cboe iv is a fraction; expose as %
      delta: round(num(o.delta), 3),
    });
  }
  if (rows.length === 0) return null;

  const calls = rows.filter((r) => r.type === "call");
  const puts = rows.filter((r) => r.type === "put");
  const sum = (arr, k) => arr.reduce((a, r) => a + r[k], 0);
  const callOI = sum(calls, "openInterest");
  const putOI = sum(puts, "openInterest");
  const callVol = sum(calls, "volume");
  const putVol = sum(puts, "volume");
  const pcOI = pcRatio(callOI, putOI);

  // Per-expiration breakdown (nearest first), with an at-the-money IV read:
  // the call and put whose strike sits closest to spot, averaged, ignoring the
  // zero/garbage IVs Cboe reports for untraded deep ITM/OTM strikes.
  const byExpiry = new Map();
  for (const r of rows) {
    if (!byExpiry.has(r.expiry)) byExpiry.set(r.expiry, []);
    byExpiry.get(r.expiry).push(r);
  }
  const atmIvFor = (contracts) => {
    const pick = (type) =>
      contracts
        .filter((r) => r.type === type && Number.isFinite(r.iv) && r.iv > 0)
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0]?.iv ?? null;
    const c = pick("call");
    const p = pick("put");
    const vals = [c, p].filter((v) => v != null);
    return vals.length ? round(vals.reduce((a, v) => a + v, 0) / vals.length, 1) : null;
  };
  const expirations = [...byExpiry.entries()]
    .map(([date, contracts]) => {
      const ec = contracts.filter((r) => r.type === "call");
      const ep = contracts.filter((r) => r.type === "put");
      const eCallOI = sum(ec, "openInterest");
      const ePutOI = sum(ep, "openInterest");
      return {
        date,
        days: daysTo(date, now),
        callOI: eCallOI,
        putOI: ePutOI,
        callVol: sum(ec, "volume"),
        putVol: sum(ep, "volume"),
        pcOI: pcRatio(eCallOI, ePutOI),
        atmIV: atmIvFor(contracts),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const trim = (r) => ({
    contract: r.contract,
    type: r.type,
    strike: r.strike,
    expiry: r.expiry,
    last: r.last,
    volume: r.volume,
    openInterest: r.openInterest,
    iv: r.iv,
  });
  const mostActive = [...rows]
    .filter((r) => r.volume > 0)
    .sort((a, b) => b.volume - a.volume || b.openInterest - a.openInterest)
    .slice(0, 8)
    .map(trim);
  const topOI = [...rows]
    .filter((r) => r.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest || b.volume - a.volume)
    .slice(0, 8)
    .map(trim);

  const iv30 = round(num(d.iv30), 1);

  return {
    generatedAt: new Date(now).toISOString(),
    symbol: d.symbol ?? "FRMI",
    quoteTime: d.last_trade_time ?? null,
    underlying: {
      price: round(spot, 2),
      change: round(num(d.price_change), 2),
      changePct: round(num(d.price_change_percent), 2),
      prevClose: round(num(d.prev_day_close), 2),
    },
    iv30,
    iv30ChangePct: round(num(d.iv30_change_percent), 2),
    totals: {
      contracts: rows.length,
      expirations: expirations.length,
      callOI,
      putOI,
      callVol,
      putVol,
      pcOI,
      pcVol: pcRatio(callVol, putVol),
    },
    sentiment: readSentiment(pcOI, iv30),
    expirations: expirations.slice(0, 8),
    mostActive,
    topOI,
    source: "Cboe (delayed)",
  };
}

// Fetch + summarize. Fail-open: returns null on any network/parse error so the
// collector never breaks on a bad options cycle.
export async function fetchFrmiOptions(symbol = "FRMI", now = Date.now()) {
  try {
    const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
    const res = await fetch(url, {
      headers: { "User-Agent": CBOE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn(`[options] Cboe returned ${res.status} — skipping options snapshot`);
      return null;
    }
    const json = await res.json();
    const summary = buildOptionsSummary(json, now);
    if (!summary) console.warn("[options] Cboe payload had no usable contracts — skipping");
    return summary;
  } catch (e) {
    console.warn(`[options] fetch failed (${e?.message ?? e}) — skipping options snapshot`);
    return null;
  }
}
