import { NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { jobStatus } from '@/lib/nightshift'
import { sourceHealth } from '@/lib/rateLimit'
import { getMode } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()

    const [jobs, health, coinCount, candleCount, openPositions, mode] = await Promise.all([
      Promise.resolve(jobStatus()),
      Promise.resolve(sourceHealth()),
      db.coin.count(),
      db.candle.count(),
      db.fundPosition.count({ where: { status: 'open' } }),
      getMode(),
    ])

    const coreOk = health['binance-spot']?.ok ?? false
    return NextResponse.json(
      {
        status: coreOk ? 'ok' : 'degraded',
        mode,
        sources: {
          binance: health['binance-spot']?.ok ?? false,
          binanceFutures: health['binance-futures']?.ok ?? false,
          cmc: health['cmc']?.ok ?? false,
          feargreed: health['feargreed']?.ok ?? false,
        },
        jobs: Object.fromEntries(
          jobs.map((j) => [
            j.name,
            { running: j.running, last: j.last ? { at: j.last.at, ok: j.last.ok, detail: j.last.detail } : null },
          ]),
        ),
        stats: { coins: coinCount, candles: candleCount, openPositions },
        uptimeSec: Math.round(process.uptime()),
      },
      { status: 200 },
    )
  } catch (e) {
    return NextResponse.json(
      { status: 'error', error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
