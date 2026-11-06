// گزارش یادگیری مغز: چه آموخته، چقدر دقت، اعتماد به استراتژی‌ها
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const keys = await db.setting.findMany({
    where: { key: { in: ['brainWeights', 'brainAccuracy', 'brainTrainedAt', 'strategyTrust', 'brainBackfillDone'] } },
  })
  for (const k of keys) {
    let v = k.value
    if (v.length > 220) v = v.slice(0, 220) + '…'
    console.log(`${k.key} = ${v || '(خالی)'}`)
  }

  const total = await db.brainSample.count()
  const evaluated = await db.brainSample.count({ where: { outcome: { not: null } } })
  const wins = await db.brainSample.count({ where: { outcome: 'win' } })
  const losses = await db.brainSample.count({ where: { outcome: 'loss' } })
  const flats = await db.brainSample.count({ where: { outcome: 'flat' } })
  console.log(`\nsamples=${total} evaluated=${evaluated} win=${wins} loss=${losses} flat=${flats}`)

  // دقت در بازه‌های زمانی (روند یادگیری): آخرین ۵۰ / ۱۰۰ / ۲۰۰ نمونهٔ ارزیابی‌شده
  for (const n of [50, 100, 200]) {
    const rows = await db.brainSample.findMany({
      where: { outcome: { not: null } },
      orderBy: { evaluatedAt: 'desc' },
      take: n,
      select: { outcome: true },
    })
    const w = rows.filter((r) => r.outcome === 'win').length
    console.log(`last${Math.min(n, rows.length)}: winRate=${rows.length ? ((w / rows.length) * 100).toFixed(1) : '—'}%`)
  }

  // عملکرد به تفکیک استراتژی
  const byStrat = await db.brainSample.groupBy({
    by: ['strategy'],
    where: { outcome: { not: null } },
    _count: { _all: true },
  })
  const winMap = await db.brainSample.groupBy({
    by: ['strategy'],
    where: { outcome: 'win' },
    _count: { _all: true },
  })
  const winBy = new Map(winMap.map((g) => [g.strategy, g._count._all]))
  console.log('\nper-strategy (evaluated / win / winRate):')
  for (const g of byStrat.sort((a, b) => b._count._all - a._count._all)) {
    const w = winBy.get(g.strategy) ?? 0
    console.log(`  ${g.strategy}: ${g._count._all} / ${w} / ${((w / g._count._all) * 100).toFixed(0)}%`)
  }

  // عملکرد به تفکیک جهت (long/short)
  for (const side of ['long', 'short']) {
    const tot = await db.brainSample.count({ where: { outcome: { not: null }, side } })
    const w = await db.brainSample.count({ where: { outcome: 'win', side } })
    if (tot) console.log(`side=${side}: ${tot} evaluated, winRate=${((w / tot) * 100).toFixed(0)}%`)
  }

  // جدیدترین نمونه‌های ثبت‌شده (حافظهٔ تازه)
  const recent = await db.brainSample.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { symbol: true, side: true, predicted: true, outcome: true, createdAt: true } })
  console.log('\nrecent samples:')
  for (const r of recent) console.log(`  ${r.symbol} ${r.side} pred=${r.predicted} outcome=${r.outcome ?? 'درانتظار'} at=${r.createdAt.toISOString().slice(0, 16)}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
