// DB corruption recovery: copy every table row-by-row into a fresh DB,
// then verify counts. Old DB: db/custom.db (corrupt) → New: db/rebuild.db
// Run: bun scripts/db-rebuild.ts   (then swap files manually)
import { PrismaClient } from '@prisma/client'

const old = new PrismaClient() // DATABASE_URL → db/custom.db
const neu = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/rebuild.db' })

async function copyTable<T>(name: string, read: () => Promise<T[]>, write: (rows: T[]) => Promise<number>): Promise<number> {
  const rows = await read()
  let inserted = 0
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000)
    inserted += await write(chunk)
  }
  console.log(`${name}: ${inserted} رکورد منتقل شد`)
  return inserted
}

async function main(): Promise<void> {
  await neu.$executeRawUnsafe('PRAGMA journal_mode=WAL;').catch(() => undefined)
  await neu.$executeRawUnsafe('PRAGMA busy_timeout=5000;').catch(() => undefined)

  await copyTable('Setting', () => old.setting.findMany(), (r) => neu.setting.createMany({ data: r }).then((x) => x.count))
  await copyTable('Coin', () => old.coin.findMany(), (r) => neu.coin.createMany({ data: r }).then((x) => x.count))
  await copyTable('FundPosition', () => old.fundPosition.findMany(), (r) => neu.fundPosition.createMany({ data: r }).then((x) => x.count))
  await copyTable('FundOrder', () => old.fundOrder.findMany(), (r) => neu.fundOrder.createMany({ data: r }).then((x) => x.count))
  await copyTable('EquityPoint', () => old.equityPoint.findMany(), (r) => neu.equityPoint.createMany({ data: r }).then((x) => x.count))
  await copyTable('JobLog', () => old.jobLog.findMany(), (r) => neu.jobLog.createMany({ data: r }).then((x) => x.count))
  await copyTable('Signal', () => old.signal.findMany(), (r) => neu.signal.createMany({ data: r }).then((x) => x.count))
  await copyTable('BrainSample', () => old.brainSample.findMany(), (r) => neu.brainSample.createMany({ data: r }).then((x) => x.count))
  await copyTable('FundingSnapshot', () => old.fundingSnapshot.findMany(), (r) => neu.fundingSnapshot.createMany({ data: r }).then((x) => x.count))
  await copyTable('TickerSnapshot', () => old.tickerSnapshot.findMany(), (r) => neu.tickerSnapshot.createMany({ data: r }).then((x) => x.count))
  await copyTable('Candle', () => old.candle.findMany(), (r) => neu.candle.createMany({ data: r }).then((x) => x.count))

  const qc = await neu.$queryRawUnsafe<unknown[]>('PRAGMA quick_check;')
  console.log('quick_check جدید:', JSON.stringify(qc))

  await neu.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined)
  await old.$disconnect()
  await neu.$disconnect()
  console.log('REBUILD DONE')
}

void main().catch((e) => {
  console.error('REBUILD FAIL:', e instanceof Error ? e.message.slice(0, 200) : e)
  process.exit(1)
})
