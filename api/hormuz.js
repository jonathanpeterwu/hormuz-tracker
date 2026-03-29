export default async function handler(req, res) {
  // Fetch disruption timeline from hormuztracker.com
  try {
    const resp = await fetch('https://www.hormuztracker.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HormuzWarRoom/1.0)',
        'Accept': 'text/html',
      },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const html = await resp.text();

    const timeline = parseTimeline(html);
    const vessels = parseVessels(html);
    const pipelines = parsePipelines(html);

    // Pakistan deal: 2/day non-Iranian transits via bilateral arrangement
    // Source: FM Dar confirmation + Vance/Islamabad format discussions
    vessels.pakistanDeal = {
      nonIranianPerDay: 2,
      source: 'Pakistan bilateral deal (FM Dar confirmed)',
      note: 'Adds ~2/day non-Iranian transits via Pakistan-negotiated corridor'
    };
    // Compute total estimate: base transits + Pakistan deal contribution
    const baseTransits = vessels.transitsPerDay || 7;
    vessels.totalEstimate = baseTransits;
    vessels.breakdown = {
      iranTollBooth: Math.max(0, baseTransits - 2),
      pakistanDeal: 2,
      total: baseTransits
    };

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ timeline, vessels, pipelines });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

function parseTimeline(html) {
  // Extract timeline entries — look for day/date/description patterns
  const entries = [];

  // Match timeline items: "Day N" + date + description blocks
  // The site uses structured timeline with day markers
  const dayPattern = /Day\s+(\d+)\s*(?:<[^>]*>)*\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4})/gi;
  // Broader approach: find all text blocks with "Day X" and nearby content
  const blocks = html.split(/Day\s+(\d+)/i);

  for (let i = 1; i < blocks.length; i += 2) {
    const dayNum = parseInt(blocks[i]);
    const content = blocks[i + 1] || '';

    // Extract date
    const dateMatch = content.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4})/i);
    const date = dateMatch ? dateMatch[1].trim() : '';

    // Extract text content - strip HTML tags, get first meaningful chunk
    const stripped = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Get the headline (first sentence or phrase after the date)
    let headline = '';
    if (date) {
      const afterDate = stripped.split(date)[1] || stripped;
      // Take first 1-2 sentences
      const sentences = afterDate.trim().split(/\.\s+/);
      headline = sentences.slice(0, 2).join('. ').trim();
      if (headline && !headline.endsWith('.')) headline += '.';
    }

    if (headline && headline.length > 10 && dayNum > 0) {
      entries.push({ day: dayNum, date, headline: headline.slice(0, 300) });
    }
  }

  // Dedupe by day number (keep first/most recent description per day)
  const seen = new Map();
  for (const e of entries) {
    if (!seen.has(e.day) || e.headline.length > seen.get(e.day).headline.length) {
      seen.set(e.day, e);
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.day - a.day)
    .slice(0, 15);
}

function parseVessels(html) {
  // Try to extract vessel count numbers
  const vessels = {};

  // Look for patterns like "X,XXX ships" or "X ships"
  const trappedMatch = html.match(/([\d,]+)\s*(?:ships?\s+)?(?:trapped|inside\s+Gulf)/i);
  if (trappedMatch) vessels.trapped = parseInt(trappedMatch[1].replace(/,/g, ''));

  const waitingMatch = html.match(/([\d,]+)\s*(?:ships?\s+)?(?:waiting|outside\s+strait)/i);
  if (waitingMatch) vessels.waiting = parseInt(waitingMatch[1].replace(/,/g, ''));

  const transitMatch = html.match(/([\d,]+)\s*(?:ships?\s+)?transit(?:ing|s)?\s+(?:per|\/)\s*day/i);
  if (transitMatch) vessels.transitsPerDay = parseInt(transitMatch[1].replace(/,/g, ''));

  const tonnageMatch = html.match(/([\d.]+)%\s*(?:of\s+)?(?:global\s+)?tonnage/i);
  if (tonnageMatch) vessels.globalTonnageIdle = parseFloat(tonnageMatch[1]);

  return vessels;
}

function parsePipelines(html) {
  // Try to extract pipeline capacity data
  const pipelines = [];

  // Saudi East-West / Petroline
  const petroMatch = html.match(/(?:East-West|Petroline)[^.]*?([\d.]+(?:-[\d.]+)?)\s*M?\s*(?:bbl|barrel)/i);
  if (petroMatch) {
    pipelines.push({ name: 'Saudi Petroline', to: 'Yanbu (Red Sea)', capacity: petroMatch[1], active: true });
  }

  // UAE ADCOP
  const adcopMatch = html.match(/(?:ADCOP|Abu\s+Dhabi\s+.*?pipeline)[^.]*?([\d.]+(?:-[\d.]+)?)\s*M?\s*(?:bbl|barrel)/i);
  if (adcopMatch) {
    pipelines.push({ name: 'UAE ADCOP', to: 'Fujairah', capacity: adcopMatch[1], active: true });
  }

  // Iraq-Turkey / Kirkuk-Ceyhan
  const kirkukMatch = html.match(/(?:Iraq-Turkey|Kirkuk-Ceyhan)[^.]*?([\d.]+(?:-[\d.]+)?)\s*M?\s*(?:bbl|barrel)/i);
  if (kirkukMatch) {
    pipelines.push({ name: 'Iraq-Turkey (Kirkuk-Ceyhan)', to: 'Ceyhan', capacity: kirkukMatch[1], active: false });
  }

  return pipelines;
}
