import { db } from '@/lib/db'
import { ensureDefaults, setSetting, getSetting } from '@/lib/settings'
import { assertUniverse, refreshUniverse } from '@/lib/universe'
import { fetchAndStoreCandles, INTERVAL_MS, type Interval } from '@/lib/candles'
import { getKlines, getAllTickers, getFundingRate, getOpenInterest } from '@/lib/fetchers/binance'
import { getCmcGlobal, cmcEnabled } from '@/lib/fetchers/cmc'
import { getFearGreed } from '@/lib/fetchers/feargreed'
import { scanRadar, persistRadarResult } from '@/lib/radar'
import { evaluateDueSamples, trainBrain, runSelfTest } from '@/lib/brain'
import { markToMarket, snapshotEquity, currentEquity } from '@/lib/fund'
import { runAutoTrader } from '@/lib/autotrader'
import { sourceHealth } from '@/lib/rateLimit'
import { faNum } from '@/lib/fa'

// ─── Nightshift: 24/7 job scheduler (§8) — idempotent, crash-safe, hot-reload safe ───
// Corrections applied: cmc every 15min (budget), data-prune job, hourly equity
// snapshot, daily jobs pinned to Asia/Tehran clock.

export interface JobDef {
  name: string
  fa: string
  intervalMs: number | null // null = cron-style via check fn
  run: () => Promise<string>
}

type SchedulerState = {
  started: boolean
  bootId: string
  timers: NodeJS.Timeout[]
  running: Set<string>
  lastRun: Map<string, { at: number; ok: boolean; durationMs: number; detail: string; error: string | null }>
}

const BOOT_ID = Math.random().toString(36).slice(2)

const g = globalThis as unknown as { __cryptoyar_nightshift?: SchedulerState }

function sched(): SchedulerState {
  if (!g.__cryptoyar_nightshift) {
    g.__cryptoyar_nightshift = { started: false, bootId: '', timers: [], running: new Set(), lastRun: new Map() }
  }
  return g.__cryptoyar_nightshift
}

async function logJob(job: string, startedAt: Date, ok: boolean, detail: string, error?: string) {
  const finishedAt = new Date()
  try {
    await db.jobLog.create({
      data: {
        job,
        startedAt,
        finishedAt,
        ok,
        error: error ? error.slice(0, 500) : null,
        detail: detail.slice(0, 500),
      },
    })
  } catch {
    /* never crash on logging */
  }
}

function wrap(job: JobDef) {
  return async () => {
    const s = sched()
    if (s.running.has(job.name)) return // overlap guard
    s.running.add(job.name)
    const startedAt = new Date()
    const t0 = Date.now()
    let ok = true
    let detail = ''
    let error: string | null = null
    try {
      detail = await job.run()
    } catch (e) {
      ok = false
      error = e instanceof Error ? e.message : String(e)
      detail = 'خطا در اجرا'
    }
    const durationMs = Date.now() - t0
    s.lastRun.set(job.name, { at: Date.now(), ok, durationMs, detail, error })
    await logJob(job.name, startedAt, ok, detail, error ?? undefined)
    s.running.delete(job.name)
  }
}

// ─── Tehran-time daily helper (self-test 04:00, prune 03:00) ───
function tehranNow(): { hhmm: string; date: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
  return {
    hhmm: `${parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  }
}

function dailyJob(jobName: string, targetHHmm: string, dateKey: string, fn: () => Promise<string>): JobDef {
  return {
    name: jobName,
    fa: jobName === 'self-test' ? 'آزمون خودکار مغز' : 'پاک‌سازی داده‌ها',
    intervalMs: 5 * 60_000,
    run: async () => {
      const t = tehranNow()
      const last = (await getSetting(dateKey)) ?? ''
      const [hh, mm] = targetHHmm.split(':').map(Number)
      const cur = { h: Number(t.hhmm.slice(0, 2)), m: Number(t.hhmm.slice(3, 5)) }
      // «اولین فرصتِ بعد از ساعت هدف» — با هر آهنگی که چرخه‌ها اجرا شوند (حتی
      // چرخه‌های مبهمِ کرون ابری) کار روزانه دقیقاً یک‌بار در روز انجام می‌شود.
      // قبلاً پنجرهٔ ۱۰ دقیقه‌ای بود که روی ابر هرگز نمی‌گرفت (باگ تأییدشده).
      const inWindow = cur.h * 60 + cur.m >= hh * 60 + mm
      if (!inWindow || last === t.date) return ` در انتظار پنجرهٔ روزانه (${targetHHmm} تهران — امروز: ${last === t.date ? 'انجام شد' : 'هنوز'})`
      const result = await fn()
      // تاریخ فقط بعد از موفقیت ثبت شود تا اگر اجرا خطا خورد، در بررسی بعدی دوباره تلاش شود
      await setSetting(dateKey, t.date)
      return result
    },
  }
}

// ─── Job implementations ───

async function jobTickerRefresh(): Promise<string> {
  const symbols = await assertUniverse()
  const all = await getAllTickers()
  const map = new Map(all.map((t) => [t.symbol, t]))
  const rows: { symbol: string; price: number; change24h: number; volume24h: number; high24h: number; low24h: number }[] = []
  for (const sym of symbols) {
    const t = map.get(sym)
    if (!t) continue
    rows.push({
      symbol: sym,
      price: Number(t.lastPrice),
      change24h: Number(t.priceChangePercent),
      volume24h: Number(t.quoteVolume),
      high24h: Number(t.highPrice),
      low24h: Number(t.lowPrice),
    })
  }
  if (rows.length) await db.tickerSnapshot.createMany({ data: rows })
  return `${faNum(rows.length, 0)} تیکر ذخیره شد`
}

async function jobCandleRefresh(): Promise<string> {
  const symbols = await assertUniverse()
  const intervals: Interval[] = ['15m', '1h', '4h', '1d']
  let stored = 0
  let failed = 0
  const queue: { sym: string; iv: Interval }[] = []
  for (const iv of intervals) for (const sym of symbols) queue.push({ sym, iv })
  // bounded concurrency
  // Brain v2: deeper bootstrap for 15m/1h (1000 bars ≈ 10d / 41d) — the extra
  // history feeds the brain's backfill warm-start (Binance allows 1000/call)
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      try {
        const deep = item.iv === '15m' || item.iv === '1h' ? 1000 : 300
        stored += await fetchAndStoreCandles(item.sym, item.iv, (s, i, l) => getKlines(s, i, l), deep)
      } catch {
        failed++
      }
    }
  })
  await Promise.all(workers)
  return `${faNum(stored, 0)} کندل ذخیره شد${failed ? ` — ${faNum(failed, 0)} ناموفق` : ''}`
}

async function jobFundingRefresh(): Promise<string> {
  const symbols = await assertUniverse()
  let okCount = 0
  for (const sym of symbols) {
    const [fr, oi] = await Promise.all([getFundingRate(sym), getOpenInterest(sym)])
    if (fr || oi !== null) {
      await db.fundingSnapshot.create({
        data: { symbol: sym, fundingRate: fr?.fundingRate ?? 0, openInterest: oi, markPrice: fr?.markPrice ?? null },
      })
      okCount++
    }
  }
  // Fear & Greed badge source (hourly)
  let fng = ''
  try {
    const fg = await getFearGreed()
    await setSetting('fearGreed', JSON.stringify(fg))
    fng = ` — ترس/طمع: ${fg.classificationFa} (${fg.value})`
  } catch {
    fng = ' — ترس/طمع در دسترس نیست'
  }
  return `${faNum(okCount, 0)}/${faNum(symbols.length, 0)} نماد فاندینگ/OI ذخیره شد${fng}`
}

async function jobCmcRefresh(): Promise<string> {
  const { source } = await refreshUniverse()
  let detail = `universe از ${source === 'cmc' ? 'CMC' : 'Binance'}`
  if (cmcEnabled()) {
    // budget counter (2 calls per run)
    const day = new Date().toISOString().slice(0, 10)
    const prevDay = (await getSetting('cmcCallsDay')) ?? ''
    const prev = prevDay === day ? Number((await getSetting('cmcCallsToday')) ?? 0) : 0
    await setSetting('cmcCallsDay', day)
    await setSetting('cmcCallsToday', String(prev + 2))
    try {
      const g2 = await getCmcGlobal()
      await setSetting(
        'globalMetrics',
        JSON.stringify({
          totalMarketCap: g2.quote.USD.total_market_cap,
          totalVolume24h: g2.quote.USD.total_volume_24h,
          btcDominance: g2.quote.USD.btc_dominance,
          ts: Date.now(),
        }),
      )
      detail += ' + سنجه‌های کلان'
    } catch {
      detail += ' (سنجه‌های کلان در دسترس نیست)'
    }
  } else {
    detail += ' — کلید CMC ثبت نشده'
  }
  return detail
}

async function jobRadarScan(): Promise<string> {
  const result = await scanRadar()
  const created = await persistRadarResult(result)
  return `${faNum(result.scanned, 0)} نماد اسکن شد — ${faNum(created, 0)} سیگنال جدید، ${faNum(result.watch.length, 0)} زیر آستانه`
}

async function jobFundMark(): Promise<string> {
  const r = await markToMarket()
  return r.closed ? `${faNum(r.closed, 0)} پوزیشن بسته شد: ${r.details.join('، ')}` : 'به‌روزرسانی قیمت انجام شد'
}

async function jobEquitySnapshot(): Promise<string> {
  const eq = await snapshotEquity()
  return `سرمایه لحظه‌ای: ${faNum(eq, 2)} USDT`
}

async function jobBrainTrain(): Promise<string> {
  // Brain v2: warm-start from history — deep replay once, then a daily 48h top-up.
  // Lazy import keeps node-only APIs out of Edge bundles (same pattern as autonomy).
  let bf = ''
  try {
    const { backfillBrain } = await import('@/lib/backfill')
    const done = (await getSetting('brainBackfillDone')) ?? ''
    if (done !== 'v2') {
      bf = await backfillBrain({ deep: true })
      await setSetting('brainBackfillDone', 'v2')
    } else {
      const t = tehranNow()
      if (((await getSetting('backfillLastDate')) ?? '') !== t.date) {
        bf = await backfillBrain({ deep: false })
        await setSetting('backfillLastDate', t.date)
      }
    }
  } catch (e) {
    bf = `بازپرگیری ناموفق: ${e instanceof Error ? e.message.slice(0, 60) : 'خطا'}`
  }
  const ev = await evaluateDueSamples()
  const tr = await trainBrain()
  const parts = [`ارزیابی ${faNum(ev.evaluated, 0)} نمونه (TP:${faNum(ev.tpHits, 0)} SL:${faNum(ev.slHits, 0)})`, tr.detail]
  if (bf) parts.push(bf)
  return parts.join(' — ')
}

async function jobSelfTest(): Promise<string> {
  const r = await runSelfTest()
  return r.overall
    ? `دقت مغز: ${faNum(r.overall.accuracy, 1)}٪ روی ${faNum(r.overall.total, 0)} نمونه`
    : 'نمونهٔ ارزیابی‌شده‌ای موجود نیست'
}

async function jobDataPrune(): Promise<string> {
  const now = Date.now()
  const d90 = new Date(now - 90 * 24 * 3600_000)
  const d365 = new Date(now - 365 * 24 * 3600_000)
  const d3 = new Date(now - 3 * 24 * 3600_000)
  const d30 = new Date(now - 30 * 24 * 3600_000)
  const [c15, c1h, tick, fund, log] = await Promise.all([
    db.candle.deleteMany({ where: { interval: '15m', ts: { lt: d90 } } }),
    db.candle.deleteMany({ where: { interval: '1h', ts: { lt: d365 } } }),
    db.tickerSnapshot.deleteMany({ where: { ts: { lt: d3 } } }),
    db.fundingSnapshot.deleteMany({ where: { ts: { lt: d30 } } }),
    db.jobLog.deleteMany({ where: { startedAt: { lt: d30 } } }),
  ])
  return `پاک‌سازی: کندل ۱۵m=${c15.count}، ۱h=${c1h.count}، تیکر=${tick.count}، فاندینگ=${fund.count}، لاگ=${log.count}`
}

async function jobBotTrade(): Promise<string> {
  return runAutoTrader()
}

// Autonomy jobs are lazy-imported: keeps node-only APIs (child_process, fs)
// out of the Edge instrumentation bundle that reaches this module via boot.ts.
async function jobSelfHeal(): Promise<string> {
  const m = await import('@/lib/autonomy')
  return m.runSelfHeal()
}

async function jobSelfOptimize(): Promise<string> {
  const m = await import('@/lib/autonomy')
  return m.runSelfOptimize()
}

async function jobSelfUpdate(): Promise<string> {
  const m = await import('@/lib/autonomy')
  return m.runSelfUpdate()
}

async function jobHealth(): Promise<string> {
  const h = sourceHealth()
  await setSetting(
    'healthSnapshot',
    JSON.stringify({
      at: Date.now(),
      binanceSpot: h['binance-spot'].ok,
      binanceFutures: h['binance-futures'].ok,
      cmc: h.cmc.ok,
      feargreed: h.feargreed.ok,
    }),
  )
  return `spot=${h['binance-spot'].ok ? 'سالم' : 'قطع'} futures=${h['binance-futures'].ok ? 'سالم' : 'قطع'}`
}

// ─── Bootstrap: first-start data warmup (acceptance §14.3) ───
// Populates the universe ONCE (single-flight) before the staggered first runs
// of the jobs — prevents the thundering-herd that tripped Binance 429s.
async function bootstrap(): Promise<void> {
  const s = sched()
  if (s.started) return
  await ensureDefaults()
  try {
    await refreshUniverse()
    await jobTickerRefresh()
  } catch {
    /* degrade — staggered jobs will retry */
  }
  void (async () => {
    try {
      await db.equityPoint.create({ data: { equityUsdt: await currentEquity() } })
    } catch {
      /* ignore */
    }
  })()
}

// ─── Public API ───

export function jobDefs(): JobDef[] {
  return [
    { name: 'ticker-refresh', fa: 'به‌روزرسانی تیکرها', intervalMs: 60_000, run: jobTickerRefresh },
    { name: 'candle-refresh', fa: 'به‌روزرسانی کندل‌ها', intervalMs: 15 * 60_000, run: jobCandleRefresh },
    { name: 'funding-refresh', fa: 'فاندینگ و OI', intervalMs: 60 * 60_000, run: jobFundingRefresh },
    { name: 'cmc-refresh', fa: 'رتبه‌بندی بازار', intervalMs: 15 * 60_000, run: jobCmcRefresh },
    { name: 'radar-scan', fa: 'اسکن رادار', intervalMs: 15 * 60_000, run: jobRadarScan },
    { name: 'fund-mark', fa: 'ارزش‌گذاری صندوق', intervalMs: 60_000, run: jobFundMark },
    { name: 'bot-trade', fa: 'ربات معامله‌گر', intervalMs: 5 * 60_000, run: jobBotTrade },
    { name: 'self-heal', fa: 'خودترمیمی', intervalMs: 10 * 60_000, run: jobSelfHeal },
    { name: 'self-optimize', fa: 'خودبهینه‌سازی', intervalMs: 60 * 60_000, run: jobSelfOptimize },
    { name: 'self-update', fa: 'خودبروزرسانی', intervalMs: 6 * 60 * 60_000, run: jobSelfUpdate },
    { name: 'brain-train', fa: 'آموزش مغز', intervalMs: 60 * 60_000, run: jobBrainTrain },
    { name: 'equity-snapshot', fa: 'نمودار سرمایه', intervalMs: 60 * 60_000, run: jobEquitySnapshot },
    { name: 'health', fa: 'پایش سلامت', intervalMs: 5 * 60_000, run: jobHealth },
    dailyJob('self-test', '04:00', 'selftestLastDate', jobSelfTest),
    dailyJob('data-prune', '03:00', 'pruneLastDate', jobDataPrune),
  ]
}

export function jobStatus() {
  const s = sched()
  return jobDefs().map((j) => {
    const last = s.lastRun.get(j.name) ?? null
    const running = s.running.has(j.name)
    return {
      name: j.name,
      fa: j.fa,
      intervalMs: j.intervalMs,
      running,
      last: last ? { at: last.at, ok: last.ok, durationMs: last.durationMs, detail: last.detail, error: last.error } : null,
    }
  })
}

export async function bootNightshift(): Promise<void> {
  const s = sched()
  if (s.started) {
    if (s.bootId === BOOT_ID) return // this exact module version already running
    // module hot-reloaded: tear down old timers, reboot with fresh code
    for (const t of s.timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    s.timers = []
    s.running.clear()
    console.log('[CryptoYar] زمان‌بند با کد جدید راه‌اندازی مجدد شد')
  }
  s.started = true
  s.bootId = BOOT_ID
  await bootstrap()
  const defs = jobDefs()
  for (let i = 0; i < defs.length; i++) {
    const j = defs[i]
    const fn = wrap(j)
    const iv = setInterval(() => void fn(), j.intervalMs ?? 300_000)
    if (typeof iv.unref === 'function') iv.unref()
    s.timers.push(iv)
    // stagger first runs (3s apart) so the bootstrap herd never repeats
    const t = setTimeout(() => void fn(), 3_000 + i * 3_000)
    if (typeof t.unref === 'function') t.unref()
    s.timers.push(t)
  }
  console.log(`[CryptoYar] شیفت‌شب فعال شد — ${faNum(defs.length, 0)} وظیفه زمان‌بندی شد`)
}

export function isBootstrapped(): boolean {
  return sched().started
}

export { INTERVAL_MS }
