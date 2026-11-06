import { NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { computeStats, currentEquity, liquidationPrice, roeOf } from '@/lib/fund'
import { STRATEGY_FA } from '@/lib/brain'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()

    const [stats, positions, orders, equity, closed] = await Promise.all([
      computeStats(),
      db.fundPosition.findMany({ where: { status: 'open' }, orderBy: { openedAt: 'desc' } }),
      db.fundOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      db.equityPoint.findMany({ orderBy: { ts: 'desc' }, take: 48 }),
      db.fundPosition.findMany({ where: { status: 'closed' }, orderBy: { closedAt: 'desc' }, take: 12 }),
    ])

    return NextResponse.json({
      stats,
      equityNow: await currentEquity(),
      equityCurve: equity.reverse().map((p) => ({ ts: p.ts.getTime(), v: p.equityUsdt })),
      positions: positions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        leverage: p.leverage || 1,
        marginUsdt: p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, p.leverage || 1),
        liquidationPrice: liquidationPrice(p),
        roe: roeOf(p),
        strategy: p.strategy,
        reasonFa: p.reasonFa,
        pnlUsdt: (p.side === 'long' ? p.markPrice - p.entryPrice : p.entryPrice - p.markPrice) * p.qty,
        pnlPct: ((p.side === 'long' ? p.markPrice - p.entryPrice : p.entryPrice - p.markPrice) * p.qty) /
          Math.max(p.entryPrice * p.qty, 1e-9) * 100,
        openedAt: p.openedAt.getTime(),
      })),
      orders: orders.map((o) => ({
        id: o.id,
        kind: o.kind,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        price: o.price,
        reasonFa: o.reasonFa,
        createdAt: o.createdAt.getTime(),
      })),
      closed: closed.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        leverage: p.leverage || 1,
        strategy: p.strategy,
        strategyFa: STRATEGY_FA[p.strategy] ?? (p.strategy === 'manual' ? 'دستی' : p.strategy),
        pnlUsdt: p.pnlUsdt ?? 0,
        pnlPct: p.pnlPct ?? 0,
        openedAt: p.openedAt.getTime(),
        closedAt: p.closedAt ? p.closedAt.getTime() : null,
        reasonFa: p.reasonFa,
        closeReasonFa: p.closeReasonFa,
      })),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
