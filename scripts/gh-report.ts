// ─── CryptoYar Free — static dashboard generator (GitHub Pages) ───
// Reads the current DB state and writes a self-contained RTL HTML report
// + data.json into ./site (deployed by the workflow).

import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs'
import { db, ensurePragmas } from '@/lib/db'
import { getSetting, getBrainWeights, type FeatureKey } from '@/lib/settings'
import { currentEquity } from '@/lib/fund'
import { runSelfTest } from '@/lib/brain'
import { faNum, faPct } from '@/lib/fa'

const FA_TIME = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran',
  dateStyle: 'short',
  timeStyle: 'short',
})

const JOBS_FA: Record<string, string> = {
  'ticker-refresh': 'تیکرها',
  'candle-refresh': 'کندل‌ها',
  'cmc-refresh': 'رتبه‌بندی CMC',
  'funding-refresh': 'فاندینگ/OI',
  'radar-scan': 'اسکن رادار',
  'fund-mark': 'ارزش‌گذاری صندوق',
  'brain-train': 'آموزش مغز',
  'equity-snapshot': 'نمودار سرمایه',
  health: 'پایش سلامت',
  'self-test': 'خودآزمایی',
  'data-prune': 'پاک‌سازی داده',
}

async function main(): Promise<void> {
  await ensurePragmas()

  const jobs = JOBS_FA && Object.keys(JOBS_FA)
  const lastRuns = await Promise.all(
    jobs.map(async (j) => {
      const r = await db.jobLog.findFirst({ where: { job: j }, orderBy: { startedAt: 'desc' } })
      return r
    }),
  )

  const [healthRaw, weights, equityNow, equityPoints, positions, signals, coins, candleCount, selfTest] = await Promise.all([
    getSetting('healthSnapshot'),
    getBrainWeights(),
    currentEquity().catch(() => 0),
    db.equityPoint.findMany({ orderBy: { ts: 'desc' }, take: 48 }),
    db.fundPosition.findMany({ where: { status: 'open' } }),
    db.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    db.coin.count(),
    db.candle.count(),
    runSelfTest().catch(() => null),
  ])

  const health = healthRaw ? (JSON.parse(healthRaw) as Record<string, boolean>) : null
  const equityAsc = equityPoints.slice().reverse()
  const unrealized = positions.reduce((s, p) => {
    const dir = p.side === 'short' ? -1 : 1
    const qty = p.qty || 0
    return s + dir * qty * ((p.markPrice || p.entryPrice) - p.entryPrice)
  }, 0)

  const sideFa = (s: string) => (s === 'long' ? 'خرید' : 'فروش')
  const cls = (b: boolean) => (b ? 'up' : 'down')

  const spark = (() => {
    if (equityAsc.length < 2) return ''
    const vals = equityAsc.map((p) => p.equityUsdt)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min || 1
    const pts = vals
      .map((v, i) => `${(i / (vals.length - 1)) * 300},${58 - ((v - min) / span) * 52}`)
      .join(' ')
    const last = vals[vals.length - 1]
    const color = last >= vals[0] ? '#0ecb81' : '#f6465d'
    return `<svg viewBox="0 0 300 60" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`
  })()

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>کریپتویار — داشبورد رایگان</title>
<style>
  @font-face { font-family:'Vazirmatn'; src:url('fonts/Vazirmatn-Regular.woff2') format('woff2'); font-weight:400; }
  @font-face { font-family:'Vazirmatn'; src:url('fonts/Vazirmatn-Bold.woff2') format('woff2'); font-weight:700; }
  * { box-sizing:border-box; }
  body { margin:0; background:#0b0e11; color:#eaecef; font-family:'Vazirmatn',Tahoma,sans-serif; }
  main { max-width:960px; margin:0 auto; padding:16px; }
  header { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 0 16px; }
  h1 { font-size:20px; margin:0; color:#f0b90b; }
  .sub { font-size:11px; color:#848e9c; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
  .card { background:#12161c; border:1px solid #1e242c; border-radius:12px; padding:14px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:#eaecef; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:12px; }
  .kpi { background:#12161c; border:1px solid #1e242c; border-radius:12px; padding:12px; }
  .kpi b { display:block; font-size:18px; margin-top:4px; }
  .kpi span { font-size:11px; color:#848e9c; }
  .up { color:#0ecb81; } .down { color:#f6465d; } .warn { color:#f0b90b; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td, th { padding:7px 6px; border-bottom:1px solid #1e242c; text-align:right; }
  th { color:#848e9c; font-weight:400; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:10px; border:1px solid #1e242c; color:#848e9c; }
  .reason { font-size:11px; color:#848e9c; line-height:1.7; }
  svg.spark { width:100%; height:60px; }
  .bar { height:6px; background:#1e242c; border-radius:99px; overflow:hidden; }
  .bar i { display:block; height:100%; background:#f0b90b; }
  footer { text-align:center; color:#848e9c; font-size:10px; padding:20px 0; line-height:1.8; }
</style>
</head>
<body>
<main>
  <header>
    <h1>کریپتویار — شکار بهترین کوین‌ها در بهترین زمان</h1>
    <div class="sub">به‌روزرسانی: ${FA_TIME.format(new Date())} (تهران) · هر ۱۵ دقیقه توسط GitHub Actions</div>
  </header>

  <div class="kpis">
    <div class="kpi"><span>دارایی صندوق (شبیه‌سازی)</span><b>${faNum(equityNow, 2)} <span style="font-size:11px">USDT</span></b></div>
    <div class="kpi"><span>سود/زیان باز</span><b class="${unrealized >= 0 ? 'up' : 'down'}">${faNum(unrealized, 2)} USDT</b></div>
    <div class="kpi"><span>کوین‌های تحت پوشش</span><b>${faNum(coins, 0)}</b></div>
    <div class="kpi"><span>کندل‌های ذخیره‌شده</span><b>${faNum(candleCount, 0)}</b></div>
    <div class="kpi"><span>پوزیشن باز</span><b>${faNum(positions.length, 0)}</b></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>منحنی سرمایه (۴۸ نقطهٔ اخیر)</h2>
      ${spark ? `<svg class="spark" viewBox="0 0 300 60">${spark}</svg>` : '<div class="reason">هنوز نقطهٔ کافی ثبت نشده — اولین ساعتی که اجرا شود پر می‌شود.</div>'}
      ${
        health
          ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <span class="pill">Binance اسپات: <b class="${cls(Boolean(health.binanceSpot))}">${health.binanceSpot ? 'سالم' : 'قطع'}</b></span>
        <span class="pill">فیوچرز: <b class="${cls(Boolean(health.binanceFutures))}">${health.binanceFutures ? 'سالم' : 'قطع'}</b></span>
        <span class="pill">CMC: <b class="${cls(Boolean(health.cmc))}">${health.cmc ? 'سالم' : 'بدون کلید'}</b></span>
        <span class="pill">ترس‌وطمع: <b class="${cls(Boolean(health.feargreed))}">${health.feargreed ? 'سالم' : 'قطع'}</b></span>
      </div>`
          : ''
      }
    </div>

    <div class="card">
      <h2>پوزیشن‌های باز صندوق</h2>
      ${
        positions.length
          ? `<table><tr><th>نماد</th><th>سمت</th><th>ورود</th><th>فعلی</th><th>سود</th></tr>
      ${positions
        .map(
          (p) => `<tr><td>${p.symbol.replace('USDT', '')}/USDT</td><td>${sideFa(p.side)}</td><td>${faNum(p.entryPrice, 4)}</td><td>${faNum(p.markPrice, 4)}</td><td class="${(p.pnlPct ?? 0) >= 0 ? 'up' : 'down'}">${faPct(p.pnlPct ?? 0, 2)}</td></tr>`,
        )
        .join('')}</table>`
          : '<div class="reason">پوزیشن بازی وجود ندارد — رادار هر ۱۵ دقیقه دنبال فرصت است.</div>'
      }
    </div>

    <div class="card">
      <h2>آخرین سیگنال‌های رادار</h2>
      ${
        signals.length
          ? signals
              .map(
                (s) => `<div style="padding:7px 0;border-bottom:1px solid #1e242c">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <b>${s.symbol.replace('USDT', '')}/USDT — ${sideFa(s.side)} <span class="pill">${faNum(s.score, 0)} امتیاز</span></b>
          <span class="sub">${FA_TIME.format(s.createdAt)}</span>
        </div>
        <div class="reason">${s.reasonFa}</div>
      </div>`,
              )
              .join('')
          : '<div class="reason">هنوز سیگنالی ثبت نشده.</div>'
      }
    </div>

    <div class="card">
      <h2>مغز یادگیرنده (باندیت وزن‌ها)</h2>
      ${Object.entries(weights as Record<FeatureKey, number>)
        .map(
          ([k, v]) => `<div style="display:flex;align-items:center;gap:8px;margin:6px 0">
        <span style="width:70px;font-size:11px;color:#848e9c">${k}</span>
        <span class="bar" style="flex:1"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></span>
        <b style="width:34px;text-align:left">${faNum(v, 0)}</b>
      </div>`,
        )
        .join('')}
      <div class="reason" style="margin-top:8px">
        ${
          selfTest?.overall
            ? `دقت فعلی: ${faNum((selfTest.overall.accuracy ?? 0) * 100, 1)}٪ روی ${faNum(selfTest.overall.total ?? 0, 0)} نمونهٔ ارزیابی‌شده`
            : 'هنوز نمونهٔ ارزیابی‌شده‌ای نیست — گارد سرد‌شروع: بعد از ۵۰ نمونه باندیت فعال می‌شود.'
        }
      </div>
    </div>

    <div class="card">
      <h2>وظایف چرخه (آخرین اجرا)</h2>
      <table><tr><th>وظیفه</th><th>وضعیت</th><th>جزئیات</th><th>زمان</th></tr>
      ${lastRuns
        .filter(Boolean)
        .map(
          (r) => `<tr>
        <td>${JOBS_FA[r!.job] ?? r!.job}</td>
        <td class="${r!.ok ? 'up' : 'down'}">${r!.ok ? 'موفق' : 'خطا'}</td>
        <td class="reason">${(r!.detail ?? '').slice(0, 70)}</td>
        <td class="sub">${FA_TIME.format(r!.startedAt)}</td>
      </tr>`,
        )
        .join('')}
      </table>
    </div>
  </div>

  <footer>
    کریپتویار · نسخهٔ رایگان روی GitHub Actions + Pages · دادهٔ آموزشی صندوق شبیه‌سازی است و توصیهٔ سرمایه‌گذاری نیست
  </footer>
</main>
</body>
</html>`

  mkdirSync('site/fonts', { recursive: true })
  for (const f of ['Vazirmatn-Regular.woff2', 'Vazirmatn-Bold.woff2', 'Vazirmatn-Medium.woff2']) {
    const src = `public/fonts/${f}`
    if (existsSync(src)) copyFileSync(src, `site/fonts/${f}`)
  }
  writeFileSync('site/index.html', html, 'utf8')
  writeFileSync(
    'site/data.json',
    JSON.stringify({ equityNow, unrealized, coins, candleCount, positions, signals: signals.map((s) => ({ symbol: s.symbol, side: s.side, score: s.score, strategy: s.strategy })) }, null, 2),
    'utf8',
  )
  console.log(`REPORT DONE — site/index.html (${(html.length / 1024).toFixed(1)}KB), positions=${positions.length}, signals=${signals.length}`)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
