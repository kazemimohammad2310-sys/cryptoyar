import {
  fetchJson,
  SourceUnavailableError,
  currentBinanceSpotBase,
  BINANCE_SPOT_BASES,
  sleep,
} from '@/lib/rateLimit'

// ─── Binance public fetchers (spot w/ base failover + USDT-M futures) ───

export interface BinanceTicker {
  symbol: string
  lastPrice: string
  priceChangePercent: string
  quoteVolume: string
  highPrice: string
  lowPrice: string
}

export interface CandleRow {
  ts: number // ms epoch
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** GET from the working Binance spot base; auto-failover to the mirror. */
async function spotGet<T>(path: string, query: string): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < BINANCE_SPOT_BASES.length; i++) {
    const base = currentBinanceSpotBase()
    try {
      return await fetchJson<T>(`${base}${path}${query}`, { source: 'binance-spot' })
    } catch (e) {
      lastErr = e
      const next = BINANCE_SPOT_BASES[(BINANCE_SPOT_BASES.indexOf(base) + 1) % BINANCE_SPOT_BASES.length]
      if (next && next !== base) {
        ;(globalThis as unknown as { __cryptoyar_net?: { binanceSpotBase: string | null } }).__cryptoyar_net!.binanceSpotBase =
          next
        await sleep(150)
        continue
      }
      break
    }
  }
  throw lastErr
}

export async function getKlines(symbol: string, interval: string, limit: number): Promise<CandleRow[]> {
  const data = await spotGet<(number | string)[][]>(
    '/api/v3/klines',
    `?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  )
  return data.map((k) => ({
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }))
}

export async function getAllTickers(): Promise<BinanceTicker[]> {
  return spotGet<BinanceTicker[]>('/api/v3/ticker/24hr', '')
}

export async function getValidUsdtPairs(): Promise<Set<string>> {
  const data = await spotGet<{ symbols: { symbol: string; status: string; quoteAsset: string }[] }>(
    '/api/v3/exchangeInfo',
    '',
  )
  const set = new Set<string>()
  for (const s of data.symbols ?? []) {
    if (s.quoteAsset === 'USDT' && s.status === 'TRADING') set.add(s.symbol)
  }
  return set
}

// ─── USDT-M futures (degradable — may be geo/rate restricted per IP) ───

export interface FundingInfo {
  symbol: string
  fundingRate: number
  markPrice: number | null
  fundingTime: number
}

export async function getFundingRate(symbol: string): Promise<FundingInfo | null> {
  try {
    const data = await fetchJson<{ symbol: string; fundingTime: number; fundingRate: string; markPrice: string }[]>(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`,
      { source: 'binance-futures', retries: 1 },
    )
    const d = data?.[0]
    if (!d) return null
    return {
      symbol: d.symbol,
      fundingRate: Number(d.fundingRate),
      markPrice: d.markPrice ? Number(d.markPrice) : null,
      fundingTime: Number(d.fundingTime),
    }
  } catch {
    return null
  }
}

export async function getOpenInterest(symbol: string): Promise<number | null> {
  try {
    const data = await fetchJson<{ openInterest: string }>(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
      { source: 'binance-futures', retries: 1 },
    )
    return Number(data.openInterest) || null
  } catch {
    return null
  }
}

export function isFuturesDown(e: unknown): boolean {
  return e instanceof SourceUnavailableError && e.source === 'binance-futures'
}
