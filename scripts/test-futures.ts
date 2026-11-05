// ─── تست کامل فیوچرز: رادار تازه + ربات با دروازهٔ استادی + اهرم ───
import { db, ensurePragmas } from '@/lib/db'
import { scanRadar, persistRadarResult } from '@/lib/radar'
import { runAutoTrader } from '@/lib/autotrader'

await ensurePragmas()

console.log('=== RADAR SCAN (fresh signals) ===')
const result = await scanRadar()
console.log(`scanned=${result.scanned} signals=${result.signals.length} watch=${result.watch.length} errors=${result.errors.length}`)
const created = await persistRadarResult(result)
console.log('persisted:', created)

console.log('=== BOT TICK (expert gate + leverage) ===')
const bot = await runAutoTrader()
console.log(bot)

console.log('=== OPEN POSITIONS WITH LEVERAGE ===')
const open = await db.fundPosition.findMany({ where: { status: 'open' }, orderBy: { id: 'desc' }, take: 8 })
for (const p of open) {
  const margin = p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, p.leverage || 1)
  console.log(`${p.symbol} ${p.side} lev=×${p.leverage} margin=${margin.toFixed(2)} notional=${(p.entryPrice * p.qty).toFixed(2)} | ${p.reasonFa.slice(0, 120)}`)
}

await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
process.exit(0)
