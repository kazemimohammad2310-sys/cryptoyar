import { db } from '@/lib/db'
import type { PrismaPromise } from '@prisma/client'
import { faNum } from '@/lib/fa'

// ─── موتور درس‌های آموخته (lessons) ───
// مغز علاوه بر وزن‌ها، «الگوهای شرطی» را هم از نتایج واقعی کشف می‌کند:
//   «وقتی شرط X برقرار بود، نرخ برد Y٪ بود در برابر میانگین Z٪» → امتیاز سیگنال‌های مشابه ±دلتا می‌گیرد.
// هر ساعت در پایان trainBrain اجرا می‌شود؛ درس‌های بی‌شواهد غیرفعال می‌شوند تا دیتای کهنه اثر نگذارد.

export interface LessonFeats {
  rsiRaw?: number
  fundingRaw?: number | null
  mtf?: number
  btc?: number
  oi?: number
  stretch?: number
  atrPct?: number
  hourUtc?: number // ساعت UTC لحظهٔ ثبت نمونه (برای درس‌های زمانی)
}

export interface LessonPattern {
  key: string
  titleFa: string
  /** فقط نمونه‌های همین سمت در این الگو شمرده می‌شود ('any' = هر دو) */
  side: 'long' | 'short' | 'any'
  /** امتیاز مثبت = فاکتور مساعد، منفی = فاکتور خطر */
  test: (f: LessonFeats) => boolean
}

export const LESSON_PATTERNS: LessonPattern[] = [
  { key: 'long_rsi_hot', side: 'long', titleFa: 'خرید در اشباع خرید (RSI بالای ۶۸)', test: (f) => (f.rsiRaw ?? 50) >= 68 },
  { key: 'short_rsi_cold', side: 'short', titleFa: 'فروش در اشباع فروش (RSI زیر ۳۲)', test: (f) => (f.rsiRaw ?? 50) <= 32 },
  {
    key: 'long_funding_crowded',
    side: 'long',
    titleFa: 'خرید با فاندینگ مثبت سنگین (ازدحام لانگ)',
    test: (f) => (f.fundingRaw ?? 0) >= 0.0008,
  },
  {
    key: 'short_funding_crowded',
    side: 'short',
    titleFa: 'فروش با فاندینگ منفی سنگین (ازدحام شورت)',
    test: (f) => (f.fundingRaw ?? 0) <= -0.0008,
  },
  { key: 'mtf_align_long', side: 'long', titleFa: 'خرید همسو با روند ۴ساعته', test: (f) => (f.mtf ?? 0) >= 0.3 },
  { key: 'mtf_align_short', side: 'short', titleFa: 'فروش همسو با روند ۴ساعته', test: (f) => (f.mtf ?? 0) <= -0.3 },
  { key: 'mtf_against_long', side: 'long', titleFa: 'خرید برخلاف روند ۴ساعته', test: (f) => (f.mtf ?? 0) <= -0.3 },
  { key: 'mtf_against_short', side: 'short', titleFa: 'فروش برخلاف روند ۴ساعته', test: (f) => (f.mtf ?? 0) >= 0.3 },
  { key: 'vol_dead', side: 'any', titleFa: 'معامله در نوسان مرده (ATR روزانه زیر ۰٫۶٪)', test: (f) => (f.atrPct ?? 2) < 0.6 },
  { key: 'vol_wild', side: 'any', titleFa: 'معامله در نوسان وحشی (ATR روزانه بالای ۶٪)', test: (f) => (f.atrPct ?? 0) > 6 },
  { key: 'oi_buildup', side: 'any', titleFa: 'رشد ارزش قفل‌شدهٔ پوزیشن‌ها (OI)', test: (f) => (f.oi ?? 0) >= 0.25 },
  { key: 'btc_headwind_long', side: 'long', titleFa: 'خرید وقتی بیت‌کوین ریخته است', test: (f) => (f.btc ?? 0) <= -0.3 },
  { key: 'btc_tailwind_short', side: 'short', titleFa: 'فروش در رالی بیت‌کوین', test: (f) => (f.btc ?? 0) >= 0.3 },
  {
    key: 'stretch_hot_long',
    side: 'long',
    titleFa: 'خرید وقتی قیمت خیلی از میانگین فاصله گرفته',
    test: (f) => (f.stretch ?? 0) >= 0.35,
  },
  // ─── درس‌های زمانی (Brain v4): سشن‌های کم‌نقدینگی و پرنقدینگی ───
  {
    key: 'hour_night',
    side: 'any',
    titleFa: 'معامله در سکوت شب (۰۰ تا ۰۶ UTC)',
    test: (f) => (f.hourUtc ?? 12) < 6,
  },
  {
    key: 'hour_active',
    side: 'any',
    titleFa: 'معامله در سشن پرتحرک (۱۲ تا ۲۰ UTC)',
    test: (f) => (f.hourUtc ?? 0) >= 12 && (f.hourUtc ?? 0) < 20,
  },
  // ─── درس‌های رژیم نوسان (بازارهای متفاوت، قواعد متفاوت) ───
  {
    key: 'regime_calm',
    side: 'any',
    titleFa: 'رژیم آرام بازار (ATR روزانه ۰٫۶ تا ۱٫۵٪)',
    test: (f) => {
      const a = f.atrPct ?? 2
      return a >= 0.6 && a < 1.5
    },
  },
  {
    key: 'regime_hot',
    side: 'any',
    titleFa: 'رژیم داغ بازار (ATR روزانه ۳٫۵ تا ۶٪)',
    test: (f) => {
      const a = f.atrPct ?? 0
      return a >= 3.5 && a <= 6
    },
  },
  { key: 'side_long_global', side: 'long', titleFa: 'معاملات خرید (لانگ) در وضعیت فعلی بازار', test: () => true },
  { key: 'side_short_global', side: 'short', titleFa: 'معاملات فروش (شورت) در وضعیت فعلی بازار', test: () => true },
]

const PATTERN_BY_KEY = new Map(LESSON_PATTERNS.map((p) => [p.key, p]))

const MINE_TAKE = 400
const MIN_N = 20 // حداقل نمونه برای اعتبار یک درس
const MIN_GAP_PP = 8 // حداقل فاصله از میانگین (واحد درصدی)
const MAX_DELTA = 8

interface EvalRow {
  side: string
  featuresJson: string
  ftPnlPct: number | null
  pnlPct: number | null
  createdAt: Date
}

function pnlOf(r: EvalRow): number {
  return r.ftPnlPct ?? r.pnlPct ?? 0
}

/** کشف/به‌روزرسانی درس‌ها از آخرین نمونه‌های ارزیابی‌شده — خروجی: عنوان درس‌های تغییرکرده */
export async function mineLessons(): Promise<string[]> {
  const rows = await db.brainSample.findMany({
    where: { evaluatedAt: { not: null } },
    select: { side: true, featuresJson: true, ftPnlPct: true, pnlPct: true, createdAt: true },
    orderBy: { evaluatedAt: 'desc' },
    take: MINE_TAKE,
  })
  if (rows.length < MIN_N) return []

  const parsed: { side: 'long' | 'short'; feats: LessonFeats; win: boolean }[] = []
  for (const r of rows) {
    let f: LessonFeats = {}
    try {
      f = JSON.parse(r.featuresJson) as LessonFeats
    } catch {
      continue
    }
    f.hourUtc = r.createdAt.getUTCHours()
    parsed.push({ side: r.side === 'short' ? 'short' : 'long', feats: f, win: pnlOf(r) > 0 })
  }
  if (parsed.length < MIN_N) return []

  const overall = parsed.filter((p) => p.win).length / parsed.length
  const changed: string[] = []
  // نوشتن‌های لازم در یک تراکنش — چرخِ دیتابیس چند برابر سبک‌تر می‌شود
  const writes: PrismaPromise<unknown>[] = []

  for (const p of LESSON_PATTERNS) {
    const match = parsed.filter((x) => (p.side === 'any' || x.side === p.side) && safeTest(p, x.feats))
    const n = match.length
    const wr = n ? match.filter((m) => m.win).length / n : 0
    const gapPp = (wr - overall) * 100

    const statsFa = `${faNum(n, 0)} نمونه — برد ${faNum(wr * 100, 0)}٪ در برابر میانگین ${faNum(overall * 100, 0)}٪`
    const significant = n >= MIN_N && Math.abs(gapPp) >= MIN_GAP_PP

    if (significant) {
      const delta = Math.round(Math.max(-MAX_DELTA, Math.min(MAX_DELTA, gapPp * 0.35)) * 10) / 10
      const confidence = Math.min(95, Math.round(35 + n / 3 + Math.abs(gapPp)))
      const dir = gapPp > 0 ? 'مساعد' : 'خطر'
      const bodyFa =
        gapPp > 0
          ? `مغز کشف کرد در داده‌های اخیر، «${p.titleFa}» نتیجهٔ بهتری از میانگین داده است (${statsFa}). سیگنال‌های مشابه امتیاز مثبت می‌گیرند.`
          : `مغز کشف کرد در داده‌های اخیر، «${p.titleFa}» نتیجهٔ بدتری از میانگین داده است (${statsFa}). سیگنال‌های مشابه جریمه می‌شوند و دروازهٔ استادی سخت‌گیرتر است.`
      const existing = await db.brainLesson.findUnique({ where: { key: p.key }, select: { delta: true, confidence: true, active: true } })
      const unchanged = existing && existing.active && existing.delta === delta && existing.confidence === confidence
      if (!unchanged) {
        writes.push(
          db.brainLesson.upsert({
            where: { key: p.key },
            update: { kind: 'pattern', titleFa: p.titleFa, bodyFa, statsFa, confidence, delta, active: true },
            create: { key: p.key, kind: 'pattern', titleFa: p.titleFa, bodyFa, statsFa, confidence, delta, active: true },
          }),
        )
      }
      if (!existing || !existing.active || Math.abs((existing.delta ?? 0) - delta) > 0.5) {
        changed.push(`${p.titleFa} (${dir})`)
      }
    } else {
      // شواهد کافی نیست — درس کهنه نباید بی‌پایه اثر بگذارد
      const existing = await db.brainLesson.findUnique({ where: { key: p.key }, select: { active: true } })
      if (existing?.active) {
        writes.push(db.brainLesson.update({ where: { key: p.key }, data: { active: false, delta: 0 } }))
        changed.push(`بازنگری «${p.titleFa}» — شواهد کافی نیست، غیرفعال شد`)
      }
    }
  }
  if (writes.length) await db.$transaction(writes)
  return changed
}

function safeTest(p: LessonPattern, f: LessonFeats): boolean {
  try {
    return p.test(f)
  } catch {
    return false
  }
}

// ─── اعمال درس‌ها روی امتیاز سیگنال ───

interface ActiveLesson {
  key: string
  titleFa: string
  delta: number
}

let cache: { at: number; rows: ActiveLesson[] } | null = null
const CACHE_MS = 5 * 60_000

async function activeLessonRows(): Promise<ActiveLesson[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.rows
  const rows = await db.brainLesson.findMany({
    where: { kind: 'pattern', active: true, delta: { not: 0 } },
    select: { key: true, titleFa: true, delta: true },
  })
  cache = { at: now, rows }
  return rows
}

/** امتیاز تنظیمی درس‌ها + فهرست درس‌های اعمال‌شده (برای ثبت در دلیل سیگنال) */
export async function lessonAdjustment(
  feats: LessonFeats,
  side: 'long' | 'short',
): Promise<{ delta: number; matchedFa: string[] }> {
  const rows = await activeLessonRows()
  let delta = 0
  const matchedFa: string[] = []
  for (const r of rows) {
    const p = PATTERN_BY_KEY.get(r.key)
    if (!p) continue
    if (p.side !== 'any' && p.side !== side) continue
    if (!safeTest(p, feats)) continue
    delta += r.delta
    matchedFa.push(`${p.titleFa} ${r.delta > 0 ? '+' : ''}${faNum(r.delta, 1)}`)
  }
  // سقف کل تأثیر درس‌ها: ±۱۰ امتیاز — درس‌ها تنظیم‌گرِ دقیق‌اند، نه تصمیم‌گیرندهٔ تنها
  delta = Math.round(Math.max(-10, Math.min(10, delta)) * 10) / 10
  return { delta, matchedFa }
}


