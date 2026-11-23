// تشخیص: چرا نامزدهای یادگیری دروازه‌ها را رد کردند؟ (فقط خواندن + چاپ دلیل هر دروازه)
import { db, ensurePragmas } from '../src/lib/db'
import { ensureDefaults, getLearningConfig, getFuturesConfig } from '../src/lib/settings'
import { computeFundamentals, type FundamentalRow } from '../src/lib/fundamentals'
import { sameSideBlock, strategyCooldownBlock, pumpGateFailReason, expertGateFailReason, BOT_PREFIX, STRAT_LOSS_STREAK } from '../src/lib/autotrader'

async function main(): Promise<void> {
  await ensurePragmas()
  await ensureDefaults()
  const learn = await getLearningConfig()
  console.log('LEARN CONFIG:', JSON.stringify(learn))

  const since = new Date(Date.now() - 8 * 3600_000)
  const rows = await db.signal.findMany({
    where: { status: { in: ['open', 'watch'] }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 60,
  })
  console.log('fresh signals (open+watch):', rows.length)
  const cands = rows
    .filter((s) => Math.abs(s.score) >= learn.minScore)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5)
  console.log('learn candidates (abs>=', learn.minScore, '):', cands.length)

  const openBySide: Record<string, number> = {}
  for (const g of await db.fundPosition.groupBy({ by: ['side'], where: { status: 'open' }, _count: { _all: true } })) {
    openBySide[g.side] = g._count._all
  }
  let fundMap = new Map<string, FundamentalRow>()
  const fut = await getFuturesConfig()
  try {
    const snap = await computeFundamentals({ maxAgeMs: 15 * 60_000 })
    fundMap = new Map(snap.rows.map((r) => [r.symbol, r]))
    console.log('fundamentals rows:', snap.rows.length)
  } catch (e) {
    console.log('fundamentals FAILED (gate inactive):', e instanceof Error ? e.message.slice(0, 80) : e)
  }

  for (const s of cands) {
    const side = s.side === 'short' ? 'short' : 'long'
    const absScore = Math.abs(s.score)
    let f: Record<string, number> = {}
    try {
      f = JSON.parse(s.featuresJson) as Record<string, number>
    } catch {
      /* خالی */
    }
    const fundRow = fundMap.get(s.symbol) ?? null
    console.log(`\n== ${s.symbol} ${side} score=${s.score.toFixed(1)} strat=${s.strategy} fund=${fundRow?.level ?? 'n/a'}`)
    console.log('   features:', JSON.stringify({ rsiRaw: f.rsiRaw, atrPct: f.atrPct, funding: f.funding, mtf: f.mtf, volZ: f.volZ, volSurge: f.volSurge, cvd: f.cvd }))
    const dup = await db.fundPosition.findFirst({ where: { symbol: s.symbol, status: 'open' }, select: { id: true } })
    console.log('   dup:', dup ? 'YES → skip' : 'no')
    const same = sameSideBlock(side, openBySide)
    console.log('   sameSide:', same ?? 'pass')
    const stratCloses = await db.fundPosition.findMany({
      where: { status: 'closed', strategy: s.strategy },
      orderBy: { closedAt: 'desc' },
      take: STRAT_LOSS_STREAK,
      select: { pnlUsdt: true, closedAt: true },
    })
    const strat = strategyCooldownBlock(stratCloses)
    console.log('   stratCooldown:', strat ?? 'pass')
    const lastClosed = await db.fundPosition.findFirst({
      where: { symbol: s.symbol, status: 'closed' },
      orderBy: { closedAt: 'desc' },
      select: { closedAt: true, pnlUsdt: true },
    })
    if (lastClosed?.closedAt) {
      const wasLoss = (lastClosed.pnlUsdt ?? 0) <= 0
      const cdH = wasLoss ? 6 : 1
      const sinceH = (Date.now() - lastClosed.closedAt.getTime()) / 3600_000
      console.log('   symbolCooldown:', sinceH < cdH ? `BLOCK (${sinceH.toFixed(1)}h < ${cdH}h)` : 'pass')
    } else {
      console.log('   symbolCooldown: no history')
    }
    if (s.strategy === 'momentum_breakout') console.log('   pumpGate:', pumpGateFailReason(f) ?? 'pass')
    if (fut.expertGate === 'on') console.log('   expertGate:', expertGateFailReason(f, side, s.strategy, absScore, fundRow) ?? 'pass')
  }
  process.exit(0)
}

void main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
