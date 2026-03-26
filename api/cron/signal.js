// Vercel Cron: auto-generates signal snapshots daily.
// Fetches live prices, Polymarket, runs AI signal, stores snapshot in KV.
// Configure in vercel.json: crons → /api/cron/signal
//
// Each snapshot stored as: signal_snap:{timestamp} → { prices, polymarket, signals, rulesVersion }
// Index stored as: signal_snap_index → sorted list of timestamps (last 500)

import { kv } from '@vercel/kv';

const SNAP_INDEX_KEY = 'signal_snap_index';
const MAX_SNAPS = 500;

export default async function handler(req, res) {
  // Vercel cron sends GET with Authorization header
  // Also allow manual trigger with RULES_SECRET
  const cronSecret = req.headers['authorization']?.replace('Bearer ', '');
  const isCron = cronSecret === process.env.CRON_SECRET;
  const isManual = cronSecret === process.env.RULES_SECRET;
  if (!isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!process.env.KV_REST_API_URL) return res.status(500).json({ error: 'Vercel KV not configured. Link a KV store in your Vercel project settings.' });

  const ts = new Date().toISOString();
  const errors = [];

  // 1. Fetch live prices (Yahoo + Hyperliquid in parallel)
  let yahooData = {};
  let hlData = {};
  let pmData = {};

  const positions = await getPositions();
  const tickers = [...positions.filter(p => p.type !== 'option').map(p => p.ticker), '^TNX', 'JPY=X'];

  const [yahooResult, hlResult, pmResult] = await Promise.allSettled([
    fetchYahooPrices(tickers, req),
    fetchHyperliquidPrices(),
    fetchPolymarketData(),
  ]);

  if (yahooResult.status === 'fulfilled') yahooData = yahooResult.value;
  else errors.push('yahoo: ' + yahooResult.reason?.message);

  if (hlResult.status === 'fulfilled') hlData = hlResult.value;
  else errors.push('hl: ' + hlResult.reason?.message);

  if (pmResult.status === 'fulfilled') pmData = pmResult.value;
  else errors.push('pm: ' + pmResult.reason?.message);
  for (const p of positions) {
    if (yahooData[p.ticker]) {
      p.lastPrice = yahooData[p.ticker];
      p.pnl = ((p.lastPrice - p.avg) * p.qty).toFixed(2);
    }
  }

  const liveData = {
    btc: hlData.BTC || yahooData['BTC-USD'] || null,
    wti: hlData['@107'] || null,
    gold: yahooData.GLD || null,
    ceasefire: pmData.ceasefire ?? null,
    opsEnd: pmData.opsEnd ?? null,
    hormuz: pmData.hormuz ?? null,
    mar31Ceasefire: pmData.mar31Ceasefire ?? null,
    militaryAction: pmData.militaryAction ?? null,
    ust10y: yahooData['^TNX'] || null,
    usdjpy: yahooData['JPY=X'] || null,
    sprCeiling: { low: 110, high: 115 },
  };

  let signals = [];
  let rulesVersion = 'n/a';
  try {
    const result = await generateSignals(apiKey, positions, liveData);
    signals = result.signals;
    rulesVersion = result.rulesVersion;
  } catch (e) {
    errors.push('signal: ' + e.message);
  }

  const prices = { ...yahooData, ...hlData };

  const snap = {
    ts,
    prices,
    polymarket: pmData,
    liveData,
    signals,
    positions: positions.map(p => ({
      ticker: p.ticker, qty: p.qty, avg: p.avg,
      lastPrice: p.lastPrice, pnl: p.pnl, label: p.label, type: p.type,
    })),
    rulesVersion,
    errors: errors.length ? errors : undefined,
  };

  try {
    const snapKey = `signal_snap:${ts}`;
    await kv.set(snapKey, JSON.stringify(snap), { ex: 60 * 60 * 24 * 90 }); // 90 day TTL

    // Update index
    await kv.lpush(SNAP_INDEX_KEY, ts);
    await kv.ltrim(SNAP_INDEX_KEY, 0, MAX_SNAPS - 1);
  } catch (e) {
    return res.status(500).json({ error: 'KV write failed: ' + e.message });
  }

  return res.status(200).json({
    ok: true,
    ts,
    signalCount: signals.length,
    priceCount: Object.keys(prices).length,
    errors: errors.length ? errors : undefined,
  });
}

// ── Fetch helpers ──

async function getPositions() {
  // Try KV first, then fall back to default
  try {
    const kvPos = await kv.get('positions');
    if (kvPos) return typeof kvPos === 'string' ? JSON.parse(kvPos) : kvPos;
  } catch (_) {}
  return DEFAULT_POSITIONS;
}

async function fetchYahooPrices(tickers, req) {
  const symbols = tickers.join(',');
  const base = getBaseUrl(req);
  const resp = await fetch(`${base}/api/yahoo?symbols=${encodeURIComponent(symbols)}`);
  if (!resp.ok) throw new Error('Yahoo ' + resp.status);
  const data = await resp.json();
  const result = {};
  if (data.quoteResponse?.result) {
    for (const q of data.quoteResponse.result) {
      if (q.symbol && q.regularMarketPrice) result[q.symbol] = q.regularMarketPrice;
    }
  }
  return result;
}

async function fetchHyperliquidPrices() {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  if (!resp.ok) throw new Error('HL ' + resp.status);
  const mids = await resp.json();
  const result = {};
  for (const [coin, price] of Object.entries(mids)) {
    result[coin] = parseFloat(price);
  }
  return result;
}

async function fetchPolymarketData() {
  const slugs = {
    ceasefire: 'will-there-be-a-ceasefire-in-the-israel-hamas-war-by-december-31-2026',
    opsEnd: 'will-trump-end-military-operations-by-june-30',
    hormuz: 'will-the-strait-of-hormuz-return-to-normal-by-april-30',
    mar31Ceasefire: 'us-x-iran-ceasefire-by-march-31',
    militaryAction: 'will-iran-take-military-action-by-march-31',
  };
  const entries = Object.entries(slugs);
  const results = await Promise.allSettled(entries.map(async ([, slug]) => {
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data[0]?.outcomePrices) return null;
    const prices = JSON.parse(data[0].outcomePrices);
    return Math.round(parseFloat(prices[0]) * 100);
  }));
  const result = {};
  entries.forEach(([key], i) => {
    if (results[i].status === 'fulfilled' && results[i].value != null) {
      result[key] = results[i].value;
    }
  });
  return result;
}

async function generateSignals(apiKey, positions, liveData) {
  // Import rules dynamically
  let rules, rulesVersion;
  try {
    const kvRules = await kv.get('trading_rules');
    if (kvRules) {
      rules = kvRules;
      rulesVersion = await kv.get('rules_version') || 'kv';
    }
  } catch (_) {}
  if (!rules) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    rules = readFileSync(join(dir, '../../rules/v3.1.md'), 'utf-8');
    rulesVersion = 'v3.1';
  }

  const context = `
LIVE MARKET DATA (as of ${new Date().toISOString()}):
- BTC: ${liveData.btc || 'n/a'}
- WTI (@107 perp): ${liveData.wti || 'n/a'}
- Gold: ${liveData.gold || 'n/a'}
- T1: Military action Mar 31: ${liveData.militaryAction ?? 'n/a'}% | Iran mil vs Israel: 100%
- T1: Hormuz normal Apr 15: ${liveData.hormuz ?? 'n/a'}% (sell FRO if >40%)
- T2: Ceasefire Apr 7: ${liveData.mar31Ceasefire ?? 'n/a'}% (FLAG 40% | STAGE 50% | TRIM 60%)
- T2: Ops-end Jun 30: ${liveData.opsEnd ?? 'n/a'}% (trim trigger at 80%)
- T2: US forces enter Iran Apr 30: rising — smart money YES
- T3: Ceasefire Dec 31: ${liveData.ceasefire ?? 'n/a'}% (9-month cumulative — NEVER trim on this)
- 10Y UST yield: ${liveData.ust10y ?? 'n/a'}% (ADD TLT ≥4.60, SPIRAL ≥4.70, 20Y hit 5.00%)
- USDJPY: ${liveData.usdjpy ?? 'n/a'} (STRESS if USDJPY×Oil >15,500)
- SPR swap ceiling: $110-115 (Wright rolling structure, NOT depleting)
- Apr 6 deadline: Trump energy pause expires 8pm ET
- IRGC navy commander Tangsiri killed Mar 26

POSITIONS:
${positions.map(p => `- ${p.ticker} (${p.label}): ${p.qty} shares @ $${p.avg}, last $${p.lastPrice || 'n/a'}`).join('\n')}
`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      temperature: 0.4,
      messages: [{ role: 'user', content: `You are a quantitative trading signal generator.

${rules}

${context}

For EACH position, output a JSON object with:
- ticker, buy (0-100), hold (0-100), sell (0-100), reasoning (1-2 sentences)
buy + hold + sell MUST equal 100.
Respond with ONLY a JSON array.` }],
    }),
  });

  if (!resp.ok) throw new Error('Claude ' + resp.status);
  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Parse failed');
  const signals = JSON.parse(match[0]).map(s => ({
    ticker: s.ticker,
    buy: Math.round(s.buy || 0),
    hold: Math.round(s.hold || 0),
    sell: Math.round(s.sell || 0),
    reasoning: s.reasoning || '',
  }));
  return { signals, rulesVersion };
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Default positions fallback (mirrors api/positions.js)
const DEFAULT_POSITIONS = [
  { ticker: 'GUSH', qty: 400, avg: 36.155, label: '2x oil E&P', type: 'stock' },
  { ticker: 'USO', qty: 125, avg: 111.602, label: 'WTI crude', type: 'stock' },
  { ticker: 'OILK', qty: 200, avg: 56.038, label: 'Roll-efficient oil', type: 'stock' },
  { ticker: 'SQQQ', qty: 100, avg: 78.985, label: 'Short QQQ 3x', type: 'stock' },
  { ticker: 'NTR', qty: 40, avg: 74.815, label: 'Diversified fert.', type: 'stock' },
  { ticker: 'CANE', qty: 200, avg: 10.485, label: 'Sugar ETF', type: 'stock' },
  { ticker: 'TLT Jun18 $84 Put', qty: 2, avg: 0, label: 'Bonds short', type: 'option' },
  { ticker: 'EWY Jun18 $100 Put', qty: 1, avg: 0, label: 'Korea short', type: 'option' },
  { ticker: "TSM Jan15'27 $185 Put", qty: 1, avg: 6.331, label: 'Taiwan tail', type: 'option' },
  { ticker: "TSM Jan15'27 $200 Put", qty: 1, avg: 8.051, label: 'Taiwan delta', type: 'option' },
  { ticker: 'JETS Jun18 $22 Put', qty: 10, avg: 1.262, label: 'Airlines short', type: 'option' },
];
