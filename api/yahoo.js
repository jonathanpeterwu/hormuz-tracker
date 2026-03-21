export default async function handler(req, res) {
  const { symbols } = req.query;
  if (!symbols) {
    return res.status(400).json({ error: 'symbols query parameter required' });
  }

  try {
    // Step 1: get crumb + cookie from Yahoo
    const cookieRes = await fetch('https://fc.yahoo.com', { redirect: 'manual' });
    const setCookie = cookieRes.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];

    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' },
    });
    const crumb = await crumbRes.text();

    // Step 2: fetch quotes with crumb auth
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&crumb=${encodeURIComponent(crumb)}`;
    const response = await fetch(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo returned ${response.status}`);
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
