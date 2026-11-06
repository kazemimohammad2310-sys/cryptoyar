import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 1) integrity
  const integ = (await db.$queryRawUnsafe('PRAGMA quick_check')) as unknown[]
  console.log('INTEGRITY:', JSON.stringify(integ))

  // 2) failed jobs in last 24h
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
  const fails: any[] = await db.$queryRawUnsafe(
    `SELECT job, COUNT(*) as c, MAX(startedAt) as last FROM JobLog WHERE ok=0 AND startedAt >= ? GROUP BY job ORDER BY c DESC`,
    dayAgo,
  )
  console.log('FAILED JOBS (24h):')
  for (const f of fails) console.log(`  ${f.job} x${Number(f.c)} last=${new Date(Number(f.last)).toISOString()}`)

  // 3) last error detail per failing job
  for (const f of fails.slice(0, 6)) {
    const rows: any[] = await db.$queryRawUnsafe(
      `SELECT detail, error, startedAt FROM JobLog WHERE job=? AND ok=0 ORDER BY startedAt DESC LIMIT 2`,
      f.job,
    )
    for (const r of rows) {
      const when = new Date(Number(r.startedAt)).toISOString()
      console.log(`  [${f.job} @ ${when}] ${(r.detail ?? r.error ?? '').slice(0, 160)}`)
    }
  }

  // 4) counts sanity
  const cnt = async (sql: string) => Number(((await db.$queryRawUnsafe(sql)) as any[])[0]?.c ?? 0)
  console.log(
    `COUNTS: positions=${await cnt('SELECT COUNT(*) as c FROM FundPosition')}` +
      ` open=${await cnt("SELECT COUNT(*) as c FROM FundPosition WHERE status='open'" as string)}` +
      ` signals=${await cnt('SELECT COUNT(*) as c FROM Signal')}` +
      ` candles=${await cnt('SELECT COUNT(*) as c FROM Candle')}` +
      ` coins=${await cnt('SELECT COUNT(*) as c FROM Coin')}` +
      ` equityPts=${await cnt('SELECT COUNT(*) as c FROM EquityPoint')}` +
      ` brainSamples=${await cnt('SELECT COUNT(*) as c FROM BrainSample')}` +
      ` lessons=${await cnt('SELECT COUNT(*) as c FROM BrainLesson')}`,
  )

  // 5) stale data checks
  const staleCandle: any[] = await db.$queryRawUnsafe('SELECT MAX(ts) as m FROM Candle')
  const maxC = staleCandle[0]?.m
  if (maxC) console.log('NEWEST CANDLE:', new Date(Number(maxC)).toISOString())

  const staleCoin: any[] = await db.$queryRawUnsafe('SELECT MAX(updatedAt) as m FROM Coin')
  const maxU = staleCoin[0]?.m
  if (maxU) console.log('NEWEST COIN UPDATE:', new Date(Number(maxU)).toISOString())

  // 6) open positions with zero/absurd values
  const bad: any[] = await db.$queryRawUnsafe(
    `SELECT id, symbol, side, status, entryPrice, qty, leverage, stopLoss, takeProfit FROM FundPosition
     WHERE (entryPrice IS NULL OR entryPrice<=0) OR (qty IS NULL OR qty<=0) OR (stopLoss IS NOT NULL AND stopLoss<=0)`,
  )
  console.log(`BAD POSITIONS: ${bad.length}`)
  for (const b of bad) console.log(' ', JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

  // 7) WAL checkpoint
  const wal: any[] = await db.$queryRawUnsafe('PRAGMA wal_checkpoint(PASSIVE)')
  console.log('WAL CHECKPOINT:', JSON.stringify(wal, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
}

main()
  .catch((e) => {
    console.error('ERR', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
