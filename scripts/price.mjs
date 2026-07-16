// Keyless FRMI price fetch for the daily brief. Uses Yahoo Finance's public v8
// chart endpoint (no API key, no crumb needed for this route) with a browser
// User-Agent — Yahoo rejects bot-styled agents. Returns a small quote object or
// null on any failure; the brief degrades gracefully (the live TradingView chart
// on the page still shows the real-time price regardless).
//
// Note: this endpoint is end-of-day/lightly-delayed and unofficial. It's used
// only for the brief's summary line, never for anything actionable.

const YF_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

// range=1mo/interval=1d gives ~21 daily closes — enough for a day-over-day change
// and a trailing-window move without a second request.
export async function fetchFrmiPrice(symbol = "FRMI") {
  for (const host of HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": YF_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta ?? {};
      const stamps = result.timestamp ?? [];
      const rawCloses = result.indicators?.quote?.[0]?.close ?? [];

      // Pair each close with its timestamp, then drop null closes (Yahoo pads
      // holidays/half-days with nulls). Keeps day and window math honest.
      const series = rawCloses
        .map((c, i) => ({ close: c, ts: stamps[i] }))
        .filter((p) => Number.isFinite(p.close));
      if (series.length < 1) continue;

      const last = series[series.length - 1];
      const price = Number.isFinite(meta.regularMarketPrice)
        ? meta.regularMarketPrice
        : last.close;
      const prevClose = series.length >= 2 ? series[series.length - 2].close : null;
      const changePct =
        prevClose != null ? ((price - prevClose) / prevClose) * 100 : null;

      const first = series[0];
      const windowDays = series.length;
      const windowChangePct =
        first.close ? ((price - first.close) / first.close) * 100 : null;

      const asOfSec = Number.isFinite(meta.regularMarketTime)
        ? meta.regularMarketTime
        : last.ts;
      const asOf = Number.isFinite(asOfSec)
        ? new Date(asOfSec * 1000).toISOString().slice(0, 10)
        : null;

      return {
        symbol,
        price: round2(price),
        prevClose: prevClose != null ? round2(prevClose) : null,
        changePct: changePct != null ? round2(changePct) : null,
        windowChangePct: windowChangePct != null ? round2(windowChangePct) : null,
        windowDays,
        asOf,
        currency: meta.currency ?? "USD",
      };
    } catch {
      /* try the next host, then fail open */
    }
  }
  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
