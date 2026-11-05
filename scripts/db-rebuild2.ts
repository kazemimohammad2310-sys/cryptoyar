// Recovery part 2: TickerSnapshot + Candle with corrupt-page skipping.
// Reads by id ranges; when a range throws (corrupt page) it jumps forward.
// Run: bun scripts/db-rebuild2.ts
import { PrismaClient } from '@prisma/client'

const old = new PrismaClient() // corrupt DB
const neu = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/rebuild.db' })

const CHUNK = 3000
const MAX_SKIP = 3_000_000

async function resilientCopy(
  name: string,
  read: (cursor: number, take: number) => Promise<{ id: number }[]>,
  write: (rows: { id: number }[]) => Promise<number>,
): Promise<void> {
  let cursor = 0
  let saved = 0
  let skipped = 0
  for (;;) {
    let rows: { id: number }[]
    try {
      rows = await read(cursor, CHUNK)
    } catch {
      skipped += CHUNK
      cursor += CHUNK
      if (skipped > MAX_SKIP) break
      continue
    }
    if (!rows.length) break
    const nextCursor = rows[rows.length - 1].id
    if (nextCursor <= cursor) break
    try {
      saved += await write(rows)
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 60) : ''
      console.log(`${name}: chunk insert skip (${msg})`)
    }
    cursor = nextCursor
  }
  console.log(`${name}: ${saved} نجات یافت، ${skipped} ردیف از ناحیهٔ خراب رد شد`)
}

async function main(): Promise<void> {
  await resilientCopy(
    'TickerSnapshot',
    (cursor, take) =>
      old.tickerSnapshot.findMany({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take }),
    (rows) => neu.tickerSnapshot.createMany({ data: rows as never }).then((x) => x.count),
  )
  await resilientCopy(
    'Candle',
    (cursor, take) =>
      old.candle.findMany({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take }),
    (rows) => neu.candle.createMany({ data: rows as never }).then((x) => x.count),
  )

  const qc = await neu.$queryRawUnsafe<unknown[]>('PRAGMA quick_check;')
  console.log('quick_check جدید:', JSON.stringify(qc))

  await neu.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined)
  await old.$disconnect()
  await neu.$disconnect()
  console.log('REBUILD2 DONE')
}

void main().catch((e) => {
  console.error('REBUILD2 FAIL:', e instanceof Error ? e.message.slice(0, 200) : e)
  process.exit(1)
})
