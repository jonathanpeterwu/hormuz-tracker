// Backtest API: scores historical signal snapshots against actual price outcomes.
//
// GET /api/backtest
//   ?limit=50        — number of snapshots to analyze (default 50)
//   ?horizon=24      — hours forward to measure outcome (default 24)
//   ?ticker=GUSH     — filter to single ticker
//   ?rulesVersion=v3 — filter to specific rules version
//
// Returns: { snapshots[], summary, accuracy }

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const horizon = parseInt(req.query.horizon) || 24; // hours
  const tickerFilter = req.query.ticker || null;
  const versionFilter = req.query.rulesVersion || null;

  try {
    if (!process.env.KV_REST_API_URL) {
      return res.status(200).json({
        snapshots: [],
        summary: { total: 0, message: 'Vercel KV not configured. Link a KV store in your Vercel project settings.' },
      });
    }

    const index = await kv.lrange('signal_snap_index', 0, limit + 50) || [];
    if (!index.length) {
      return res.status(200).json({
        snapshots: [],
        summary: { total: 0, message: 'No snapshots yet. Wait for cron to generate signal history.' },
      });
    }

    const snapKeys = index.slice(0, limit + 50).map(ts => `signal_snap:${ts}`);
    const rawSnaps = await kv.mget(...snapKeys);
    const allSnaps = rawSnaps
      .filter(Boolean)
      .map(s => typeof s === 'string' ? JSON.parse(s) : s)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    if (!allSnaps.length) {
      return res.status(200).json({ snapshots: [], summary: { total: 0 } });
    }

    const scored = [];
    const snapTimes = allSnaps.map(s => new Date(s.ts).getTime());
    const horizonMs = horizon * 3600 * 1000;

    for (let i = 0; i < allSnaps.length; i++) {
      const snap = allSnaps[i];
      if (!snap.signals?.length) continue;

      const snapTime = snapTimes[i];
      const targetTime = snapTime + horizonMs;
      let outcomeSnap = null;

      for (let j = i + 1; j < allSnaps.length; j++) {
        if (snapTimes[j] >= targetTime) {
          outcomeSnap = allSnaps[j];
          break;
        }
        outcomeSnap = allSnaps[j];
      }

      if (!outcomeSnap) continue;

      const actualHours = (new Date(outcomeSnap.ts).getTime() - snapTime) / 3600000;

      // Score each signal
      for (const sig of snap.signals) {
        if (tickerFilter && sig.ticker !== tickerFilter) continue;

        const entryPrice = snap.prices?.[sig.ticker] || null;
        const exitPrice = outcomeSnap.prices?.[sig.ticker] || null;

        if (!entryPrice || !exitPrice) continue;

        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;

        // Determine the dominant signal
        const dominant = sig.buy >= sig.hold && sig.buy >= sig.sell ? 'buy'
          : sig.sell >= sig.hold && sig.sell >= sig.buy ? 'sell'
          : 'hold';

        // Score: was the signal correct?
        // buy correct if price went up, sell correct if price went down, hold correct if < ±1%
        let correct;
        if (dominant === 'buy') correct = returnPct > 0;
        else if (dominant === 'sell') correct = returnPct < 0;
        else correct = Math.abs(returnPct) < 1;

        // Confidence-weighted score: how strongly the signal pointed in the dominant direction
        const confidence = sig[dominant];

        scored.push({
          ts: snap.ts,
          outcomeTs: outcomeSnap.ts,
          horizonHours: Math.round(actualHours * 10) / 10,
          ticker: sig.ticker,
          signal: { buy: sig.buy, hold: sig.hold, sell: sig.sell },
          dominant,
          confidence,
          reasoning: sig.reasoning,
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice: Math.round(exitPrice * 100) / 100,
          returnPct: Math.round(returnPct * 100) / 100,
          correct,
          rulesVersion: snap.rulesVersion || 'unknown',
        });
      }
    }

    // 4. Filter by rules version
    const filtered = versionFilter
      ? scored.filter(s => s.rulesVersion === versionFilter)
      : scored;

    const summary = computeSummary(filtered);
    const tickerStats = groupAndSummarize(filtered, s => s.ticker);
    const versionStats = groupAndSummarize(filtered, s => s.rulesVersion);

    // Return latest-first for display
    filtered.reverse();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      snapshots: filtered.slice(0, limit),
      summary,
      tickerStats,
      versionStats,
      horizon,
      totalSnapshots: index.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function groupAndSummarize(entries, keyFn) {
  const groups = {};
  for (const s of entries) {
    const k = keyFn(s);
    (groups[k] ||= []).push(s);
  }
  const stats = {};
  for (const [k, v] of Object.entries(groups)) stats[k] = computeSummary(v);
  return stats;
}

function computeSummary(entries) {
  if (!entries.length) return { total: 0 };

  const total = entries.length;
  const correctCount = entries.filter(e => e.correct).length;
  const accuracy = Math.round((correctCount / total) * 1000) / 10;

  const avgReturn = entries.reduce((sum, e) => sum + e.returnPct, 0) / total;
  const avgConfidence = entries.reduce((sum, e) => sum + e.confidence, 0) / total;

  // Signal-weighted return: return × (confidence/100) × direction multiplier
  const weightedReturn = entries.reduce((sum, e) => {
    const dir = e.dominant === 'buy' ? 1 : e.dominant === 'sell' ? -1 : 0;
    return sum + (e.returnPct * dir * e.confidence / 100);
  }, 0) / total;

  // Buy/sell/hold breakdown
  const buys = entries.filter(e => e.dominant === 'buy');
  const sells = entries.filter(e => e.dominant === 'sell');
  const holds = entries.filter(e => e.dominant === 'hold');

  return {
    total,
    correct: correctCount,
    accuracy,
    avgReturn: Math.round(avgReturn * 100) / 100,
    avgConfidence: Math.round(avgConfidence * 10) / 10,
    weightedReturn: Math.round(weightedReturn * 100) / 100,
    breakdown: {
      buy: { count: buys.length, accuracy: buys.length ? Math.round(buys.filter(e => e.correct).length / buys.length * 100) : 0 },
      sell: { count: sells.length, accuracy: sells.length ? Math.round(sells.filter(e => e.correct).length / sells.length * 100) : 0 },
      hold: { count: holds.length, accuracy: holds.length ? Math.round(holds.filter(e => e.correct).length / holds.length * 100) : 0 },
    },
  };
}
