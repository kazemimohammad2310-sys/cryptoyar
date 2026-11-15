import { db } from '@/lib/db'
import { faNum } from '@/lib/fa'

// برچسب‌های استاندارد ربات — منبع اصلی این‌جاست (autotrader دوباره‌صادر می‌کند تا
// ایمپورت‌های موجود نشکنند؛ journal هرگز autotrader را import نمی‌کند تا چرخه نسازد)
export const BOT_PREFIX = 'ربات خودکار'
export const LEARN_TAG = 'معاملهٔ یادگیری'

// ─── دفترچهٔ یادگیری (Journal) ───
// ربات مثل یک تریدر حرفه‌ای در لحظه‌های کلیدی یادداشت می‌نویسد:
//   hypothesis — چرا وارد شدم (فرضیه، شواهد، ریسک، حد ضرر/هدف، اقدام بعدی)
//   result     — وقتی معامله بسته شد (نتیجه، بازخوانی فرضیه، درس عملی مکانیکی از داده)
//   lesson     — وقتی مغز از داده‌های واقعی یک الگو کشف می‌کند (درس‌های lessons.ts)
//   shield     — سپرهای انضباطی (قطع‌کن مدار، توقف استراتژی، ترمز ضرر پیاپی)
//   waiting    — صبر آگاهانه: نداشتن سیگنال قوی خودش یک تصمیم حرفه‌ای است
// همهٔ یادداشت‌ها فقط از دادهٔ واقعی ساخته می‌شوند؛ هیچ‌چیز ساختگی. هر یادداشت
// با refKey و پنجرهٔ زمانی ضدتکرار می‌شود تا چرخهٔ ۵ دقیقه‌ای اسپم نسازد.

export type JournalKind = 'hypothesis' | 'result' | 'lesson' | 'shield' | 'waiting'

export const JOURNAL_KIND_FA: Record<JournalKind, string> = {
  hypothesis: 'یادداشت ورود (فرضیه)',
  result: 'یادداشت خروج (نتیجه)',
  lesson: 'درس آموخته از داده',
  shield: 'یادداشت انضباطی',
  waiting: 'یادداشت صبر',
}

export const JOURNAL_KIND_TAG: Record<JournalKind, string> = {
  hypothesis: 'فرضیه',
  result: 'نتیجه',
  lesson: 'درس',
  shield: 'انضباط',
  waiting: 'صبر',
}

export interface JournalInput {
  kind: JournalKind
  titleFa: string
  bodyFa: string
  tags?: string[]
  symbol?: string | null
  strategy?: string | null
  positionId?: number | null
  refKey?: string | null
  /** پنجرهٔ ضدتکرار به ساعت (پیش‌فرض ۲۴)؛ ۰ = هر بار بنویس */
  dedupeHours?: number
}

/** ثبت یک یادداشت — true = نوشته شد، false = تکراری بود یا خطای غیرحیاتی */
export async function addJournalNote(inp: JournalInput): Promise<boolean> {
  try {
    if (inp.refKey) {
      const hours = inp.dedupeHours ?? 24
      const dup = await db.journalNote.findFirst({
        where: hours > 0 ? { refKey: inp.refKey, createdAt: { gte: new Date(Date.now() - hours * 3600_000) } } : { refKey: inp.refKey },
        select: { id: true },
      })
      if (dup) return false
    }
    await db.journalNote.create({
      data: {
        kind: inp.kind,
        titleFa: inp.titleFa.slice(0, 180),
        bodyFa: inp.bodyFa.slice(0, 1800),
        tags: (inp.tags ?? []).join(',').slice(0, 200),
        symbol: inp.symbol ?? null,
        strategy: inp.strategy ?? null,
        positionId: inp.positionId ?? null,
        refKey: inp.refKey ?? null,
      },
    })
    return true
  } catch {
    /* دفترچه هرگز نباید جریان معامله را بشکند */
    return false
  }
}

export interface JournalNoteRow {
  kind: string
  titleFa: string
  bodyFa: string
  tags: string
  symbol: string | null
  strategy: string | null
  createdAt: Date
}

/** متن یک یادداشت برای کپی/اشتراک — قالب دفترچهٔ تریدر حرفه‌ای */
export function noteShareText(n: JournalNoteRow, dateFa: string): string {
  const kindFa = JOURNAL_KIND_FA[(n.kind as JournalKind)] ?? n.kind
  const head = `دفترچهٔ یادگیری کریپتویار — ${kindFa}`
  const subj = n.symbol ? `${n.symbol.replace('USDT', '')}/USDT${n.strategy ? ` · ${n.strategy}` : ''}` : n.strategy ?? ''
  const tags = n.tags ? `\nبرچسب‌ها: ${n.tags.split(',').filter(Boolean).join('، ')}` : ''
  return `${head}${subj ? `\n${subj}` : ''}\n\n${n.bodyFa}${tags}\n${dateFa}`
}

/** متن کل دفترچه برای «کپی همه» و دانلود فایل — قدیمی‌ترین اول */
export function journalExportText(notes: (JournalNoteRow & { dateFa: string })[], dateFaNow: string): string {
  const head = `دفترچهٔ یادگیری کریپتویار — خروجی ${faNum(notes.length, 0)} یادداشت (${dateFaNow})\n${'='.repeat(46)}`
  const body = notes
    .map((n) => `\n${noteShareText(n, n.dateFa)}\n${'-'.repeat(46)}`)
    .join('\n')
  const tail = `\nکریپتویار — یادداشت‌ها خودکار از دادهٔ واقعی معاملات شبیه‌ساز ساخته می‌شوند؛ توصیهٔ سرمایه‌گذاری نیست.`
  return `${head}\n${body}${tail}`
}

// ─── سازندهٔ یادداشت ورود (فرضیه) ───

export interface OpenJournalCtx {
  positionId: number
  symbol: string
  side: 'long' | 'short'
  strategy: string
  strategyFa: string
  absScore: number
  minScoreFa: string // «از آستانهٔ ۷۰» یا «از آستانهٔ یادگیری ۴۲»
  confluence: number
  levelFa: string
  leverage: number
  marginUsdt: number
  entry: number
  stop: number
  target: number
  isLearning: boolean
  mtfFa?: string | null
}

export async function journalFromOpen(c: OpenJournalCtx): Promise<void> {
  const sideFa = c.side === 'long' ? 'خرید' : 'فروش'
  const riskPct = c.entry > 0 ? Math.abs((c.entry - c.stop) / c.entry) * 100 : 0
  const rr = riskPct > 0 ? Math.abs((c.target - c.entry) / (c.entry - c.stop)) : 0
  const body = [
    `فرضیه: ${c.strategyFa} — ${sideFa} ${c.symbol.replace('USDT', '')}/USDT با انتظار حرکت هم‌جهت تا هدف.`,
    `شواهد ورود: امتیاز ${faNum(Math.round(c.absScore), 0)} ${c.minScoreFa}، همگرایی ${faNum(c.confluence, 0)}/۹ فاکتور تکنیکال، ${c.levelFa}${c.mtfFa ? `، ${c.mtfFa}` : ''}.`,
    `سطح ریسک: مارجین ${faNum(c.marginUsdt, 2)} USDT با اهرم ×${faNum(c.leverage, c.leverage % 1 === 0 ? 0 : 1)}، فاصلهٔ حد ضرر ${faNum(riskPct, 1)}٪ و نسبت ریسک/سود ۱:${faNum(rr, 1)} — ${c.isLearning ? 'نصف ریسک چون این معاملهٔ یادگیری است و هدفش تولید دادهٔ آموزشی برای مغز است' : 'مطابق قواعد مدیریت ریسک صندوق'}.`,
    `اقدام بعدی: پایش خودکار حد ضرر/هدف؛ اگر قیمت تا حد ضرر رفت، فرضیه در این رژیم بازار رد می‌شود و در یادداشت خروج بازخوانی خواهد شد.`,
  ].join('\n')
  await addJournalNote({
    kind: 'hypothesis',
    titleFa: `ورود ${sideFa} ${c.symbol.replace('USDT', '')}/USDT — ${c.strategyFa} (امتیاز ${faNum(Math.round(c.absScore), 0)})`,
    bodyFa: body,
    tags: ['فرضیه', c.strategyFa, ...(c.isLearning ? ['معاملهٔ یادگیری', 'ریسک نصف'] : ['دروازهٔ استادی'])],
    symbol: c.symbol,
    strategy: c.strategy,
    positionId: c.positionId,
    refKey: `open:${c.positionId}`,
    dedupeHours: 0,
  })
}

// ─── سازندهٔ یادداشت خروج (نتیجه) ───

export interface CloseJournalCtx {
  positionId: number
  symbol: string
  side: string
  strategy: string
  strategyFa: string
  reasonFa: string // عامل خروج (قبل از غنی‌سازی نهایی)
  pnlUsdt: number
  pnlPct: number
  durationH: number
  entryPrice: number
  closePrice: number
  stopLoss: number
  wasLearning: boolean
}

/** درس عملی مکانیکی از ترکیب عامل خروج و نتیجه — هیچ ادعایی فراتر از داده نیست */
function closeLessonFa(c: CloseJournalCtx): string {
  const r = c.reasonFa || ''
  if (r.includes('هدف سود')) return 'هدف سود با نسبت ریسک/سود ۱٫۵ به دست آمد — قاعدهٔ خروج برنامه‌ریزی‌شده درست عمل کرد؛ همین قالب تکرار شود.'
  if (r.includes('لیکوییدیشن')) return 'پوزیشن به لیکوییدیشن رسید — اهرم و فاصلهٔ حد ضرر برای این نماد بیش از حد تنگ بود؛ ورودهای بعدی با اهرم محافظه‌کارانه‌تر.'
  if (r.includes('خروج زمانی')) return 'معامله بی‌تحرک ماند و با خروج زمانی بسته شد — ریسک و ظرفیت آزاد شد برای فرصت‌های زندهٔ بازار؛ این قاعده جلوی قفل‌شدن سرمایه در معاملهٔ مرده را گرفت.'
  if (r.includes('محافظت‌شده')) return c.pnlPct >= 0
    ? 'حد ضرر پس از سود به ناحیهٔ سود منتقل شده بود و معامله در سود بسته شد — قانون «قفل سود» کارش را کرد.'
    : 'حد ضرر محافظت‌شده فعال شد — سود قفل‌شده بخشی پس گرفته شد؛ فاصلهٔ تریلینگ برای نوسان این نماد باید بازنگری شود.'
  if (r.includes('حد ضرر')) return c.pnlPct < 0
    ? 'حد ضرر اولیه کارش را کرد — ضرر کوچک نگه داشته شد و سرمایهٔ اصلی سالم ماند؛ بی‌معامله‌ماندن بدون حد ضرر هرگز گزینه نیست.'
    : 'خروج در محدودهٔ حد ضرر اما در سود — مدیریت خروج انعطاف درست داشت.'
  return c.pnlPct >= 0
    ? 'خروج در سود ثبت شد؛ نتیجه با قواعد فعلی مدیریت پوزیشن سازگار است.'
    : 'خروج در زیان ثبت شد — زیان کوچک و مهارشده‌است؛ تکرار این الگو در همان استراتژی به توقف موقت آن می‌انجامد.'
}

export async function journalFromClose(c: CloseJournalCtx): Promise<void> {
  const sideFa = c.side === 'short' ? 'فروش' : 'خرید'
  const win = c.pnlUsdt >= 0
  const durFa = c.durationH >= 1 ? `${faNum(Math.round(c.durationH), 0)} ساعت` : `${faNum(Math.max(1, Math.round(c.durationH * 60)), 0)} دقیقه`
  const body = [
    `نتیجه: ${win ? 'سود' : 'زیان'} ${faNum(Math.abs(c.pnlPct), 2)}٪ (${faNum(Math.abs(c.pnlUsdt), 2)} USDT) پس از ${durFa} نگهداری — ورود ${faNum(c.entryPrice, 6)} → خروج ${faNum(c.closePrice, 6)}.`,
    `عامل خروج: ${c.reasonFa || '—'}`,
    `بازخوانی فرضیه: ${win ? 'فرضیهٔ ورود تأیید شد' : 'فرضیهٔ ورود تأیید نشد'}؛ ${closeLessonFa(c)}`,
    `اقدام بعدی: این نتیجه وارد حافظهٔ مغز شد و اعتماد به استراتژی «${c.strategyFa}» به‌روزرسانی می‌شود${c.wasLearning ? '؛ چون معاملهٔ یادگیری بود، دادهٔ آموزشی آن ارزش اصلی معامله بود' : ''}.`,
  ].join('\n')
  await addJournalNote({
    kind: 'result',
    titleFa: `خروج ${sideFa} ${c.symbol.replace('USDT', '')}/USDT — ${win ? 'سود' : 'زیان'} ${faNum(Math.abs(c.pnlPct), 2)}٪`,
    bodyFa: body,
    tags: ['نتیجهٔ واقعی', win ? 'سود' : 'زیان', c.strategyFa, ...(c.wasLearning ? ['معاملهٔ یادگیری'] : [])],
    symbol: c.symbol,
    strategy: c.strategy,
    positionId: c.positionId,
    refKey: `close:${c.positionId}`,
    dedupeHours: 0,
  })
}

// ─── سازندهٔ یادداشت درس (از mineLessons) ───

export interface LessonJournalCtx {
  key: string
  titleFa: string
  statsFa: string
  bodyFa: string
  delta: number
  confidence: number
}

export async function journalFromLesson(l: LessonJournalCtx): Promise<void> {
  const body = [
    `کشف الگو: «${l.titleFa}» در داده‌های اخیر نرخ برد فاصله‌گرفته از میانگین دارد.`,
    `شواهد: ${l.statsFa} — اطمینان ${faNum(l.confidence, 0)}٪.`,
    `اثر بر تصمیم‌ها: سیگنال‌های مشابه ${l.delta > 0 ? `تقویت می‌شوند (+${faNum(l.delta, 1)} امتیاز)` : `جریمه می‌شوند (${faNum(l.delta, 1)} امتیاز)`} و دروازهٔ ورود به‌تناسب سخت‌گیرانه‌تر یا مهربان‌تر است.`,
    `اقدام بعدی: ادامهٔ پایش — اگر شواهد کافی نشود، این درس به‌صورت خودکار غیرفعال و بازنگری می‌شود.`,
  ].join('\n')
  await addJournalNote({
    kind: 'lesson',
    titleFa: `درس مغز: ${l.titleFa}`,
    bodyFa: body,
    tags: ['درس', l.delta >= 0 ? 'الگوی سودده' : 'الگوی پرخطر'],
    refKey: `lesson:${l.key}`,
    dedupeHours: 12,
  })
}

// ─── سازندهٔ یادداشت انضباطی (سپرها) ───

export async function journalShieldNote(refKey: string, titleFa: string, bodyLines: string[], tags: string[]): Promise<void> {
  await addJournalNote({
    kind: 'shield',
    titleFa,
    bodyFa: bodyLines.join('\n'),
    tags,
    refKey,
    dedupeHours: 24,
  })
}

// ─── سازندهٔ یادداشت صبر ───

export async function journalWaitingNote(minScore: number, detailFa: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const body = [
    `امروز هیچ سیگنالی از آستانهٔ ورود ${faNum(minScore, 0)} عبور نکرد و ربات وارد نشده است.`,
    `تحلیل: ${detailFa}`,
    `درس حرفه‌ای: «معامله نکردن» هم یک پوزیشن است — تریدر حرفه‌ای وقتی شرایط نیست بیرون می‌ماند؛ فرصت بعدی با کیفیت بالاتر می‌آید.`,
    `اقدام بعدی: رادار هر ۵ دقیقه بازار را اسکن می‌کند؛ حالت یادگیری هم با نصف ریسک در حال جمع‌کردن داده است.`,
  ].join('\n')
  await addJournalNote({
    kind: 'waiting',
    titleFa: 'صبر آگاهانه — امروز شرایط ورود شکل نگرفت',
    bodyFa: body,
    tags: ['صبر', 'انضباط'],
    refKey: `waiting:${day}`,
    dedupeHours: 20,
  })
}

/** آیا این پوزیشن ربات، معاملهٔ یادگیری است؟ (برچسب در reasonFa) */
export function isLearnPosition(reasonFa: string): boolean {
  return reasonFa.startsWith(BOT_PREFIX) && reasonFa.includes(LEARN_TAG)
}
