// گزارش سلامت: آخرین خطاهای JobLog + آمار پایه
import { db } from '../src/lib/db'

async function main() {
  const fails = await db.jobLog.findMany({
    where: { ok: false },
    orderBy: { startedAt: 'desc' },
    take: 25,
  })
  console.log(`FAILED_JOBS (آخرین ${fails.length}):`)
  for (const f of fails) {
    console.log(
      `• ${f.job} @ ${f.startedAt.toISOString()} ok=${f.ok} err=${(f.error ?? '').slice(0, 160)}`,
    )
  }
  const counts = await db.jobLog.groupBy({
    by: ['job'],
    _count: { _all: true },
    where: { ok: false, startedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
  })
  console.log('--- خطاهای ۷ روز اخیر بر اساس شغل ---')
  for (const c of counts) console.log(`• ${c.job}: ${c._count._all}`)
  const samples = await db.brainSample.count()
  const ev = await db.brainSample.count({ where: { evaluatedAt: { not: null } } })
  const pos = await db.fundPosition.findMany({ where: { status: 'open' }, select: { symbol: true, pnlUsdt: true } })
  const equity = await db.equityPoint.findMany({ orderBy: { ts: 'desc' }, take: 1 })
  console.log(`--- وضعیت --- نمونه‌ها: ${samples} (${ev} ارزیابی‌شده) | پوزیشن باز: ${pos.map((p) => p.symbol).join(', ')}`)
  if (equity[0]) console.log(`اکوییتی آخر: ${equity[0].equityUsdt}`)
  const signals = await db.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } })
  console.log(`سیگنال ۲۴س اخیر: ${signals}`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error('ERR:', String(e).slice(0, 400))
  process.exit(1)
})
