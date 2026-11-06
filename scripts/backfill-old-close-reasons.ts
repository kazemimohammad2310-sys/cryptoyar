import { faNum } from '../src/lib/fa'
import { db } from '../src/lib/db'

// بازسازی دلیل بستنِ پوزیشن‌های قدیمی (بسته‌شده پیش از استقرار قابلیت دلیل‌ها)
// منبع اول: دفتر سفارش‌ها (FundOrder kind=close هم‌زمان). اگر نبود: استنتاج از قیمت‌ها.

function durFa(ms: number): string {
  const h = Math.max(0, ms / 3600_000)
  return h >= 1 ? `${faNum(Math.round(h), 0)} ساعت` : `${faNum(Math.max(1, Math.round(h * 60)), 0)} دقیقه`
}

function inferCause(side: string, entry: number, close: number, sl: number | null, tp: number | null): string {
  if (tp) {
    if (side === 'long' && close >= tp * 0.995) return 'هدف سود محقق شد (حد سود به قیمت رسید)'
    if (side === 'short' && close <= tp * 1.005) return 'هدف سود محقق شد (حد سود به قیمت رسید)'
  }
  if (sl) {
    if (side === 'long' && close <= sl * 1.005) return 'حد ضرر فعال شد'
    if (side === 'short' && close >= sl * 0.995) return 'حد ضرر فعال شد'
  }
  return 'بستن مدیریتی (بر اساس داده‌های تاریخی بازسازی شد)'
}

async function main() {
  const old = await db.fundPosition.findMany({
    where: { status: 'closed', OR: [{ closeReasonFa: null }, { closeReasonFa: '' }] },
    orderBy: { closedAt: 'asc' },
  })
  console.log(`positions to backfill: ${old.length}`)
  let fixed = 0

  for (const p of old) {
    const closedAt = p.closedAt?.getTime() ?? 0
    // ۱) نزدیک‌ترین سفارش بستن هم‌نماد (تا ۱۰ دقیقه قبل از closedAt)
    const order = await db.fundOrder.findFirst({
      where: { kind: 'close', symbol: p.symbol, createdAt: { gte: new Date(closedAt - 10 * 60_000), lte: new Date(closedAt + 60_000) } },
      orderBy: { createdAt: 'desc' },
    })
    const pnlPct = p.pnlPct ?? 0
    const pnlUsdt = p.pnlUsdt ?? 0
    const result = `نتیجه: ${pnlUsdt >= 0 ? 'سود' : 'زیان'} ${faNum(Math.abs(pnlPct), 2)}٪ (${faNum(Math.abs(pnlUsdt), 2)} USDT) — مدت نگهداری ${durFa(closedAt - (p.openedAt?.getTime() ?? closedAt))}`
    const cause = order?.reasonFa?.trim() || inferCause(p.side, p.entryPrice, p.closePrice ?? p.markPrice, p.stopLoss, p.takeProfit)
    const final = `${cause} — ${result}`
    await db.fundPosition.update({ where: { id: p.id }, data: { closeReasonFa: final } })
    fixed++
    console.log(`  #${p.id} ${p.symbol} ${p.side} → ${final.slice(0, 100)}`)
  }
  console.log(`DONE: ${fixed}/${old.length} backfilled`)
}

main()
  .catch((e) => {
    console.error('FAIL:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
