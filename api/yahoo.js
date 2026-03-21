export default async function handler(req, res) {
  const { symbols } = req.query;
  if (!symbols) {
    return res.status(400).json({ error: 'symbols query parameter required' });
  }

  try {
    // Use spark endpoint — no auth/crumb required, returns latest close prices
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols)}&range=1d&interval=1d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo returned ${response.status}`);
    }

    const spark = await response.json();

    // Transform spark response into quoteResponse format the frontend expects
    const result = Object.values(spark).map(s => ({
      symbol: s.symbol,
      regularMarketPrice: s.close ? s.close[s.close.length - 1] : null,
      chartPreviousClose: s.chartPreviousClose || null,
    }));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ quoteResponse: { result } });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
