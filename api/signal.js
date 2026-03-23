// Self-annealing LLM signal generator (Karpathy-style iterative refinement)
// Uses Claude API to generate buy/hold/sell probabilities per position
// with critique → refine loop at decreasing temperature.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const RULES_V3 = `
HORMUZ TRACKER — TRADING RULES v3 (Mar 23 2026)

THESIS: Iran/Hormuz disruption drives oil supply squeeze. Long oil (GUSH, USO, OILK),
short tech (SQQQ), gold hedge (GLD), ag exposure (CF, NTR, CANE), tail puts (JETS, TSM, EWY).

SIGNAL HIERARCHY:
- Tier 1 (physical): Vessel count, daily transits, Fujairah damage — unmanipulable, highest weight
- Tier 2 (market-implied): Polymarket probabilities, options flow, credit spreads
- Tier 3 (verbal): Trump/official statements, social media — lowest weight, often noise
- T1 overrides T3 when diverged.

DELEVERAGING RULE v2 — requires ALL THREE simultaneously:
1. Oil -10%+ intraday (not -5%, filters Trump announcement noise)
2. Physical confirmation: vessel count dropping (from 2,500 toward 2,000) OR transits >20/day
3. Polymarket Tier 1 shift: ops-end Jun 30 >80% held 24h AND Iran mil vs Israel <70%
If only 1-2 of 3: HOLD — do NOT trim.

SPR CLOCK OVERRIDE:
If SPR cover <10 days remaining → NO oil trim regardless of price.
Oil flush during SPR drawdown = market mispricing supply fix that isn't coming.
Currently active through ~late April 2026.

TRUMP ANNOUNCEMENT FILTER:
If oil drops on Trump verbal + Iran denies within 24h + vessel count unchanged →
automatic HOLD regardless of price magnitude.

FORCED LIQUIDATION (market-wide cascade):
Oil + BTC + SOX all -10%+ same session + VIX >40 →
close 30% oil ONLY (not 50%), 25% cash, wait 72h.
This is margin call cascade, not thesis death.

CEASEFIRE INTERPRETATION:
Dec 31 ceasefire is CUMULATIVE (war ends sometime in 2026), NOT imminent.
Real trim trigger is ops-end Jun 30 at 80% held 24h, not ceasefire Dec 31.
Ceasefire ≠ supply restoration: post-deal Fujairah needs weeks, mine clearance 4-8 weeks,
2,500 vessels need weeks to clear, Goldman says elevated through 2027.

POSITION-SPECIFIC RULES:
- GUSH +40-50% from entry → aggressive trim zone
- Oil positions: trim levels at BNO $65-68, $75-80; USO $138-142
- SQQQ: hedge, hold while risk-off persists, size up if BTC <65K
- GLD/ag: neutral hold, low conviction to trim
- Options: let ride to expiry unless thesis invalidated

OUTPUT: For each position, output {buy, hold, sell} probabilities summing to 100.
buy = add to position, hold = maintain, sell = trim/exit.
`;

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

  // Build context snapshot
  const context = `
LIVE MARKET DATA (as of ${new Date().toISOString()}):
- BTC: ${liveData.btc || 'n/a'}
- WTI (@107 perp): ${liveData.wti || 'n/a'}
- Gold (via GLD): ${liveData.gold || 'n/a'}
- Polymarket — Ceasefire Dec 31: ${liveData.ceasefire ?? 'n/a'}%
- Polymarket — Ops-end Jun 30: ${liveData.opsEnd ?? 'n/a'}%
- Polymarket — Hormuz normal Apr 30: ${liveData.hormuz ?? 'n/a'}%
- SPR override active: ${liveData.sprOverride !== false ? 'YES (through ~late April)' : 'NO (expired)'}

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

${RULES_V3}

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

${RULES_V3}

${context}

PREVIOUS SIGNAL OUTPUT:
${JSON.stringify(parsed, null, 2)}

CRITIQUE INSTRUCTIONS:
1. Check each signal against the v3 rules. Are any signals WRONG?
2. Is the SPR clock override being respected? (If active, oil sell signals should be suppressed)
3. Is the Trump announcement filter being applied? (If oil dropped on verbal + Iran denial, sell should be suppressed)
4. Is ceasefire being treated as cumulative (low weight) not imminent (high weight)?
5. Are ops-end thresholds correct? (Only >80% triggers trim)
6. Does forced liquidation require ALL conditions (oil+BTC+SOX -10% + VIX >40)?

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
