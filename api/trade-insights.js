// Trade Insights — Secondary rules engine for homepage suggestions
// Generates actionable trade insight cards based on current market data + v3.2 rules
// Lightweight: single-pass, focused output format for UI cards

import { kv } from '@vercel/kv';
import { rules as fileRules, rulesVersion as fileVersion } from '../rules/current.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const INSIGHT_SYSTEM = `You are the Trade Insights Engine for the Hormuz War Room dashboard.
Your job is to generate 3-5 actionable trade insight cards based on current market data and v3.2 trading rules.

Each insight should be:
- Specific and actionable (not generic)
- Grounded in v3.2 rules (reference specific thresholds)
- Prioritized by urgency and impact
- Honest about uncertainty

HARD RULES:
- v3.2 trim requires ALL 3 conditions
- TACO filter auto-vetoes trims during psyop windows
- Dec 31 ceasefire is NEVER a trim trigger
- FRO: no sale before June dividend unless Hormuz Apr15 >40%

Output ONLY a JSON array. Each object:
{
  "type": "action" | "watch" | "warning" | "info",
  "urgency": "high" | "medium" | "low",
  "title": "Short headline (max 60 chars)",
  "body": "1-2 sentence explanation with specific numbers",
  "ticker": "relevant ticker or null",
  "rule": "v3.2 rule reference"
}

Sort by urgency (high first). Return 3-5 insights maximum.
Respond with ONLY the JSON array, no other text.`;

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

  const { liveData, positions } = req.body;
  if (!liveData) return res.status(400).json({ error: 'liveData required' });

  const { rules, version } = await loadRules();

  const ld = liveData;
  const context = [];
  context.push(`CURRENT TRADING RULES (${version}):`);
  context.push(rules);
  context.push('');
  context.push(`LIVE DATA (${new Date().toISOString()}):`);
  if (ld.wti) context.push(`WTI: $${ld.wti}`);
  if (ld.brentYahoo) context.push(`Brent: $${ld.brentYahoo}`);
  if (ld.ust10y) context.push(`10Y UST: ${ld.ust10y}%`);
  if (ld.usdjpy) context.push(`USDJPY: ${ld.usdjpy}`);
  if (ld.usdjpy && (ld.brentYahoo || ld.wti)) {
    context.push(`Composite: ${Math.round(ld.usdjpy * parseFloat(ld.brentYahoo || ld.wti))}`);
  }
  if (ld.ceasefire !== null && ld.ceasefire !== undefined) context.push(`Ceasefire Dec31: ${ld.ceasefire}%`);
  if (ld.mar31Ceasefire !== null && ld.mar31Ceasefire !== undefined) context.push(`Ceasefire Apr7: ${ld.mar31Ceasefire}%`);
  if (ld.opsEnd !== null && ld.opsEnd !== undefined) context.push(`Ops-end Jun30: ${ld.opsEnd}%`);
  if (ld.hormuz !== null && ld.hormuz !== undefined) context.push(`Hormuz normal: ${ld.hormuz}%`);
  if (ld.dailyTransits !== null && ld.dailyTransits !== undefined) context.push(`Transits/day: ${ld.dailyTransits}`);
  if (ld.btc) context.push(`BTC: $${ld.btc}`);
  if (ld.gold) context.push(`Gold: $${ld.gold}`);

  // Day of week for TACO filter
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  context.push(`Day: ${dow}`);

  if (positions && positions.length) {
    context.push('');
    context.push('POSITIONS:');
    positions.forEach(p => {
      const ret = p.lastPrice ? (((p.lastPrice - p.avg) / p.avg) * 100).toFixed(1) + '%' : 'n/a';
      context.push(`${p.ticker}: ${p.qty} @ $${p.avg}, last $${p.lastPrice || 'n/a'}, ret ${ret}`);
    });
  }

  context.push('');
  context.push('Generate 3-5 trade insight cards based on this data. Focus on what changed, what is approaching a threshold, and what action (if any) to take today.');

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
        max_tokens: 1500,
        temperature: 0.4,
        system: INSIGHT_SYSTEM,
        messages: [{ role: 'user', content: context.join('\n') }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'Failed to parse insights' });

    const insights = JSON.parse(match[0]);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      insights,
      rulesVersion: version,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
