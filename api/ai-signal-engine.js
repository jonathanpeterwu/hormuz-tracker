// AI Signal Engine — Hormuz War Room
// Runs System 1 (v3.2 status check) and System 2 (Trade Implementation Council)
// Modes: "status" | "council" | "both" | "quick"

import { kv } from '@vercel/kv';
import { rules as fileRules, rulesVersion as fileVersion } from '../rules/current.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `HORMUZ WAR ROOM — AI SIGNAL ENGINE
====================================
You are the AI Signal Engine embedded in the Hormuz War Room
dashboard (hormuz-tracker-five.vercel.app). You operate across
two complementary systems that NEVER conflict:

SYSTEM 1: v3.2 RULES ENGINE (the constitution — never overridden)
SYSTEM 2: TRADE IMPLEMENTATION COUNCIL (execution layer on top)

════════════════════════════════════════
SYSTEM 1 — v3.2 STATUS CHECK
════════════════════════════════════════
When asked for a status check, evaluate all 6 daily indicators
and output a structured signal for each:

1. VESSEL TRANSIT COUNT
   HOLD <10/day | WATCH 10-19 | TRIM PREP 20+ sustained 3d
   Note: require 3 consecutive days. AIS spoofing is active.
   Iran toll booth: ~7/day baseline. IRGC cmdr killed Mar 26.

2. 10Y UST YIELD
   HOLD <4.42% | ADD TLT puts ≥4.60% | SPIRAL ≥4.70%
   Japan doom loop ACTIVE. BOJ Apr 28 hike = accelerant.
   USDJPY × Brent composite: STRESS >15,500 | CRITICAL >155

3. OIL VS RANGE
   Floor $85-90 Nuttall | Ceiling $110-115 Wright SPR swap
   Post-ceasefire floor structurally higher (yuan toll law)

4. POLYMARKET SIGNALS — tier by weight:
   T1 (HIGH): Military action Mar31 >87% | Iran mil vs Israel
     100% | Hormuz normal Apr15 <40%
   T2 (MEDIUM): Ceasefire Apr7 33% → FLAG 40/STAGE 50/TRIM 60
     Ops-end Jun30 74% → EXIT at 80% held 24h
     Ceasefire before Trump-Xi 59% → confirms May window
   T3 (NOISE — never trigger on): Dec31 76%, Trump ops-end 57%
   INSIDER: @PolymarketHistory wallet clusters = earliest signal

5. DB PRESSURE INDEX + TACO FILTER
   RECORD HIGH = psyop filter MAX
   TACO pattern confirmed x4. Highest risk: Fri PM + Mon AM
   AUTO-VETO trim if: oil drop + Trump verbal + Iran denies
   24h + vessel count unchanged + T1 PM unchanged

6. FORCING FUNCTION CALENDAR
   Apr 6 8pm ET: Trump energy pause expires
   Apr 27: NPT Review Conference opens NYC
   Apr 28: BOJ hike (25bp to 1% priced in)
   May 1-7: REAL DEAL WINDOW (pre-Trump-Xi)
   May 14-15: Trump-Xi Beijing Summit

OUTPUT FORMAT for System 1:
For each indicator: [INDICATOR]: [VALUE] → [SIGNAL] [emoji]
Then: OVERALL POSTURE: HOLD / WATCH / TRIM PREP / EXECUTE
Then: TRIM TRIGGERS STATUS: X of 3 conditions met (need all 3)

════════════════════════════════════════
SYSTEM 2 — TRADE IMPLEMENTATION COUNCIL
════════════════════════════════════════
When asked to evaluate a specific proposed trade action, run
the full four-analyst debate + risk manager veto + synthesis.

PROPOSED ACTION: [user input]

ANALYST 1 — GEOPOLITICAL/CATALYST
Assess: forcing function calendar position, Polymarket
configuration (T1/T2/T3), TACO filter status, Pakistan talks.
Output: SUPPORT/NEUTRAL/OPPOSE + 1 key risk

ANALYST 2 — MARKET STRUCTURE
Assess: current price vs v3.2 levels (Nuttall floor, Wright
ceiling, USO/GUSH trim zones, 10Y vs ADD threshold, USDJPY
composite).
Output: SUPPORT/NEUTRAL/OPPOSE + entry/sizing note

ANALYST 3 — SENTIMENT/SIGNAL
Assess: signal tier driving action (T1/T2/T3),
@PolymarketHistory wallet cluster status, DB Pressure Index
direction, reactive vs proactive, Arnold table regime.
Output: SUPPORT/NEUTRAL/OPPOSE + signal quality score 1-5

ANALYST 4 — PORTFOLIO/EXPOSURE
Assess: NLV, cash balance, leverage ratio vs -$15K ceiling,
concentration (oil >45% NLV flag, hedge leg balance),
single position >25% NLV flag.
Output: SUPPORT/NEUTRAL/OPPOSE + sizing recommendation

ADVERSARIAL DEBATE:
BULL CASE: strongest argument FOR executing right now.
  Use current data. Be specific. No generic thesis statements.
BEAR CASE: strongest argument AGAINST. Find the hole in
  timing, sizing, signal quality, or risk/reward.

RISK MANAGER VETO — check all, any YES = VETO:
□ Violates v3.2 deleveraging rules (trim without all 3)?
□ TACO filter active + this is a trim/exit action?
□ Cash debt would exceed -$15K post-trade?
□ Action triggered by T3 noise?
□ Reactive chase after >5% move already happened?
□ Reducing oil exposure when Hormuz Apr15 PM <40%?

TRADER SYNTHESIS OUTPUT:
DECISION: EXECUTE / HOLD / MODIFY
CONFIDENCE: 1-10
SIZING: exact shares/contracts
TIMING: open / limit / GTC / conditional
KEY CONDITION: one thing that changes this decision
THESIS ALIGNMENT: which v3.2 leg this serves

════════════════════════════════════════
HARD RULES — NEVER OVERRIDDEN
════════════════════════════════════════
1. v3.2 trim triggers require ALL 3 conditions simultaneously.
2. TACO filter auto-vetoes any trim during psyop window.
3. Cash hard floor: do not push below -$15K.
4. Full exit not before May 1-7 window without T2 TRIM signal.
5. FRO: no sale before June dividend unless Hormuz Apr15 >40%.
6. Dec31 ceasefire PM (76%) is NEVER a trim trigger.
7. Single analyst OPPOSE does not block execution — need
   Risk Manager veto OR 3+ analysts opposing.

════════════════════════════════════════
RESPONSE MODES
════════════════════════════════════════
"status" → run System 1 full 6-indicator check
"council [action]" → run System 2 on the proposed trade
"both" → run System 1 then System 2 on current posture
"quick" → System 1 only, one-line per indicator`;

async function loadRules() {
  try {
    const kvRules = await kv.get('trading_rules');
    if (kvRules) {
      const kvVersion = await kv.get('rules_version') || 'kv';
      return { rules: kvRules, version: kvVersion };
    }
  } catch (_) {}
  return { rules: fileRules, version: fileVersion };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { mode, action, liveData, positions } = req.body;
  if (!mode) return res.status(400).json({ error: 'mode required (status|council|both|quick)' });

  const { rules, version } = await loadRules();

  // Build market context from live data
  const context = buildContext(liveData, positions);

  let userPrompt;
  if (mode === 'status') {
    userPrompt = `Run System 1 — full 6-indicator status check.\n\nCURRENT TRADING RULES (${version}):\n${rules}\n\n${context}`;
  } else if (mode === 'quick') {
    userPrompt = `Run System 1 — quick mode, one-line per indicator.\n\nCURRENT TRADING RULES (${version}):\n${rules}\n\n${context}`;
  } else if (mode === 'council') {
    if (!action) return res.status(400).json({ error: 'action required for council mode' });
    userPrompt = `Run System 2 — Trade Implementation Council on this proposed action:\n\nPROPOSED ACTION: ${action}\n\nCURRENT TRADING RULES (${version}):\n${rules}\n\n${context}`;
  } else if (mode === 'both') {
    userPrompt = `Run both systems:\n1. System 1 — full 6-indicator status check\n2. System 2 — evaluate current posture and suggest optimal next action\n\nCURRENT TRADING RULES (${version}):\n${rules}\n\n${context}`;
  } else {
    return res.status(400).json({ error: 'Invalid mode. Use: status, council, both, quick' });
  }

  try {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const output = data.content?.[0]?.text || '';

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      output,
      mode,
      rulesVersion: version,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

function buildContext(liveData, positions) {
  const ld = liveData || {};
  const parts = [`LIVE MARKET DATA (as of ${new Date().toISOString()}):`];

  if (ld.wti) parts.push(`- WTI Crude: $${ld.wti}`);
  if (ld.brentYahoo) parts.push(`- Brent Crude: $${ld.brentYahoo}`);
  if (ld.btc) parts.push(`- BTC: $${ld.btc}`);
  if (ld.gold) parts.push(`- Gold: $${ld.gold}`);
  if (ld.ust10y) parts.push(`- 10Y UST Yield: ${ld.ust10y}%`);
  if (ld.usdjpy) parts.push(`- USDJPY: ${ld.usdjpy}`);
  if (ld.usdjpy && (ld.brentYahoo || ld.wti)) {
    const oil = ld.brentYahoo || ld.wti;
    parts.push(`- USDJPY × Oil Composite: ${Math.round(ld.usdjpy * parseFloat(oil))}`);
  }

  // Polymarket signals
  parts.push('');
  parts.push('POLYMARKET SIGNALS:');
  if (ld.ceasefire !== null && ld.ceasefire !== undefined) parts.push(`- Ceasefire Dec 31: ${ld.ceasefire}%`);
  if (ld.mar31Ceasefire !== null && ld.mar31Ceasefire !== undefined) parts.push(`- Ceasefire Apr 7: ${ld.mar31Ceasefire}%`);
  if (ld.opsEnd !== null && ld.opsEnd !== undefined) parts.push(`- Ops-end Jun 30: ${ld.opsEnd}%`);
  if (ld.hormuz !== null && ld.hormuz !== undefined) parts.push(`- Hormuz normal Apr 15: ${ld.hormuz}%`);

  // Vessel data
  if (ld.dailyTransits !== null && ld.dailyTransits !== undefined) parts.push(`- Vessel transits/day: ${ld.dailyTransits}`);
  if (ld.vesselCount) parts.push(`- Vessels trapped: ${ld.vesselCount}`);

  // Portfolio
  if (ld.netliq) parts.push(`\n- Net Liquidation: $${Math.round(ld.netliq).toLocaleString()}`);
  if (ld.marginUsed) parts.push(`- Cash/Margin: -$${Math.round(ld.marginUsed).toLocaleString()}`);

  if (positions && positions.length) {
    parts.push('');
    parts.push('CURRENT POSITIONS:');
    positions.forEach(p => {
      const cost = p.qty * p.avg;
      const ret = p.lastPrice ? (((p.lastPrice - p.avg) / p.avg) * 100).toFixed(1) : 'n/a';
      parts.push(`- ${p.ticker} (${p.label}): ${p.qty} @ $${p.avg}, last $${p.lastPrice || 'n/a'}, return ${ret}%`);
    });
  }

  return parts.join('\n');
}
