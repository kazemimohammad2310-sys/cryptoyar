// ─── CryptoYar Free — static dashboard generator (GitHub Pages) ───
// Reads the current DB state and writes a self-contained RTL HTML dashboard
// (6 tabs, mobile-first) + data.json into ./site (deployed by the workflow).

import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs'
import { db, ensurePragmas } from '@/lib/db'
import { getSetting, getBrainWeights, getBotConfig, type FeatureKey } from '@/lib/settings'
import { currentEquity } from '@/lib/fund'
import { runSelfTest } from '@/lib/brain'
import { BOT_PREFIX } from '@/lib/autotrader'
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
  'bot-trade': 'ربات معامله‌گر',
  'brain-train': 'آموزش مغز',
  'equity-snapshot': 'نمودار سرمایه',
  health: 'پایش سلامت',
  'self-test': 'خودآزمایی مغز',
  'data-prune': 'پاک‌سازی داده',
}

const JOB_INTERVAL_MS: Record<string, number> = {
  'ticker-refresh': 60_000,
  'candle-refresh': 15 * 60_000,
  'funding-refresh': 60 * 60_000,
  'cmc-refresh': 15 * 60_000,
  'radar-scan': 15 * 60_000,
  'fund-mark': 60_000,
  'bot-trade': 5 * 60_000,
  'brain-train': 60 * 60_000,
  'equity-snapshot': 60 * 60_000,
  health: 5 * 60_000,
  'self-test': 5 * 60_000,
  'data-prune': 5 * 60_000,
}

const COLD_START_SAMPLES = 50

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const faInterval = (ms: number): string =>
  ms >= 3_600_000 ? `${faNum(ms / 3_600_000, 0)} ساعت` : `${faNum(ms / 60_000, 0)} دقیقه`

async function main(): Promise<void> {
  await ensurePragmas()

  const jobs = Object.keys(JOBS_FA)
  const lastRuns = await Promise.all(
    jobs.map(async (j) => {
      const r = await db.jobLog.findFirst({ where: { job: j }, orderBy: { startedAt: 'desc' } })
      return r
    }),
  )
  const recentLogs = await db.jobLog.findMany({ orderBy: { startedAt: 'desc' }, take: 12 })

  const [healthRaw, weights, bot, equityNow, equityPoints, positions, closedPositions, signals, coins, candleCount, selfTest, sampleTotal, sampleEvaluated, sampleWins, closedCount, botOpenCount, botTotalCount, lastBotLog] = await Promise.all([
    getSetting('healthSnapshot'),
    getBrainWeights(),
    getBotConfig(),
    currentEquity().catch(() => 0),
    db.equityPoint.findMany({ orderBy: { ts: 'desc' }, take: 48 }),
    db.fundPosition.findMany({ where: { status: 'open' } }),
    db.fundPosition.findMany({ where: { status: 'closed' }, orderBy: { closedAt: 'desc' }, take: 8 }),
    db.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    db.coin.count(),
    db.candle.count(),
    runSelfTest().catch(() => null),
    db.brainSample.count(),
    db.brainSample.count({ where: { evaluatedAt: { not: null } } }),
    db.brainSample.count({ where: { outcome: 'win' } }),
    db.fundPosition.count({ where: { status: 'closed' } }),
    db.fundPosition.count({ where: { status: 'open', reasonFa: { startsWith: BOT_PREFIX } } }),
    db.fundPosition.count({ where: { reasonFa: { startsWith: BOT_PREFIX } } }),
    db.jobLog.findFirst({ where: { job: 'bot-trade' }, orderBy: { startedAt: 'desc' } }),
  ])

  const health = healthRaw ? (JSON.parse(healthRaw) as Record<string, boolean>) : null
  const equityAsc = equityPoints.slice().reverse()
  const unrealized = positions.reduce((s, p) => {
    const dir = p.side === 'short' ? -1 : 1
    const qty = p.qty || 0
    return s + dir * qty * ((p.markPrice || p.entryPrice) - p.entryPrice)
  }, 0)
  const realizedSum = closedPositions.reduce((s, p) => s + (p.pnlUsdt ?? 0), 0)
  const winRate = sampleEvaluated > 0 ? sampleWins / sampleEvaluated : null

  const sideFa = (s: string) => (s === 'long' ? 'خرید' : 'فروش')
  const cls = (b: boolean) => (b ? 'up' : 'down')
  const sigStatusFa = (s: string) => (s === 'open' ? 'باز' : s === 'registered' ? 'ثبت‌شده در صندوق' : 'منقضی')

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

  const healthPills = health
    ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <span class="pill">Binance اسپات: <b class="${cls(Boolean(health.binanceSpot))}">${health.binanceSpot ? 'سالم' : 'قطع'}</b></span>
        <span class="pill">فیوچرز: <b class="${cls(Boolean(health.binanceFutures))}">${health.binanceFutures ? 'سالم' : 'قطع'}</b></span>
        <span class="pill">CMC: <b class="${cls(Boolean(health.cmc))}">${health.cmc ? 'سالم' : 'بدون کلید'}</b></span>
        <span class="pill">ترس‌وطمع: <b class="${cls(Boolean(health.feargreed))}">${health.feargreed ? 'سالم' : 'قطع'}</b></span>
      </div>`
    : ''

  const tabDashboard = `
    <div class="kpis">
      <div class="kpi"><span>دارایی صندوق (شبیه‌سازی)</span><b>${faNum(equityNow, 2)} <span style="font-size:11px">USDT</span></b></div>
      <div class="kpi"><span>سود/زیان باز</span><b class="${unrealized >= 0 ? 'up' : 'down'}">${faNum(unrealized, 2)} USDT</b></div>
      <div class="kpi"><span>پوزیشن باز</span><b>${faNum(positions.length, 0)}</b></div>
      <div class="kpi"><span>کوین‌های تحت پوشش</span><b>${faNum(coins, 0)}</b></div>
      <div class="kpi"><span>کندل‌های ذخیره‌شده</span><b>${faNum(candleCount, 0)}</b></div>
    </div>
    <div class="grid">
      <div class="card">
        <h2>منحنی سرمایه (۴۸ نقطهٔ اخیر)</h2>
        ${spark ? `<svg class="spark" viewBox="0 0 300 60">${spark}</svg>` : '<div class="reason">هنوز نقطهٔ کافی ثبت نشده — با ادامهٔ چرخه‌ها پر می‌شود.</div>'}
        ${healthPills}
      </div>
      <div class="card">
        <h2>وظایف چرخه (آخرین اجرا)</h2>
        <table><tr><th>وظیفه</th><th>وضعیت</th><th>زمان</th></tr>
        ${lastRuns
          .filter(Boolean)
          .map(
            (r) => `<tr>
          <td>${JOBS_FA[r!.job] ?? r!.job}</td>
          <td class="${r!.ok ? 'up' : 'down'}">${r!.ok ? 'موفق' : 'خطا'}</td>
          <td class="sub">${FA_TIME.format(r!.startedAt)}</td>
        </tr>`,
          )
          .join('')}
        </table>
      </div>
    </div>`

  const tabRadar = signals.length
    ? `<div class="card">
        ${signals
          .map(
            (s) => `<div style="padding:9px 0;border-bottom:1px solid #1e242c">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <b>${esc(s.symbol.replace('USDT', ''))}/USDT — ${sideFa(s.side)}</b>
          <span class="pill ${s.status === 'registered' ? 'reg' : ''}">${sigStatusFa(s.status)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
          <span class="bar" style="flex:1"><i style="width:${Math.max(3, Math.min(100, s.score))}%"></i></span>
          <b style="width:40px;text-align:left;color:#f0b90b">${faNum(s.score, 0)}</b>
        </div>
        <div class="reason">ورود: ${faNum(s.entryPrice, 4)} · حد ضرر: <span class="down">${faNum(s.stopLoss, 4)}</span> · حد سود: <span class="up">${faNum(s.takeProfit, 4)}</span> · استراتژی: ${esc(s.strategy)}</div>
        <div class="reason">${esc(s.reasonFa)}</div>
        <div class="sub">${FA_TIME.format(s.createdAt)}</div>
      </div>`,
          )
          .join('')}
      </div>`
    : '<div class="card"><div class="reason">هنوز سیگنالی ثبت نشده — رادار هر ۱۵ دقیقه بازار را اسکن می‌کند.</div></div>'

  const tabFund = `
    <div class="kpis">
      <div class="kpi"><span>دارایی فعلی</span><b>${faNum(equityNow, 2)} USDT</b></div>
      <div class="kpi"><span>سود/زیان باز</span><b class="${unrealized >= 0 ? 'up' : 'down'}">${faNum(unrealized, 2)} USDT</b></div>
      <div class="kpi"><span>معاملات بسته‌شده</span><b>${faNum(closedCount, 0)}</b></div>
      <div class="kpi"><span>پوزیشن‌های ربات</span><b>${faNum(botOpenCount, 0)} باز / ${faNum(botTotalCount, 0)} کل</b></div>
    </div>
    <div class="card">
      <h2>ربات معامله‌گر</h2>
      <div class="reason">
        وضعیت: <b class="${bot.enabled === 'on' ? 'up' : 'down'}">${bot.enabled === 'on' ? 'روشن — خودش از سیگنال‌های قوی معامله می‌کند' : 'خاموش — فقط ثبت دستی'}</b>
        · حداقل امتیاز ورود: ${faNum(bot.minScore, 0)} · سقف پوزیشن ربات: ${faNum(bot.maxOpen, 0)} · خنک‌شدن پس از ضرر: ${faNum(bot.cooldownHours, 0)} ساعت
      </div>
      <div class="reason" style="margin-top:6px">قوانین مدیریت: بعد از سود +۱٪ حد ضرر به سر‌به‌سر می‌رود، بعد از +۱٫۶٪ متحرک می‌شود، و معاملهٔ بی‌تحرک بعد از ۷۲ ساعت بسته می‌شود.</div>
      <div class="reason" style="margin-top:6px">آخرین فعالیت ربات: ${
        lastBotLog
          ? `${lastBotLog.ok ? '<b class="up">موفق</b>' : '<b class="down">خطا</b>'} — ${esc(lastBotLog.detail ?? '')} <span class="sub">(${FA_TIME.format(lastBotLog.startedAt)})</span>`
          : 'هنوز اجرا نشده — با اولین چرخه فعال می‌شود'
      }</div>
    </div>
    <div class="card">
      <h2>پوزیشن‌های باز</h2>
      ${
        positions.length
          ? `<div class="twrap"><table><tr><th>نماد</th><th>سمت</th><th>ورود</th><th>فعلی</th><th>حد ضرر</th><th>حد سود</th><th>سود</th></tr>
      ${positions
        .map(
          (p) => `<tr><td>${esc(p.symbol.replace('USDT', ''))}/USDT</td><td>${sideFa(p.side)}</td><td>${faNum(p.entryPrice, 4)}</td><td>${faNum(p.markPrice, 4)}</td><td class="down">${faNum(p.stopLoss, 4)}</td><td class="up">${faNum(p.takeProfit, 4)}</td><td class="${(p.pnlPct ?? 0) >= 0 ? 'up' : 'down'}">${faPct(p.pnlPct ?? 0, 2)}</td></tr>`,
        )
        .join('')}</table></div>`
          : '<div class="reason">پوزیشن بازی وجود ندارد — رادار هر ۱۵ دقیقه دنبال فرصت است.</div>'
      }
    </div>
    <div class="card">
      <h2>معاملات اخیر بسته‌شده</h2>
      ${
        closedPositions.length
          ? `<div class="twrap"><table><tr><th>نماد</th><th>سمت</th><th>سود USDT</th><th>سود ٪</th><th>زمان بستن</th></tr>
      ${closedPositions
        .map(
          (p) => `<tr><td>${esc(p.symbol.replace('USDT', ''))}/USDT</td><td>${sideFa(p.side)}</td><td class="${(p.pnlUsdt ?? 0) >= 0 ? 'up' : 'down'}">${faNum(p.pnlUsdt ?? 0, 2)}</td><td class="${(p.pnlPct ?? 0) >= 0 ? 'up' : 'down'}">${faPct(p.pnlPct ?? 0, 2)}</td><td class="sub">${p.closedAt ? FA_TIME.format(p.closedAt) : '—'}</td></tr>`,
        )
        .join('')}</table></div>`
          : '<div class="reason">هنوز معامله‌ای بسته نشده — SL و TP هر پوزیشن باز به‌صورت خودکار پایش می‌شود.</div>'
      }
    </div>`

  const tabBrain = `
    <div class="kpis">
      <div class="kpi"><span>نمونه‌های جمع‌آوری‌شده</span><b>${faNum(sampleTotal, 0)}</b></div>
      <div class="kpi"><span>ارزیابی‌شده</span><b>${faNum(sampleEvaluated, 0)}</b></div>
      <div class="kpi"><span>نرخ برد</span><b class="${(winRate ?? 0) >= 0.5 ? 'up' : 'down'}">${winRate === null ? '—' : faPct(winRate * 100, 1)}</b></div>
    </div>
    <div class="card">
      <h2>مسیر فعال‌شدن مغز (گارد سرد‌شروع)</h2>
      <div class="reason">مغز بعد از ${faNum(COLD_START_SAMPLES, 0)} نمونهٔ ارزیابی‌شده شروع به تنظیم خودکار وزن‌ها می‌کند.</div>
      <div class="bar" style="margin:8px 0"><i style="width:${Math.min(100, (sampleEvaluated / COLD_START_SAMPLES) * 100)}%"></i></div>
      <div class="sub">${faNum(sampleEvaluated, 0)} از ${faNum(COLD_START_SAMPLES, 0)} نمونه</div>
      <div class="reason" style="margin-top:8px">
        ${
          selfTest?.overall
            ? `دقت فعلی: ${faNum((selfTest.overall.accuracy ?? 0) * 100, 1)}٪ روی ${faNum(selfTest.overall.total ?? 0, 0)} نمونهٔ ارزیابی‌شده`
            : 'هنوز نمونهٔ ارزیابی‌شده‌ای نیست — با ادامهٔ چرخه‌ها پر می‌شود.'
        }
      </div>
    </div>
    <div class="card">
      <h2>وزن‌های فعلی (باندیت)</h2>
      ${Object.entries(weights as Record<FeatureKey, number>)
        .map(
          ([k, v]) => `<div style="display:flex;align-items:center;gap:8px;margin:6px 0">
        <span style="width:86px;font-size:11px;color:#848e9c">${esc(k)}</span>
        <span class="bar" style="flex:1"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></span>
        <b style="width:34px;text-align:left">${faNum(v, 0)}</b>
      </div>`,
        )
        .join('')}
    </div>`

  const tabNightshift = `
    <div class="card">
      <h2>موتور زمان‌بندی (بدون نیاز به کامپیوتر روشن)</h2>
      <div class="reason">این وظایف روی سرور رایگان GitHub Actions هر ۱۵ دقیقه یک‌جا اجرا می‌شوند؛ حتی وقتی گوشی و کامپیوتر شما خاموش است.</div>
    </div>
    <div class="card">
      <h2>وظایف و فاصلهٔ اجرا</h2>
      <div class="twrap"><table><tr><th>وظیفه</th><th>فاصله</th><th>آخرین وضعیت</th><th>جزئیات</th><th>زمان</th></tr>
      ${jobs
        .map((j) => {
          const r = lastRuns[jobs.indexOf(j)]
          return `<tr>
          <td>${JOBS_FA[j] ?? j}</td>
          <td class="sub">${faInterval(JOB_INTERVAL_MS[j] ?? 900_000)}</td>
          <td class="${r ? (r.ok ? 'up' : 'down') : 'sub'}">${r ? (r.ok ? 'موفق' : 'خطا') : 'هنوز اجرا نشده'}</td>
          <td class="reason">${r ? esc((r.detail ?? r.error ?? '').slice(0, 60)) : '—'}</td>
          <td class="sub">${r ? FA_TIME.format(r.startedAt) : '—'}</td>
        </tr>`
        })
        .join('')}
      </table></div>
    </div>
    <div class="card">
      <h2>۱۲ رویداد اخیر</h2>
      <div class="twrap"><table><tr><th>وظیفه</th><th>وضعیت</th><th>جزئیات</th><th>زمان</th></tr>
      ${recentLogs
        .map(
          (r) => `<tr><td>${JOBS_FA[r.job] ?? esc(r.job)}</td><td class="${r.ok ? 'up' : 'down'}">${r.ok ? 'موفق' : 'خطا'}</td><td class="reason">${esc((r.detail ?? r.error ?? '').slice(0, 70))}</td><td class="sub">${FA_TIME.format(r.startedAt)}</td></tr>`,
        )
        .join('')}
      </table></div>
    </div>`

  const tabHelp = `
    <div class="card">
      <h2>تنظیمات فعلی</h2>
      <div class="twrap"><table>
        <tr><td>حالت معاملات</td><td class="up">شبیه‌سازی (paper) — پول واقعی درگیر نیست</td></tr>
        <tr><td>افق ارزیابی</td><td>۲۴ و ۷۲ ساعت</td></tr>
        <tr><td>به‌روزرسانی داده</td><td>هر ۱۵ دقیقه توسط GitHub Actions</td></tr>
        <tr><td>عملیات مدیریتی (ثبت صندوق)</td><td>فقط از داشبورد کامل داخل پنل چت</td></tr>
      </table></div>
    </div>
    <div class="card">
      <h2>هر بخش چه می‌گوید؟</h2>
      <div class="reason" style="line-height:2">
        <b>داشبورد:</b> خلاصهٔ کل سامانه — دارایی، سلامت منابع داده و وضعیت وظایف.<br>
        <b>رادار فرصت‌ها:</b> سیگنال‌های خرید/فروش با امتیاز، حد ضرر و حد سود؛ «ثبت‌شده در صندوق» یعنی وارد شبیه‌سازی شده.<br>
        <b>صندوق شبیه‌ساز:</b> پوزیشن‌های باز و بسته‌شده با سود/زیان — مثل حساب آزمایشی.<br>
        <b>مغز یادگیرنده:</b> از نتیجهٔ سیگنال‌ها یاد می‌گیرد و وزن‌ها را خودکار تنظیم می‌کند.<br>
        <b>شیفت‌شب:</b> موتور زمان‌بندی که ۲۴ ساعته بدون شما کار می‌کند.
      </div>
    </div>
    <div class="card">
      <h2>هشدار مهم</h2>
      <div class="reason">همهٔ اعداد این صفحه آموزشی و شبیه‌سازی‌شده‌اند و هیچ توصیهٔ سرمایه‌گذاری‌ای نیستند. داده‌ها از Binance و CoinMarketCap تأمین می‌شود.</div>
    </div>`

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
  main { max-width:960px; margin:0 auto; padding:12px 16px 24px; }
  header { padding:8px 0 10px; }
  h1 { font-size:18px; margin:0; color:#f0b90b; }
  .sub { font-size:11px; color:#848e9c; }
  .tabs { position:sticky; top:0; background:#0b0e11; display:flex; gap:5px; overflow-x:auto; padding:8px 0; border-bottom:1px solid #1e242c; z-index:5; scrollbar-width:none; }
  .tabs::-webkit-scrollbar { display:none; }
  .tabbtn { flex:1 0 auto; background:#12161c; color:#848e9c; border:1px solid #1e242c; border-radius:10px; padding:8px 12px; font-family:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
  .tabbtn.on { background:rgba(240,185,11,.14); color:#f0b90b; border-color:rgba(240,185,11,.4); font-weight:700; }
  section[data-tab] { padding-top:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
  .card { background:#12161c; border:1px solid #1e242c; border-radius:12px; padding:14px; margin-bottom:12px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:#eaecef; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:12px; }
  .kpi { background:#12161c; border:1px solid #1e242c; border-radius:12px; padding:12px; }
  .kpi b { display:block; font-size:17px; margin-top:4px; }
  .kpi span { font-size:11px; color:#848e9c; }
  .up { color:#0ecb81; } .down { color:#f6465d; } .warn { color:#f0b90b; }
  .twrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td, th { padding:7px 6px; border-bottom:1px solid #1e242c; text-align:right; white-space:nowrap; }
  td:last-child { white-space:normal; }
  th { color:#848e9c; font-weight:400; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:10px; border:1px solid #1e242c; color:#848e9c; }
  .pill.reg { border-color:rgba(14,203,129,.5); color:#0ecb81; }
  .reason { font-size:11px; color:#848e9c; line-height:1.8; }
  svg.spark { width:100%; height:60px; }
  .bar { height:6px; background:#1e242c; border-radius:99px; overflow:hidden; }
  .bar i { display:block; height:100%; background:#f0b90b; }
  footer { text-align:center; color:#848e9c; font-size:10px; padding:16px 0; line-height:1.8; }
</style>
</head>
<body>
<main>
  <header>
    <h1>کریپتویار — شکار بهترین کوین‌ها در بهترین زمان</h1>
    <div class="sub">به‌روزرسانی: ${FA_TIME.format(new Date())} (تهران) · هر ۱۵ دقیقه توسط GitHub Actions</div>
  </header>

  <nav class="tabs" aria-label="بخش‌های داشبورد">
    <button type="button" class="tabbtn" data-go="dashboard">داشبورد</button>
    <button type="button" class="tabbtn" data-go="radar">رادار فرصت‌ها</button>
    <button type="button" class="tabbtn" data-go="fund">صندوق شبیه‌ساز</button>
    <button type="button" class="tabbtn" data-go="brain">مغز یادگیرنده</button>
    <button type="button" class="tabbtn" data-go="nightshift">شیفت‌شب</button>
    <button type="button" class="tabbtn" data-go="help">راهنما</button>
  </nav>

  <section data-tab="dashboard">${tabDashboard}</section>
  <section data-tab="radar" hidden>${tabRadar}</section>
  <section data-tab="fund" hidden>${tabFund}</section>
  <section data-tab="brain" hidden>${tabBrain}</section>
  <section data-tab="nightshift" hidden>${tabNightshift}</section>
  <section data-tab="help" hidden>${tabHelp}</section>

  <footer>
    کریپتویار · نسخهٔ رایگان روی GitHub Actions + Pages · دادهٔ آموزشی صندوق شبیه‌سازی است و توصیهٔ سرمایه‌گذاری نیست
  </footer>
</main>
<script>
(function(){
  var btns=document.querySelectorAll('.tabbtn'),secs=document.querySelectorAll('section[data-tab]');
  function show(t){
    for(var i=0;i<btns.length;i++){btns[i].classList.toggle('on',btns[i].getAttribute('data-go')===t)}
    for(var j=0;j<secs.length;j++){secs[j].hidden=secs[j].getAttribute('data-tab')!==t}
    try{localStorage.setItem('cy_cloud_tab',t)}catch(e){}
  }
  for(var i=0;i<btns.length;i++){(function(b){b.addEventListener('click',function(){show(b.getAttribute('data-go'))})})(btns[i])}
  var init='dashboard';
  try{init=localStorage.getItem('cy_cloud_tab')||init}catch(e){}
  show(init);
})();
</script>
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
    JSON.stringify(
      {
        equityNow,
        unrealized,
        coins,
        candleCount,
        positions: positions.map((p) => ({ symbol: p.symbol, side: p.side, pnlPct: p.pnlPct })),
        signals: signals.map((s) => ({ symbol: s.symbol, side: s.side, score: s.score, strategy: s.strategy, status: s.status })),
        brain: { total: sampleTotal, evaluated: sampleEvaluated, wins: sampleWins },
        bot: { enabled: bot.enabled, minScore: bot.minScore, maxOpen: bot.maxOpen, openPositions: botOpenCount, totalPositions: botTotalCount },
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(
    `REPORT DONE — site/index.html (${(html.length / 1024).toFixed(1)}KB) tabs=6, positions=${positions.length}, signals=${signals.length}, brainEval=${sampleEvaluated}/${sampleTotal}`,
  )
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
