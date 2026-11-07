import { db } from '@/lib/db'
import type { CandleRow } from '@/lib/fetchers/binance'

// ─── Candle store helpers ───

export const INTERVALS = ['15m', '1h', '4h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]

export const INTERVAL_MS: Record<Interval, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

export function rowsToCandleRows(rows: { ts: Date; open: number; high: number; low: number; close: number; volume: number; takerBuy?: number | null }[]): CandleRow[] {
  return rows.map((r) => ({
    ts: r.ts.getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    takerBuyBase: r.takerBuy ?? undefined,
  }))
}

export async function loadCandles(symbol: string, interval: Interval, limit = 300): Promise<CandleRow[]> {
  const rows = await db.candle.findMany({
    where: { symbol, interval },
    orderBy: { ts: 'desc' },
    take: limit,
  })
  return rowsToCandleRows(rows.reverse())
}

/** Load candles in an explicit time range (ascending) — used by the brain backfill. */
export async function loadCandlesRange(
  symbol: string,
  interval: Interval,
  fromTs: number,
  toTs: number,
): Promise<CandleRow[]> {
  const rows = await db.candle.findMany({
    where: { symbol, interval, ts: { gte: new Date(fromTs), lte: new Date(toTs) } },
    orderBy: { ts: 'asc' },
  })
  return rowsToCandleRows(rows)
}

export async function upsertCandles(symbol: string, interval: Interval, rows: CandleRow[]): Promise<number> {
  if (!rows.length) return 0
  // NOTE: Prisma 6 stores SQLite DateTime as INTEGER epoch-ms — raw inserts must match.
  const CHUNK = 80
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const values: (string | number | null)[] = []
    for (const r of chunk) {
      values.push(symbol, interval, r.ts, r.open, r.high, r.low, r.close, r.volume, r.takerBuyBase ?? null)
    }
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "Candle" ("symbol", "interval", "ts", "open", "high", "low", "close", "volume", "takerBuy") VALUES ${placeholders}`,
      ...values,
    )
  }
  return rows.length
}

/** Fetch only the candles missing since the last stored one (budget-friendly). */
export async function fetchAndStoreCandles(
  symbol: string,
  interval: Interval,
  fetchFn: (s: string, iv: string, limit: number) => Promise<CandleRow[]>,
  bootstrapLimit = 300,
): Promise<number> {
  const last = await db.candle.findFirst({
    where: { symbol, interval },
    orderBy: { ts: 'desc' },
    select: { ts: true },
  })
  let limit = bootstrapLimit
  if (last) {
    const gapBars = Math.ceil((Date.now() - last.ts.getTime()) / INTERVAL_MS[interval]) + 2
    limit = Math.min(bootstrapLimit, Math.max(2, gapBars))
  }
  const rows = await fetchFn(symbol, interval, limit)
  await upsertCandles(symbol, interval, rows)
  return rows.length
}
