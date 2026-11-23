// ─── بازرسی جامع سامانه — یافتن خطاها و ناسازگاری‌ها از دیتابیس واقعی ابر ───
// اجرا: git show origin/main:db/custom.db > /tmp/audit.db && DATABASE_URL="file:/tmp/audit.db" bun scripts/audit-system.ts
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const hr = '─'.repeat(58)

function head(t: string): void {
  console.log(`\n${hr}\n${t}\n${hr}`)
}

async function main(): Promise<void> {
  // ۱) آخرین خطاهای ثبت‌شده در jobLog (خطاهای واقعی ابر)
  head('۱) خطاهای اخیر jobLog (۷ روز اخیر)')
  const since = new Date(Date.now() - 7 * 24 * 3600_000)
  const fails = await db.jobLog.findMany({
    where: { ok: false, startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    take: 25,
  })
  if (!fails.length) console.log('هیچ خطای ثبت‌شده‌ای در ۷ روز اخیر نیست ✓')
  const byErr = new Map<string, number>()
  for (const f of fails) {
    const key = `${f.job} :: ${(f.error ?? 'بدون پیام').slice(0, 140)}`
    byErr.set(key, (byErr.get(key) ?? 0) + 1)
    if (byErr.get(key) === 1) console.log(`ERR [${f.job}] ${f.error?.slice(0, 160)} — آخرین: ${f.startedAt.toISOString()}`)
  }
  for (const [k, v] of byErr) console.log(`×${v} ${k.slice(0, 120)}`)

  // ۲) سلامت آخرین اجرای هر وظیفه
  head('۲) آخرین اجرای موفق هر وظیفه (ساعت پیش)')
  const jobs = ['ticker-refresh', 'candle-refresh', 'cmc-refresh', 'funding-refresh', 'radar-scan', 'fund-mark', 'bot-trade', 'equity-snapshot', 'brain-train', 'health', 'self-heal', 'self-optimize', 'self-update', 'self-test', 'data-prune']
  for (const j of jobs) {
    const r = await db.jobLog.findFirst({ where: { job: j, ok: true }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } })
    const h = r ? (Date.now() - r.startedAt.getTime()) / 3600_000 : -1
    console.log(`${j.padEnd(18)} ${h < 0 ? 'هرگز' : h.toFixed(1) + ' ساعت پیش'}${h > 2 ? '  ← عقب‌افتاده!' : ''}`)
  }

  // ۳) تنظیمات ربات — بررسی آستانه‌ها و درستی مقادیر
  head('۳) تنظیمات (Setting) مربوط به ربات/ریسک/یادگیری')
  const keys = await db.setting.findMany()
  const interesting = keys.filter((k) => /bot|risk|learn|fund|threshold|circuit|night|brain/i.test(k.key))
  for (const k of interesting) console.log(`${k.key} = ${k.value.slice(0, 220)}`)

  // ۴) سیگنال‌های کهنه/آشغال — registered قدیمی، watch قدیمی، نشتی‌ها
  head('۴) سیگنال‌ها')
  const sigTotal = await db.signal.count()
  const oldest = await db.signal.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const staleReg = await db.signal.count({ where: { status: 'registered', createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } })
  const staleWatch = await db.signal.count({ where: { status: 'watch', createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } })
  const perDay = sigTotal / Math.max(1, (Date.now() - (oldest?.createdAt?.getTime() ?? Date.now())) / 86400_000)
  console.log(`کل: ${sigTotal} | سرانهٔ روزانه: ${perDay.toFixed(0)} | registered کهنه(>24ساعت): ${staleReg} | watch کهنه: ${staleWatch}`)

  // ۵) پوزیشن‌ها و صندوق — سازگاری
  head('۵) پوزیشن‌ها')
  const open = await db.fundPosition.findMany({ where: { status: 'open' } })
  const dupSym = new Set<string>()
  const seen = new Set<string>()
  for (const p of open) {
    if (seen.has(p.symbol)) dupSym.add(p.symbol)
    seen.add(p.symbol)
    console.log(`OPEN ${p.symbol} ${p.side} margin=${p.marginUsdt.toFixed(1)} lev=×${p.leverage} openedAt=${p.openedAt.toISOString().slice(0, 16)} learn=${p.reasonFa.includes('یادگیری') ? 'بله' : 'خیر'}`)
  }
  if (dupSym.size) console.log(`!! نماد تکراری باز: ${[...dupSym].join(',')}`)
  const closed30 = await db.fundPosition.count({ where: { status: 'closed', closedAt: { gte: new Date(Date.now() - 30 * 24 * 3600_000) } } })
  const wins30 = await db.fundPosition.count({ where: { status: 'closed', closedAt: { gte: new Date(Date.now() - 30 * 24 * 3600_000) }, pnlUsdt: { gt: 0 } } })
  console.log(`۳۰ روز اخیر: بسته‌شده=${closed30} برد=${wins30} (${closed30 ? ((wins30 / closed30) * 100).toFixed(0) : '—'}٪)`)

  // ۶) مغز — نمونه‌ها، درس‌ها، وزن‌ها
  head('۶) مغز')
  const samples = await db.brainSample.count()
  const unevaluated = await db.brainSample.count({ where: { evaluatedAt: null, createdAt: { lt: new Date(Date.now() - 72 * 3600_000) } } })
  const lessons = await db.brainLesson.findMany({ where: { active: true }, select: { key: true, delta: true, confidence: true } })
  console.log(`نمونه‌ها=${samples} | نمونهٔ کهنهٔ ارزیابی‌نشده(>72ساعت): ${unevaluated}`)
  console.log(`درس‌های فعال=${lessons.length}: ${lessons.map((l) => `${l.key}(${l.delta > 0 ? '+' : ''}${l.delta.toFixed(1)})`).join(', ')}`)

  // ۷) دیتای بازار — تازگی تیکرها و کندل‌ها
  head('۷) تازگی دادهٔ بازار')
  const lastTicker = await db.tickerSnapshot.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, symbol: true } })
  const lastCandle = await db.candle.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, symbol: true, interval: true } })
  const candleCount = await db.candle.count()
  const tickH = lastTicker ? (Date.now() - lastTicker.ts.getTime()) / 3600_000 : -1
  const candH = lastCandle ? (Date.now() - lastCandle.ts.getTime()) / 3600_000 : -1
  console.log(`آخرین تیکر: ${lastTicker?.symbol} ${tickH.toFixed(2)} ساعت پیش | آخرین کندل: ${lastCandle?.symbol}/${lastCandle?.interval} ${candH.toFixed(2)} ساعت پیش | کل کندل‌ها=${candleCount}`)

  // ۸) دفترچهٔ یادگیری — وضعیت
  head('۸) دفترچهٔ یادگیری')
  const jn = await db.journalNote.count()
  const jnKinds = await db.journalNote.groupBy({ by: ['kind'], _count: { _all: true } })
  console.log(`یادداشت‌ها=${jn}: ${jnKinds.map((k) => `${k.kind}×${k._count._all}`).join(', ')}`)

  console.log(`\n${hr}\nAUDIT DONE`)
  await db.$disconnect()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
