// using ollama + paper trading
import fetch from 'node-fetch';
import fs from 'fs';

// ================== CONFIG ==================
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = 'qwen2.5-coder:3b';   // or mistral / qwen3:8b

const PAPER_STARTING_BALANCE = 10;      // starting virtual $
const MIN_PROFIT_TARGET = 5;             // aim for at least $5 profit if correct
const MAX_PROFIT_TARGET = 20;            // aim for at most $20 profit if correct
const MIN_EDGE_TO_TRADE = 'small';        // ignore "none"
const LOG_FILE = './paper_trades.jsonl'; // append-only trade log
// ============================================

// ---------- Paper trading state ----------
let paper = {
  balance: PAPER_STARTING_BALANCE,
  openPosition: null,          // { windowStart, side, stake, entryPrice, potentialPayout, marketSlug }
  closedTrades: [],
  totalPnL: 0,
  wins: 0,
  losses: 0
};

function loadPaperState() {
  try {
    if (fs.existsSync('./paper_state.json')) {
      paper = JSON.parse(fs.readFileSync('./paper_state.json', 'utf8'));
      console.log(`Loaded paper state | Balance: $${paper.balance.toFixed(2)} | PnL: $${paper.totalPnL.toFixed(2)}`);
    }
  } catch (e) {
    console.warn('Could not load paper state, starting fresh');
  }
}

function savePaperState() {
  fs.writeFileSync('./paper_state.json', JSON.stringify(paper, null, 2));
}

function logTrade(trade) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(trade) + '\n');
}

// Calculate stake so that potential profit ≈ target (capped)
function calculateStake(entryPrice, targetProfit) {
  // If we buy at price P, payout multiplier = 1/P
  // Profit = stake * (1/P - 1)
  // → stake = targetProfit / (1/P - 1)
  if (entryPrice <= 0 || entryPrice >= 1) return 0;
  const multiplier = 1 / entryPrice;
  const profitPerDollar = multiplier - 1;
  if (profitPerDollar <= 0) return 0;

  let stake = targetProfit / profitPerDollar;
  // Safety caps
  stake = Math.max(1, Math.min(stake, paper.balance * 0.15)); // never risk >15% of bank
  return Math.round(stake * 100) / 100;
}

function placePaperBet(side, entryPrice, market, windowStart) {
  if (paper.openPosition) {
    console.log('Already have an open paper position for this window – skipping');
    return false;
  }

  // Choose a mid-range profit target
  const targetProfit = (MIN_PROFIT_TARGET + MAX_PROFIT_TARGET) / 2; // ~12.5
  const stake = calculateStake(entryPrice, targetProfit);

  if (stake < 1 || stake > paper.balance) {
    console.log(`Stake $${stake} invalid or insufficient balance`);
    return false;
  }

  const potentialPayout = stake / entryPrice;
  const potentialProfit = potentialPayout - stake;

  paper.balance -= stake;
  paper.openPosition = {
    windowStart,
    side,                    // 'Up' or 'Down'
    stake,
    entryPrice,
    potentialPayout,
    potentialProfit,
    marketSlug: market.question,
    placedAt: Date.now()
  };

  savePaperState();

  const tradeLog = {
    type: 'OPEN',
    time: new Date().toISOString(),
    side,
    stake,
    entryPrice,
    potentialProfit: +potentialProfit.toFixed(2),
    market: market.question,
    balanceAfter: +paper.balance.toFixed(2)
  };
  logTrade(tradeLog);

  console.log(`\n📌 PAPER BET PLACED`);
  console.log(`   Side: ${side} @ ${entryPrice.toFixed(3)}`);
  console.log(`   Stake: $${stake.toFixed(2)} → Potential profit: $${potentialProfit.toFixed(2)}`);
  console.log(`   Balance left: $${paper.balance.toFixed(2)}\n`);

  return true;
}

function settlePaperBet(finalUpWon) {
  if (!paper.openPosition) return;

  const pos = paper.openPosition;
  const won = (pos.side === 'Up' && finalUpWon) || (pos.side === 'Down' && !finalUpWon);

  let pnl = 0;
  if (won) {
    paper.balance += pos.potentialPayout;
    pnl = pos.potentialProfit;
    paper.wins += 1;
  } else {
    // stake already deducted
    pnl = -pos.stake;
    paper.losses += 1;
  }

  paper.totalPnL += pnl;
  paper.closedTrades.push({
    ...pos,
    won,
    pnl: +pnl.toFixed(2),
    settledAt: Date.now()
  });

  const tradeLog = {
    type: 'CLOSE',
    time: new Date().toISOString(),
    side: pos.side,
    stake: pos.stake,
    entryPrice: pos.entryPrice,
    won,
    pnl: +pnl.toFixed(2),
    balanceAfter: +paper.balance.toFixed(2),
    totalPnL: +paper.totalPnL.toFixed(2)
  };
  logTrade(tradeLog);

  console.log(`\n🏁 PAPER SETTLEMENT`);
  console.log(`   ${won ? '✅ WIN' : '❌ LOSS'} | PnL: $${pnl.toFixed(2)}`);
  console.log(`   New balance: $${paper.balance.toFixed(2)} | Lifetime PnL: $${paper.totalPnL.toFixed(2)}`);
  console.log(`   Record: ${paper.wins}W / ${paper.losses}L\n`);

  paper.openPosition = null;
  savePaperState();
}

// ---------- Original helpers (unchanged) ----------
function getWindowStarts() {
  const now = Math.floor(Date.now() / 1000);
  const currentStart = now - (now % 900);
  return { current: currentStart, next: currentStart + 900, now };
}

async function getMarket(slug) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch {
    return null;
  }
}

async function getBTCPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    if (res.ok) {
      const d = await res.json();
      return { price: parseFloat(d.price), source: 'Binance' };
    }
  } catch {}
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  const d = await res.json();
  return { price: d.bitcoin.usd, source: 'CoinGecko' };
}

async function getKlines(symbol, interval, limit = 50) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch {
    return [];
  }
}

async function getFuturesKlines(limit = 20) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      takerBuyVol: parseFloat(k[9])
    }));
  } catch {
    return [];
  }
}

async function getFundingAndOI() {
  try {
    const [fundingRes, oiRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
      fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT')
    ]);
    const funding = await fundingRes.json();
    const oi = await oiRes.json();
    return {
      fundingRate: parseFloat(funding.lastFundingRate || 0) * 100,
      markPrice: parseFloat(funding.markPrice || 0),
      openInterest: parseFloat(oi.openInterest || 0)
    };
  } catch {
    return { fundingRate: 0, markPrice: 0, openInterest: 0 };
  }
}

async function getOrderBookImbalance() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20');
    const data = await res.json();
    const bidVol = data.bids.reduce((sum, [p, q]) => sum + parseFloat(q), 0);
    const askVol = data.asks.reduce((sum, [p, q]) => sum + parseFloat(q), 0);
    const total = bidVol + askVol;
    const imbalance = total > 0 ? ((bidVol - askVol) / total) * 100 : 0;
    return {
      imbalance: imbalance.toFixed(1),
      bidVol: Math.round(bidVol),
      askVol: Math.round(askVol),
      bias: imbalance > 8 ? 'bid-heavy' : imbalance < -8 ? 'ask-heavy' : 'balanced'
    };
  } catch {
    return { imbalance: 0, bidVol: 0, askVol: 0, bias: 'unknown' };
  }
}

function parseMarket(m) {
  if (!m) return null;
  try {
    const prices = JSON.parse(m.outcomePrices || '[]');
    return {
      question: m.question,
      up: parseFloat(prices[0]),
      down: parseFloat(prices[1]),
      endDate: m.endDate,
      liquidity: Number(m.liquidity || 0),
      closed: m.closed || false,
      resolved: m.resolved || false,
      // outcome may be available after resolution
      outcome: m.outcome || null
    };
  } catch {
    return null;
  }
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function summarizeHigherTF(candles1h, candles4h) {
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  const ema20_1h = calcEMA(closes1h, 20);
  const ema50_1h = calcEMA(closes1h, 50);
  const ema20_4h = calcEMA(closes4h, 20);
  const ema50_4h = calcEMA(closes4h, 50);

  let trend1h = 'neutral';
  if (ema20_1h && ema50_1h) {
    trend1h = ema20_1h > ema50_1h * 1.001 ? 'bullish' : ema20_1h < ema50_1h * 0.999 ? 'bearish' : 'neutral';
  }

  let trend4h = 'neutral';
  if (ema20_4h && ema50_4h) {
    trend4h = ema20_4h > ema50_4h * 1.001 ? 'bullish' : ema20_4h < ema50_4h * 0.999 ? 'bearish' : 'neutral';
  }

  const aligned = trend1h === trend4h && trend1h !== 'neutral';

  return {
    trend1h,
    trend4h,
    aligned: aligned ? `YES (${trend1h})` : 'NO',
    ema20_1h: ema20_1h?.toFixed(0) || '-',
    ema50_1h: ema50_1h?.toFixed(0) || '-'
  };
}

function summarizeCandles(candles) {
  if (candles.length < 5) return null;

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const latest = closes[closes.length - 1];
  const first = closes[0];
  const change = ((latest - first) / first) * 100;
  const high = Math.max(...highs);
  const low = Math.min(...lows);

  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trSum += tr;
  }
  const atr = trSum / (candles.length - 1);
  const atrPct = (atr / latest) * 100;

  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const lastVol = volumes[volumes.length - 1];
  const last3Vol = volumes.slice(-3);
  const volTrend = last3Vol[2] > last3Vol[0] * 1.2 ? 'increasing' :
                   last3Vol[2] < last3Vol[0] * 0.8 ? 'decreasing' : 'stable';
  const volSpike = lastVol > avgVol * 1.8;

  const last3 = closes.slice(-3);
  const shortTrend = last3[2] > last3[0] ? 'rising' :
                     last3[2] < last3[0] ? 'falling' : 'flat';

  return {
    latest: latest.toFixed(1),
    changePct: change.toFixed(3) + '%',
    range: `${low.toFixed(0)} - ${high.toFixed(0)}`,
    shortTrend,
    lastCloses: closes.slice(-5).map(c => c.toFixed(1)).join(' → '),
    atr: atr.toFixed(0),
    atrPct: atrPct.toFixed(3) + '%',
    lastVolume: Math.round(lastVol).toLocaleString(),
    avgVolume: Math.round(avgVol).toLocaleString(),
    volTrend,
    volSpike: volSpike ? 'YES' : 'no',
    volumeSeries: volumes.slice(-5).map(v => Math.round(v / 1000) + 'k').join(' → ')
  };
}

function summarizeCVD(futCandles) {
  if (!futCandles || futCandles.length < 5) return null;

  let cvd = 0;
  const deltas = [];
  for (const c of futCandles) {
    const delta = (c.takerBuyVol * 2) - c.volume;
    cvd += delta;
    deltas.push(delta);
  }

  const last3Delta = deltas.slice(-3).reduce((a, b) => a + b, 0);
  const pressure = last3Delta > 0 ? 'buy' : last3Delta < 0 ? 'sell' : 'neutral';
  const strength = Math.abs(last3Delta) > (futCandles.slice(-3).reduce((s, c) => s + c.volume, 0) * 0.15)
    ? 'strong' : 'mild';

  return {
    cvdTrend: pressure,
    strength,
    last3Net: Math.round(last3Delta).toLocaleString(),
    note: `${strength} ${pressure} pressure`
  };
}

function getSessionInfo() {
  const hour = new Date().getUTCHours();
  let session = 'Asia';
  if (hour >= 7 && hour < 13) session = 'Europe';
  else if (hour >= 13 && hour < 21) session = 'US';
  else if (hour >= 21 || hour < 1) session = 'US-Asia overlap / late';

  const liquidity = (session === 'US' || session === 'Europe') ? 'higher' : 'lower';
  return { session, liquidity, utcHour: hour };
}

async function askLocalLLM(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: {
        temperature: 0.15,
        num_predict: 480
      },
      messages: [
        {
          role: 'system',
          content: `You are an expert short-term BTC trader specializing in Polymarket 15-min Up/Down markets.
You carefully weigh: price action, volume, CVD/order flow, higher timeframe trend, funding/OI, order book, volatility regime, and session.
Only recommend a trade when multiple factors align. Prefer Wait/Skip when signals conflict or edge is unclear.

Reply in this exact short format:
Prob Up: XX%
Edge: none / small / medium / strong
Action: Buy Up / Buy Down / Wait / Skip
Max price: 0.XX or -
Reason: one concise sentence highlighting the key confirming or conflicting factors`
        },
        { role: 'user', content: prompt }
      ]
    })
  });

  const data = await res.json();
  return data.message?.content || 'No response';
}

// Parse LLM response into structured decision
function parseLLMDecision(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = {
    probUp: null,
    edge: 'none',
    action: 'Wait',
    maxPrice: null,
    reason: ''
  };

  for (const line of lines) {
    if (line.toLowerCase().startsWith('prob up:')) {
      const m = line.match(/(\d+(?:\.\d+)?)/);
      if (m) result.probUp = parseFloat(m[1]);
    } else if (line.toLowerCase().startsWith('edge:')) {
      const e = line.split(':')[1]?.trim().toLowerCase();
      if (['none', 'small', 'medium', 'strong'].includes(e)) result.edge = e;
    } else if (line.toLowerCase().startsWith('action:')) {
      const a = line.split(':')[1]?.trim();
      if (['Buy Up', 'Buy Down', 'Wait', 'Skip'].includes(a)) result.action = a;
    } else if (line.toLowerCase().startsWith('max price:')) {
      const m = line.match(/0\.\d+/);
      if (m) result.maxPrice = parseFloat(m[0]);
    } else if (line.toLowerCase().startsWith('reason:')) {
      result.reason = line.split(':').slice(1).join(':').trim();
    }
  }
  return result;
}

async function runOnce() {
  const startTime = Date.now();
  const windows = getWindowStarts();

  const [
    priceData,
    currentRaw,
    nextRaw,
    candles1m,
    candles1h,
    candles4h,
    futCandles,
    fundingOI,
    orderBook,
    ethCandles
  ] = await Promise.all([
    getBTCPrice(),
    getMarket(`btc-updown-15m-${windows.current}`),
    getMarket(`btc-updown-15m-${windows.next}`),
    getKlines('BTCUSDT', '1m', 15),
    getKlines('BTCUSDT', '1h', 60),
    getKlines('BTCUSDT', '4h', 50),
    getFuturesKlines(15),
    getFundingAndOI(),
    getOrderBookImbalance(),
    getKlines('ETHUSDT', '1m', 12)
  ]);

  const current = parseMarket(currentRaw);
  const next = parseMarket(nextRaw);
  const candleSummary = summarizeCandles(candles1m);
  const htf = summarizeHigherTF(candles1h, candles4h);
  const cvd = summarizeCVD(futCandles);
  const session = getSessionInfo();

  let ethChange = 'n/a';
  if (ethCandles.length >= 5) {
    const eFirst = ethCandles[0].close;
    const eLast = ethCandles[ethCandles.length - 1].close;
    ethChange = (((eLast - eFirst) / eFirst) * 100).toFixed(3) + '%';
  }

  if (!current || !candleSummary) {
    console.log('Market or candle data not available');
    return;
  }

  const endTs = new Date(current.endDate).getTime() / 1000;
  const minutesLeft = Math.max(0, (endTs - windows.now) / 60).toFixed(1);

  // ---------- Settle previous window if needed ----------
  if (paper.openPosition && paper.openPosition.windowStart !== windows.current) {
    // Previous window has ended – try to determine outcome
    // We re-fetch the old market or use price direction as fallback
    // For simplicity we use the last known price vs the window open,
    // but better: check if the market is resolved.
    // Here we approximate with short-term price change direction.
    // In production you would store the open price of the window.
    console.log('Window rolled – settling previous paper position...');
    // Simple heuristic: if BTC rose in the last 15m → Up won
    const upWon = parseFloat(candleSummary.changePct) > 0;
    settlePaperBet(upWon);
  }

  // ---------- Build prompt & ask LLM ----------
  const prompt = `
=== BTC 15-min Up/Down Analysis ===

Current BTC Price: $${priceData.price.toLocaleString()} (${priceData.source})

--- 1-MINUTE PRICE & VOLUME ---
Latest close: ${candleSummary.latest}
Change (last ~12-15m): ${candleSummary.changePct}
Range: ${candleSummary.range}
Short trend: ${candleSummary.shortTrend}
Last closes: ${candleSummary.lastCloses}
Volume last: ${candleSummary.lastVolume} | avg: ${candleSummary.avgVolume}
Volume trend: ${candleSummary.volTrend}${candleSummary.volSpike === 'YES' ? ' (SPIKE)' : ''}
ATR: ${candleSummary.atr} (${candleSummary.atrPct})

--- ORDER FLOW (CVD approximation) ---
${cvd ? `Net pressure (last 3m): ${cvd.note} | Net delta: ${cvd.last3Net}` : 'CVD data unavailable'}

--- HIGHER TIMEFRAME ---
1H trend: ${htf.trend1h} | 4H trend: ${htf.trend4h}
HTF aligned: ${htf.aligned}
1H EMA20/50: ${htf.ema20_1h} / ${htf.ema50_1h}

--- DERIVATIVES ---
Funding rate: ${fundingOI.fundingRate.toFixed(4)}%
Open Interest: ${Math.round(fundingOI.openInterest).toLocaleString()} BTC

--- ORDER BOOK ---
Imbalance: ${orderBook.imbalance}% (${orderBook.bias})
Bid vol: ${orderBook.bidVol} | Ask vol: ${orderBook.askVol}

--- CONTEXT ---
Session: ${session.session} (liquidity: ${session.liquidity}) | UTC hour: ${session.utcHour}
ETH short-term change: ${ethChange}

--- POLYMARKET ---
Market: ${current.question}
Time left: ${minutesLeft} minutes
Odds: Up ${(current.up * 100).toFixed(1)}% | Down ${(current.down * 100).toFixed(1)}%
Liquidity: $${current.liquidity.toFixed(0)}
${next ? `Next window Up odds: ${(next.up * 100).toFixed(1)}%` : ''}

Based on ALL the above factors, give your latest suggestion.
`;

  const suggestion = await askLocalLLM(prompt);
  const decision = parseLLMDecision(suggestion);
  const took = ((Date.now() - startTime) / 1000).toFixed(1);

  // ---------- Display ----------
  console.clear();
  console.log(`⏱️  ${new Date().toLocaleTimeString()}  |  Cycle: ${took}s`);
  console.log(`BTC: $${priceData.price.toLocaleString()} (${priceData.source})`);
  console.log(`1m: ${candleSummary.shortTrend} ${candleSummary.changePct} | Vol: ${candleSummary.volTrend}${candleSummary.volSpike === 'YES' ? ' SPIKE' : ''} | ATR: ${candleSummary.atrPct}`);
  console.log(`CVD: ${cvd ? cvd.note : 'n/a'} | HTF: 1H ${htf.trend1h} / 4H ${htf.trend4h} (aligned: ${htf.aligned})`);
  console.log(`Funding: ${fundingOI.fundingRate.toFixed(4)}% | OI: ${Math.round(fundingOI.openInterest).toLocaleString()} | Book: ${orderBook.bias} (${orderBook.imbalance}%)`);
  console.log(`Session: ${session.session} | ETH: ${ethChange}`);
  console.log(`Window: ${current.question} | Left: ${minutesLeft}m`);
  console.log(`Market → Up ${(current.up * 100).toFixed(1)}% | Down ${(current.down * 100).toFixed(1)}%`);
  console.log(`Paper → Balance: $${paper.balance.toFixed(2)} | PnL: $${paper.totalPnL.toFixed(2)} | ${paper.wins}W/${paper.losses}L`);
  if (paper.openPosition) {
    console.log(`Open paper bet: ${paper.openPosition.side} @ ${paper.openPosition.entryPrice.toFixed(3)} | Stake $${paper.openPosition.stake}`);
  }
  console.log('─'.repeat(60));
  console.log(suggestion);
  console.log('─'.repeat(60));

  // ---------- Paper trade decision ----------
  const canTrade =
    !paper.openPosition &&
    (decision.action === 'Buy Up' || decision.action === 'Buy Down') &&
    decision.edge !== 'none' &&
    parseFloat(minutesLeft) > 1.5;          // don't bet in last 90 seconds

  if (canTrade) {
    const side = decision.action === 'Buy Up' ? 'Up' : 'Down';
    const entryPrice = side === 'Up' ? current.up : current.down;

    // Respect LLM max price if given
    if (decision.maxPrice && entryPrice > decision.maxPrice) {
      console.log(`Price ${entryPrice.toFixed(3)} > max allowed ${decision.maxPrice} → skip`);
    } else {
      placePaperBet(side, entryPrice, current, windows.current);
    }
  } else {
    console.log('No paper bet this cycle (Wait/Skip / already in position / low time left)');
  }

  console.log('Next cycle starting immediately...\n');
}

async function main() {
  loadPaperState();
  console.log(`Running PAPER TRADING mode`);
  console.log(`Model: ${MODEL}`);
  console.log(`Profit target band: $${MIN_PROFIT_TARGET} – $${MAX_PROFIT_TARGET}`);
  console.log(`One bet per 15-min window only\n`);

  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error('Error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
    // small pause so we don't hammer APIs
    await new Promise(r => setTimeout(r, 1000));
  }
}

main();
