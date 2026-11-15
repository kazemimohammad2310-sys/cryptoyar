// افزودن یادداشت نمایشی برای پیش‌نمایش محلی داشبورد + پاک‌سازی پس از تست
// اجرا: bun scripts/journal-demo.ts add  |  bun scripts/journal-demo.ts clean
import { db, ensurePragmas } from '@/lib/db'
import { journalFromOpen, journalFromClose, journalFromLesson } from '@/lib/journal'

async function main(): Promise<void> {
  await ensurePragmas()
  const mode = process.argv[2] ?? 'add'
  if (mode === 'clean') {
    const r = await db.journalNote.deleteMany({
      where: { OR: [{ refKey: { startsWith: 'demo:' } }, { refKey: { startsWith: 'open:9000' } }, { refKey: { startsWith: 'close:9000' } }, { refKey: { startsWith: 'lesson:demo' } }] },
    })
    console.log(`DEMO CLEAN deleted=${r.count}`)
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
    await db.$disconnect()
    return
  }

  await journalFromOpen({
    positionId: 900001,
    symbol: 'DEMOUSDT',
    side: 'long',
    strategy: 'mean_reversion',
    strategyFa: 'بازگشت به میانگین',
    absScore: 52,
    minScoreFa: 'از آستانهٔ یادگیری ۴۲',
    confluence: 2,
    levelFa: 'بنیاد ضعیف',
    leverage: 1,
    marginUsdt: 50,
    entry: 9.5,
    stop: 9.36,
    target: 9.78,
    isLearning: true,
    mtfFa: null,
  })
  await journalFromClose({
    positionId: 900001,
    symbol: 'DEMOUSDT',
    side: 'long',
    strategy: 'mean_reversion',
    strategyFa: 'بازگشت به میانگین',
    reasonFa: 'هدف سود محقق شد (نسبت ریسک/سود ۱٫۵ — حد سود به قیمت رسید)',
    pnlUsdt: 2.9,
    pnlPct: 2.9,
    durationH: 9,
    entryPrice: 9.5,
    closePrice: 9.78,
    stopLoss: 9.36,
    wasLearning: true,
  })
  await journalFromLesson({
    key: 'demo_pattern',
    titleFa: 'فروش همسو با روند ۴ساعته',
    statsFa: '۳۱ نمونه — برد ۶۱٪ در برابر میانگین ۴۷٪',
    bodyFa: '',
    delta: 3.5,
    confidence: 74,
  })
  const c = await db.journalNote.count()
  console.log(`DEMO ADD total=${c}`)
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
  await db.$disconnect()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
