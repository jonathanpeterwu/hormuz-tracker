// Self-annealing LLM signal generator (Karpathy-style iterative refinement)
// Uses Claude API to generate buy/hold/sell probabilities per position
// with critique → refine loop at decreasing temperature.

import { kv } from '@vercel/kv';
import { rules as fileRules, rulesVersion as fileVersion } from '../rules/current.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// Load rules: KV (hot-swappable) → filesystem (fallback)
async function loadRules() {
  try {
    const kvRules = await kv.get('trading_rules');
    if (kvRules) {
      const kvVersion = await kv.get('rules_version') || 'kv';
      return { rules: kvRules, version: kvVersion, source: 'kv' };
    }
  } catch (_) { /* KV not configured, use file */ }
  return { rules: fileRules, version: fileVersion, source: 'file' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { positions, liveData, passes = 2 } = req.body;
  if (!positions || !liveData) {
    return res.status(400).json({ error: 'positions and liveData required' });
  }

  // Load active rules (KV → file fallback)
  const { rules: RULES, version: rulesVersion, source: rulesSource } = await loadRules();

  // Build context snapshot
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
- Apr 6 deadline: Trump energy pause expires 8pm ET. Iran 5 conditions = no deal likely.
- IRGC navy commander Tangsiri killed Mar 26 — enforcement chain disrupted short-term

POSITIONS:
${positions.map(p => {
  const cost = p.qty * p.avg;
  const retPct = p.lastPrice ? (((p.lastPrice - p.avg) / p.avg) * 100).toFixed(1) : 'n/a';
  return `- ${p.ticker} (${p.label}): ${p.qty} shares @ $${p.avg}, last $${p.lastPrice || 'n/a'}, P&L $${p.pnl || 0} (${retPct}%), type=${p.type}, bg=${p.bg}`;
}).join('\n')}
`;

  try {
    // Pass 1: Generate initial signals
    let signals = await callClaude(apiKey, [
      { role: 'user', content: `You are a quantitative trading signal generator for the Hormuz oil disruption thesis portfolio.

${RULES}

${context}

For EACH position, output a JSON object with:
- ticker: the position ticker
- buy: probability 0-100 (add to position)
- hold: probability 0-100 (maintain)
- sell: probability 0-100 (trim/exit)
- reasoning: 1-2 sentence explanation referencing specific rule triggers

buy + hold + sell MUST equal 100 for each position.

Respond with ONLY a JSON array, no other text. Example:
[{"ticker":"GUSH","buy":10,"hold":60,"sell":30,"reasoning":"..."},...]` }
    ], 0.7);

    // Parse initial signals
    let parsed = parseSignals(signals);
    if (!parsed) return res.status(500).json({ error: 'Failed to parse initial signals' });

    // Pass 2+: Self-critique and refine (annealing — lower temperature each pass)
    for (let i = 1; i < Math.min(passes, 3); i++) {
      const temp = Math.max(0.2, 0.7 - (i * 0.25)); // 0.7 → 0.45 → 0.2
      const critique = await callClaude(apiKey, [
        { role: 'user', content: `You are reviewing trading signals for correctness against the v3 rules.

${RULES}

${context}

PREVIOUS SIGNAL OUTPUT:
${JSON.stringify(parsed, null, 2)}

CRITIQUE INSTRUCTIONS:
1. Check each signal against the v3 rules. Are any signals WRONG?
2. Is the SPR clock override being respected? (If active, oil sell signals should be suppressed)
3. Is the Trump announcement filter being applied? (If oil dropped on verbal + Iran denial, sell should be suppressed)
4. Is ceasefire Dec 31 treated as 9-month cumulative (LOW weight) not imminent? It should NEVER drive a trim.
5. Is ceasefire Mar 31 (if >35%) given HIGH weight as a near-term specific outcome?
6. Are T1 signals (military action, Hormuz, physical) given priority over T3 (ceasefire Dec 31)?
7. Are ops-end thresholds correct? (Only ≥80% held 24h triggers trim, and requires physical confirmation)
8. Does forced liquidation require ALL conditions (oil+BTC+SOX -10% + VIX >40)?

Output the CORRECTED JSON array with updated buy/hold/sell values and reasoning that references your corrections.
Respond with ONLY a JSON array, no other text.` }
      ], temp);

      const refined = parseSignals(critique);
      if (refined) parsed = refined;
    }

    // Add metadata
    const result = {
      signals: parsed,
      passes: Math.min(passes, 3),
      model: 'claude-sonnet-4-20250514',
      rulesVersion,
      rulesSource,
      generatedAt: new Date().toISOString(),
    };

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(result);

  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

async function callClaude(apiKey, messages, temperature) {
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      temperature,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

function parseSignals(text) {
  try {
    // Extract JSON array from response (handle markdown code blocks)
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;
    // Validate and normalize
    return arr.map(s => ({
      ticker: s.ticker,
      buy: Math.max(0, Math.min(100, Math.round(s.buy || 0))),
      hold: Math.max(0, Math.min(100, Math.round(s.hold || 0))),
      sell: Math.max(0, Math.min(100, Math.round(s.sell || 0))),
      reasoning: s.reasoning || '',
    })).map(s => {
      // Normalize to sum to 100
      const sum = s.buy + s.hold + s.sell;
      if (sum === 0) return { ...s, buy: 0, hold: 100, sell: 0 };
      return {
        ...s,
        buy: Math.round(s.buy / sum * 100),
        sell: Math.round(s.sell / sum * 100),
        hold: 100 - Math.round(s.buy / sum * 100) - Math.round(s.sell / sum * 100),
      };
    });
  } catch {
    return null;
  }
}
