# Hormuz War Room

Live trading dashboard for the Iran/Hormuz conflict thesis.

## Deploy to Vercel (one command)

### Option A — Vercel CLI (fastest)

```bash
# 1. Install Vercel CLI (once)
npm i -g vercel

# 2. From this folder, deploy
vercel

# Follow the prompts:
#   Set up and deploy? Y
#   Which scope? (your account)
#   Link to existing project? N
#   Project name: hormuz-war-room (or anything)
#   In which directory is your code? ./   (just hit Enter)
#   Override settings? N

# First deploy gives you a preview URL immediately.
# To promote to production:
vercel --prod
```

Your dashboard will be live at `https://hormuz-war-room.vercel.app` (or similar).

### Option B — Vercel Dashboard (no CLI)

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **"Import Git Repository"** — or just drag-drop this folder
3. If drag-drop: click **"Deploy"** — done in ~10 seconds

### Option C — GitHub + Vercel (auto-deploy on push)

```bash
# Push to GitHub
git init
git add .
git commit -m "hormuz war room"
gh repo create hormuz-war-room --private --push --source=.

# Then connect repo at vercel.com/new
# Every git push will auto-redeploy
```

## Update positions

Edit `public/index.html` — find the `POSITIONS` array near the top of the `<script>` block.
Each entry:
```js
{ticker:"GUSH", label:"2x oil E&P", type:"stock", bg:"bo", qty:400, avg:36.155, pnl:1056}
```
- `type`: `stock` | `option` | `crypto`
- `bg`: badge color — `bo`=oil, `bs`=short, `bp`=option, `ba`=ag, `bg2c`=gold, `bcc`=crypto
- Options are excluded from Yahoo price fetching automatically

Then redeploy: `vercel --prod`

## Live data sources

| Source | Data | Notes |
|--------|------|-------|
| Yahoo Finance | Equity/ETF last price | Via corsproxy.io |
| Hyperliquid | BTC, ETH, XAU, WTI perps | 24/7, POST via corsproxy.io |
| Polymarket | Ceasefire + Hormuz odds | Via corsproxy.io |

All three show green/red status pills in the footer.
Auto-refreshes every 60 seconds.
