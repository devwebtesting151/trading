/**
 * btc-polymarket-paper-bot.js
 * Paper-trading bot: Binance candles -> local Ollama LLM -> Polymarket BTC 15m Up/Down market
 * PAPER MODE ONLY. No real orders are ever placed.
 *
 * Run: node btc-polymarket-paper-bot.js
 */

import fs from "fs";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  binance: {
    symbol: "BTCUSDT",
    klineIntervals: ["1m", "5m", "15m"],
    klineLimit: 60,
  },
  ollama: {
    host: "http://localhost:11434",
    model: "llama3.1", // change to whatever model you've pulled
    confidenceThreshold: 0.62, // minimum model confidence to even consider a bet
  },
  polymarket: {
    gammaBase: "https://gamma-api.polymarket.com",
    clobBase: "https://clob.polymarket.com",
    searchTerms: ["Bitcoin Up or Down", "BTC Up or Down"],
    expectedDurationSec: 15 * 60,
    durationToleranceSec: 120, // allow some slack when matching "15 min" markets
  },
  risk: {
    startingBalance: 1000, // paper USD
    betFractionOfBalance: 0.05, // 5% of current balance per bet
    minProfitIfWin: 0.05, // 5%
    maxProfitIfWin: 0.20, // 20%
  },
  loop: {
    pollIntervalMs: 20_000, // check every 20s for new markets / resolutions
  },
  ledgerFile: "./paper_ledger.json",
};

// ---------------------------------------------------------------------------
// LEDGER (persisted paper trading state)
// ---------------------------------------------------------------------------
function loadLedger() {
  if (fs.existsSync(CONFIG.ledgerFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.ledgerFile, "utf-8"));
  }
  return {
    balance: CONFIG.risk.startingBalance,
    trades: [], // { marketId, slug, side, entryPrice, shares, betAmount, status, pnl, placedAt, resolvedAt }
    tradedMarketIds: [], // enforce 1 bet per event
  };
}

function saveLedger(ledger) {
  fs.writeFileSync(CONFIG.ledgerFile, JSON.stringify(ledger, null, 2));
}

// ---------------------------------------------------------------------------
// BINANCE: candles + volume
// ---------------------------------------------------------------------------
async function fetchKlines(interval) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${CONFIG.binance.symbol}&interval=${interval}&limit=${CONFIG.binance.klineLimit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines fetch failed: ${res.status}`);
  const raw = await res.json();
  // Binance kline fields: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...]
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
    trades: k[8],
  }));
}

async function fetch24hStats() {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${CONFIG.binance.symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance 24hr stats fetch failed: ${res.status}`);
  const d = await res.json();
  return {
    priceChangePercent: parseFloat(d.priceChangePercent),
    volume: parseFloat(d.volume),
    quoteVolume: parseFloat(d.quoteVolume),
    lastPrice: parseFloat(d.lastPrice),
  };
}

async function getMarketSnapshot() {
  const [m1, m5, m15, stats24h] = await Promise.all([
    fetchKlines("1m"),
    fetchKlines("5m"),
    fetchKlines("15m"),
    fetch24hStats(),
  ]);
  return {
    candles1m: m1,
    candles5m: m5,
    candles15m: m15,
    stats24h,
  };
}

// ---------------------------------------------------------------------------
// SIMPLE TECHNICAL INDICATORS (computed locally, fed into the LLM prompt)
// ---------------------------------------------------------------------------
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function buildIndicatorSummary(snapshot) {
  const closes1m = snapshot.candles1m.map((c) => c.close);
  const closes5m = snapshot.candles5m.map((c) => c.close);
  const vols1m = snapshot.candles1m.map((c) => c.volume);

  const last10Vol = vols1m.slice(-10);
  const prev10Vol = vols1m.slice(-20, -10);
  const avgLast10 = last10Vol.reduce((a, b) => a + b, 0) / (last10Vol.length || 1);
  const avgPrev10 = prev10Vol.reduce((a, b) => a + b, 0) / (prev10Vol.length || 1);
  const volumeTrendPct = avgPrev10 ? ((avgLast10 - avgPrev10) / avgPrev10) * 100 : 0;

  return {
    lastPrice: closes1m[closes1m.length - 1],
    ema9_1m: ema(closes1m, 9),
    ema21_1m: ema(closes1m, 21),
    sma20_5m: sma(closes5m, 20),
    rsi14_1m: rsi(closes1m, 14),
    priceChange15m: (
      ((closes1m[closes1m.length - 1] - closes1m[Math.max(0, closes1m.length - 15)]) /
        closes1m[Math.max(0, closes1m.length - 15)]) *
      100
    ).toFixed(3),
    volumeTrendPct: volumeTrendPct.toFixed(2),
    change24hPct: snapshot.stats24h.priceChangePercent,
  };
}

// ---------------------------------------------------------------------------
// OLLAMA: ask the local LLM for a directional call
// ---------------------------------------------------------------------------
async function askOllamaForDirection(indicators) {
  const prompt = `
You are a short-term BTC/USDT price direction classifier. You will predict whether BTC's price
will be HIGHER ("UP") or LOWER ("DOWN") than its current price approximately 15 minutes from now.

Current market data:
- Last price: ${indicators.lastPrice}
- EMA(9, 1m): ${indicators.ema9_1m}
- EMA(21, 1m): ${indicators.ema21_1m}
- SMA(20, 5m): ${indicators.sma20_5m}
- RSI(14, 1m): ${indicators.rsi14_1m}
- Price change over last 15 one-minute candles: ${indicators.priceChange15m}%
- Recent volume trend (last 10 vs prior 10 one-minute candles): ${indicators.volumeTrendPct}%
- 24h price change: ${indicators.change24hPct}%

Respond ONLY with a JSON object, no other text, in exactly this shape:
{"direction": "UP" or "DOWN", "confidence": number between 0 and 1, "reasoning": "one short sentence"}
`.trim();

  const res = await fetch(`${CONFIG.ollama.host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.ollama.model,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(data.response);
  } catch (e) {
    throw new Error(`Could not parse Ollama JSON response: ${data.response}`);
  }

  if (!parsed.direction || typeof parsed.confidence !== "number") {
    throw new Error(`Malformed Ollama response: ${JSON.stringify(parsed)}`);
  }
  return parsed; // { direction, confidence, reasoning }
}

// ---------------------------------------------------------------------------
// POLYMARKET: discover the active BTC 15-min Up/Down market
// ---------------------------------------------------------------------------
async function findActiveBtc15mMarket() {
  for (const term of CONFIG.polymarket.searchTerms) {
    const url = `${CONFIG.polymarket.gammaBase}/public-search?q=${encodeURIComponent(term)}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const events = data.events || [];

    const now = Date.now();

    for (const ev of events) {
      if (!ev.markets || !ev.markets.length) continue;
      for (const m of ev.markets) {
        if (m.closed || m.active === false) continue;
        if (!m.endDate) continue;

        const endMs = new Date(m.endDate).getTime();
        const startMs = m.createdAt ? new Date(m.createdAt).getTime() : null;
        const durationSec = startMs ? (endMs - startMs) / 1000 : null;

        const withinDuration =
          durationSec === null ||
          Math.abs(durationSec - CONFIG.polymarket.expectedDurationSec) <=
            CONFIG.polymarket.durationToleranceSec;

        const isFuture = endMs > now;
        const titleMatches = /up or down/i.test(m.question || ev.title || "");

        if (isFuture && titleMatches && withinDuration) {
          let outcomes, outcomePrices, clobTokenIds;
          try {
            outcomes = JSON.parse(m.outcomes);
            outcomePrices = JSON.parse(m.outcomePrices).map(Number);
            clobTokenIds = JSON.parse(m.clobTokenIds);
          } catch (e) {
            continue;
          }

          return {
            id: m.id,
            slug: m.slug,
            question: m.question,
            endDate: m.endDate,
            endMs,
            outcomes, // e.g. ["Up","Down"]
            outcomePrices, // e.g. [0.55, 0.45]
            clobTokenIds, // token ids matching outcomes order
            conditionId: m.conditionId,
          };
        }
      }
    }
  }
  return null;
}

// Get a fresher live price for a specific outcome token from the CLOB order book.
async function getClobMidPrice(tokenId) {
  try {
    const res = await fetch(`${CONFIG.polymarket.clobBase}/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const book = await res.json();
    const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
    const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
    if (bestBid && bestAsk) return (bestBid + bestAsk) / 2;
    return bestAsk || bestBid || null;
  } catch {
    return null;
  }
}

// Re-check a market later to see if it has resolved, and which side won.
async function fetchMarketResolution(marketId) {
  const res = await fetch(`${CONFIG.polymarket.gammaBase}/markets/${marketId}`);
  if (!res.ok) return null;
  const m = await res.json();
  if (!m.closed) return null; // not resolved yet

  let outcomes, outcomePrices;
  try {
    outcomes = JSON.parse(m.outcomes);
    outcomePrices = JSON.parse(m.outcomePrices).map(Number);
  } catch {
    return null;
  }
  // Winning outcome resolves to price 1, losing to 0
  const winnerIdx = outcomePrices.findIndex((p) => p >= 0.99);
  if (winnerIdx === -1) return null;
  return { winningOutcome: outcomes[winnerIdx] };
}

// ---------------------------------------------------------------------------
// DECISION + PAPER TRADE EXECUTION
// ---------------------------------------------------------------------------
function impliedProfitIfWin(entryPrice) {
  return (1 - entryPrice) / entryPrice;
}

async function evaluateAndMaybeTrade(ledger) {
  const market = await findActiveBtc15mMarket();
  if (!market) {
    console.log("[info] No active BTC 15m Up/Down market found right now.");
    return;
  }

  if (ledger.tradedMarketIds.includes(market.id)) {
    return; // already bet on this event — 1 bet per event rule
  }

  console.log(`[market] ${market.question} (id=${market.id}, ends ${market.endDate})`);

  const snapshot = await getMarketSnapshot();
  const indicators = buildIndicatorSummary(snapshot);
  console.log("[indicators]", indicators);

  const llmCall = await askOllamaForDirection(indicators);
  console.log("[ollama]", llmCall);

  if (llmCall.confidence < CONFIG.ollama.confidenceThreshold) {
    console.log(
      `[skip] Confidence ${llmCall.confidence} below threshold ${CONFIG.ollama.confidenceThreshold}`
    );
    return;
  }

  // Map LLM direction ("UP"/"DOWN") to the matching Polymarket outcome index.
  const outcomeIdx = market.outcomes.findIndex(
    (o) => o.toLowerCase() === llmCall.direction.toLowerCase()
  );
  if (outcomeIdx === -1) {
    console.log(`[skip] Could not map direction "${llmCall.direction}" to market outcomes`, market.outcomes);
    return;
  }

  const tokenId = market.clobTokenIds[outcomeIdx];
  const livePrice = (await getClobMidPrice(tokenId)) ?? market.outcomePrices[outcomeIdx];

  const profitIfWin = impliedProfitIfWin(livePrice);
  console.log(
    `[pricing] side=${market.outcomes[outcomeIdx]} price=${livePrice.toFixed(
      3
    )} impliedProfitIfWin=${(profitIfWin * 100).toFixed(1)}%`
  );

  if (profitIfWin < CONFIG.risk.minProfitIfWin || profitIfWin > CONFIG.risk.maxProfitIfWin) {
    console.log(
      `[skip] Implied profit ${(profitIfWin * 100).toFixed(1)}% outside target band ` +
        `[${CONFIG.risk.minProfitIfWin * 100}%-${CONFIG.risk.maxProfitIfWin * 100}%]`
    );
    ledger.tradedMarketIds.push(market.id); // don't keep re-evaluating this same event
    saveLedger(ledger);
    return;
  }

  // Size the paper bet
  const betAmount = ledger.balance * CONFIG.risk.betFractionOfBalance * llmCall.confidence;
  const shares = betAmount / livePrice;

  const trade = {
    marketId: market.id,
    slug: market.slug,
    question: market.question,
    side: market.outcomes[outcomeIdx],
    entryPrice: livePrice,
    betAmount: Number(betAmount.toFixed(2)),
    shares: Number(shares.toFixed(4)),
    reasoning: llmCall.reasoning,
    confidence: llmCall.confidence,
    status: "OPEN",
    pnl: null,
    placedAt: new Date().toISOString(),
    resolveAfter: market.endMs,
    resolvedAt: null,
  };

  ledger.balance -= trade.betAmount; // paper: reserve the stake
  ledger.trades.push(trade);
  ledger.tradedMarketIds.push(market.id);
  saveLedger(ledger);

  console.log(
    `[PAPER TRADE PLACED] ${trade.side} on "${trade.question}" — $${trade.betAmount} @ ${trade.entryPrice.toFixed(
      3
    )} (${trade.shares} shares)`
  );
}

async function checkAndResolveOpenTrades(ledger) {
  const now = Date.now();
  const openTrades = ledger.trades.filter((t) => t.status === "OPEN" && now > t.resolveAfter + 30_000);

  for (const trade of openTrades) {
    const result = await fetchMarketResolution(trade.marketId);
    if (!result) continue; // not resolved yet on Polymarket's side

    const won = result.winningOutcome.toLowerCase() === trade.side.toLowerCase();
    const payout = won ? trade.shares * 1.0 : 0;
    const pnl = payout - trade.betAmount;

    trade.status = won ? "WON" : "LOST";
    trade.pnl = Number(pnl.toFixed(2));
    trade.resolvedAt = new Date().toISOString();
    ledger.balance += payout; // return payout (stake was already deducted at entry)

    console.log(
      `[RESOLVED] ${trade.question} -> winner=${result.winningOutcome} | your side=${trade.side} | ` +
        `${trade.status} | PnL=$${trade.pnl} | balance=$${ledger.balance.toFixed(2)}`
    );
  }

  if (openTrades.length) saveLedger(ledger);
}

// ---------------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------------
async function mainLoop() {
  const ledger = loadLedger();
  console.log(`\n=== Paper balance: $${ledger.balance.toFixed(2)} | Trades so far: ${ledger.trades.length} ===`);

  try {
    await checkAndResolveOpenTrades(ledger);
    await evaluateAndMaybeTrade(ledger);
  } catch (err) {
    console.error("[error]", err.message);
  }
}

console.log("Starting BTC 15m Polymarket paper-trading bot (PAPER MODE — no real orders).");
mainLoop();
setInterval(mainLoop, CONFIG.loop.pollIntervalMs);
