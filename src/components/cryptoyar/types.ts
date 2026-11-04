// ─── Shared API response types (mirror of the server routes) ───

export interface CoinRow {
  symbol: string
  base: string
  name: string
  rank: number
  marketCap: number
  price: number | null
  change24h: number | null
  volume24h: number | null
  ts: number | null
}

export interface MarketResp {
  coins: CoinRow[]
  global: { totalMarketCap: number; totalVolume24h: number; btcDominance: number; ts: number } | null
  fearGreed: { value: number; classificationFa: string } | null
}

export interface RadarSignal {
  id: number
  symbol: string
  side: 'long' | 'short'
  score: number
  strategy: string
  strategyFa: string
  entryPrice: number
  stopLoss: number
  takeProfit: number
  features: Record<string, number>
  reasonFa: string
  status: string
  createdAt: number
}

export interface RadarResp {
  signals: RadarSignal[]
  watch: RadarSignal[]
}

export interface FundPositionRow {
  id: number
  symbol: string
  side: string
  qty: number
  entryPrice: number
  markPrice: number
  stopLoss: number
  takeProfit: number
  strategy: string
  reasonFa: string
  pnlUsdt: number
  pnlPct: number
  openedAt: number
}

export interface FundResp {
  stats: {
    equity: number
    realizedPnl: number
    unrealizedPnl: number
    totalPnlUsdt: number
    totalPnlPct: number
    winRate: number
    profitFactor: number | null
    maxDrawdownPct: number
    bestTrade: { symbol: string; pnlUsdt: number } | null
    worstTrade: { symbol: string; pnlUsdt: number } | null
    closedCount: number
    perStrategy: { strategy: string; fa: string; count: number; pnlUsdt: number; winRate: number }[]
    circuitBreaker: { tripped: boolean; drawdownPct: number; limitPct: number }
  }
  equityNow: number
  equityCurve: { ts: number; v: number }[]
  positions: FundPositionRow[]
  orders: { id: number; kind: string; symbol: string; side: string; qty: number; price: number; reasonFa: string; createdAt: number }[]
}

export interface BrainResp {
  counts: { total: number; evaluated: number; pending: number; coldStart: boolean; minForTraining: number }
  weights: { key: string; weight: number }[]
  training: { at: number; trained: boolean; detail: string } | null
  selfTest: {
    at: number
    overall: { label: string; total: number; accuracy: number; avgPnlPct: number; tpRate: number; slRate: number } | null
    byHorizon: { label: string; total: number; accuracy: number; avgPnlPct: number; tpRate: number; slRate: number }[]
    byStrategy: { label: string; total: number; accuracy: number; avgPnlPct: number; tpRate: number; slRate: number }[]
    samplesUsed: number
  } | null
  history: { at: number; accuracy: number }[]
  samples: {
    id: number
    symbol: string
    side: string
    strategy: string | null
    horizonHours: number
    predicted: string
    outcome: string | null
    pnlPct: number | null
    ftOutcome: string | null
    ftPnlPct: number | null
    createdAt: number
    evaluatedAt: number | null
  }[]
  cachedAccuracy: string | null
}

export interface NightshiftResp {
  bootstrapped: boolean
  jobs: { name: string; fa: string; intervalMs: number | null; running: boolean; last: { at: number; ok: boolean; durationMs: number; detail: string; error: string | null } | null }[]
  logs: { id: number; job: string; startedAt: number; finishedAt: number | null; ok: boolean; error: string | null; detail: string | null }[]
}

export interface SettingsResp {
  mode: 'paper' | 'live'
  keys: { cmc: boolean; toobitKey: boolean; toobitSecret: boolean; adminToken: boolean }
  risk: { equity: number; maxPositions: number; riskPerTradePct: number; maxPositionPct: number; dailyDrawdownHaltPct: number }
  weights: { key: string; weight: number }[]
  adminLockEnabled: boolean
  connector: { name: string; phase: number; note: string }
}
