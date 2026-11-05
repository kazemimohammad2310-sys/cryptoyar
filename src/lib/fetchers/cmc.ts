import { fetchJson, SourceUnavailableError } from '@/lib/rateLimit'
import { KEYS } from '@/lib/env'

// ─── CoinMarketCap fetchers (free tier ≈10k calls/month — budget-aware) ───
// Correction applied: cmc-refresh runs every 15min (was 10min) → ≈5,800 calls/month.

export interface CmcCoin {
  id: number
  name: string
  symbol: string
  cmc_rank: number
  quote: { USD: { market_cap: number; percent_change_24h: number; price: number } }
}

export interface CmcGlobal {
  data: {
    quote: { USD: { total_market_cap: number; total_volume_24h: number; btc_dominance: number } }
  }
}

export function cmcEnabled(): boolean {
  return KEYS.cmc.length > 0
}

export async function getCmcTopListings(limit = 50): Promise<CmcCoin[]> {
  if (!cmcEnabled()) throw new SourceUnavailableError('cmc', 'کلید CMC تنظیم نشده است')
  const data = await fetchJson<{ data: CmcCoin[] }>(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${limit}&convert=USD`,
    { source: 'cmc', headers: { 'X-CMC_PRO_API_KEY': KEYS.cmc }, retries: 1 },
  )
  return data.data
}

export async function getCmcGlobal(): Promise<CmcGlobal['data']> {
  if (!cmcEnabled()) throw new SourceUnavailableError('cmc', 'کلید CMC تنظیم نشده است')
  const data = await fetchJson<CmcGlobal>(
    'https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest',
    { source: 'cmc', headers: { 'X-CMC_PRO_API_KEY': KEYS.cmc }, retries: 1 },
  )
  return data.data
}
