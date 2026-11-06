import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const sigs = await db.signal.findMany({
  where: { gateStatus: { not: null } },
  orderBy: { createdAt: 'desc' }, take: 8,
})
for (const s of sigs) console.log(`[${s.gateStatus}] ${s.symbol} ${s.side} — ${s.gateReasonFa ?? '(عبور/ورود)'}`)
const closed = await db.fundPosition.findMany({ where: { closeReasonFa: { not: null } }, orderBy: { closedAt: 'desc' }, take: 3 })
console.log('--- closed with reason ---')
for (const p of closed) console.log(`${p.symbol}: ${p.closeReasonFa}`)
await db.$disconnect()
