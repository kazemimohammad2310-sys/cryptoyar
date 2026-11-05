// One-shot local test of the auto-trader bot (no server needed).
import { db, ensurePragmas } from '@/lib/db'
import { ensureDefaults } from '@/lib/settings'
import { runAutoTrader } from '@/lib/autotrader'
import { markToMarket } from '@/lib/fund'

async function main(): Promise<void> {
  await ensurePragmas()
  await ensureDefaults()

  console.log('── BOT TICK ──')
  console.log(await runAutoTrader())

  console.log('── MARK TO MARKET ──')
  const mm = await markToMarket()
  console.log(`closed=${mm.closed}`, mm.details.slice(0, 5).join(' | '))

  const open = await db.fundPosition.findMany({ where: { status: 'open' }, take: 10 })
  console.log('── OPEN POSITIONS ──')
  for (const p of open) {
    console.log(`#${p.id} ${p.symbol} ${p.side} qty=${p.qty.toFixed(6)} entry=${p.entryPrice} sl=${p.stopLoss} tp=${p.takeProfit}`)
    console.log(`   reason: ${p.reasonFa}`)
  }

  try {
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* degrade */
  }
  await db.$disconnect()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
