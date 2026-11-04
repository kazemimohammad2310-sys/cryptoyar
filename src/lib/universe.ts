import { db } from '@/lib/db'
import { getAllTickers, getValidUsdtPairs } from '@/lib/fetchers/binance'
import { getCmcTopListings, cmcEnabled } from '@/lib/fetchers/cmc'
import { SourceUnavailableError } from '@/lib/rateLimit'

// ─── Universe resolution: top-50 tradable USDT symbols ───
// Primary: CMC ranking (needs key). Fallback (graceful): Binance top-50 by quote volume,
// excluding leveraged tokens & stable-pairs — system never dies without CMC.

const EXCLUDE_RE = /(UP|DOWN|BULL|BEAR)USDT$/
const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EUR', 'AEUR', 'USD1', 'USDE', 'XUSD', 'PYUSD', 'EURI', 'PAXG',
])

export interface UniverseEntry {
  symbol: string
  base: string
  name: string
  rank: number
  marketCap: number
  cmcId: number | null
}

async function binanceUniverse(): Promise<UniverseEntry[]> {
  const [tickers, valid] = await Promise.all([getAllTickers(), getValidUsdtPairsCached()])
  const rows = tickers
    .filter((t) => valid.has(t.symbol) && !EXCLUDE_RE.test(t.symbol))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.replace(/USDT$/, ''), qv: Number(t.quoteVolume) }))
    .filter((r) => r.base && !STABLE_BASES.has(r.base))
    .sort((a, b) => b.qv - a.qv)
    .slice(0, 50)
  return rows.map((r, i) => ({
    symbol: r.symbol,
    base: r.base,
    name: r.base,
    rank: i + 1,
    marketCap: 0,
    cmcId: null,
  }))
}

// in-process caches: exchangeInfo is heavy (weight 20, ~2MB) and changes rarely
let validPairsCache: { at: number; set: Set<string> } | null = null
let refreshInFlight: Promise<{ entries: UniverseEntry[]; source: 'cmc' | 'binance' }> | null = null

async function getValidUsdtPairsCached(): Promise<Set<string>> {
  if (validPairsCache && Date.now() - validPairsCache.at < 24 * 3600_000) return validPairsCache.set
  const set = await getValidUsdtPairs()
  validPairsCache = { at: Date.now(), set }
  return set
}

/** Persist the current top-50 universe into Coin. Single-flight: concurrent callers share one run. */
export async function refreshUniverse(): Promise<{ entries: UniverseEntry[]; source: 'cmc' | 'binance' }> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = doRefreshUniverse().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function doRefreshUniverse(): Promise<{ entries: UniverseEntry[]; source: 'cmc' | 'binance' }> {
  let entries: UniverseEntry[] = []
  let source: 'cmc' | 'binance' = 'binance'
  if (cmcEnabled()) {
    try {
      const list = await getCmcTopListings(50)
      const valid = await getValidUsdtPairsCached()
      entries = list
        .map((c) => ({
          symbol: `${c.symbol.toUpperCase()}USDT`,
          base: c.symbol.toUpperCase(),
          name: c.name,
          rank: c.cmc_rank ?? 999,
          marketCap: c.quote?.USD?.market_cap ?? 0,
          cmcId: c.id,
        }))
        .filter((e) => valid.has(e.symbol))
        .slice(0, 50)
        .map((e, i) => ({ ...e, rank: i + 1 }))
      source = 'cmc'
    } catch {
      entries = await binanceUniverse()
      source = 'binance'
    }
  } else {
    entries = await binanceUniverse()
  }

  for (const e of entries) {
    await db.coin.upsert({
      where: { symbol: e.symbol },
      update: { name: e.name, rank: e.rank, marketCap: e.marketCap, cmcId: e.cmcId, base: e.base },
      create: { symbol: e.symbol, base: e.base, name: e.name, rank: e.rank, marketCap: e.marketCap, cmcId: e.cmcId },
    })
  }
  // prune coins no longer in universe (keep used ones)
  const syms = entries.map((e) => e.symbol)
  await db.coin.deleteMany({ where: { symbol: { notIn: syms } } })
  return { entries, source }
}

export async function getUniverseSymbols(): Promise<string[]> {
  const coins = await db.coin.findMany({ orderBy: { rank: 'asc' }, select: { symbol: true } })
  return coins.map((c) => c.symbol)
}

export async function assertUniverse(): Promise<string[]> {
  let syms = await getUniverseSymbols()
  if (!syms.length) {
    const { entries } = await refreshUniverse()
    syms = entries.map((e) => e.symbol)
  }
  if (!syms.length) throw new SourceUnavailableError('binance-spot', 'universe empty')
  return syms
}
