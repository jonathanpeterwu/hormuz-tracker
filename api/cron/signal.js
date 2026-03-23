// Vercel Cron: auto-generates signal snapshots every 30 min.
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

  const ts = new Date().toISOString();
  const errors = [];

  // 1. Fetch live prices (Yahoo + Hyperliquid in parallel)
  let yahooData = {};
  let hlData = {};
  let pmData = {};

  const tickers = await getPositionTickers();

  const [yahooResult, hlResult, pmResult] = await Promise.allSettled([
    fetchYahooPrices(tickers, req),
    fetchHyperliquidPrices(req),
    fetchPolymarketData(req),
  ]);

  if (yahooResult.status === 'fulfilled') yahooData = yahooResult.value;
  else errors.push('yahoo: ' + yahooResult.reason?.message);

  if (hlResult.status === 'fulfilled') hlData = hlResult.value;
  else errors.push('hl: ' + hlResult.reason?.message);

  if (pmResult.status === 'fulfilled') pmData = pmResult.value;
  else errors.push('pm: ' + pmResult.reason?.message);

  // 2. Build positions with live prices
  const positions = await getPositions();
  for (const p of positions) {
    if (yahooData[p.ticker]) {
      p.lastPrice = yahooData[p.ticker];
      p.pnl = ((p.lastPrice - p.avg) * p.qty).toFixed(2);
    }
  }

  // 3. Build liveData for signal API
  const liveData = {
    btc: hlData.BTC || yahooData['BTC-USD'] || null,
    wti: hlData['@107'] || null,
    gold: yahooData.GLD || null,
    ceasefire: pmData.ceasefire ?? null,
    opsEnd: pmData.opsEnd ?? null,
    hormuz: pmData.hormuz ?? null,
    sprOverride: true, // through ~late April 2026
  };

  // 4. Generate AI signals via internal signal logic
  let signals = [];
  try {
    signals = await generateSignals(apiKey, positions, liveData);
  } catch (e) {
    errors.push('signal: ' + e.message);
  }

  // 5. Build price snapshot (all tickers + crypto + commodities)
  const prices = {};
  for (const [k, v] of Object.entries(yahooData)) prices[k] = v;
  for (const [k, v] of Object.entries(hlData)) prices[k] = v;

  // 6. Store snapshot in KV
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
    rulesVersion: signals.length ? 'from_signal' : 'n/a',
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

async function getPositionTickers() {
  const positions = await getPositions();
  return positions.filter(p => p.type !== 'option').map(p => p.ticker);
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

async function fetchHyperliquidPrices(req) {
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

async function fetchPolymarketData(req) {
  const slugs = {
    ceasefire: 'will-there-be-a-ceasefire-in-the-israel-hamas-war-by-december-31-2026',
    opsEnd: 'will-trump-end-military-operations-by-june-30',
    hormuz: 'will-the-strait-of-hormuz-return-to-normal-by-april-30',
  };
  const result = {};
  for (const [key, slug] of Object.entries(slugs)) {
    try {
      const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
      if (resp.ok) {
        const data = await resp.json();
        if (data[0]?.outcomePrices) {
          const prices = JSON.parse(data[0].outcomePrices);
          result[key] = Math.round(parseFloat(prices[0]) * 100);
        }
      }
    } catch (_) {}
  }
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
    rules = readFileSync(join(dir, '../../rules/v3.md'), 'utf-8');
    rulesVersion = 'v3';
  }

  const context = `
LIVE MARKET DATA (as of ${new Date().toISOString()}):
- BTC: ${liveData.btc || 'n/a'}
- WTI (@107 perp): ${liveData.wti || 'n/a'}
- Gold (via GLD): ${liveData.gold || 'n/a'}
- Polymarket — Ceasefire Dec 31: ${liveData.ceasefire ?? 'n/a'}%
- Polymarket — Ops-end Jun 30: ${liveData.opsEnd ?? 'n/a'}%
- Polymarket — Hormuz normal Apr 30: ${liveData.hormuz ?? 'n/a'}%
- SPR override active: ${liveData.sprOverride ? 'YES' : 'NO'}

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
  return JSON.parse(match[0]).map(s => ({
    ticker: s.ticker,
    buy: Math.round(s.buy || 0),
    hold: Math.round(s.hold || 0),
    sell: Math.round(s.sell || 0),
    reasoning: s.reasoning || '',
  }));
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Default positions (mirrors frontend defaults)
const DEFAULT_POSITIONS = [
  { ticker: 'GUSH', qty: 100, avg: 23.50, label: '3x Oil Bull', type: 'stock' },
  { ticker: 'USO', qty: 200, avg: 68.00, label: 'Oil Fund', type: 'stock' },
  { ticker: 'SQQQ', qty: 150, avg: 9.80, label: '3x Short QQQ', type: 'stock' },
  { ticker: 'GLD', qty: 50, avg: 215.00, label: 'Gold', type: 'stock' },
  { ticker: 'CF', qty: 100, avg: 78.00, label: 'CF Industries', type: 'stock' },
];
