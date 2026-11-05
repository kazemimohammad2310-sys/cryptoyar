// ─── CryptoYar Free — static dashboard generator (GitHub Pages) ───
// Reads the current DB state and writes a self-contained RTL HTML dashboard
// (7 tabs, mobile-first: داشبورد/رادار/ارزها/صندوق/مغز/شیفت‌شب/راهنما) + data.json into ./site (deployed by the workflow).

import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs'
import { db, ensurePragmas } from '@/lib/db'
import { getSetting, getBrainWeights, getBotConfig, type FeatureKey } from '@/lib/settings'
import { currentEquity } from '@/lib/fund'
import { runSelfTest, STRATEGY_FA as STRATEGY_FA_LOCAL } from '@/lib/brain'
import { BOT_PREFIX } from '@/lib/autotrader'
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

  const [healRaw, optRaw, verRaw, trustRaw] = await Promise.all([
    getSetting('healSnapshot'),
    getSetting('optimizeSnapshot'),
    getSetting('versionInfo'),
    getSetting('strategyTrust'),
  ])
  const healSnap = healRaw ? (JSON.parse(healRaw) as { totalHeals?: number; recentActions?: string[]; sickNow?: string[] }) : null
  const optSnap = optRaw ? (JSON.parse(optRaw) as { sizeMB?: number | null; riskBefore?: number; riskAfter?: number; samples?: number; winRate?: number; action?: string }) : null
  const verSnap = verRaw ? (JSON.parse(verRaw) as { sha?: string; subject?: string; updatedCount?: number; syncCount?: number }) : null
  const strategyTrust = trustRaw ? (JSON.parse(trustRaw) as Record<string, number>) : {}

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

  const tabRadar = signals.length
    ? `<div class="card">
        ${signals
          .map(
            (s) => `<div style="padding:9px 0;border-bottom:1px solid #1e242c">
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
        <b>رادار فرصت‌ها:</b> سیگنال‌های خرید/فروش با امتیاز، حد ضرر و حد سود + نشان وضعیت بنیادی همان ارز؛ «ثبت‌شده در صندوق» یعنی وارد شبیه‌سازی شده.<br>
        <b>ارزها:</b> برای هر یک از ۵۰ ارزِ تحت پوشش، امتیاز و وضعیت بنیادی (رتبه بازار، نقدشوندگی، نوسان، روند، فاندینگ) به‌همراه جزییات کامل: قیمت، حجم، ارزش بازار، بازده ۷ و ۳۰ روزه و دلایل فارسی — روی هر ردیف بزنید تا باز شود.<br>
        <b>صندوق شبیه‌ساز:</b> پوزیشن‌های باز و بسته‌شده با سود/زیان — مثل حساب آزمایشی.<br>
        <b>مغز یادگیرنده:</b> از نتیجهٔ سیگنال‌ها یاد می‌گیرد و وزن‌ها را خودکار تنظیم می‌کند.<br>
        <b>شیفت‌شب:</b> موتور زمان‌بندی که ۲۴ ساعته بدون شما کار می‌کند.<br>
        <b>لایهٔ خودکار:</b> ربات معامله‌گر خودش معامله می‌کند، خودش را بروزرسانی می‌کند، خطاها را ترمیم می‌کند و ریسک را با عملکردش تنظیم می‌کند.
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
    <div class="sub">به‌روزرسانی: ${FA_TIME.format(new Date())} (تهران) · هر ۱۵ دقیقه توسط GitHub Actions</div>
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
        positions: positions.map((p) => ({ symbol: p.symbol, side: p.side, pnlPct: p.pnlPct })),
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
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
