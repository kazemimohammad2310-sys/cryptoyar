import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const cnt = async (sql: string) => {
    const rows = (await db.$queryRawUnsafe(sql)) as Array<{ c: bigint | number }>
    return Number(rows[0]?.c ?? 0)
  }
  const total = await cnt('SELECT COUNT(*) as c FROM FundPosition')
  const withOpenReason = await cnt('SELECT COUNT(*) as c FROM FundPosition WHERE reasonFa IS NOT NULL')
  const withCloseReason = await cnt('SELECT COUNT(*) as c FROM FundPosition WHERE closeReasonFa IS NOT NULL')
  console.log(`positions total=${total} withOpenReason=${withOpenReason} withCloseReason=${withCloseReason}`)

  const recent = (await db.$queryRawUnsafe(
    'SELECT symbol, side, status, openedAt, closedAt, reasonFa, closeReasonFa FROM FundPosition ORDER BY openedAt DESC LIMIT 6',
  )) as Array<{
    symbol: string
    side: string
    status: string
    openedAt: Date
    closedAt: Date | null
    reasonFa: string | null
    closeReasonFa: string | null
  }>
  for (const p of recent) {
    console.log(
      `--- ${p.symbol} ${p.side} ${p.status} opened=${p.openedAt instanceof Date ? p.openedAt.toISOString() : p.openedAt} closed=${p.closedAt instanceof Date ? p.closedAt.toISOString() : p.closedAt}`,
    )
    console.log(`  open : ${(p.reasonFa ?? '(null)').slice(0, 120)}`)
    console.log(`  close: ${(p.closeReasonFa ?? '(null)').slice(0, 120)}`)
  }

  const sigs = await cnt('SELECT COUNT(*) as c FROM Signal')
  const sigsWithGate = await cnt('SELECT COUNT(*) as c FROM Signal WHERE gateReasonFa IS NOT NULL')
  console.log(`signals total=${sigs} withGateReason=${sigsWithGate}`)
}

main()
  .catch((e) => {
    console.error('ERR', e.message)
  })
  .finally(() => db.$disconnect())
