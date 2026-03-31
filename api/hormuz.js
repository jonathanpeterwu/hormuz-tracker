const WW_FEED_URL = 'https://worldwarwatcher.com/feed.xml';
const WAR_START = new Date('2026-02-28T00:00:00Z');

export default async function handler(req, res) {
  // Fetch both sources in parallel
  const [htResult, wwResult] = await Promise.allSettled([
    fetchHormuzTracker(),
    fetchWarWatcher(),
  ]);

  const ht = htResult.status === 'fulfilled' ? htResult.value : null;
  const ww = wwResult.status === 'fulfilled' ? wwResult.value : null;

  if (!ht && !ww) {
    return res.status(502).json({ error: 'Both sources failed' });
  }

  // Merge timelines (dedupe by day, prefer hormuztracker for vessel-specific, warwatcher for broader events)
  const htTimeline = ht ? ht.timeline : [];
  const wwTimeline = ww ? ww.timeline : [];
  const mergedTimeline = mergeTimelines(htTimeline, wwTimeline);

  // Vessels: hormuztracker is primary, warwatcher enriches
  const vessels = ht ? ht.vessels : {};
  if (ww && ww.maritime) {
    vessels.warwatcher = ww.maritime;
    // If hormuztracker doesn't have transit rate, use warwatcher's daily rate
    // IMPORTANT: warwatcher latestTransitRate is only valid if ≤20/day.
    // Higher numbers (e.g. 150) are monthly totals or stalled vessel counts,
    // NOT daily transit rates. BBC Verify confirmed rate is 5-6/day.
    if (!vessels.transitsPerDay && ww.maritime.latestTransitRate && ww.maritime.latestTransitRate <= 20) {
      vessels.transitsPerDay = ww.maritime.latestTransitRate;
    }
  }

  // Pakistan deal: 2/day non-Iranian transits via bilateral arrangement
  // Source: FM Dar confirmation + Vance/Islamabad format discussions
  vessels.pakistanDeal = {
    nonIranianPerDay: 2,
    source: 'Pakistan bilateral deal (FM Dar confirmed)',
    note: 'Adds ~2/day non-Iranian transits via Pakistan-negotiated corridor'
  };
  const baseTransits = vessels.transitsPerDay || 7;
  vessels.totalEstimate = baseTransits;
  vessels.breakdown = {
    iranTollBooth: Math.max(0, baseTransits - 2),
    pakistanDeal: 2,
    total: baseTransits
  };

  const pipelines = ht ? ht.pipelines : [];

  // Track which sources responded
  const sources = [];
  if (ht) sources.push('hormuztracker.com');
  if (ww) sources.push('worldwarwatcher.com');

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
  return res.status(200).json({
    timeline: mergedTimeline,
    vessels,
    pipelines,
    sources,
    warwatcher: ww ? { categories: ww.categories, totalEntries: ww.totalEntries } : null,
  });
}

// ---- Hormuztracker.com ----

async function fetchHormuzTracker() {
  const resp = await fetch('https://www.hormuztracker.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HormuzWarRoom/1.0)',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const html = await resp.text();
  return {
    timeline: parseHtTimeline(html),
    vessels: parseVessels(html),
    pipelines: parsePipelines(html),
  };
}

function parseHtTimeline(html) {
  const entries = [];
  const blocks = html.split(/Day\s+(\d+)/i);
  for (let i = 1; i < blocks.length; i += 2) {
    const dayNum = parseInt(blocks[i]);
    const content = blocks[i + 1] || '';
    const dateMatch = content.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4})/i);
    const date = dateMatch ? dateMatch[1].trim() : '';
    const stripped = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    let headline = '';
    if (date) {
      const afterDate = stripped.split(date)[1] || stripped;
      const sentences = afterDate.trim().split(/\.\s+/);
      headline = sentences.slice(0, 2).join('. ').trim();
      if (headline && !headline.endsWith('.')) headline += '.';
    }
    if (headline && headline.length > 10 && dayNum > 0) {
      entries.push({ day: dayNum, date, headline: headline.slice(0, 300), source: 'hormuztracker.com' });
    }
  }
  const seen = new Map();
  for (const e of entries) {
    if (!seen.has(e.day) || e.headline.length > seen.get(e.day).headline.length) {
      seen.set(e.day, e);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.day - a.day).slice(0, 15);
}

function parseVessels(html) {
  const vessels = {};
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
  const pipelines = [];
  const petroMatch = html.match(/(?:East-West|Petroline)[^.]*?([\d.]+(?:-[\d.]+)?)\s*M?\s*(?:bbl|barrel)/i);
  if (petroMatch) pipelines.push({ name: 'Saudi Petroline', to: 'Yanbu (Red Sea)', capacity: petroMatch[1], active: true });
  const adcopMatch = html.match(/(?:ADCOP|Abu\s+Dhabi\s+.*?pipeline)[^.]*?([\d.]+(?:-[\d.]+)?)\s*M?\s*(?:bbl|barrel)/i);
  if (adcopMatch) pipelines.push({ name: 'UAE ADCOP', to: 'Fujairah', capacity: adcopMatch[1], active: true });
  const kirkukMatch = html.match(/(?:Iraq-Turkey|Kirkuk-Ceyhan)[^.]*?([\d.]+(?:-[\d.]+)?)\s*M?\s*(?:bbl|barrel)/i);
  if (kirkukMatch) pipelines.push({ name: 'Iraq-Turkey (Kirkuk-Ceyhan)', to: 'Ceyhan', capacity: kirkukMatch[1], active: false });
  return pipelines;
}

// ---- WorldWarWatcher.com (Atom feed) ----

async function fetchWarWatcher() {
  const resp = await fetch(WW_FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HormuzWarRoom/1.0)',
      'Accept': 'application/atom+xml, application/xml, text/xml',
    },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const xml = await resp.text();
  const entries = parseAtomFeed(xml);

  const vesselEntries = entries.filter(e =>
    /hormuz|transit|vessel|tanker|ship|strait|corridor|toll|maritime|shipping|salalah/i.test(e.title + ' ' + e.summary)
  );

  return {
    timeline: entries.slice(0, 30).map(e => ({
      day: e.day, date: e.date, headline: e.title,
      category: e.category, source: 'worldwarwatcher.com',
    })),
    maritime: extractMaritimeIntel(vesselEntries),
    categories: countCategories(entries),
    totalEntries: entries.length,
  };
}

function parseAtomFeed(xml) {
  const entries = [];
  const entryBlocks = xml.split('<entry>').slice(1);
  for (const block of entryBlocks) {
    const title = tagText(block, 'title');
    const summary = tagText(block, 'summary');
    const published = tagText(block, 'published') || tagText(block, 'updated');
    const category = attrVal(block, 'category', 'term') || 'unknown';
    if (!title) continue;
    const pubDate = published ? new Date(published) : null;
    const day = pubDate ? Math.ceil((pubDate - WAR_START) / (1000 * 60 * 60 * 24)) : 0;
    const dateStr = pubDate
      ? pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    entries.push({ title, summary, date: dateStr, day, category });
  }
  return entries.sort((a, b) => b.day - a.day);
}

function extractMaritimeIntel(entries) {
  const intel = {
    latestTransitRate: null, preWarRate: 138, trafficDrop: null,
    tollPrice: null, corridorStatus: null, bypassDisruptions: [],
    stalledVessels: null, headlines: [],
  };
  for (const e of entries) {
    const text = e.title + ' ' + (e.summary || '');

    // CRITICAL: "~150 ships transited in March" = total stalled for the MONTH
    // (one normal day's volume), NOT a daily transit rate.
    // BBC Verify: actual daily rate is 5-6/day vs 138 pre-war.
    // Only match explicit "per day" or "/day" patterns for daily rate.
    const dailyRateMatch = text.match(/(\d+)\s*(?:ships?\s+)?(?:per|\/)\s*day/i);
    if (dailyRateMatch && !intel.latestTransitRate) {
      const rate = parseInt(dailyRateMatch[1]);
      // Sanity: daily rate during blockade cannot exceed ~30; higher = misparse
      if (rate <= 30) intel.latestTransitRate = rate;
    }

    // BBC Verify pattern: "5-6/day vs 138 pre-war"
    const bbcMatch = text.match(/(\d+)[-–](\d+)\s*\/\s*day/i);
    if (bbcMatch && !intel.latestTransitRate) {
      intel.latestTransitRate = Math.round((parseInt(bbcMatch[1]) + parseInt(bbcMatch[2])) / 2);
    }

    // Stalled/stranded vessels — monthly totals, NOT daily rates
    const stalledMatch = text.match(/(\d+)\s*(?:freight\s+)?ships?\s+(?:including|stalled|stranded|stuck)/i)
      || text.match(/~?(\d+)\s*(?:ships?\s+)?transit(?:ed)?\s+in\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
    if (stalledMatch) intel.stalledVessels = parseInt(stalledMatch[1]);

    const dropMatch = text.match(/(?:traffic|volume)\s+down\s+(\d+)%/i);
    if (dropMatch) intel.trafficDrop = parseInt(dropMatch[1]);
    const tollMatch = text.match(/\$(\d+(?:\.\d+)?)\s*M?\s*(?:per\s+voyage|toll)/i);
    if (tollMatch) intel.tollPrice = tollMatch[1] + 'M';
    if (/safe corridor|IRGC corridor|selective transit/i.test(text)) {
      intel.corridorStatus = 'IRGC controlled corridor — selective transit';
    }
    if (/salalah|bypass.*struck|bypass.*disrupt/i.test(text)) {
      intel.bypassDisruptions.push(e.title);
    }
    intel.headlines.push({ day: e.day, date: e.date, title: e.title, category: e.category });
  }
  // BBC Verify: 5-6/day vs 138 pre-war = ~96% drop
  if (!intel.trafficDrop && intel.latestTransitRate) {
    intel.trafficDrop = Math.round((1 - intel.latestTransitRate / intel.preWarRate) * 100);
  }
  return intel;
}

function countCategories(entries) {
  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  return counts;
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim() : '';
}

function attrVal(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

// ---- Merge timelines ----

function mergeTimelines(htEntries, wwEntries) {
  const byDay = new Map();

  // hormuztracker entries first (vessel-specific)
  for (const e of htEntries) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }

  // warwatcher entries — add if day not already covered, or append if different headline
  for (const e of wwEntries) {
    if (!byDay.has(e.day)) {
      byDay.set(e.day, [e]);
    } else {
      const existing = byDay.get(e.day);
      const isDupe = existing.some(x => x.headline.slice(0, 50) === e.headline.slice(0, 50));
      if (!isDupe) existing.push(e);
    }
  }

  // Flatten and sort, limit to 20 most recent
  return Array.from(byDay.values())
    .flat()
    .sort((a, b) => b.day - a.day)
    .slice(0, 20);
}
