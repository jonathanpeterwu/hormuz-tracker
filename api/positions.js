const DEFAULT_POSITIONS = [
  { ticker: "GUSH", label: "2x oil E&P", type: "stock", bg: "bo", qty: 400, avg: 36.155, lastPrice: 46.03 },
  { ticker: "USO", label: "WTI crude", type: "stock", bg: "bo", qty: 125, avg: 111.602, lastPrice: 117.26 },
  { ticker: "OILK", label: "Roll-efficient oil", type: "stock", bg: "bo", qty: 200, avg: 56.038, lastPrice: 55.14 },
  { ticker: "SQQQ", label: "Short QQQ 3x", type: "stock", bg: "bs", qty: 100, avg: 78.985, lastPrice: 82.50 },
  { ticker: "NTR", label: "Diversified fert.", type: "stock", bg: "ba", qty: 40, avg: 74.815, lastPrice: 73.69 },
  { ticker: "CANE", label: "Sugar ETF", type: "stock", bg: "ba", qty: 200, avg: 10.485, lastPrice: 10.63 },
  { ticker: "TLT Jun18 $84 Put", label: "Bonds short", type: "option", bg: "bp", qty: 2, avg: 0, pnl: 5.68 },
  { ticker: "EWY Jun18 $100 Put", label: "Korea short", type: "option", bg: "bp", qty: 1, avg: 0, pnl: -41.21 },
  { ticker: "TSM Jan15'27 $185 Put", label: "Taiwan tail", type: "option", bg: "bp", qty: 1, avg: 6.331, pnl: -48.59 },
  { ticker: "TSM Jan15'27 $200 Put", label: "Taiwan delta", type: "option", bg: "bp", qty: 1, avg: 8.051, pnl: -52.79 },
  { ticker: "JETS Jun18 $22 Put", label: "Airlines short", type: "option", bg: "bp", qty: 10, avg: 1.262, pnl: -318.45 },
];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Compute summary stats — PnL is live for stocks (lastPrice - avg) * qty, static for options
  let totalCost = 0;
  let totalPnl = 0;
  const positions = DEFAULT_POSITIONS.map(p => {
    const cost = p.qty * p.avg;
    totalCost += cost;
    const pnl = (p.type === 'stock' && p.lastPrice)
      ? Math.round((p.lastPrice - p.avg) * p.qty * 100) / 100
      : (p.pnl || 0);
    totalPnl += pnl;
    return { ...p, pnl, costBasis: Math.round(cost * 100) / 100 };
  });

  const summary = {
    totalPositions: positions.length,
    totalCostBasis: Math.round(totalCost * 100) / 100,
    totalUnrealizedPnl: Math.round(totalPnl * 100) / 100,
    returnPct: totalCost > 0 ? Math.round((totalPnl / totalCost) * 10000) / 100 : 0,
    stocks: positions.filter(p => p.type === 'stock').length,
    options: positions.filter(p => p.type === 'option').length,
    updatedAt: new Date().toISOString(),
  };

  // Support ?format=csv
  const { format } = req.query;
  if (format === 'csv') {
    const header = 'ticker,label,type,bg,qty,avg,pnl,costBasis';
    const rows = positions.map(p =>
      `"${p.ticker}","${p.label}",${p.type},${p.bg},${p.qty},${p.avg},${p.pnl},${p.costBasis}`
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=positions.csv');
    return res.status(200).send([header, ...rows].join('\n'));
  }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({ positions, summary });
}
