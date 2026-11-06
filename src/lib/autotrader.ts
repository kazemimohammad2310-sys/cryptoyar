import { db } from '@/lib/db'
import { getBotConfig, getRiskConfig, getFuturesConfig } from '@/lib/settings'
import { openPosition, closePosition, latestPrice, isCircuitBreakerTripped } from '@/lib/fund'
import { computeFundamentals, type FundamentalRow } from '@/lib/fundamentals'
import { STRATEGY_FA } from '@/lib/brain'
import { faNum } from '@/lib/fa'

// ─── Auto-Trader Bot (paper) — حالت استادی ───
// Converts the strongest fresh radar signals into paper positions automatically,
// with server-side risk caps, per-symbol cooldowns and open-position management
// (breakeven stop → trailing stop → time-stop for dead trades).
// Every entry is tagged with BOT_PREFIX so the UI and reports can attribute it.
//
// دروازهٔ استادی (پیش از هر ورود، مثل یک تریدر حرفه‌ای تکنیکال + فاندامنتال):
//   ۱) فاندامنتال ضعیف → ورود ممنوع مگر امتیاز ≥ ۸۵
//   ۲) اشباع RSI خلاف جهت (جز استراتژی‌های خلاف‌روند) → ممنوع
//   ۳) نوسان مرده (< ‎۰٫۲۵٪) یا خطرناک (> ۹٪ ATR روزانه) → ممنوع
//   ۴) فاندینگ ازدحام‌شده خلاف جهت معامله (جز ناهنجاری فاندینگ) → ممنوع
//   ۵) MTF تایم‌فریم ۴ساعته کاملاً مخالف مومنتوم‌ها → ممنوع
//   + شمارش همگرایی ۹ فاکتور تکنیکال برای ثبت در دلیل معامله و اهرم متناسب با بنیاد

export const BOT_PREFIX = 'ربات خودکار'
const SIGNAL_MAX_AGE_H = 8 // never chase signals older than this
const CANDIDATES_PER_RUN = 10
const BREAKEVEN_AT_PCT = 1.0 // move stop to entry at +1%
const TRAIL_AT_PCT = 1.6 // start trailing at +1.6%
const TRAIL_GAP_PCT = 1.2 // trail distance from mark price
const TIME_STOP_H = 72 // exit dead trades after 72h
const TIME_STOP_EPS_PCT = 0.5 // ...only if |pnl| is negligible

// دروازهٔ استادی — آستانه‌ها
const WEAK_FUND_SCORE_OVERRIDE = 85 // بنیاد ضعیف فقط با امتیاز خیلی بالا عبور می‌کند
const RSI_OVERBOUGHT_LONG_BLOCK = 78
const RSI_OVERSOLD_SHORT_BLOCK = 22
const ATR_DEAD_PCT = 0.25
const ATR_DANGER_PCT = 9
const FUNDING_CROWDED = 0.0015
const MTF_HARD_AGAINST = 0.4

const DIRECTIONAL_FEATURES = ['rsi', 'trend', 'macd', 'volume', 'funding', 'oi', 'stretch', 'btc', 'mtf'] as const

type SigFeatures = Partial<Record<(typeof DIRECTIONAL_FEATURES)[number], number>> & {
  rsiRaw?: number
  volZ?: number
  atrPct?: number
}

function parseFeatures(raw: string): SigFeatures {
  try {
    return JSON.parse(raw) as SigFeatures
  } catch {
    return {}
  }
}

/** چند فاکتور تکنیکال با جهت معامله همسو هستند؟ (۰ تا ۹) */
function confluenceOf(f: SigFeatures, side: 'long' | 'short'): number {
  return DIRECTIONAL_FEATURES.reduce((acc, k) => {
    const v = f[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return acc
    return acc + ((side === 'long' && v > 0) || (side === 'short' && v < 0) ? 1 : 0)
  }, 0)
}

/** ثبت دلیل «چرا همین الان معامله نشد» روی سیگنال — برای شفافیت کامل در تب رادار */
async function recordSkip(s: { id: number }, reasonFa: string): Promise<void> {
  try {
    await db.signal.update({ where: { id: s.id }, data: { gateStatus: 'skipped', gateReasonFa: reasonFa } })
  } catch {
    /* غیرحیاتی */
  }
}

/** دروازهٔ استادی: null = عبور | رشتهٔ فارسی = دلیل رد */
function expertGateFailReason(
  f: SigFeatures,
  side: 'long' | 'short',
  strategy: string,
  absScore: number,
  fundRow: FundamentalRow | null | undefined,
): string | null {
  const contrarian = strategy === 'mean_reversion' || strategy === 'funding_anomaly'

  // ۱) بنیاد ضعیف → فقط با امتیاز استثنایی
  if (fundRow && fundRow.level === 'weak' && absScore < WEAK_FUND_SCORE_OVERRIDE) {
    return `بنیاد ضعیف (${fundRow.levelFa})`
  }
  // ۲) اشباع RSI خلاف جهت
  if (!contrarian && f.rsiRaw !== undefined && Number.isFinite(f.rsiRaw)) {
    if (side === 'long' && f.rsiRaw > RSI_OVERBOUGHT_LONG_BLOCK) return `RSI اشباع خرید (${faNum(f.rsiRaw, 0)})`
    if (side === 'short' && f.rsiRaw < RSI_OVERSOLD_SHORT_BLOCK) return `RSI اشباع فروش (${faNum(f.rsiRaw, 0)})`
  }
  // ۳) نوسان نامناسب
  if (f.atrPct !== undefined && Number.isFinite(f.atrPct)) {
    if (f.atrPct < ATR_DEAD_PCT) return 'نوسان مرده (بدون حرکت)'
    if (f.atrPct > ATR_DANGER_PCT) return 'نوسان خطرناک (ATR خیلی بالا)'
  }
  // ۴) فاندینگ ازدحام خلاف جهت معامله
  if (!contrarian && typeof f.funding === 'number') {
    const fundingRaw = (f as { fundingRaw?: number }).fundingRaw
    if (side === 'long' && fundingRaw !== undefined && Number.isFinite(fundingRaw) && fundingRaw > FUNDING_CROWDED) {
      return 'فاندینگ مثبت سنگین (ازدحام لانگ)'
    }
    if (side === 'short' && fundingRaw !== undefined && Number.isFinite(fundingRaw) && fundingRaw < -FUNDING_CROWDED) {
      return 'فاندینگ منفی سنگین (ازدحام شورت)'
    }
  }
  // ۵) تایم‌فریم ۴ساعته کاملاً مخالف مومنتوم‌ها
  if (!contrarian && typeof f.mtf === 'number' && Number.isFinite(f.mtf)) {
    if (side === 'long' && f.mtf < -MTF_HARD_AGAINST) return 'روند ۴ساعته مخالف (MTF)'
    if (side === 'short' && f.mtf > MTF_HARD_AGAINST) return 'روند ۴ساعته مخالف (MTF)'
  }
  return null
}

function pnlPctOf(side: string, entry: number, price: number): number {
  return side === 'long' ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100
}

/** Better stop for the position? (long: higher is better, short: lower is better) */
function stopImproved(side: string, current: number, candidate: number): boolean {
  return side === 'long' ? candidate > current : candidate < current
}

/** Breakeven + trailing management for one position; returns a detail string or null. */
async function manageOne(p: {
  id: number
  symbol: string
  side: string
  entryPrice: number
  markPrice: number
  stopLoss: number
  openedAt: Date
}): Promise<string | null> {
  const price = (await latestPrice(p.symbol)) ?? p.markPrice
  const pnlPct = pnlPctOf(p.side, p.entryPrice, price)

  // time-stop: dead trade → free the slot
  const hoursOpen = (Date.now() - p.openedAt.getTime()) / 3600_000
  if (hoursOpen >= TIME_STOP_H && Math.abs(pnlPct) <= TIME_STOP_EPS_PCT) {
    const r = await closePosition(p.id, `${BOT_PREFIX} — خروج زمانی: بازده ناچیز پس از ${faNum(TIME_STOP_H, 0)} ساعت`)
    return `${p.symbol}: خروج زمانی (${r.pnlUsdt.toFixed(2)} USDT)`
  }

  let newStop: number | null = null
  // breakeven: protect capital once the trade is +1%
  if (pnlPct >= BREAKEVEN_AT_PCT) {
    const be = p.side === 'long' ? p.entryPrice * 1.001 : p.entryPrice * 0.999
    if (stopImproved(p.side, p.stopLoss, be)) newStop = be
  }
  // trailing: lock in profit beyond +1.6%
  if (pnlPct >= TRAIL_AT_PCT) {
    const trail = p.side === 'long' ? price * (1 - TRAIL_GAP_PCT / 100) : price * (1 + TRAIL_GAP_PCT / 100)
    if (newStop === null || stopImproved(p.side, newStop, trail)) newStop = trail
  }
  if (newStop !== null && stopImproved(p.side, p.stopLoss, newStop)) {
    await db.fundPosition.update({ where: { id: p.id }, data: { stopLoss: newStop } })
    await db.fundOrder.create({
      data: {
        kind: 'adjust',
        symbol: p.symbol,
        side: p.side,
        qty: 0,
        price: newStop,
        reasonFa: `${BOT_PREFIX} — ${pnlPct >= TRAIL_AT_PCT ? 'حد ضرر متحرک' : 'حد ضرر به سر‌به‌سر'} (سود لحظه‌ای ${faNum(pnlPct, 2)}٪)`,
      },
    })
    return `${p.symbol}: حد ضرر → ${newStop.toFixed(6)} (${pnlPct >= TRAIL_AT_PCT ? 'تریلینگ' : 'سر‌به‌سر'})`
  }
  return null
}

/** Manage all open positions (breakeven/trailing/time-stop). */
export async function manageOpenPositions(): Promise<string[]> {
  const positions = await db.fundPosition.findMany({ where: { status: 'open' } })
  const out: string[] = []
  for (const p of positions) {
    try {
      const d = await manageOne(p)
      if (d) out.push(d)
    } catch {
      /* single-position failure must not stop the loop */
    }
  }
  return out
}

/** One full bot tick: manage open positions, then open new entries from fresh signals. */
export async function runAutoTrader(): Promise<string> {
  const bot = await getBotConfig()

  const managed = await manageOpenPositions()
  const manageFa = managed.length ? `مدیریت: ${managed.length} اصلاح حد ضرر/خروج` : 'مدیریت: بدون تغییر'

  if (bot.enabled !== 'on') {
    return `ربات خاموش است — ${manageFa}`
  }

  const risk = await getRiskConfig()
  const cb = await isCircuitBreakerTripped()
  if (cb.tripped) {
    return `مدار روزانه قطع شده (افت ${faNum(cb.drawdownPct, 1)}٪) — ورود جدید ممنوع — ${manageFa}`
  }

  // قاعدهٔ حرفه‌ای (ترمز ضرر پیاپی): بعد از ۳ ضرر متوالیِ ربات، آستانهٔ ورود سخت‌گیرانه‌تر می‌شود
  const lastBotCloses = await db.fundPosition.findMany({
    where: { status: 'closed', reasonFa: { startsWith: BOT_PREFIX } },
    orderBy: { closedAt: 'desc' },
    take: 3,
    select: { pnlUsdt: true },
  })
  const lossStreak = lastBotCloses.length === 3 && lastBotCloses.every((p) => (p.pnlUsdt ?? 0) <= 0)
  const effMinScore = lossStreak ? bot.minScore + 8 : bot.minScore

  const botOpen = await db.fundPosition.count({
    where: { status: 'open', reasonFa: { startsWith: BOT_PREFIX } },
  })
  const capacity = Math.min(bot.maxOpen, risk.maxPositions) - botOpen

  if (capacity <= 0) {
    return `ظرفیت ربات پر است (${faNum(botOpen, 0)}/${faNum(Math.min(bot.maxOpen, risk.maxPositions), 0)}) — ${manageFa}`
  }

  // fresh actionable signals, strongest first
  const since = new Date(Date.now() - SIGNAL_MAX_AGE_H * 3600_000)
  const rows = await db.signal.findMany({
    where: { status: 'open', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })
  const candidates = rows
    .filter((s) => Math.abs(s.score) >= effMinScore)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, CANDIDATES_PER_RUN)

  if (!candidates.length) {
    return `سیگنال تازهٔ بالای امتیاز ${faNum(effMinScore, 0)} نداریم — ${manageFa}`
  }

  // دروازهٔ استادی: نقشهٔ بنیادی نمادها (کش ۱۵ دقیقه‌ای — بدون تماس اضافه)
  const fut = await getFuturesConfig()
  let fundMap = new Map<string, FundamentalRow>()
  if (fut.expertGate === 'on') {
    try {
      const snap = await computeFundamentals({ maxAgeMs: 15 * 60_000 })
      fundMap = new Map(snap.rows.map((r) => [r.symbol, r]))
    } catch {
      /* بدون نقشهٔ بنیادی، دروازهٔ فاندامنتال غیرفعال می‌ماند */
    }
  }

  let opened = 0
  let skipped = 0
  let gated = 0
  const openedFa: string[] = []
  const skipFa: string[] = []

  for (const s of candidates) {
    if (opened >= capacity) break
    try {
      const dup = await db.fundPosition.findFirst({
        where: { symbol: s.symbol, status: 'open' },
        select: { id: true },
      })
      if (dup) {
        skipped++
        skipFa.push(`${s.symbol}: پوزیشن باز دارد`)
        await recordSkip(s, 'برای این نماد پوزیشن باز داریم — ورود همزمان دوم ممنوع')
        continue
      }
      // cooldown after a recent close on the same symbol (loss 6h default, win 1h)
      const lastClosed = await db.fundPosition.findFirst({
        where: { symbol: s.symbol, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true, pnlUsdt: true },
      })
      if (lastClosed?.closedAt) {
        const wasLoss = (lastClosed.pnlUsdt ?? 0) <= 0
        const cooldownH = wasLoss ? bot.cooldownHours : 1
        const sinceClose = (Date.now() - lastClosed.closedAt.getTime()) / 3600_000
        if (sinceClose < cooldownH) {
          const cdFa = `دورهٔ خنک‌شدن پس از ${wasLoss ? 'ضرر' : 'سود'} قبلی (${faNum(cooldownH, 0)} ساعت) هنوز تمام نشده`
          skipped++
          skipFa.push(`${s.symbol}: خنک‌شدن پس از ${wasLoss ? 'ضرر' : 'سود'}`)
          await recordSkip(s, cdFa)
          continue
        }
      }

      // ─── دروازهٔ استادی ───
      const side: 'long' | 'short' = s.side === 'short' ? 'short' : 'long'
      const absScore = Math.abs(s.score)
      const fundRow = fundMap.get(s.symbol) ?? null
      const f = parseFeatures(s.featuresJson)
      if (fut.expertGate === 'on') {
        const gateFail = expertGateFailReason(f, side, s.strategy, absScore, fundRow)
        if (gateFail) {
          gated++
          skipFa.push(`${s.symbol}: ${gateFail}`)
          // دلیل رد شدن را روی خود سیگنال ثبت کن تا در تب رادار دیده شود
          try {
            await db.signal.update({ where: { id: s.id }, data: { gateStatus: 'rejected', gateReasonFa: gateFail } })
          } catch {
            /* ثبت یادداشت گیت حیاتی نیست */
          }
          continue
        }
        try {
          await db.signal.update({ where: { id: s.id }, data: { gateStatus: 'passed' } })
        } catch {
          /* غیرحیاتی */
        }
      } else {
        try {
          await db.signal.update({ where: { id: s.id }, data: { gateStatus: 'skipped' } })
        } catch {
          /* غیرحیاتی */
        }
      }

      const confluence = confluenceOf(f, side)
      const levelFa = fundRow ? fundRow.levelFa : 'نامشخص'
      // جهت‌گیری با روند ۴ساعته — بخشی از «چرا ورود»
      const mtfFa =
        typeof f.mtf === 'number' && Number.isFinite(f.mtf)
          ? f.mtf > 0.15
            ? 'هم‌جهت با روند ۴ساعته'
            : f.mtf < -0.15
              ? 'خلاف روند ۴ساعته (فرصت خلاف‌روند)'
              : null
          : null
      const r = await openPosition({
        symbol: s.symbol,
        side,
        signalId: s.id,
        reasonFa: `${BOT_PREFIX} — ${STRATEGY_FA[s.strategy] ?? s.strategy} — امتیاز ${faNum(Math.round(absScore), 0)}، همگرایی ${faNum(confluence, 0)}/${faNum(9, 0)} فاکتور، بنیاد ${levelFa}${mtfFa ? `، ${mtfFa}` : ''}`,
        fundamentalLevel: fundRow?.level ?? null,
      })
      opened++
      openedFa.push(`${s.symbol} ${side === 'long' ? 'خرید' : 'فروش'} ×${faNum(r.leverage, r.leverage % 1 === 0 ? 0 : 1)}`)
    } catch {
      skipped++
    }
  }

  const parts = [`ورود: ${faNum(opened, 0)}`]
  if (openedFa.length) parts.push(`(${openedFa.join('، ')})`)
  if (gated > 0) parts.push(`رد استادی: ${faNum(gated, 0)}`)
  parts.push(`ردشده: ${faNum(skipped, 0)}`)
  if (skipFa.length) parts.push(`دلایل: ${skipFa.slice(0, 5).join(' · ')}`)
  if (lossStreak) parts.push('ترمز ضرر پیاپی فعال — آستانهٔ ورود +۸ سخت‌گیرانه شد')
  parts.push(manageFa)
  return parts.join(' — ')
}
