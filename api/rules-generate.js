// Uses Claude to generate a new rules version based on current rules + user instructions.
// POST /api/rules-generate
//   { instructions: "tighten SPR window", currentRules: "...", currentVersion: "v3" }
// Returns: { rules: "new rules text", version: "v3.1", changelog: "..." }

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  // Auth check
  const secret = process.env.RULES_SECRET;
  if (!secret) return res.status(500).json({ error: 'RULES_SECRET not configured' });
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== secret) return res.status(401).json({ error: 'Invalid token' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { instructions, currentRules, currentVersion } = req.body;
  if (!currentRules || !instructions) {
    return res.status(400).json({ error: 'instructions and currentRules required' });
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
        messages: [{
          role: 'user',
          content: `You are a trading rules architect for the Hormuz oil disruption thesis portfolio.

CURRENT RULES (${currentVersion || 'unknown'}):
${currentRules}

USER INSTRUCTIONS FOR NEW VERSION:
${instructions}

Generate an UPDATED version of the trading rules incorporating the user's instructions.
Keep the same structure and format. Only change what the instructions require.
Be precise with thresholds and conditions — these rules drive automated trading signals.

Respond with EXACTLY this JSON format (no other text):
{
  "rules": "the full updated rules text",
  "version": "${nextVersion(currentVersion)}",
  "changelog": "bullet-point summary of what changed"
}`
        }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse generated rules');
    const result = JSON.parse(match[0]);

    return res.status(200).json({
      rules: result.rules,
      version: result.version || nextVersion(currentVersion),
      changelog: result.changelog || '',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

function nextVersion(v) {
  if (!v) return 'v3.1';
  // v3 → v3.1, v3.1 → v3.2, v3.9 → v3.10
  const m = v.match(/^v(\d+)(?:\.(\d+))?$/);
  if (!m) return v + '.1';
  const major = m[1];
  const minor = m[2] ? parseInt(m[2]) + 1 : 1;
  return `v${major}.${minor}`;
}
