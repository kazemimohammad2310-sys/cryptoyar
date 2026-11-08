import { db } from '@/lib/db'
import { getBotConfig, getRiskConfig, getFuturesConfig, getStrategyTrust, getLearningConfig } from '@/lib/settings'
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
//   ۶) گیت پامپ (Brain v4): شکست مومنتوم فقط با تأیید حجم + خرید تهاجمی (CVD) وارد می‌شود —
//      و پامپ تأییدشده تریلینگ سریع‌تری دارد تا سود قبل از فروپاشی قفل شود
//   ۷) سقف هم‌جهت (Restart v5): حداکثر ۲ پوزیشن همزمان در یک جهت — هر ۳ خرید با هم قرمز نشود
//   ۸) قطع‌کن مدار استراتژی (Restart v5): ۳ ضرر پیاپی یک استراتژی → توقف ۲۴ ساعتهٔ ورود آن
//   ۹) آستانهٔ اعتماد مغز (Restart v5): اعتماد کم مغز به یک استراتژی → آستانهٔ ورود بالاتر
//   ۱۰) حالت یادگیری (Restart v5.1): اگر سیگنالی از آستانهٔ سخت‌گیرانه عبور نکند، ربات هر
//       ‎learnIdleHours ساعت یک‌بار با بهترین سیگنال تازهٔ بالای آستانهٔ یادگیری و نصف ریسک وارد
//       می‌شود تا مغز از نتایج واقعی درس بگیرد — دروازه‌های ایمن ‎۲ تا ۶ کامل اعمال می‌شوند؛
//       فقط شرط «بنیاد قوی» در ورود یادگیری ملایم‌تر است (نصف ریسک جبران می‌کند)
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

// گیت پامپ (Brain v4) + تریلینگ سریع پامپ تأییدشده
const MB_MIN_VOLZ = 1.5 // شکست مومنتوم باید حجم ≥ ۱٫۵ انحراف معیار داشته باشد
const PUMP_TRAIL_AT_PCT = 1.0 // پامپ تأییدشده: تریلینگ از ‎+۱٪ شروع می‌شود (به‌جای ‎+۱٫۶٪)
const PUMP_TRAIL_GAP_PCT = 0.8 // ...و فاصلهٔ تریل ۰٫۸٪ است (به‌جای ۱٫۲٪) — سود زودتر قفل می‌شود
const PUMP_CVD_EDGE = 0.15 // آستانهٔ خرید تهاجمی هم‌جهت برای تشخیص پامپ واقعی

// Restart v5 — سه دروازهٔ جدید ربات هوشمند
export const MAX_SAME_SIDE = 2 // حداکثر ۲ پوزیشن باز در یک جهت (خرید یا فروش)
export const STRAT_LOSS_STREAK = 3 // ۳ ضرر پیاپی یک استراتژی → توقف موقت
export const STRAT_COOLDOWN_H = 24 // مدت توقف موقت استراتژی بد (ساعت)
export const LOW_TRUST_MAX = 0.85 // اعتماد مغز کمتر از این → آستانهٔ ورود سخت‌تر
export const TRUSTED_MIN = 1.1 // اعتماد مغز بیشتر از این → آستانهٔ ورود کمی آسان‌تر
export const LOW_TRUST_EXTRA_SCORE = 5 // جریمهٔ امتیاز برای استراتژی کم‌اعتماد
export const TRUSTED_DISCOUNT = 2 // تخفیف امتیاز برای استراتژی پراعتماد
export const TRUST_SCORE_FLOOR = 60 // آستانهٔ ورود هرگز زیر این نمی‌رود

// Restart v5.1 — حالت یادگیری: مغز برای درس گرفتن به معاملهٔ واقعی نیاز دارد
export const LEARN_TAG = 'معاملهٔ یادگیری' // برچسب در reasonFa پوزیشن‌های یادگیری
export const LEARN_MIN_SCORE_DEFAULT = 42 // آستانهٔ امتیاز یادگیری (سیگنال‌های watch را هم می‌بیند)
export const LEARN_IDLE_H_DEFAULT = 4 // بین دو ورود یادگیری حداقل این‌قدر فاصله (ساعت)
export const LEARN_MAX_OPEN_DEFAULT = 2 // حداکثر پوزیشن یادگیری همزمان
export const LEARN_RISK_SCALE_DEFAULT = 0.5 // حجم ورود یادگیری = نصف حجم عادی

const DIRECTIONAL_FEATURES = ['rsi', 'trend', 'macd', 'volume', 'funding', 'oi', 'stretch', 'btc', 'mtf'] as const

type SigFeatures = Partial<Record<(typeof DIRECTIONAL_FEATURES)[number], number>> & {
  rsiRaw?: number
  volZ?: number
  atrPct?: number
  volSurge?: number
  cvd?: number
  oiRegime?: number
}

function parseFeatures(raw: string): SigFeatures {
  try {
    return JSON.parse(raw) as SigFeatures
  } catch {
    return {}
  }
}

/**
 * گیت پامپ (Brain v4): استراتژی شکست مومنتوم فقط با تأیید حجم + خرید تهاجمی (CVD) وارد می‌شود.
 * شکست سقف بدون موج حجم = شکست فیک؛ شکست با حجم اما با فروش تهاجمی = پامپ مشکوک.
 * null = عبور | رشتهٔ فارسی = دلیل رد.
 */
export function pumpGateFailReason(f: SigFeatures): string | null {
  const volOk =
    (typeof f.volZ === 'number' && Number.isFinite(f.volZ) && f.volZ >= MB_MIN_VOLZ) ||
    (typeof f.volSurge === 'number' && Number.isFinite(f.volSurge) && f.volSurge > 0)
  if (!volOk) return 'شکست بی‌حجم — موج حجم تأیید نکرد (احتمال شکست فیک)'
  const cvd = f.cvd
  if (typeof cvd !== 'number' || !Number.isFinite(cvd)) return 'دادهٔ خرید تهاجمی (CVD) در دسترس نیست — شکست تأیید نشد'
  if (cvd <= 0) return 'خرید تهاجمی تأیید نکرد (CVD منفی) — پامپ مشکوک به فیک'
  return null
}

/**
 * Restart v5 — سقف هم‌جهت: اگر در این جهت قبلاً ‎MAX_SAME_SIDE پوزیشن باز داریم، ورود جدید ممنوع.
 * درس واقعی صندوق قبلی: ۳ خرید همزمان با هم قرمز شدند چون همه به یک جهت شرط بسته بودند.
 */
export function sameSideBlock(side: 'long' | 'short', openBySide: Record<string, number>): string | null {
  const cnt = openBySide[side] ?? 0
  if (cnt >= MAX_SAME_SIDE) {
    return `سقف معاملات هم‌جهت (${faNum(MAX_SAME_SIDE, 0)} پوزیشن ${side === 'long' ? 'خرید' : 'فروش'}) پر است — تنوع ریسک`
  }
  return null
}

/**
 * Restart v5 — قطع‌کن مدار استراتژی: اگر ۳ معاملهٔ آخر یک استراتژی ضرر بوده و آخرینِ آن
 * کمتر از ۲۴ ساعت پیش بسته شده، ورود جدیدِ همان استراتژی موقتاً ممنوع است.
 */
export function strategyCooldownBlock(
  lastCloses: { pnlUsdt: number | null; closedAt: Date | null }[],
  now = Date.now(),
): string | null {
  if (lastCloses.length < STRAT_LOSS_STREAK) return null
  const allLoss = lastCloses.slice(0, STRAT_LOSS_STREAK).every((c) => (c.pnlUsdt ?? 0) <= 0)
  if (!allLoss) return null
  const last = lastCloses[0]?.closedAt
  if (!last) return null
  const sinceH = (now - last.getTime()) / 3600_000
  if (sinceH >= STRAT_COOLDOWN_H) return null
  return `توقف موقت استراتژی: ${faNum(STRAT_LOSS_STREAK, 0)} ضرر پیاپی — تا ${faNum(Math.ceil(STRAT_COOLDOWN_H - sinceH), 0)} ساعت دیگر`
}

/**
 * Restart v5 — آستانهٔ اعتماد مغز: اعتماد هر استراتژی (×۰٫۷۵ تا ×۱٫۲) روی آستانهٔ ورود اثر می‌کند:
 * اعتماد کم → ‎+۵ سخت‌گیرانه‌تر | اعتماد بالا → ‎−۲ آسان‌تر (ولی هرگز زیر ‎۶۰).
 */
export function trustAdjustedMinScore(baseMinScore: number, trust: number | undefined): { min: number; fa: string } {
  const tr = typeof trust === 'number' && Number.isFinite(trust) ? trust : 1
  if (tr < LOW_TRUST_MAX) {
    return { min: baseMinScore + LOW_TRUST_EXTRA_SCORE, fa: `اعتماد مغز پایین (×${faNum(tr, 2)}) — آستانهٔ ورود +${faNum(LOW_TRUST_EXTRA_SCORE, 0)}` }
  }
  if (tr >= TRUSTED_MIN) {
    const min = Math.max(TRUST_SCORE_FLOOR, baseMinScore - TRUSTED_DISCOUNT)
    return { min, fa: `اعتماد مغز بالا (×${faNum(tr, 2)}) — آستانهٔ ورود −${faNum(TRUSTED_DISCOUNT, 0)}` }
  }
  return { min: baseMinScore, fa: `اعتماد مغز خنثی (×${faNum(tr, 2)})` }
}

/**
 * Restart v5.1 — آیا این چرخه اجازهٔ ورود یادگیری داریم؟ (تابع خالص — قابل تست)
 * فلسفه: مغز از نتایج واقعی یاد می‌گیرد؛ وقتی بازار سیگنال قوی نمی‌سازد،
 * ورود کوچک یادگیری دادهٔ آموزشی می‌سازد — ولی با ریتم و سقف مشخص.
 */
export function learningEntryAllowed(opts: {
  learnMode: string
  capacity: number
  openLearnCount: number
  learnMaxOpen: number
  lastBotEntryAt: Date | null
  learnIdleHours: number
  now?: number
}): { ok: boolean; fa: string } {
  if (opts.learnMode !== 'on') return { ok: false, fa: 'حالت یادگیری خاموش است' }
  if (opts.capacity <= 0) return { ok: false, fa: 'ظرفیت پوزیشن ربات پر است' }
  if (opts.openLearnCount >= opts.learnMaxOpen) {
    return { ok: false, fa: `سقف معاملات یادگیری (${faNum(opts.learnMaxOpen, 0)} پوزیشن) پر است` }
  }
  const now = opts.now ?? Date.now()
  if (opts.lastBotEntryAt) {
    const idleH = (now - opts.lastBotEntryAt.getTime()) / 3600_000
    if (idleH < opts.learnIdleHours) {
      return {
        ok: false,
        fa: `آخرین ورود ربات ${faNum(Math.max(0, idleH), 1)} ساعت پیش است — ${faNum(opts.learnIdleHours, 0)} ساعت فرصت به سیگنال قوی می‌دهیم`,
      }
    }
  }
  return { ok: true, fa: 'شرایط یادگیری فراهم است' }
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

/** دروازهٔ استادی: null = عبور | رشتهٔ فارسی = دلیل رد
 *  ignoreWeakFund (حالت یادگیری): بنیاد ضعیف با نصف ریسک قابل قبول است — دادهٔ آموزشی مغز؛
 *  بقیهٔ فیلترها (اشباع RSI، نوسان مرده/خطرناک، فاندینگ ازدحام، MTF مخالف) همچنان کامل اعمال می‌شوند */
export function expertGateFailReason(
  f: SigFeatures,
  side: 'long' | 'short',
  strategy: string,
  absScore: number,
  fundRow: FundamentalRow | null | undefined,
  ignoreWeakFund = false,
): string | null {
  const contrarian = strategy === 'mean_reversion' || strategy === 'funding_anomaly'

  // ۱) بنیاد ضعیف → فقط با امتیاز استثنایی (در حالت یادگیری: بخشیده می‌شود — نصف ریسک جبران می‌کند)
  if (!ignoreWeakFund && fundRow && fundRow.level === 'weak' && absScore < WEAK_FUND_SCORE_OVERRIDE) {
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
  sourceSignalId: number | null
}): Promise<string | null> {
  const price = (await latestPrice(p.symbol)) ?? p.markPrice
  const pnlPct = pnlPctOf(p.side, p.entryPrice, price)

  // Brain v4: پامپ تأییدشده (موج حجم + CVD هم‌جهت با معامله) → تریلینگ سریع‌تر
  // چون پامپ‌های واقعی اوج کوتاه‌تری دارند؛ سود باید قبل از فروپاشی قفل شود.
  let pumpTrail = false
  if (p.sourceSignalId) {
    try {
      const sig = await db.signal.findUnique({ where: { id: p.sourceSignalId }, select: { featuresJson: true } })
      if (sig) {
        const f = parseFeatures(sig.featuresJson)
        const cvdOk =
          typeof f.cvd === 'number' &&
          Number.isFinite(f.cvd) &&
          (p.side === 'long' ? f.cvd > PUMP_CVD_EDGE : f.cvd < -PUMP_CVD_EDGE)
        const volOk =
          (typeof f.volSurge === 'number' && Number.isFinite(f.volSurge) && f.volSurge > 0) ||
          (typeof f.volZ === 'number' && Number.isFinite(f.volZ) && f.volZ >= 2)
        pumpTrail = cvdOk && volOk
      }
    } catch {
      /* غیرحیاتی — تریلینگ عادی ادامه می‌یابد */
    }
  }
  const trailAtPct = pumpTrail ? PUMP_TRAIL_AT_PCT : TRAIL_AT_PCT
  const trailGapPct = pumpTrail ? PUMP_TRAIL_GAP_PCT : TRAIL_GAP_PCT

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
  // trailing: lock in profit (sooner and tighter for pump-confirmed trades)
  if (pnlPct >= trailAtPct) {
    const trail = p.side === 'long' ? price * (1 - trailGapPct / 100) : price * (1 + trailGapPct / 100)
    if (newStop === null || stopImproved(p.side, newStop, trail)) newStop = trail
  }
  if (newStop !== null && stopImproved(p.side, p.stopLoss, newStop)) {
    await db.fundPosition.update({ where: { id: p.id }, data: { stopLoss: newStop } })
    const kindFa =
      pnlPct >= trailAtPct ? (pumpTrail ? 'تریلینگ سریع پامپ تأییدشده' : 'حد ضرر متحرک') : 'حد ضرر به سر‌به‌سر'
    await db.fundOrder.create({
      data: {
        kind: 'adjust',
        symbol: p.symbol,
        side: p.side,
        qty: 0,
        price: newStop,
        reasonFa: `${BOT_PREFIX} — ${kindFa} (سود لحظه‌ای ${faNum(pnlPct, 2)}٪)`,
      },
    })
    return `${p.symbol}: حد ضرر → ${newStop.toFixed(6)} (${pnlPct >= trailAtPct ? (pumpTrail ? 'تریلینگ سریع پامپ' : 'تریلینگ') : 'سر‌به‌سر'})`
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

interface LearnCtx {
  capacity: number
  openBySide: Record<string, number>
  expertGateOn: boolean
  fundMap: Map<string, FundamentalRow>
  manageFa: string
  botCooldownHours: number
}

/**
 * Restart v5.1 — گذر یادگیری: وقتی ورود اصلی اتفاق نیفتاد، ربات با بهترین سیگنال تازهٔ
 * بالای آستانهٔ یادگیری و نصف ریسک وارد می‌شود (حداکثر یکی در هر چرخه).
 * سیگنال‌های «watch» را هم می‌بیند (آستانهٔ اصلی فقط «open» را می‌دید و ربات در بازار رنج
 * هرگز معامله نمی‌کرد و مغز گرسنهٔ داده می‌ماند).
 * همهٔ دروازه‌های ایمن (هم‌جهت، قطع‌کن استراتژی، خنک‌شدن نماد، گیت پامپ، دروازهٔ استادی)
 * همچنان اعمال می‌شوند — فقط آستانهٔ امتیاز مهربان‌تر است.
 * خروجی: پیام فارسی برای کارت ربات | null = چیزی برای گفتن ندارد.
 */
async function runLearningPass(ctx: LearnCtx): Promise<string | null> {
  const learn = await getLearningConfig()
  const [openLearnCount, lastBotEntry] = await Promise.all([
    db.fundPosition.count({ where: { status: 'open', reasonFa: { contains: LEARN_TAG } } }),
    db.fundPosition.findFirst({
      where: { reasonFa: { startsWith: BOT_PREFIX } },
      orderBy: { openedAt: 'desc' },
      select: { openedAt: true },
    }),
  ])
  const verdict = learningEntryAllowed({
    learnMode: learn.mode,
    capacity: ctx.capacity,
    openLearnCount,
    learnMaxOpen: learn.maxOpen,
    lastBotEntryAt: lastBotEntry?.openedAt ?? null,
    learnIdleHours: learn.idleHours,
  })
  if (!verdict.ok) return null

  const since = new Date(Date.now() - SIGNAL_MAX_AGE_H * 3600_000)
  const rows = await db.signal.findMany({
    where: { status: { in: ['open', 'watch'] }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 60,
  })
  const cands = rows
    .filter((s) => Math.abs(s.score) >= learn.minScore)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5)
  if (!cands.length) {
    return `یادگیری فعال اما سیگنال تازهٔ بالای امتیاز ${faNum(learn.minScore, 0)} نداریم — ${ctx.manageFa}`
  }

  for (const s of cands) {
    try {
      const dup = await db.fundPosition.findFirst({
        where: { symbol: s.symbol, status: 'open' },
        select: { id: true },
      })
      if (dup) continue
      const side: 'long' | 'short' = s.side === 'short' ? 'short' : 'long'
      const absScore = Math.abs(s.score)
      const f = parseFeatures(s.featuresJson)
      const fundRow = ctx.fundMap.get(s.symbol) ?? null
      // دروازهٔ هم‌جهت + قطع‌کن استراتژی بد + خنک‌شدن نماد — مثل ورود اصلی
      if (sameSideBlock(side, ctx.openBySide)) continue
      const stratCloses = await db.fundPosition.findMany({
        where: { status: 'closed', strategy: s.strategy },
        orderBy: { closedAt: 'desc' },
        take: STRAT_LOSS_STREAK,
        select: { pnlUsdt: true, closedAt: true },
      })
      if (strategyCooldownBlock(stratCloses)) continue
      const lastClosed = await db.fundPosition.findFirst({
        where: { symbol: s.symbol, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true, pnlUsdt: true },
      })
      if (lastClosed?.closedAt) {
        const wasLoss = (lastClosed.pnlUsdt ?? 0) <= 0
        const cdH = wasLoss ? ctx.botCooldownHours : 1
        if ((Date.now() - lastClosed.closedAt.getTime()) / 3600_000 < cdH) continue
      }
      // گیت پامپ + دروازهٔ استادی — سیگنال ضعیف حق ندارد زباله باشد
      // (فقط شرط بنیاد قوی برای ورود یادگیری ملایم‌تر است — نصف ریسک جبران می‌کند)
      if (s.strategy === 'momentum_breakout' && pumpGateFailReason(f)) continue
      if (ctx.expertGateOn && expertGateFailReason(f, side, s.strategy, absScore, fundRow, true)) continue

      const confluence = confluenceOf(f, side)
      const levelFa = fundRow?.levelFa ?? 'بنیاد نامشخص'
      const r = await openPosition({
        symbol: s.symbol,
        side,
        signalId: s.id,
        riskScale: learn.riskScale,
        fundamentalLevel: fundRow?.level ?? null,
        reasonFa: `${BOT_PREFIX} — ${LEARN_TAG} — ${STRATEGY_FA[s.strategy] ?? s.strategy} — امتیاز ${faNum(Math.round(absScore), 0)} از آستانهٔ یادگیری ${faNum(learn.minScore, 0)}، همگرایی ${faNum(confluence, 0)}/${faNum(9, 0)} فاکتور، ${levelFa}، ریسک نصف برای دادهٔ یادگیری`,
      })
      try {
        await db.signal.update({
          where: { id: s.id },
          data: { gateStatus: 'passed', gateReasonFa: 'ورود در حالت یادگیری — ریسک نصف‌شده برای دادهٔ آموزشی مغز' },
        })
      } catch {
        /* غیرحیاتی */
      }
      return `یادگیری: ورود ${s.symbol} ${side === 'long' ? 'خرید' : 'فروش'} امتیاز ${faNum(Math.round(absScore), 0)} با نصف ریسک (مارجین ${faNum(r.marginUsdt, 2)} USDT) — ${ctx.manageFa}`
    } catch {
      continue
    }
  }
  return `یادگیری فعال اما نامزدهای یادگیری دروازه‌های ایمن را رد کردند — ${ctx.manageFa}`
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

  // Restart v5: نقشهٔ پوزیشن‌های باز به تفکیک جهت + اعتماد مغز به هر استراتژی
  const openBySide: Record<string, number> = {}
  for (const g of await db.fundPosition.groupBy({ by: ['side'], where: { status: 'open' }, _count: { _all: true } })) {
    openBySide[g.side] = g._count._all
  }
  const trust = await getStrategyTrust()

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

  // شفافیت: سیگنال‌های «open» که به‌خاطر آستانهٔ ورود (یا آستانهٔ موقت خنک‌شدن) بررسی نشدند —
  // دلیل «چرا ربات وارد نشد» روی خودشان ثبت می‌شود (فقط اگر هنوز قضاوتی ندارند).
  const candIds = new Set(candidates.map((s) => s.id))
  for (const s of rows) {
    if (candIds.has(s.id) || s.gateStatus) continue
    try {
      await db.signal.update({
        where: { id: s.id },
        data: {
          gateStatus: 'skipped',
          gateReasonFa: lossStreak
            ? `امتیاز ${faNum(Math.abs(Math.round(s.score)), 0)} از آستانهٔ موقت ${faNum(effMinScore, 0)} (خنک‌شدن پس از ۳ ضرر پیاپی) کمتر است — ربات وارد نشد`
            : `امتیاز ${faNum(Math.abs(Math.round(s.score)), 0)} از حداقل ورود ربات (${faNum(bot.minScore, 0)}) کمتر است — ربات وارد نشد؛ ثبت دستی آزاد است`,
        },
      })
    } catch {
      /* غیرحیاتی */
    }
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

  const learnCtx: LearnCtx = {
    capacity,
    openBySide,
    expertGateOn: fut.expertGate === 'on',
    fundMap,
    manageFa,
    botCooldownHours: bot.cooldownHours,
  }

  if (!candidates.length) {
    // Restart v5.1 — حالت یادگیری: بازار سیگنال قوی نمی‌سازد؟ ورود کوچک برای دادهٔ آموزشی
    const learnFa = await runLearningPass(learnCtx)
    if (learnFa) return learnFa
    return `سیگنال تازهٔ بالای امتیاز ${faNum(effMinScore, 0)} نداریم — ${manageFa}`
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

      const side: 'long' | 'short' = s.side === 'short' ? 'short' : 'long'
      const absScore = Math.abs(s.score)
      const fundRow = fundMap.get(s.symbol) ?? null
      const f = parseFeatures(s.featuresJson)
      // ─── Restart v5 — دروازهٔ ۱: سقف هم‌جهت ───
      const sameFail = sameSideBlock(side, openBySide)
      if (sameFail) {
        skipped++
        skipFa.push(`${s.symbol}: ${sameFail}`)
        await recordSkip(s, `${sameFail} — ربات وارد نشد`)
        continue
      }
      // ─── Restart v5 — دروازهٔ ۲: قطع‌کن مدار استراتژی بد ───
      const stratCloses = await db.fundPosition.findMany({
        where: { status: 'closed', strategy: s.strategy },
        orderBy: { closedAt: 'desc' },
        take: STRAT_LOSS_STREAK,
        select: { pnlUsdt: true, closedAt: true },
      })
      const stratFail = strategyCooldownBlock(stratCloses)
      if (stratFail) {
        gated++
        skipFa.push(`${s.symbol}: ${stratFail}`)
        await recordSkip(s, `${stratFail} — درس مغز: استراتژی در رژیم فعلی بازار جواب نمی‌دهد`)
        continue
      }
      // ─── Restart v5 — دروازهٔ ۳: آستانهٔ اعتماد مغز ───
      const trustAdj = trustAdjustedMinScore(effMinScore, trust[s.strategy])
      if (absScore < trustAdj.min) {
        gated++
        skipFa.push(`${s.symbol}: امتیاز زیر آستانهٔ اعتماد`)
        await recordSkip(s, `امتیاز ${faNum(Math.abs(Math.round(s.score)), 0)} از آستانهٔ ${faNum(trustAdj.min, 0)} کمتر است — ${trustAdj.fa}`)
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
      // ─── گیت پامپ (Brain v4): مستقل از دروازهٔ استادی — شکست مومنتوم فقط با تأیید حجم + CVD ───
      if (s.strategy === 'momentum_breakout') {
        const pumpFail = pumpGateFailReason(f)
        if (pumpFail) {
          gated++
          skipFa.push(`${s.symbol}: ${pumpFail}`)
          try {
            await db.signal.update({ where: { id: s.id }, data: { gateStatus: 'rejected', gateReasonFa: pumpFail } })
          } catch {
            /* غیرحیاتی */
          }
          continue
        }
      }
      // ─── دروازهٔ استادی ───
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
      const levelFa = fundRow?.levelFa ?? 'بنیاد نامشخص'
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
        reasonFa: `${BOT_PREFIX} — ${STRATEGY_FA[s.strategy] ?? s.strategy} — امتیاز ${faNum(Math.round(absScore), 0)}، همگرایی ${faNum(confluence, 0)}/${faNum(9, 0)} فاکتور، ${levelFa}${mtfFa ? `، ${mtfFa}` : ''}`,
        fundamentalLevel: fundRow?.level ?? null,
      })
      opened++
      openedFa.push(`${s.symbol} ${side === 'long' ? 'خرید' : 'فروش'} ×${faNum(r.leverage, r.leverage % 1 === 0 ? 0 : 1)}`)
    } catch {
      skipped++
    }
  }

  // Restart v5.1 — اگر ورود اصلی هیچ نتیجه‌ای نداشت، گذر یادگیری امتحان می‌شود
  if (opened === 0) {
    const learnFa = await runLearningPass(learnCtx)
    if (learnFa) return learnFa
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
