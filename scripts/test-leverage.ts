// ─── آزمون اهرم متناسب: سه سطح بنیاد (قوی/متوسط/ضعیف) → باز و بستن فوری ───
import { db, ensurePragmas } from '@/lib/db'
import { openPosition, closePosition, liquidationPrice, roeOf } from '@/lib/fund'

await ensurePragmas()

const cases = [
  { sym: 'BTCUSDT', level: 'strong' as const, tag: 'قوی → تا سقف تنظیمات' },
  { sym: 'ETHUSDT', level: 'mid' as const, tag: 'متوسط → تا ×۳' },
  { sym: 'ZECUSDT', level: 'weak' as const, tag: 'ضعیف → ×۱ بدون اهرم' },
]

for (const c of cases) {
  try {
    const r = await openPosition({
      symbol: c.sym,
      side: 'long',
      reasonFa: `آزمون اهرم (${c.tag})`,
      fundamentalLevel: c.level,
    })
    const pos = await db.fundPosition.findUniqueOrThrow({ where: { id: r.positionId } })
    const liq = liquidationPrice(pos)
    const roe = roeOf(pos)
    console.log(
      `${c.sym} بنیاد=${c.level} → اهرم ×${r.leverage} | مارجین=${r.marginUsdt.toFixed(2)} USDT | حجم اسمی=${(r.entry * r.qty).toFixed(2)} | لیکوییدیشن=${liq.toFixed(2)} | ROE=${roe.toFixed(2)}%`,
    )
    const closed = await closePosition(r.positionId, 'آزمون اهرم — بستن فوری')
    console.log(`   بسته شد: سود/زیان ${closed.pnlUsdt.toFixed(2)} USDT`)
  } catch (e) {
    console.log(`${c.sym} خطا: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// اهرم ثابت هم بررسی شود
process.env.FUT_FIXED = '1'
await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
process.exit(0)
