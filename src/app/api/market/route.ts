import { NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { getSetting } from '@/lib/settings'
import { getFearGreed } from '@/lib/fetchers/feargreed'

export const dynamic = 'force-dynamic'

interface GlobalMetrics {
  totalMarketCap: number
  totalVolume24h: number
  btcDominance: number
  ts: number
}

interface FearGreed {
  value: number
  classificationFa: string
}

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()

    // top-50 universe + their latest ticker (single pass, ordered by rank)
    const coins = await db.coin.findMany({ orderBy: { rank: 'asc' }, take: 60 })
    const symbols = coins.map((c) => c.symbol)

    const tickers = await Promise.all(
      symbols.map((sym) =>
        db.tickerSnapshot.findFirst({
          where: { symbol: sym },
          orderBy: { ts: 'desc' },
          select: { symbol: true, price: true, change24h: true, volume24h: true, high24h: true, low24h: true, ts: true },
        }),
      ),
    )

    const rows = coins
      .map((c) => {
        const t = tickers.find((x) => x?.symbol === c.symbol)
        return {
          symbol: c.symbol,
          base: c.base,
          name: c.name,
          rank: c.rank,
          marketCap: c.marketCap,
          price: t?.price ?? null,
          change24h: t?.change24h ?? null,
          volume24h: t?.volume24h ?? null,
          ts: t?.ts?.getTime() ?? null,
        }
      })
      .filter((r) => r.price !== null)

    const [globalRaw, fgRaw] = await Promise.all([getSetting('globalMetrics'), getSetting('fearGreed')])
    let global: GlobalMetrics | null = null
    try {
      if (globalRaw) global = JSON.parse(globalRaw) as GlobalMetrics
    } catch {
      global = null
    }

    // fear & greed: prefer cached snapshot, fall back to a live call
    let fearGreed: FearGreed | null = null
    try {
      if (fgRaw) {
        const parsed = JSON.parse(fgRaw) as FearGreed
        if (parsed && typeof parsed.value === 'number') fearGreed = parsed
      }
    } catch {
      fearGreed = null
    }
    if (!fearGreed) {
      try {
        const fg = await getFearGreed()
        fearGreed = { value: fg.value, classificationFa: fg.classificationFa }
      } catch {
        fearGreed = null
      }
    }

    return NextResponse.json({
      coins: rows,
      global,
      fearGreed,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
