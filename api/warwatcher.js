const FEED_URL = 'https://worldwarwatcher.com/feed.xml';
const WAR_START = new Date('2026-02-28T00:00:00Z');

export default async function handler(req, res) {
  try {
    const resp = await fetch(FEED_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HormuzWarRoom/1.0)',
        'Accept': 'application/atom+xml, application/xml, text/xml',
      },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const xml = await resp.text();

    const entries = parseAtomFeed(xml);
    const timeline = entries.map(e => ({
      day: e.day,
      date: e.date,
      headline: e.title,
      category: e.category,
      source: 'worldwarwatcher.com',
    }));

    // Extract vessel/transit-related entries for cross-reference
    const vesselEntries = entries.filter(e =>
      /hormuz|transit|vessel|tanker|ship|strait|corridor|toll|maritime|shipping/i.test(e.title + ' ' + e.summary)
    );

    // Extract key maritime intel from summaries
    const maritime = extractMaritimeIntel(vesselEntries);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({
      timeline: timeline.slice(0, 30),
      maritime,
      categories: countCategories(entries),
      totalEntries: entries.length,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
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
    latestTransitRate: null,
    preWarRate: 138,
    trafficDrop: null,
    tollPrice: null,
    corridorStatus: null,
    bypassDisruptions: [],
    headlines: [],
  };

  for (const e of entries) {
    const text = e.title + ' ' + (e.summary || '');

    // Transit rate: "X ships transited" or "X/day"
    const rateMatch = text.match(/(\d+)\s*(?:ships?\s+)?transit/i);
    if (rateMatch && !intel.latestTransitRate) {
      intel.latestTransitRate = parseInt(rateMatch[1]);
    }

    // Traffic drop percentage
    const dropMatch = text.match(/(?:traffic|volume)\s+down\s+(\d+)%/i);
    if (dropMatch) intel.trafficDrop = parseInt(dropMatch[1]);

    // Toll price
    const tollMatch = text.match(/\$(\d+(?:\.\d+)?)\s*M?\s*(?:per\s+voyage|toll)/i);
    if (tollMatch) intel.tollPrice = tollMatch[1] + 'M';

    // IRGC corridor status
    if (/safe corridor|IRGC corridor|selective transit/i.test(text)) {
      intel.corridorStatus = 'IRGC controlled corridor — selective transit';
    }

    // Bypass disruptions (Salalah, etc.)
    if (/salalah|bypass.*struck|bypass.*disrupt/i.test(text)) {
      intel.bypassDisruptions.push(e.title);
    }

    intel.headlines.push({ day: e.day, date: e.date, title: e.title, category: e.category });
  }

  // BBC Verify data from feed: 5-6/day vs 138 pre-war = ~96% drop
  if (!intel.trafficDrop && intel.latestTransitRate) {
    intel.trafficDrop = Math.round((1 - intel.latestTransitRate / intel.preWarRate) * 100);
  }

  return intel;
}

function countCategories(entries) {
  const counts = {};
  for (const e of entries) {
    counts[e.category] = (counts[e.category] || 0) + 1;
  }
  return counts;
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim() : '';
}

function attrVal(block, tag, attr) {
  const match = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}
