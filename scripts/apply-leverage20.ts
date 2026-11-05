// اهرم فیوچرز ← ×۲۰ (درخواست کاربر)
// 1) settings: futuresLeverageMode=fixed, futuresFixedLeverage=20, futuresMaxLeverage=20
// 2) همهٔ پوزیشن‌های باز → اهرم ×۲۰ با مارجین بازمحاسبه‌شده + ثبت سفارش «adjust» برای شفافیت
import { PrismaClient } from '@prisma/client'
import { faNum } from '../src/lib/fa'

const db = new PrismaClient()
const LEV = 20

async function main() {
  // ─── 1) تنظیمات ───
  const settings: [string, string][] = [
    ['futuresLeverageMode', 'fixed'],
    ['futuresFixedLeverage', String(LEV)],
    ['futuresMaxLeverage', String(LEV)],
  ]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
  }
  console.log('settings → fixed ×20 (cap 20)')

  // ─── 2) پوزیشن‌های باز ───
  const open = await db.fundPosition.findMany({ where: { status: 'open' } })
  for (const p of open) {
    if ((p.leverage || 1) === LEV && p.marginUsdt > 0) {
      console.log(`#${p.id} ${p.symbol} already ×20 — skip`)
      continue
    }
    const notional = p.entryPrice * p.qty
    const margin = notional / LEV
    const liq = p.side === 'long' ? p.entryPrice * (1 - 0.95 / LEV) : p.entryPrice * (1 + 0.95 / LEV)
    await db.fundPosition.update({
      where: { id: p.id },
      data: { leverage: LEV, marginUsdt: margin },
    })
    await db.fundOrder.create({
      data: {
        kind: 'adjust',
        symbol: p.symbol,
        side: p.side,
        qty: 0,
        price: p.markPrice,
        reasonFa: `تنظیم اهرم به ×${faNum(LEV, 0)} (درخواست کاربر) — مارجین ${faNum(margin, 2)} USDT، حجم اسمی ${faNum(notional, 2)} USDT، قیمت لیکوییدیشن حدود ${faNum(liq, 4)}`,
      },
    })
    console.log(`#${p.id} ${p.symbol} ${p.side} → ×20, margin=${margin.toFixed(2)}, notional=${notional.toFixed(2)}`)
  }
  if (!open.length) console.log('no open positions')
  console.log('done')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
