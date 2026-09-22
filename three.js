/**
 * btc-polymarket-paper-bot-final.js
 * Event-driven flow: new 15m window detected -> fetch data -> LLM decision -> check price -> paper bet.
 * PAPER MODE ONLY.
 *
 * npm i ws
 * Run: node btc-polymarket-paper-bot-final.js
 */

import fs from "fs";
import WebSocket from "ws";

const CONFIG = {
  binance: { symbol: "btcusdt", intervals: ["1m", "5m", "15m"], bufferSize: 60 },
  ollama: {
    host: "http://localhost:11434",
    model: "llama3.2:1b",
    keepAliveMinutes: 30,
    numPredict: 60,
    confidenceThreshold: 0.62,
  },
  polymarket: {
    gammaBase: "https://gamma-api.polymarket.com",
    wsMarketUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    slugPrefix: "btc-updown-15m", // confirm against live market before trusting
    windowSec: 900,
  },
  risk: {
    startingBalance: 1000,
    betFractionOfBalance: 0.05,
    minProfitIfWin: 0.05,
    maxProfitIfWin: 0.20,
  },
  ledgerFile: "./paper_ledger.json",
};

// ---------------- LEDGER ----------------
function loadLedger() {
  if (fs.existsSync(CONFIG.ledgerFile)) return JSON.parse(fs.readFileSync(CONFIG.ledgerFile, "utf-8"));
  return { balance: CONFIG.risk.startingBalance, trades: [], tradedMarketIds: [] };
}
function saveLedger(l) { fs.writeFileSync(CONFIG.ledgerFile, JSON.stringify(l, null, 2)); }

// ---------------- BINANCE WS FEED ----------------
class BinanceFeed {
  constructor() {
    this.buffers = { "1m": [], "5m": [], "15m": [] };
    this.readyPromise = this.init();
  }

  async init() {
    // Backfill instantly via REST so we don't wait on the WS to accumulate history
    await Promise.all(
      CONFIG.binance.intervals.map(async (interval) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${CONFIG.binance.symbol.toUpperCase()}&interval=${interval}&limit=${CONFIG.binance.bufferSize}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance backfill failed for ${interval}: ${res.status}`);
        const raw = await res.json();
        this.buffers[interval] = raw.map((k) => ({
          openTime: k[0],
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));
      })
    );
    console.log("[binance] backfilled history:", Object.fromEntries(
      Object.entries(this.buffers).map(([k, v]) => [k, v.length])
    ));
    this.connect(); // now switch to live WS updates on top of the backfilled data
  }

  connect() {
    const streams = CONFIG.binance.intervals.map((i) => `${CONFIG.binance.symbol}@kline_${i}`).join("/");
    this.ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    this.ws.on("message", (raw) => {
      const k = JSON.parse(raw).data?.k;
      if (!k) return;
      const buf = this.buffers[k.i];
      if (!buf) return;
      const candle = { openTime: k.t, close: parseFloat(k.c), volume: parseFloat(k.v) };
      if (buf.length && buf[buf.length - 1].openTime === candle.openTime) buf[buf.length - 1] = candle;
      else { buf.push(candle); if (buf.length > CONFIG.binance.bufferSize) buf.shift(); }
    });
    this.ws.on("close", () => setTimeout(() => this.connect(), 2000));
    this.ws.on("error", (e) => console.error("[binance-ws]", e.message));
  }

  ready() { return this.buffers["1m"].length > 25 && this.buffers["5m"].length > 20; }
}

// ---------------- INDICATORS ----------------
function ema(v, p) {
  if (v.length < p) return null;
  const k = 2 / (p + 1);
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}
function rsi(v, p = 14) {
  if (v.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = v.length - p; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function buildIndicators(feed) {
  const c1 = feed.buffers["1m"].map((c) => c.close);
  const v1 = feed.buffers["1m"].map((c) => c.volume);
  const last10 = v1.slice(-10), prev10 = v1.slice(-20, -10);
  const avgLast = last10.reduce((a, b) => a + b, 0) / (last10.length || 1);
  const avgPrev = prev10.reduce((a, b) => a + b, 0) / (prev10.length || 1);
  return {
    lastPrice: c1.at(-1),
    ema9: ema(c1, 9),
    ema21: ema(c1, 21),
    rsi14: rsi(c1, 14),
    chg15m: (((c1.at(-1) - c1[Math.max(0, c1.length - 15)]) / c1[Math.max(0, c1.length - 15)]) * 100).toFixed(3),
    volTrendPct: (avgPrev ? ((avgLast - avgPrev) / avgPrev) * 100 : 0).toFixed(2),
  };
}

// ---------------- OLLAMA DECISION ----------------
async function askOllama(ind) {
  const prompt = `BTC 15m direction. last=${ind.lastPrice} ema9=${ind.ema9?.toFixed(2)} ema21=${ind.ema21?.toFixed(2)} rsi=${ind.rsi14?.toFixed(1)} chg15m=${ind.chg15m}% volTrend=${ind.volTrendPct}%.
JSON only, this field order: {"direction":"UP"|"DOWN","confidence":0-1,"reasoning":"<8 words"}`;
  const res = await fetch(`${CONFIG.ollama.host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.ollama.model, prompt, stream: false, format: "json",
      keep_alive: `${CONFIG.ollama.keepAliveMinutes}m`,
      options: { temperature: 0.2, num_predict: CONFIG.ollama.numPredict },
    }),
  });
  if (!res.ok) throw new Error(`Ollama failed: ${res.status}`);
  const parsed = JSON.parse((await res.json()).response);
  if (!parsed.direction || typeof parsed.confidence !== "number") throw new Error("Malformed Ollama output");
  return parsed;
}

// ---------------- POLYMARKET: direct slug lookup + WS prices ----------------
async function fetchMarketBySlug(slug) {
  const res = await fetch(`${CONFIG.polymarket.gammaBase}/events/slug/${slug}`);
  if (!res.ok) return null;
  const ev = await res.json();
  const m = ev?.markets?.[0];
  if (!m || m.closed || m.active === false) return null;
  const endMs = new Date(m.endDate).getTime();
  if (endMs <= Date.now()) return null;
  try {
    return {
      id: m.id, slug: m.slug, question: m.question, endMs,
      outcomes: JSON.parse(m.outcomes),
      outcomePrices: JSON.parse(m.outcomePrices).map(Number),
      clobTokenIds: JSON.parse(m.clobTokenIds),
      conditionId: m.conditionId,
    };
  } catch { return null; }
}

function currentWindowStart() {
  return Math.floor(Math.floor(Date.now() / 1000) / CONFIG.polymarket.windowSec) * CONFIG.polymarket.windowSec;
}

async function findLiveMarket() {
  const start = currentWindowStart();
  for (const ts of [start, start + CONFIG.polymarket.windowSec]) {
    const m = await fetchMarketBySlug(`${CONFIG.polymarket.slugPrefix}-${ts}`);
    if (m) return m;
  }
  return null;
}

class PolymarketFeed {
  constructor() { this.bestPrices = {}; this.resolved = new Map(); this.subscribed = new Set(); this.connect(); }
  connect() {
    this.ws = new WebSocket(CONFIG.polymarket.wsMarketUrl);
    this.ws.on("open", () => this.subscribed.size && this._sub());
    this.ws.on("message", (raw) => {
      const events = JSON.parse(raw); const list = Array.isArray(events) ? events : [events];
      for (const e of list) {
        if (e.event_type === "best_bid_ask" && e.asset_id) this.bestPrices[e.asset_id] = { bid: +e.best_bid, ask: +e.best_ask };
        else if (e.event_type === "book" && e.asset_id) {
          const bid = e.bids?.[0]?.price ? +e.bids[0].price : null, ask = e.asks?.[0]?.price ? +e.asks[0].price : null;
          if (bid || ask) this.bestPrices[e.asset_id] = { bid, ask };
        } else if (e.event_type === "market_resolved") {
          this.resolved.set(e.condition_id, e.winning_outcome);
        }
      }
    });
    this.ws.on("close", () => setTimeout(() => this.connect(), 2000));
    this.ws.on("error", (e) => console.error("[pm-ws]", e.message));
  }
  _sub() { this.ws.send(JSON.stringify({ assets_ids: [...this.subscribed], type: "market", custom_feature_enabled: true })); }
  subscribe(ids) { let changed = false; for (const t of ids) if (!this.subscribed.has(t)) { this.subscribed.add(t); changed = true; } if (changed && this.ws.readyState === 1) this._sub(); }
  midPrice(id) { const p = this.bestPrices[id]; if (!p) return null; return p.bid && p.ask ? (p.bid + p.ask) / 2 : (p.ask || p.bid || null); }
  getResolution(conditionId) { const w = this.resolved.get(conditionId); if (w) this.resolved.delete(conditionId); return w || null; }
}

async function fetchResolutionRest(marketId) {
  const res = await fetch(`${CONFIG.polymarket.gammaBase}/markets/${marketId}`);
  if (!res.ok) return null;
  const m = await res.json();
  if (!m.closed) return null;
  const outcomes = JSON.parse(m.outcomes), prices = JSON.parse(m.outcomePrices).map(Number);
  const idx = prices.findIndex((p) => p >= 0.99);
  return idx === -1 ? null : outcomes[idx];
}

// ---------------- CORE PIPELINE: event live -> data -> decision -> bet ----------------
function impliedProfit(price) { return (1 - price) / price; }

async function runPipelineForMarket(market, ledger, binanceFeed, pmFeed) {
  if (ledger.tradedMarketIds.includes(market.id)) return; // 1 bet per event
  if (!binanceFeed.ready()) { console.log("[wait] Binance buffers still warming up"); return; }

  pmFeed.subscribe(market.clobTokenIds); // start streaming this event's live prices right away

  console.log(`[event live] ${market.question}`);
  const indicators = buildIndicators(binanceFeed);
  console.log("[data]", indicators);

  const decision = await askOllama(indicators);
  console.log("[decision]", decision);

  ledger.tradedMarketIds.push(market.id); // mark evaluated regardless of outcome below

  if (decision.confidence < CONFIG.ollama.confidenceThreshold) {
    console.log(`[no bet] confidence ${decision.confidence} below threshold`);
    saveLedger(ledger);
    return;
  }

  const idx = market.outcomes.findIndex((o) => o.toLowerCase() === decision.direction.toLowerCase());
  if (idx === -1) { console.log("[no bet] direction did not map to an outcome"); saveLedger(ledger); return; }

  const tokenId = market.clobTokenIds[idx];
  // give the WS a brief moment to deliver a live quote; fall back to Gamma snapshot price
  await new Promise((r) => setTimeout(r, 300));
  const price = pmFeed.midPrice(tokenId) ?? market.outcomePrices[idx];
  const profitIfWin = impliedProfit(price);

  console.log(`[pricing] side=${market.outcomes[idx]} price=${price.toFixed(3)} profitIfWin=${(profitIfWin * 100).toFixed(1)}%`);

  if (profitIfWin < CONFIG.risk.minProfitIfWin || profitIfWin > CONFIG.risk.maxProfitIfWin) {
    console.log("[no bet] implied profit outside 5-20% band");
    saveLedger(ledger);
    return;
  }

  const betAmount = ledger.balance * CONFIG.risk.betFractionOfBalance * decision.confidence;
  const shares = betAmount / price;
  ledger.balance -= betAmount;
  ledger.trades.push({
    marketId: market.id, conditionId: market.conditionId, slug: market.slug, question: market.question,
    side: market.outcomes[idx], entryPrice: price, betAmount: +betAmount.toFixed(2), shares: +shares.toFixed(4),
    reasoning: decision.reasoning, status: "OPEN", pnl: null, placedAt: new Date().toISOString(), resolveAfter: market.endMs,
  });
  saveLedger(ledger);
  console.log(`[PAPER BET PLACED] ${market.outcomes[idx]} @ ${price.toFixed(3)} | $${betAmount.toFixed(2)}`);
}

async function resolveOpenTrades(ledger, pmFeed) {
  const now = Date.now();
  const open = ledger.trades.filter((t) => t.status === "OPEN" && now > t.resolveAfter);
  for (const t of open) {
    const winner = pmFeed.getResolution(t.conditionId) ?? (await fetchResolutionRest(t.marketId));
    if (!winner) continue;
    const won = winner.toLowerCase() === t.side.toLowerCase();
    const payout = won ? t.shares : 0;
    t.status = won ? "WON" : "LOST";
    t.pnl = +(payout - t.betAmount).toFixed(2);
    t.resolvedAt = new Date().toISOString();
    ledger.balance += payout;
    console.log(`[RESOLVED] ${t.slug} -> ${t.status} | PnL=$${t.pnl} | balance=$${ledger.balance.toFixed(2)}`);
  }
  if (open.length) saveLedger(ledger);
}

// ---------------- MAIN: watch for the live event, react immediately ----------------
async function main() {
  const ledger = loadLedger();
  const binanceFeed = new BinanceFeed();
  await binanceFeed.readyPromise; // resolves almost immediately (one REST round-trip)

  const pmFeed = new PolymarketFeed();
  let lastSeenMarketId = null;
  console.log(`Starting. Paper balance: $${ledger.balance.toFixed(2)}`);

  setInterval(async () => {
    try {
      await resolveOpenTrades(ledger, pmFeed);
      const market = await findLiveMarket();
      if (!market) return;
      if (market.id !== lastSeenMarketId) {
        lastSeenMarketId = market.id;
        await runPipelineForMarket(market, ledger, binanceFeed, pmFeed);
      }
    } catch (err) {
      console.error("[error]", err.message);
    }
  }, 2000);
}

main();
