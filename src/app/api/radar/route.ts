import { NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { STRATEGY_FA } from '@/lib/brain'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    await ensurePragmas()
    await ensureBooted()

    const url = new URL(req.url)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 12), 1), 50)

    const signals = await db.signal.findMany({
      where: { status: { in: ['open', 'watch'] } },
      orderBy: { createdAt: 'desc' },
      take: 120,
    })

    // sort by |score| desc, split open vs watch
    signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    const open = signals.filter((s) => s.status === 'open').slice(0, limit)
    const watch = signals.filter((s) => s.status === 'watch').slice(0, limit)

    const shape = (s: (typeof signals)[number]) => ({
      id: s.id,
      symbol: s.symbol,
      side: s.side,
      score: s.score,
      strategy: s.strategy,
      strategyFa: STRATEGY_FA[s.strategy] ?? s.strategy,
      entryPrice: s.entryPrice,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      features: safeParse(s.featuresJson),
      reasonFa: s.reasonFa,
      status: s.status,
      createdAt: s.createdAt.getTime(),
    })

    return NextResponse.json({ signals: open.map(shape), watch: watch.map(shape) })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}

function safeParse(raw: string): Record<string, number> {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
    }
    return out
  } catch {
    return {}
  }
}
