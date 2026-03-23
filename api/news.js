export default async function handler(req, res) {
  // Fetch Middle East / oil / geopolitical headlines from Google News RSS
  const queries = [
    'Iran+Strait+of+Hormuz',
    'Iran+ceasefire+oil',
    'Middle+East+oil+supply',
    'Iran+sanctions+crude',
    'Hormuz+shipping+tanker',
  ];

  try {
    const allItems = [];
    const seen = new Set();

    // Fetch multiple queries in parallel for breadth
    const results = await Promise.allSettled(
      queries.map(async (q) => {
        const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!resp.ok) return [];
        const xml = await resp.text();
        return parseRSSItems(xml);
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const item of r.value) {
          // dedupe by title
          const key = item.title.toLowerCase().slice(0, 60);
          if (!seen.has(key)) {
            seen.add(key);
            allItems.push(item);
          }
        }
      }
    }

    // Sort by pubDate descending (most recent first)
    allItems.sort((a, b) => b.ts - a.ts);

    // Return top 12
    const headlines = allItems.slice(0, 12).map((item) => ({
      title: item.title,
      source: item.source,
      url: item.url,
      ago: relativeTime(item.ts),
      ts: item.ts,
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(headlines);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const source = extractTag(block, 'source');
    if (title) {
      items.push({
        title: decodeEntities(title),
        url: link || '',
        source: source ? decodeEntities(source) : '',
        ts: pubDate ? new Date(pubDate).getTime() : 0,
      });
    }
  }
  return items;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}
