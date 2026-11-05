// Inspect futures settings + positions in the paper fund DB
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const keys = await db.setting.findMany({
    where: { key: { in: ['futuresLeverageMode', 'futuresMaxLeverage', 'futuresFixedLeverage', 'botExpertGate', 'botEnabled'] } },
  })
  console.log('--- settings ---')
  for (const k of keys) console.log(`${k.key} = ${k.value}`)

  const open = await db.fundPosition.findMany({ where: { status: 'open' }, orderBy: { id: 'desc' } })
  console.log('--- open positions:', open.length, '---')
  for (const p of open) {
    const slPct = ((Math.abs(p.entryPrice - p.stopLoss) / p.entryPrice) * 100).toFixed(2)
    const liqLevCap = (0.95 / ((Math.abs(p.entryPrice - p.stopLoss) / p.entryPrice) * 2.5)).toFixed(1)
    console.log(
      `#${p.id} ${p.symbol} ${p.side} lev=×${p.leverage} margin=${p.marginUsdt.toFixed(2)} slPct=${slPct}% maxSafeLev≈${liqLevCap} | ${p.reasonFa.slice(0, 60)}`,
    )
  }

  const closed = await db.fundPosition.findMany({ where: { status: 'closed' }, orderBy: { id: 'desc' }, take: 5 })
  console.log('--- last closed ---')
  for (const p of closed) console.log(`#${p.id} ${p.symbol} ${p.side} lev=×${p.leverage} pnl=${p.pnlUsdt?.toFixed(2)}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
