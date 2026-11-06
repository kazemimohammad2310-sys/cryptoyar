import { PrismaClient } from '@prisma/client'

// Backfill reason data from the feature-era snapshot (/tmp/cloud-1233.db, cycle d62298a)
// into the current live DB. Matches rows by natural keys (not autoincrement ids).
const live = new PrismaClient()
const snap = new PrismaClient({ datasources: { db: { url: process.env.SNAP_URL } } })

async function main() {
  // --- positions: match by symbol + side + entryPrice + openedAt ---
  const snapPositions = (await snap.$queryRawUnsafe(
    'SELECT id, symbol, side, entryPrice, openedAt, closeReasonFa FROM FundPosition WHERE closeReasonFa IS NOT NULL',
  )) as any[]
  let posFixed = 0
  for (const sp of snapPositions) {
    const openedIso = new Date(Number(sp.openedAt)).toISOString()
    const rows: any[] = await live.$queryRawUnsafe(
      'SELECT id, closeReasonFa FROM FundPosition WHERE symbol=? AND side=? AND entryPrice=? AND openedAt=? LIMIT 1',
      sp.symbol,
      sp.side,
      sp.entryPrice,
      openedIso,
    )
    if (rows.length && !rows[0].closeReasonFa) {
      await live.$executeRawUnsafe('UPDATE FundPosition SET closeReasonFa=? WHERE id=?', sp.closeReasonFa, rows[0].id)
      posFixed++
      console.log(`position backfilled: ${sp.symbol} ${sp.side} (${openedIso})`)
    } else if (rows.length) {
      console.log(`position already has reason: ${sp.symbol} ${sp.side}`)
    } else {
      console.log(`no live match for snapshot position: ${sp.symbol} ${sp.side} (${openedIso})`)
    }
  }
  if (!snapPositions.length) console.log('snapshot has no position reasons to backfill')

  // --- signals: match by symbol + createdAt ---
  const snapSignals = (await snap.$queryRawUnsafe(
    'SELECT id, symbol, createdAt, gateStatus, gateReasonFa FROM Signal WHERE gateReasonFa IS NOT NULL',
  )) as any[]
  let sigFixed = 0
  for (const ss of snapSignals) {
    const createdIso = new Date(Number(ss.createdAt)).toISOString()
    const rows: any[] = await live.$queryRawUnsafe(
      'SELECT id FROM Signal WHERE symbol=? AND createdAt=? LIMIT 1',
      ss.symbol,
      createdIso,
    )
    if (rows.length) {
      await live.$executeRawUnsafe(
        'UPDATE Signal SET gateStatus=?, gateReasonFa=? WHERE id=?',
        ss.gateStatus,
        ss.gateReasonFa,
        rows[0].id,
      )
      sigFixed++
      console.log(`signal backfilled: ${ss.symbol} (${createdIso}) ${ss.gateStatus}`)
    } else {
      console.log(`no live match for snapshot signal: ${ss.symbol} (${createdIso})`)
    }
  }
  if (!snapSignals.length) console.log('snapshot has no signal gate reasons to backfill')

  console.log(`DONE positions=${posFixed} signals=${sigFixed}`)
}

main()
  .catch((e) => {
    console.error('ERR', e)
    process.exit(1)
  })
  .finally(async () => {
    await live.$disconnect()
    await snap.$disconnect()
  })
