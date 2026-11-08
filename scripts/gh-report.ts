// ─── CryptoYar Free — static dashboard generator (GitHub Pages) ───
// Reads the current DB state and writes a self-contained RTL HTML dashboard
// (7 tabs, mobile-first: داشبورد/رادار/ارزها/صندوق/مغز/شیفت‌شب/راهنما) + data.json into ./site (deployed by the workflow).

import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { db, ensurePragmas } from '@/lib/db'
import { getSetting, getBrainWeights, getBotConfig, getFuturesConfig, type FeatureKey } from '@/lib/settings'
import { currentEquity, liquidationPrice, roeOf } from '@/lib/fund'
import { runSelfTest, computeFeatures, STRATEGY_FA as STRATEGY_FA_LOCAL } from '@/lib/brain'
import { BOT_PREFIX } from '@/lib/autotrader'
import { getKlines } from '@/lib/fetchers/binance'
import { computeFundamentals, faBigUsd, type FundamentalRow } from '@/lib/fundamentals'
import { faNum, faPct, faPrice } from '@/lib/fa'

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
  'self-heal': 'خودترمیمی',
  'self-optimize': 'خودبهینه‌سازی',
  'self-update': 'خودبروزرسانی',
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
  'self-heal': 10 * 60_000,
  'self-optimize': 60 * 60_000,
  'self-update': 60 * 60_000,
  'brain-train': 30 * 60_000,
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

  const [healthRaw, weights, bot, futures, equityNow, equityPoints, positions, closedPositions, signals, coins, candleCount, selfTest, sampleTotal, sampleEvaluated, sampleWins, closedCount, botOpenCount, botTotalCount, lastBotLog, brainLessons] = await Promise.all([
    getSetting('healthSnapshot'),
    getBrainWeights(),
    getBotConfig(),
    getFuturesConfig(),
    currentEquity().catch(() => 0),
    db.equityPoint.findMany({ orderBy: { ts: 'desc' }, take: 48 }),
    db.fundPosition.findMany({ where: { status: 'open' } }),
    db.fundPosition.findMany({ where: { status: 'closed' }, orderBy: { closedAt: 'desc' }, take: 12 }),
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
    db.brainLesson.findMany({ orderBy: [{ kind: 'asc' }, { confidence: 'desc' }], take: 40 }),
  ])

  const [healRaw, optRaw, verRaw, trustRaw, cloudRaw, fail24] = await Promise.all([
    getSetting('healSnapshot'),
    getSetting('optimizeSnapshot'),
    getSetting('versionInfo'),
    getSetting('strategyTrust'),
    getSetting('cloudWatchdog'),
    db.jobLog.count({ where: { ok: false, startedAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
  ])
  const healSnap = healRaw ? (JSON.parse(healRaw) as { totalHeals?: number; recentActions?: string[]; sickNow?: string[] }) : null
  const optSnap = optRaw ? (JSON.parse(optRaw) as { sizeMB?: number | null; riskBefore?: number; riskAfter?: number; samples?: number; winRate?: number; action?: string }) : null
  const verSnap = verRaw ? (JSON.parse(verRaw) as { sha?: string; subject?: string; updatedCount?: number; syncCount?: number }) : null
  const strategyTrust = trustRaw ? (JSON.parse(trustRaw) as Record<string, number>) : {}
  const cloudWatch = cloudRaw
    ? (JSON.parse(cloudRaw) as { lastCycleCommitAt?: number; ageMin?: number | null; stale?: boolean; dispatchCount?: number; lastActionFa?: string; at?: number })
    : null
  // ضربان چرخهٔ ابری: فاصله از آخرین کامیت موفق چرخه (وضعیت نگهبان محلی + خود چرخه)
  const cycleAgeMin = cloudWatch?.lastCycleCommitAt
    ? Math.max(0, Math.round((Date.now() - cloudWatch.lastCycleCommitAt) / 60_000))
    : null
  const heartbeatFa =
    cycleAgeMin === null
      ? 'در انتظار اولین پایش نگهبان'
      : cycleAgeMin <= 2
        ? 'همین حالا ✓'
        : `${faNum(cycleAgeMin, 0)} دقیقه پیش${(cloudWatch?.stale || cycleAgeMin > 15) ? ' <b class="warn">— کندتر از حد معمول، نگهبان در حال رسیدگی</b>' : ''}`

  const health = healthRaw ? (JSON.parse(healthRaw) as Record<string, boolean>) : null

  // وضعیت بنیادی + جزییات هر ارز (کش ۱۰ دقیقه‌ای — بدون تماس API اضافه)
  const fundSnap = await computeFundamentals({ maxAgeMs: 10 * 60_000 }).catch(() => null)
  const fundBySymbol = new Map<string, FundamentalRow>((fundSnap?.rows ?? []).map((r) => [r.symbol, r]))
  const openSignalBySymbol = new Map<string, (typeof signals)[number]>()
  for (const s of signals) {
    if ((s.status === 'open' || s.status === 'registered') && !openSignalBySymbol.has(s.symbol)) openSignalBySymbol.set(s.symbol, s)
  }
  const posBySymbol = new Map(positions.map((p) => [p.symbol, p]))

  const equityAsc = equityPoints.slice().reverse()
  const unrealized = positions.reduce((s, p) => {
    const dir = p.side === 'short' ? -1 : 1
    const qty = p.qty || 0
    return s + dir * qty * ((p.markPrice || p.entryPrice) - p.entryPrice)
  }, 0)

  // ─── فیوچرز: تجمیع مارجین/اهرم پوزیشن‌های باز ───
  const futMargin = positions.reduce((a, p) => a + (p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, p.leverage || 1)), 0)
  const futNotional = positions.reduce((a, p) => a + p.entryPrice * p.qty, 0)
  const futAvgLev = futNotional > 0 ? positions.reduce((a, p) => a + (p.leverage || 1) * p.entryPrice * p.qty, 0) / futNotional : 1
  const futMaxLev = positions.reduce((a, p) => Math.max(a, p.leverage || 1), 1)
  const futLevCount = positions.filter((p) => (p.leverage || 1) > 1).length
  const futRoe = futMargin > 0 ? (unrealized / futMargin) * 100 : 0
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
      <div class="card">
        <h2>لایهٔ خودکار — سامانه خودش را بروزرسانی، ترمیم و بهینه می‌کند</h2>
        <div class="reason">
          <b>خودبروزرسانی:</b> ${
            verSnap?.sha
              ? `نسخهٔ فعال <b>${esc(verSnap.sha)}</b>${verSnap.subject ? ` — ${esc(verSnap.subject)}` : ''} · ${faNum(verSnap.updatedCount ?? 0, 0)} بروزرسانی و ${faNum(verSnap.syncCount ?? 0, 0)} همگام‌سازی خودکار`
              : 'در چرخهٔ بعدی ثبت می‌شود'
          }
        </div>
        <div class="reason" style="margin-top:6px">
          <b>خودترمیمی:</b> ${
            healSnap
              ? `${faNum(healSnap.totalHeals ?? 0, 0)} اقدام ترمیم تا امروز${healSnap.recentActions?.length ? ` — آخرین: ${esc(String(healSnap.recentActions[0]))}` : ' — فعلاً نیازی به ترمیم نبوده'}${healSnap.sickNow?.length ? ` · <b class="warn">${faNum(healSnap.sickNow.length, 0)} وظیفهٔ ناسالم: ${esc(healSnap.sickNow.join('، '))}</b>` : ''}`
              : 'پایش هنوز فعال نشده'
          }
        </div>
        <div class="reason" style="margin-top:6px">
          <b>ضربان ابر و نگهبان:</b> آخرین چرخهٔ ابری: ${heartbeatFa}${
            cloudWatch?.dispatchCount
              ? ` · نگهبان <b>${faNum(cloudWatch.dispatchCount, 0)}</b> بار چرخهٔ جاافتادهٔ کرون را دوباره روشن کرده${cloudWatch.lastActionFa ? ` — ${esc(cloudWatch.lastActionFa)}` : ''}`
              : ' · نگهبان ضربان فعال است'
          }
        </div>
        <div class="reason" style="margin-top:6px">
          <b>خطاهای ۲۴ ساعت اخیر:</b> ${
            fail24 > 0
              ? `<b class="warn">${faNum(fail24, 0)} خطا ثبت شده — خودترمیمی فعال است و خطاهای گذرا در همان چرخه یک تلاش دوم می‌گیرند</b>`
              : '<b class="up">صفر — همهٔ وظایف سالم</b>'
          }
        </div>
        <div class="reason" style="margin-top:6px">
          <b>خودبهینه‌سازی و رشد:</b> ${
            optSnap?.action
              ? `${esc(optSnap.action)}${optSnap.sizeMB ? ` · حجم دیتابیس ${faNum(optSnap.sizeMB, 1)} مگابایت` : ''}`
              : 'اولین تنظیم خودکار بعد از ۱۰ معاملهٔ ربات انجام می‌شود'
          }
        </div>
      </div>
    </div>`

  const fundBadge = (symbol: string): string => {
    const fr = fundBySymbol.get(symbol)
    return fr ? `<span class="badge ${fr.level}">${esc(fr.levelFa)} ${faNum(fr.score, 0)}</span>` : ''
  }

  const coinCard = (r: FundamentalRow): string => {
    const sig = openSignalBySymbol.get(r.symbol)
    const pos = posBySymbol.get(r.symbol)
    const perfCls = (v: number | null) => (v === null ? '' : v >= 0 ? 'up' : 'down')
    return `<details class="coin">
      <summary>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span class="rankchip">${faNum(r.rank, 0)}</span>
            <div style="min-width:0">
              <b style="font-size:12px">${esc(r.base)}/USDT</b>
              <div class="sub">${esc(r.name)}</div>
            </div>
          </div>
          <div style="text-align:left;flex-shrink:0">
            <div>${fundBadge(r.symbol)}</div>
            <div class="sub" style="margin-top:3px">${faPrice(r.price)} · <span class="${(r.change24h ?? 0) >= 0 ? 'up' : 'down'}">${r.change24h === null ? '—' : faPct(r.change24h, 1, true)}</span> ۲۴س</div>
          </div>
        </div>
      </summary>
      <div class="cdetail">
        <div class="cmetrics">
          <div class="cmet"><span>حجم روزانه</span><b>${faBigUsd(r.volume24h)}</b></div>
          <div class="cmet"><span>ارزش بازار</span><b>${faBigUsd(r.marketCap > 0 ? r.marketCap : null)}</b></div>
          <div class="cmet"><span>نرخ فاندینگ</span><b>${r.fundingRate === null ? '—' : faPct(r.fundingRate * 100, 3, true)}</b></div>
          <div class="cmet"><span>نوسان روزانه</span><b>${r.volatilityPct === null ? '—' : `${faNum(r.volatilityPct, 1)}٪`}</b></div>
          <div class="cmet"><span>RSI روزانه</span><b>${r.rsi1d === null ? '—' : faNum(r.rsi1d, 0)}</b></div>
          <div class="cmet"><span>روند روزانه</span><b>${esc(r.trendFa)}</b></div>
          <div class="cmet"><span>بازده ۷روزه</span><b class="${perfCls(r.perf7d)}">${r.perf7d === null ? '—' : faPct(r.perf7d, 1, true)}</b></div>
          <div class="cmet"><span>بازده ۳۰روزه</span><b class="${perfCls(r.perf30d)}">${r.perf30d === null ? '—' : faPct(r.perf30d, 1, true)}</b></div>
        </div>
        <div class="reason">${r.reasonsFa.map((x) => `• ${esc(x)}`).join('<br>')}</div>
        ${sig ? `<div class="reason" style="margin-top:7px">سیگنال فعال: <b>${sideFa(sig.side)}</b> با امتیاز ${faNum(sig.score, 0)} — ${sigStatusFa(sig.status)}</div>` : ''}
        ${pos ? `<div class="reason" style="margin-top:4px">پوزیشن باز در صندوق: ${sideFa(pos.side)} · سود/زیان فعلی <b class="${(pos.pnlPct ?? 0) >= 0 ? 'up' : 'down'}">${faPct(pos.pnlPct ?? 0, 2)}</b></div>` : ''}
      </div>
    </details>`
  }

  const marketChips = [
    fundSnap?.global && fundSnap.global.totalMarketCap > 0 ? `ارزش کل بازار: <b>${faBigUsd(fundSnap.global.totalMarketCap)}</b>` : null,
    fundSnap?.global && fundSnap.global.btcDominance > 0 ? `برتری بیت‌کوین: <b>${faNum(fundSnap.global.btcDominance, 1)}٪</b>` : null,
    fundSnap?.fearGreed && fundSnap.fearGreed.value > 0 ? `شاخص ترس‌وطمع: <b>${faNum(fundSnap.fearGreed.value, 0)}</b> (${esc(fundSnap.fearGreed.classificationFa)})` : null,
  ]
    .filter((x): x is string => Boolean(x))
    .map((x) => `<span class="pill">${x}</span>`)
    .join(' ')

  const tabCoins = fundSnap && fundSnap.rows.length
    ? `<div class="card">
        <h2>وضعیت بنیادی بازار چطور سنجیده می‌شود؟</h2>
        <div class="reason">امتیاز بنیادی هر ارز (۰ تا ۱۰۰) از ترکیب ۵ عامل ساخته می‌شود: رتبه بازار (۳۰ امتیاز) + نقدشوندگی حجم روزانه (۲۵) + باثباتی نوسان (۲۰) + سلامت روند روزانه (۱۵) + فشار فاندینگ (۱۰). «بنیاد قوی» یعنی پروژهٔ بزرگ، پرحجم و کم‌ریسک؛ «بنیاد ضعیف» یعنی پروژهٔ کوچک‌تر یا پرنوسان که ریسک بالاتری دارد.</div>
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">${marketChips}</div>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="badge strong">بنیاد قوی · ۷۰ به بالا</span>
          <span class="badge mid">بنیاد متوسط · ۵۰ تا ۶۹</span>
          <span class="badge weak">بنیاد ضعیف · زیر ۵۰</span>
        </div>
      </div>
      <div class="card">
        <h2>ارزهای تحت پوشش (${faNum(fundSnap.rows.length, 0)}) — برای دیدن جزییات، روی هر ردیف بزنید</h2>
        ${fundSnap.rows.map((r) => coinCard(r)).join('')}
      </div>`
    : '<div class="card"><div class="reason">دادهٔ بنیادی هنوز جمع نشده — بعد از اولین چرخهٔ کامل داده‌ها پر می‌شود.</div></div>'

  // ─── پامپ‌سنج زنده (Brain v4): CVD + موج حجم برای چند ارز شاخص — دادهٔ رایگان بایننس ───
  const PUMP_SCAN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT']
  type PumpRow = { symbol: string; cvd: number; volSurge: number; verdictFa: string; vcls: string }
  const pumpRows: PumpRow[] = []
  const pumpScans = await Promise.all(
    PUMP_SCAN_SYMBOLS.map(async (sym): Promise<PumpRow | null> => {
      try {
        const c = await getKlines(sym, '1h', 200)
        const f = computeFeatures({ candles1h: c, fundingRaw: null, oiNow: null, oi24hAgo: null, btcRet24h: 0 })
        if (!f) return null
        let verdictFa = 'آرام و بی‌جهت'
        let vcls = 'sub'
        if (f.volSurge > 0 && f.cvd > 0.15) {
          verdictFa = 'پامپ تأییدشده — خرید تهاجمی با موج حجم (پول واقعی)'
          vcls = 'up'
        } else if (f.volSurge > 0 && f.cvd < -0.15) {
          verdictFa = 'ریزش فعال — فروش تهاجمی با موج حجم'
          vcls = 'down'
        } else if (f.cvd > 0.15) {
          verdictFa = 'خرید تهاجمی بدون موج حجم — منتظر تأیید حجم'
          vcls = ''
        } else if (f.cvd < -0.15) {
          verdictFa = 'فشار فروش بدون موج حجم'
          vcls = ''
        }
        return { symbol: sym, cvd: f.cvd, volSurge: f.volSurge, verdictFa, vcls }
      } catch {
        return null
      }
    }),
  )
  for (const r of pumpScans) if (r) pumpRows.push(r)

  const pumpMeter = `
    <div class="card">
      <h2>پامپ‌سنج — چشم‌های جدید رادار (نسخهٔ ۴ مغز)</h2>
      <div class="reason">رادار حالا سه چشم جدید دارد: <b>CVD</b> (فشار خرید تهاجمی — نشان می‌دهد خریداران واقعی فعال‌اند یا فروشندگان)، <b>موج حجم</b> (حجم معامله در برابر میانگین ۲۰ کندل) و <b>رژیم OI</b> (ورود پول نو به فیوچرز). قاعدهٔ جدید ربات: شکست مومنتوم فقط وقتی وارد معامله می‌شود که حجم و خرید تهاجمی هر دو تأیید کنند — شکست بی‌حجم یا با فروش تهاجمی، «فیک» شمرده می‌شود و رد می‌شود.</div>
      ${
        pumpRows.length
          ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">${pumpRows
              .map(
                (p) => `<div style="border:1px solid #1e242c;border-radius:10px;padding:8px 10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <b style="font-size:12px">${esc(p.symbol.replace('USDT', ''))}/USDT</b>
            <span class="sub">CVD ${faNum(p.cvd, 2)} · موج حجم ${faNum(p.volSurge, 2)}</span>
          </div>
          <div class="${p.vcls}" style="font-size:11px;margin-top:3px">${esc(p.verdictFa)}</div>
        </div>`,
              )
              .join('')}</div>`
          : '<div class="reason">پامپ‌سنج در چرخهٔ بعدی پر می‌شود.</div>'
      }
    </div>`

  const tabRadar = `${pumpMeter}${signals.length
    ? `<div class="card">
        ${signals
          .map((s) => {
            // یکپارچه‌سازی پامپ-پک در کارت سیگنال: نشان‌های CVD / موج حجم / رژیم OI (وقتی داده موجود باشد)
            let fx: { cvd?: number; volSurge?: number; oiRegime?: number } = {}
            try {
              fx = JSON.parse(s.featuresJson ?? '{}') as typeof fx
            } catch {
              /* سیگنال قدیمی — بدون نشان پامپ */
            }
            const pills: string[] = []
            if (typeof fx.cvd === 'number')
              pills.push(
                `<span class="pill ${fx.cvd > 0.15 ? '' : fx.cvd < -0.15 ? '' : 'sub'}" style="${fx.cvd > 0.15 ? 'color:#0ecb81' : fx.cvd < -0.15 ? 'color:#f6465d' : ''}">CVD ${faNum(fx.cvd, 2)}</span>`,
              )
            if (typeof fx.volSurge === 'number')
              pills.push(`<span class="pill ${fx.volSurge > 0 ? '' : 'sub'}" style="${fx.volSurge > 0 ? 'color:#f0b90b' : ''}">موج حجم ${faNum(fx.volSurge, 2)}</span>`)
            if (typeof fx.oiRegime === 'number' && Math.abs(fx.oiRegime) > 0.15)
              pills.push(
                `<span class="pill">${fx.oiRegime > 0 ? 'پول نو به فیوچرز' : 'OI شکننده'} ${faNum(fx.oiRegime, 2)}</span>`,
              )
            const pumpPillsHtml = pills.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin:4px 0">${pills.join('')}</div>` : ''
            return `<div style="padding:9px 0;border-bottom:1px solid #1e242c">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <b>${esc(s.symbol.replace('USDT', ''))}/USDT — ${sideFa(s.side)}</b>
          <span style="display:flex;gap:5px;align-items:center">
            ${fundBadge(s.symbol)}
            <span class="pill ${s.status === 'registered' ? 'reg' : ''}">${sigStatusFa(s.status)}</span>
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
          <span class="bar" style="flex:1"><i style="width:${Math.max(3, Math.min(100, s.score))}%"></i></span>
          <b style="width:40px;text-align:left;color:#f0b90b">${faNum(s.score, 0)}</b>
        </div>
        <div class="reason">ورود: ${faNum(s.entryPrice, 4)} · حد ضرر: <span class="down">${faNum(s.stopLoss, 4)}</span> · حد سود: <span class="up">${faNum(s.takeProfit, 4)}</span> · استراتژی: ${esc(STRATEGY_FA_LOCAL[s.strategy] ?? s.strategy)}</div>
        ${pumpPillsHtml}
        <div class="reason">${esc(s.reasonFa)}</div>
        ${s.gateStatus === 'rejected' && s.gateReasonFa ? `<div class="reason" style="color:#f6465d">چرا ربات معامله نکرد؟ دروازهٔ استادی رد کرد: <b>${esc(s.gateReasonFa)}</b> — ثبت دستی آزاد است ولی ریسک با شماست.</div>` : s.gateStatus === 'skipped' && s.gateReasonFa ? `<div class="reason" style="color:#f0b90b">چرا هنوز معامله نشد؟ <b>${esc(s.gateReasonFa)}</b></div>` : s.status === 'registered' || s.gateStatus === 'passed' ? `<div class="reason" style="color:#0ecb81">از دروازهٔ استادی عبور کرد و وارد صندوق شد ✓</div>` : ''}
        <div class="sub">${FA_TIME.format(s.createdAt)}</div>
      </div>`
          })
          .join('')}
      </div>`
    : '<div class="card"><div class="reason">هنوز سیگنالی ثبت نشده — رادار هر ۵ دقیقه بازار را اسکن می‌کند.</div></div>'}`

  const tabFund = `
    <div class="kpis">
      <div class="kpi"><span>دارایی فعلی</span><b>${faNum(equityNow, 2)} USDT</b></div>
      <div class="kpi"><span>سود/زیان باز</span><b class="${unrealized >= 0 ? 'up' : 'down'}">${faNum(unrealized, 2)} USDT</b></div>
      <div class="kpi"><span>معاملات بسته‌شده</span><b>${faNum(closedCount, 0)}</b></div>
      <div class="kpi"><span>پوزیشن‌های ربات</span><b>${faNum(botOpenCount, 0)} باز / ${faNum(botTotalCount, 0)} کل</b></div>
    </div>
    <div class="card">
      <h2>فیوچرز — مارجین و اهرم (شبیه‌سازی)</h2>
      <div class="kpis" style="margin:0">
        <div class="kpi"><span>مارجین درگیر</span><b>${faNum(futMargin, 2)} USDT</b></div>
        <div class="kpi"><span>اهرم میانگین / بیشینه</span><b>×${faNum(futAvgLev, 1)} / ×${faNum(futMaxLev, 0)}</b></div>
        <div class="kpi"><span>ROE باز روی مارجین</span><b class="${futRoe >= 0 ? 'up' : 'down'}">${faPct(futRoe, 1)}</b></div>
        <div class="kpi"><span>حجم اسمی</span><b>${faNum(futNotional, 0)} USDT</b></div>
      </div>
      <div class="reason" style="margin-top:8px">حالت اهرم: ${futures.mode === 'auto' ? '<b class="up">خودکار — متناسب با ریسک، نوسان و بنیاد هر ارز</b>' : `<b class="warn">ثابت ×${faNum(futures.fixedLev, 0)}</b>`} · سقف اهرم: ×${faNum(futures.maxLev, 0)} · دروازهٔ استادی: ${futures.expertGate === 'on' ? '<b class="up">روشن</b>' : '<b class="down">خاموش</b>'} · پوزیشن اهرم‌دار: ${faNum(futLevCount, 0)} — سقف اهرم از اپ (تب تنظیمات) قابل تغییر است.</div>
    </div>
    <div class="card">
      <h2>ربات معامله‌گر</h2>
      <div class="reason">
        وضعیت: <b class="${bot.enabled === 'on' ? 'up' : 'down'}">${bot.enabled === 'on' ? 'روشن — خودش از سیگنال‌های قوی معامله می‌کند' : 'خاموش — فقط ثبت دستی'}</b>
        · حداقل امتیاز ورود: ${faNum(bot.minScore, 0)} · سقف پوزیشن ربات: ${faNum(bot.maxOpen, 0)} · خنک‌شدن پس از ضرر: ${faNum(bot.cooldownHours, 0)} ساعت
      </div>
      <div class="reason" style="margin-top:6px">تحلیل استادی: پیش از هر ورود، بنیاد ارز، اشباع RSI، نوسان ATR، فاندینگ ازدحام و روند ۴ساعته (MTF) بررسی می‌شود و همگرایی ۹ فاکتور تکنیکال شمرده می‌شود؛ ${futures.mode === 'auto' ? 'اهرم هر معامله با بنیاد همان ارز تنظیم می‌گردد (ضعیف بدون اهرم، متوسط تا ×۳، قوی تا سقف)' : `همهٔ معامله‌ها با اهرم ثابت <b class="warn">×${faNum(futures.fixedLev, 0)}</b> باز می‌شوند`}.</div>
      <div class="reason" style="margin-top:6px">قوانین مدیریت: بعد از سود ‎+۱٪ حد ضرر به سر‌به‌سر می‌رود، بعد از ‎+۱٫۶٪ متحرک می‌شود، و معاملهٔ بی‌تحرک بعد از ۷۲ ساعت بسته می‌شود. <b>گیت پامپ:</b> شکست مومنتوم فقط با تأیید حجم و خرید تهاجمی (CVD) وارد می‌شود؛ پامپ‌های تأییدشده زودتر و تنگ‌تر تریل می‌شوند (‎+۱٪ با فاصلهٔ ۰٫۸٪) تا سود قبل از فروپاشی قفل شود.</div>
      <div class="reason" style="margin-top:6px"><b>قوانین هوشمند جدید (شروع دوباره با ۱٬۰۰۰ USDT):</b> ① حداکثر <b>۲ پوزیشن هم‌جهت</b> — دیگر همهٔ خریدها با هم قرمز نمی‌شوند ② استراتژی‌ای که <b>۳ ضرر پیاپی</b> بدهد، ۲۴ ساعت وارد معامله نمی‌شود ③ «اعتماد مغز» هر استراتژی روی آستانهٔ ورود اثر می‌گذارد (اعتماد کم = سخت‌گیرانه‌تر، اعتماد بالا = کمی آسان‌تر) ④ آستانهٔ ورود به <b>۷۰</b> و سقف پوزیشن به <b>۴</b> سخت‌گیرانه شد — کیفیت مهم‌تر از تعداد است.</div>
      <div class="reason" style="margin-top:6px">آخرین فعالیت ربات: ${
        lastBotLog
          ? `${lastBotLog.ok ? '<b class="up">موفق</b>' : '<b class="down">خطا</b>'} — ${esc(lastBotLog.detail ?? '')} <span class="sub">(${FA_TIME.format(lastBotLog.startedAt)})</span>`
          : 'هنوز اجرا نشده — با اولین چرخه فعال می‌شود'
      }</div>
    </div>
    <div class="card">
      <h2>پوزیشن‌های باز فیوچرز</h2>
      ${
        positions.length
          ? `<div class="twrap"><table><tr><th>نماد</th><th>سمت</th><th>اهرم</th><th>مارجین</th><th>ورود</th><th>فعلی</th><th>حد ضرر</th><th>لیکوییدیشن</th><th>حد سود</th><th>ROE</th><th>سود</th><th>دلیل ورود (چرا؟)</th></tr>
      ${positions
        .map(
          (p) => {
            const lev = p.leverage || 1
            const margin = p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, lev)
            const roe = roeOf(p)
            const liq = liquidationPrice(p)
            return `<tr><td>${esc(p.symbol.replace('USDT', ''))}/USDT</td><td>${sideFa(p.side)}</td><td><b class="${lev > 1 ? 'warn' : 'sub'}">×${faNum(lev, lev % 1 === 0 ? 0 : 1)}</b></td><td>${faNum(margin, 2)}</td><td>${faNum(p.entryPrice, 4)}</td><td>${faNum(p.markPrice, 4)}</td><td class="down">${faNum(p.stopLoss, 4)}</td><td class="sub">${lev > 1 ? faNum(liq, 4) : '—'}</td><td class="up">${faNum(p.takeProfit, 4)}</td><td class="${roe >= 0 ? 'up' : 'down'}">${faPct(roe, 1)}</td><td class="${(p.pnlPct ?? 0) >= 0 ? 'up' : 'down'}">${faPct(p.pnlPct ?? 0, 2)}</td><td class="sub" style="max-width:230px;min-width:150px;font-size:11px;line-height:1.7">${esc(p.reasonFa || '—')}</td></tr>`
          },
        )
        .join('')}</table></div>`
          : '<div class="reason">پوزیشن بازی وجود ندارد — رادار هر ۵ دقیقه دنبال فرصت است.</div>'
      }
    </div>
    <div class="card">
      <h2>معاملات اخیر بسته‌شده</h2>
      ${
        closedPositions.length
          ? `<div class="twrap"><table><tr><th>نماد</th><th>سمت</th><th>سود USDT</th><th>سود ٪</th><th>دلیل بستن (چرا؟)</th><th>زمان بستن</th></tr>
      ${closedPositions
        .map(
          (p) => `<tr><td>${esc(p.symbol.replace('USDT', ''))}/USDT</td><td>${sideFa(p.side)}</td><td class="${(p.pnlUsdt ?? 0) >= 0 ? 'up' : 'down'}">${faNum(p.pnlUsdt ?? 0, 2)}</td><td class="${(p.pnlPct ?? 0) >= 0 ? 'up' : 'down'}">${faPct(p.pnlPct ?? 0, 2)}</td><td class="sub" style="max-width:260px;min-width:170px;font-size:11px;line-height:1.7">${esc(p.closeReasonFa || '—')}</td><td class="sub">${p.closedAt ? FA_TIME.format(p.closedAt) : '—'}</td></tr>`,
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
      <h2>وزن‌های فعلی (باندیت نسخه ۲)</h2>
      ${Object.entries(weights as Record<FeatureKey, number>)
        .map(
          ([k, v]) => `<div style="display:flex;align-items:center;gap:8px;margin:6px 0">
        <span style="width:86px;font-size:11px;color:#848e9c">${esc(k)}</span>
        <span class="bar" style="flex:1"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></span>
        <b style="width:34px;text-align:left">${faNum(v, 0)}</b>
      </div>`,
        )
        .join('')}
    </div>
    <div class="card">
      <h2>اعتماد به استراتژی‌ها (یادگرفته‌شده از نتایج واقعی)</h2>
      ${
        Object.keys(strategyTrust).length
          ? `<div class="reason">ضریب بالای ۱ = استراتژی پربازده‌تر (امتیازش تقویت می‌شود)، زیر ۱ = ضعیف‌تر (سخت‌گیرانه‌تر می‌شود).</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
        ${Object.entries(strategyTrust)
          .map(
            ([k, v]) =>
              `<span style="padding:4px 10px;border-radius:12px;font-size:11px;background:${v >= 1 ? 'rgba(14,203,129,.12);color:#0ecb81' : 'rgba(246,70,93,.12);color:#f6465d'}">${esc(STRATEGY_FA_LOCAL[k] ?? k)} ×${faNum(v, 2)}</span>`,
          )
          .join('')}
      </div>`
          : '<div class="reason">هنوز نمونهٔ کافی برای سنجش اعتماد هر استراتژی جمع نشده — به‌مرور از نتایج واقعی یاد گرفته می‌شود.</div>'
      }
    </div>
    <div class="card">
      <h2>دانش‌نامهٔ تریدر حرفه‌ای + درس‌های آموخته از بازار</h2>
      ${
        brainLessons.length
          ? (() => {
              const cur = brainLessons.filter((l) => l.kind === 'curriculum')
              const mined = brainLessons.filter((l) => l.kind === 'pattern' && l.active)
              return `<div class="reason"><b>${faNum(cur.length, 0)} قاعدهٔ طلایی</b> همیشه در تصمیم‌ها اعمال می‌شود (دروازهٔ استادی، موتور ریسک، مدیریت پوزیشن):</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${cur.map((l) => `<span style="padding:4px 10px;border-radius:12px;font-size:11px;background:rgba(252,213,53,.1);color:#fcd535">${esc(l.titleFa)}</span>`).join('')}</div>
      <div class="reason" style="margin-top:12px"><b>درس‌های کشف‌شده از داده‌های واقعی</b> (الگوهایی که نرخ بردشان از میانگین فاصله معنادار دارد — امتیاز سیگنال‌های مشابه ±دلتا می‌گیرد):</div>
      ${
        mined.length
          ? `<div style="margin-top:8px;display:grid;gap:8px">${mined
              .map(
                (l) => `<div style="border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
              <b style="font-size:12px">${esc(l.titleFa)}</b>
              <span style="flex-shrink:0;font-size:11px;font-weight:700;color:${l.delta >= 0 ? '#0ecb81' : '#f6465d'}">${l.delta > 0 ? '+' : ''}${faNum(l.delta, 1)} امتیاز</span>
            </div>
            <div class="sub" style="margin-top:4px">${esc(l.statsFa)} · اطمینان ${faNum(l.confidence, 0)}٪</div>
            <div class="reason" style="margin-top:4px;font-size:11px">${esc(l.bodyFa)}</div>
          </div>`,
              )
              .join('')}</div>`
          : '<div class="reason" style="margin-top:8px">هنوز الگویی با شواهد کافی کشف نشده — با ارزیابی نمونه‌های بیشتر، درس‌های تازه همین‌جا ثبت می‌شوند.</div>'
      }`
            })()
          : '<div class="reason">دانش‌نامه هنوز کاشته نشده — با اولین چرخه فعال می‌شود.</div>'
      }
    </div>`

  const tabNightshift = `
    <div class="card">
      <h2>موتور زمان‌بندی (بدون نیاز به کامپیوتر روشن)</h2>
      <div class="reason">این وظایف روی سرور رایگان GitHub Actions هر ۵ دقیقه یک‌جا اجرا می‌شوند؛ حتی وقتی گوشی و کامپیوتر شما خاموش است.</div>
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
        <tr><td>به‌روزرسانی داده</td><td>هر ۵ دقیقه توسط GitHub Actions</td></tr>
        <tr><td>عملیات مدیریتی (ثبت صندوق)</td><td>فقط از داشبورد کامل داخل پنل چت</td></tr>
      </table></div>
    </div>
    <div class="card">
      <h2>هر بخش چه می‌گوید؟</h2>
      <div class="reason" style="line-height:2">
        <b>داشبورد:</b> خلاصهٔ کل سامانه — دارایی، سلامت منابع داده و وضعیت وظایف.<br>
        <b>رادار فرصت‌ها:</b> سیگنال‌های خرید/فروش با امتیاز، حد ضرر و حد سود + نشان وضعیت بنیادی همان ارز؛ «ثبت‌شده در صندوق» یعنی وارد شبیه‌سازی شده.<br>
        <b>ارزها:</b> برای هر یک از ۵۰ ارزِ تحت پوشش، امتیاز و وضعیت بنیادی (رتبه بازار، نقدشوندگی، نوسان، روند، فاندینگ) به‌همراه جزییات کامل: قیمت، حجم، ارزش بازار، بازده ۷ و ۳۰ روزه و دلایل فارسی — روی هر ردیف بزنید تا باز شود.<br>
        <b>صندوق شبیه‌ساز (فیوچرز):</b> پوزیشن‌های خرید/فروش با اهرم متناسب، مارجین، ROE و قیمت لیکوییدیشن — مثل حساب فیوچرز آزمایشی؛ سقف اهرم از تب تنظیمات اپ قابل تغییر است.<br>
        <b>مغز یادگیرنده:</b> از نتیجهٔ سیگنال‌ها یاد می‌گیرد و وزن‌ها را خودکار تنظیم می‌کند.<br>
        <b>شیفت‌شب:</b> موتور زمان‌بندی که ۲۴ ساعته بدون شما کار می‌کند.<br>
        <b>لایهٔ خودکار:</b> ربات معامله‌گر با دروازهٔ استادی (بنیاد + تکنیکال ۹ فاکتور) خودش معامله فیوچرز با اهرم متناسب باز می‌کند، خودش را بروزرسانی می‌کند، خطاها را ترمیم می‌کند و ریسک را با عملکردش تنظیم می‌کند.
      </div>
    </div>
    <div class="card">
      <h2>نصب به‌صورت اپلیکیشن</h2>
      <div class="reason" style="line-height:2">
        <b>اندروید (کروم):</b> منوی سه‌نقطهٔ بالای مرورگر → «افزودن به صفحه اصلی» یا «نصب برنامه» → تأیید. آیکون کریپتویار مثل یک اپ واقعی روی صفحهٔ گوشی می‌نشیند و تمام‌صفحه باز می‌شود.<br>
        <b>آیفون و آیپد (سافاری):</b> دکمهٔ اشتراک (مربع با فلش رو به بالا) → «افزودن به صفحهٔ اصلی» → Add. اپ از آیکون خودش و بدون نوار مرورگر باز می‌شود.<br>
        <b>ویندوز و مک (کروم یا اج):</b> در نوار آدرس آیکون نصب را بزنید، یا منوی سه‌نقطه → «Install» . اپ در پنجرهٔ مستقل خودش باز می‌شود و در منوی استارت/داک می‌نشیند.<br>
        این نسخهٔ نصب‌شده حتی بدون اینترنت صفحه را باز می‌کند و داده‌ها همیشه از آخرین چرخهٔ ۱۵ دقیقه‌ای می‌آید.
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
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>کریپتویار — داشبورد رایگان</title>
<meta name="theme-color" content="#0d1220">
<link rel="manifest" href="manifest.json">
<link rel="icon" type="image/png" sizes="64x64" href="icons/favicon-64.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="کریپتویار">
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
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:10px; font-weight:700; white-space:nowrap; }
  .badge.strong { background:rgba(14,203,129,.14); color:#0ecb81; }
  .badge.mid { background:rgba(240,185,11,.14); color:#f0b90b; }
  .badge.weak { background:rgba(246,70,93,.14); color:#f6465d; }
  .rankchip { display:inline-flex; align-items:center; justify-content:center; min-width:26px; height:22px; padding:0 4px; border-radius:7px; background:#1e242c; color:#f0b90b; font-size:10px; font-weight:700; }
  details.coin { border-bottom:1px solid #1e242c; }
  details.coin:last-child { border-bottom:none; }
  details.coin summary { cursor:pointer; list-style:none; padding:10px 0; }
  details.coin summary::-webkit-details-marker { display:none; }
  details.coin summary::after { content:'⌄'; float:left; color:#848e9c; font-size:13px; }
  details.coin[open] summary::after { content:'⌃'; }
  details.coin[open] summary { border-bottom:1px dashed #1e242c; margin-bottom:8px; }
  .cdetail { padding:2px 0 12px; }
  .cmetrics { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:6px 0 9px; }
  .cmet { background:#0b0e11; border:1px solid #1e242c; border-radius:8px; padding:7px 9px; }
  .cmet span { display:block; color:#848e9c; font-size:10px; margin-bottom:2px; }
  .cmet b { font-size:11px; }
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
    <div class="sub">به‌روزرسانی: ${FA_TIME.format(new Date())} (تهران) · هر ۵ دقیقه توسط GitHub Actions</div>
  </header>

  <nav class="tabs" aria-label="بخش‌های داشبورد">
    <button type="button" class="tabbtn" data-go="dashboard">داشبورد</button>
    <button type="button" class="tabbtn" data-go="radar">رادار فرصت‌ها</button>
    <button type="button" class="tabbtn" data-go="coins">ارزها</button>
    <button type="button" class="tabbtn" data-go="fund">صندوق شبیه‌ساز</button>
    <button type="button" class="tabbtn" data-go="brain">مغز یادگیرنده</button>
    <button type="button" class="tabbtn" data-go="nightshift">شیفت‌شب</button>
    <button type="button" class="tabbtn" data-go="help">راهنما</button>
  </nav>

  <section data-tab="dashboard">${tabDashboard}</section>
  <section data-tab="radar" hidden>${tabRadar}</section>
  <section data-tab="coins" hidden>${tabCoins}</section>
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
  var VALID=['dashboard','radar','coins','fund','brain','nightshift','help'];
  function show(t,skipHash){
    for(var i=0;i<btns.length;i++){btns[i].classList.toggle('on',btns[i].getAttribute('data-go')===t)}
    for(var j=0;j<secs.length;j++){secs[j].hidden=secs[j].getAttribute('data-tab')!==t}
    try{localStorage.setItem('cy_cloud_tab',t)}catch(e){}
    if(!skipHash){try{history.replaceState(null,'','#'+t)}catch(e){}}
  }
  for(var i=0;i<btns.length;i++){(function(b){b.addEventListener('click',function(){show(b.getAttribute('data-go'))})})(btns[i])}
  var init='dashboard';
  var h=(location.hash||'').replace('#','');
  if(VALID.indexOf(h)>=0){init=h}
  else{try{init=localStorage.getItem('cy_cloud_tab')||init}catch(e){}}
  show(init,true);
  window.addEventListener('hashchange',function(){var nh=(location.hash||'').replace('#','');if(VALID.indexOf(nh)>=0)show(nh,true)});
  if('serviceWorker' in navigator){try{navigator.serviceWorker.register('sw.js')}catch(e){}}
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

  // ─── PWA: manifest + service worker + icons ───
  const manifest = {
    name: 'کریپتویار — شکار بهترین کوین‌ها',
    short_name: 'کریپتویار',
    description: 'داشبورد رایگان رادار سیگنال، صندوق شبیه‌ساز و مغز یادگیرنده',
    lang: 'fa',
    dir: 'rtl',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0d1220',
    theme_color: '#0d1220',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
  writeFileSync('site/manifest.json', JSON.stringify(manifest, null, 2), 'utf8')

  const swJs = `var CACHE='cryptoyar-shell-v1';
self.addEventListener('install',function(e){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var url;try{url=new URL(e.request.url)}catch(err){return}
  if(url.origin!==location.origin)return;
  e.respondWith(
    fetch(e.request).then(function(r){
      if(r&&r.ok){var cp=r.clone();try{caches.open(CACHE).then(function(c){c.put(e.request,cp)})}catch(err){}}
      return r;
    }).catch(function(){
      return caches.match(e.request).then(function(hit){
        if(hit)return hit;
        if(e.request.mode==='navigate')return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
`
  writeFileSync('site/sw.js', swJs, 'utf8')

  mkdirSync('site/icons', { recursive: true })
  for (const f of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-64.png']) {
    const src = `public/pwa/${f}`
    if (existsSync(src)) copyFileSync(src, `site/icons/${f}`)
  }

  writeFileSync(
    'site/data.json',
    JSON.stringify(
      {
        equityNow,
        unrealized,
        coins,
        candleCount,
        positions: positions.map((p) => ({ symbol: p.symbol, side: p.side, pnlPct: p.pnlPct, leverage: p.leverage || 1, marginUsdt: p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, p.leverage || 1), reasonFa: p.reasonFa, closeReasonFa: p.closeReasonFa })),
        signals: signals.map((s) => ({ symbol: s.symbol, side: s.side, score: s.score, strategy: s.strategy, status: s.status })),
        fundamentals: fundSnap
          ? {
              at: fundSnap.at,
              fearGreed: fundSnap.fearGreed,
              global: fundSnap.global,
              rows: fundSnap.rows.map((r) => ({
                symbol: r.symbol,
                base: r.base,
                rank: r.rank,
                price: r.price,
                change24h: r.change24h,
                volume24h: r.volume24h,
                marketCap: r.marketCap,
                fundingRate: r.fundingRate,
                rsi1d: r.rsi1d,
                volatilityPct: r.volatilityPct,
                perf7d: r.perf7d,
                perf30d: r.perf30d,
                trendFa: r.trendFa,
                score: r.score,
                level: r.level,
                levelFa: r.levelFa,
                reasonsFa: r.reasonsFa,
              })),
            }
          : null,
        brain: { total: sampleTotal, evaluated: sampleEvaluated, wins: sampleWins },
        bot: { enabled: bot.enabled, minScore: bot.minScore, maxOpen: bot.maxOpen, openPositions: botOpenCount, totalPositions: botTotalCount },
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(
    `REPORT DONE — site/index.html (${(html.length / 1024).toFixed(1)}KB) tabs=7, coins=${fundSnap?.rows.length ?? 0}, positions=${positions.length}, signals=${signals.length}, brainEval=${sampleEvaluated}/${sampleTotal}`,
  )

  await commitAndPushDb()
}

// ─── مقاوم‌سازی کامیت دیتابیس (حادثهٔ 2026-11-07) ───
// مرحلهٔ YAML «Commit database back to repo» فقط commit+push ساده است؛ اگر هر
// چیز دیگری (هارت‌بیت نگهبان، کامیت خودکار سندباکس) بین checkout و push به
// مخزن رسیده باشد، push با «fetch first» رد می‌شود → چرخه مرد و داشبورد منتشر نشد
// (اجرای 18:13، 18:53 و 21:51 UTC). راه‌حل: کامیت+push همین‌جا با منطق مقاوم
// انجام می‌شود تا مرحلهٔ YAML بی‌کار شود (چیزی برای اضافه‌کردن نمی‌ماند).
async function gitCmd(args: string[], timeoutMs = 90_000): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await promisify(execFile)('git', args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    })
    return { ok: true, out: r.stdout.trim() }
  } catch (err) {
    const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer }
    const errOut = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString?.() ?? '')
    const msg = [e.message ?? '', errOut].filter(Boolean).join(' | ').slice(0, 500)
    return { ok: false, out: msg }
  }
}

async function commitAndPushDb(): Promise<void> {
  // فقط داخل CI — اجرای محلی گزارش هرگز چیزی کامیت نمی‌کند
  if (process.env.GITHUB_ACTIONS !== 'true') {
    console.log('DB COMMIT: خارج از CI — رد شد')
    return
  }
  try {
    await gitCmd(['config', 'user.name', 'cryptoyar-bot'])
    await gitCmd(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
    await gitCmd(['add', 'db/custom.db'])
    if ((await gitCmd(['diff', '--cached', '--quiet'])).ok) {
      console.log('DB COMMIT: تغییر دیتابیسی برای ثبت نیست')
      return
    }
    // نسخهٔ پشتیبان باینری از دیتابیس تازهٔ این چرخه (برای بازیابی در تلاش مجدد)
    copyFileSync('db/custom.db', '/tmp/mycycle.db')
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const cm = await gitCmd(['commit', '-m', `data: cycle ${stamp}`])
    if (!cm.ok) {
      console.log(`DB COMMIT: کامیت ناموفق — ${cm.out}`)
      return
    }
    let push = await gitCmd(['push', 'origin', 'main'], 120_000)
    if (!push.ok && /fetch first|non-fast-forward|rejected/i.test(push.out)) {
      // مخزن جلوتر رفته (هارت‌بیت نگهبان یا کامیت خارجی) → بازیابی مقاوم:
      // به نوک مخزن برو، فقط دیتابیسِ تازهٔ خودمان را برگردان و دوباره push کن
      console.log('DB COMMIT: push رد شد — همگام‌سازی با نوک مخزن و تلاش مجدد…')
      const fe = await gitCmd(['fetch', 'origin', 'main'], 120_000)
      const rs = fe.ok ? await gitCmd(['reset', '--hard', 'origin/main'], 60_000) : { ok: false, out: 'fetch failed' }
      if (rs.ok) {
        copyFileSync('/tmp/mycycle.db', 'db/custom.db')
        await gitCmd(['add', 'db/custom.db'])
        const cm2 = await gitCmd(['commit', '-m', `data: cycle ${stamp} (retry on fresh tip)`])
        if (cm2.ok) push = await gitCmd(['push', 'origin', 'main'], 120_000)
      }
      if (!push.ok) console.log(`DB COMMIT: تلاش مجدد ناموفق — ${push.out.slice(0, 200)}`)
    }
    console.log(
      push.ok
        ? `DB COMMIT: انتشار موفق ✓ ${stamp}`
        : 'DB COMMIT: push نهایی ناموفق — داده در چرخهٔ بعد منتشر می‌شود',
    )
  } catch (e) {
    // هرگز شکست کامیت نباید چرخه و انتشار داشبورد را بکُشد
    console.log(`DB COMMIT: خطای غیرمنتظره — ${String(e).slice(0, 200)}`)
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
