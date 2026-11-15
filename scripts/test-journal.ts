// ─── تست دفترچهٔ یادگیری: ضدتکرار، سازنده‌های یادداشت، و ساخت داشبورد محلی ───
// اجرا: bun scripts/test-journal.ts  (محلی — چیزی کامیت نمی‌کند)
import { db, ensurePragmas } from '@/lib/db'
import { addJournalNote, journalFromOpen, journalFromClose, journalFromLesson, noteShareText, journalExportText } from '@/lib/journal'

let pass = 0
let fail = 0
function check(name: string, ok: boolean): void {
  if (ok) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}`)
  }
}

async function main(): Promise<void> {
  await ensurePragmas()

  // ۱) ضدتکرار با refKey + پنجرهٔ زمانی
  const first = await addJournalNote({
    kind: 'shield',
    titleFa: 'تست ضدتکرار',
    bodyFa: 'خط اول\nخط دوم',
    tags: ['تست'],
    refKey: 'test:dedupe:1',
    dedupeHours: 24,
  })
  const second = await addJournalNote({
    kind: 'shield',
    titleFa: 'تست ضدتکرار',
    bodyFa: 'خط اول\nخط دوم',
    tags: ['تست'],
    refKey: 'test:dedupe:1',
    dedupeHours: 24,
  })
  check('یادداشت اول نوشته شد', first === true)
  check('یادداشت تکراری نوشته نشد (ضدتکرار)', second === false)

  // ۲) یادداشت فرضیهٔ ورود (عادی)
  await journalFromOpen({
    positionId: 990001,
    symbol: 'TESTUSDT',
    side: 'long',
    strategy: 'mean_reversion',
    strategyFa: 'بازگشت به میانگین',
    absScore: 72,
    minScoreFa: 'از آستانهٔ ۷۰',
    confluence: 6,
    levelFa: 'بنیاد متوسط',
    leverage: 3,
    marginUsdt: 50,
    entry: 1.2345,
    stop: 1.2000,
    target: 1.3035,
    isLearning: false,
    mtfFa: 'هم‌جهت با روند ۴ساعته',
  })
  const hyp = await db.journalNote.findFirst({ where: { refKey: 'open:990001' } })
  check('یادداشت فرضیه ثبت شد', Boolean(hyp))
  check('فرضیه: نسبت ریسک/سود در متن هست', Boolean(hyp?.bodyFa.includes('نسبت ریسک/سود ۱:۲')))
  check('فرضیه: برچسب دروازهٔ استادی هست', Boolean(hyp?.tags.includes('دروازهٔ استادی')))

  // ۳) یادداشت فرضیهٔ ورود یادگیری
  await journalFromOpen({
    positionId: 990002,
    symbol: 'TESTUSDT',
    side: 'short',
    strategy: 'trend_following',
    strategyFa: 'پیروی از روند',
    absScore: 45,
    minScoreFa: 'از آستانهٔ یادگیری ۴۲',
    confluence: 4,
    levelFa: 'بنیاد ضعیف',
    leverage: 1,
    marginUsdt: 25,
    entry: 2.0,
    stop: 2.06,
    target: 1.91,
    isLearning: true,
    mtfFa: null,
  })
  const learn = await db.journalNote.findFirst({ where: { refKey: 'open:990002' } })
  check('یادداشت فرضیهٔ یادگیری ثبت شد', Boolean(learn))
  check('یادگیری: برچسب ریسک نصف در برچسب‌ها هست', Boolean(learn?.tags.includes('ریسک نصف')))

  // ۴) یادداشت نتیجهٔ خروج — زیان با حد ضرر اولیه
  await journalFromClose({
    positionId: 990001,
    symbol: 'TESTUSDT',
    side: 'long',
    strategy: 'mean_reversion',
    strategyFa: 'بازگشت به میانگین',
    reasonFa: 'حد ضرر اولیه فعال شد (ATR — جلوگیری از بزرگ‌تر شدن ضرر)',
    pnlUsdt: -1.85,
    pnlPct: -2.79,
    durationH: 5.4,
    entryPrice: 1.2345,
    closePrice: 1.2000,
    stopLoss: 1.2,
    wasLearning: false,
  })
  const res = await db.journalNote.findFirst({ where: { refKey: 'close:990001' } })
  check('یادداشت نتیجه ثبت شد', Boolean(res))
  check('نتیجه: درس حد ضرر اولیه در متن هست', Boolean(res?.bodyFa.includes('حد ضرر اولیه کارش را کرد')))

  // ۵) یادداشت نتیجهٔ خروج — سود با هدف سود
  await journalFromClose({
    positionId: 990002,
    symbol: 'TESTUSDT',
    side: 'short',
    strategy: 'trend_following',
    strategyFa: 'پیروی از روند',
    reasonFa: 'هدف سود محقق شد (نسبت ریسک/سود ۱٫۵ — حد سود به قیمت رسید)',
    pnlUsdt: 2.1,
    pnlPct: 2.1,
    durationH: 12,
    entryPrice: 2.0,
    closePrice: 1.91,
    stopLoss: 2.06,
    wasLearning: true,
  })
  const resWin = await db.journalNote.findFirst({ where: { refKey: 'close:990002' } })
  check('یادداشت نتیجهٔ سود ثبت شد', Boolean(resWin))
  check('نتیجهٔ سود: بازخوانی فرضیه تأیید شده', Boolean(resWin?.bodyFa.includes('فرضیهٔ ورود تأیید شد')))

  // ۶) یادداشت درس از مغز
  await journalFromLesson({
    key: 'test_pattern',
    titleFa: 'معامله در نوسان مرده',
    statsFa: '۲۰ نمونه — برد ۲۵٪ در برابر میانگین ۴۵٪',
    bodyFa: '',
    delta: -4.2,
    confidence: 78,
  })
  const les = await db.journalNote.findFirst({ where: { refKey: 'lesson:test_pattern' } })
  check('یادداشت درس ثبت شد', Boolean(les))
  check('درس: جریمه در متن هست', Boolean(les?.bodyFa.includes('جریمه')))

  // ۷) متن اشتراک و خروجی کل
  const rows = await db.journalNote.findMany({ orderBy: { createdAt: 'desc' }, take: 40 })
  const share = noteShareText(rows[0], '۱۴۰۴/۰۸/۲۵ ۱۸:۳۰')
  check('متن اشتراک غیرخالی و دارای سرصفحه است', share.length > 40 && share.includes('دفترچهٔ یادگیری کریپتویار'))
  const exportAll = journalExportText(rows.slice().reverse().map((n) => ({ kind: n.kind, titleFa: n.titleFa, bodyFa: n.bodyFa, tags: n.tags, symbol: n.symbol, strategy: n.strategy, createdAt: n.createdAt, dateFa: '۱۴۰۴/۰۸/۲۵' })), '۱۴۰۴/۰۸/۲۵')
  const SEP = '-'.repeat(46)
  check('خروجی کل دفترچه شامل همهٔ یادداشت‌هاست', exportAll.includes('خروجی') && exportAll.split(SEP).length >= rows.length)

  // ۸) پاک‌سازی ردیف‌های تست — دیتابیس ابری باید بدون دادهٔ تست کامیت شود
  const del = await db.journalNote.deleteMany({ where: { refKey: { startsWith: 'test:' } } })
  await db.journalNote.deleteMany({ where: { OR: [{ refKey: { startsWith: 'open:99' } }, { refKey: { startsWith: 'close:99' } }, { refKey: 'lesson:test_pattern' }] } })
  check('ردیف‌های تست پاک شدند', del.count > 0)

  console.log(`\nJOURNAL TEST DONE pass=${pass} fail=${fail}`)
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
  await db.$disconnect()
  if (fail > 0) process.exit(1)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
