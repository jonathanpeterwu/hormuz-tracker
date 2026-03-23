// Admin endpoint for hot-swapping trading rules without deploy.
// GET  /api/rules         → current active rules + metadata
// POST /api/rules         → push new rules (requires RULES_SECRET)
// GET  /api/rules?history → list all versions
//
// Requires Vercel KV: create in dashboard, link to project.
// Set RULES_SECRET env var for write auth.

import { kv } from '@vercel/kv';
import { rules as fileRules, rulesVersion as fileVersion } from '../rules/current.js';

const KV_KEY = 'trading_rules';       // current rules text
const KV_VERSION_KEY = 'rules_version'; // e.g. "v3.1"
const KV_HISTORY_KEY = 'rules_history'; // list of {version, updatedAt, summary}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // GET: return current rules
  if (req.method === 'GET') {
    try {
      const kvRules = await kv.get(KV_KEY);
      const kvVersion = await kv.get(KV_VERSION_KEY);

      if (kvRules) {
        const result = { rules: kvRules, version: kvVersion || 'kv', source: 'kv' };

        // If ?history, include version history
        if (req.query.history !== undefined) {
          result.history = await kv.lrange(KV_HISTORY_KEY, 0, -1) || [];
        }
        return res.status(200).json(result);
      }

      // Fallback to filesystem
      return res.status(200).json({ rules: fileRules, version: fileVersion, source: 'file' });
    } catch (e) {
      // KV not configured — fall back to file
      return res.status(200).json({ rules: fileRules, version: fileVersion, source: 'file', kvError: e.message });
    }
  }

  // POST: update rules
  if (req.method === 'POST') {
    // Auth check
    const secret = process.env.RULES_SECRET;
    if (!secret) return res.status(500).json({ error: 'RULES_SECRET not configured' });

    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== secret) return res.status(401).json({ error: 'Invalid token' });

    const { rules, version, summary } = req.body;
    if (!rules || !version) {
      return res.status(400).json({ error: 'rules (string) and version (string) required' });
    }

    try {
      // Store current rules
      await kv.set(KV_KEY, rules);
      await kv.set(KV_VERSION_KEY, version);

      // Push to history
      await kv.lpush(KV_HISTORY_KEY, JSON.stringify({
        version,
        summary: summary || '',
        updatedAt: new Date().toISOString(),
        length: rules.length,
      }));
      // Keep last 50 versions
      await kv.ltrim(KV_HISTORY_KEY, 0, 49);

      return res.status(200).json({ ok: true, version, source: 'kv', updatedAt: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ error: 'KV write failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'GET or POST required' });
}
