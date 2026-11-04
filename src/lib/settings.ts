import { db } from '@/lib/db'

// ─── Typed settings store (Setting table) with defaults from §3 ───

export type FeatureKey = 'rsi' | 'trend' | 'macd' | 'volume' | 'funding' | 'oi' | 'stretch' | 'btc'
export const FEATURE_KEYS: FeatureKey[] = ['rsi', 'trend', 'macd', 'volume', 'funding', 'oi', 'stretch', 'btc']

export const DEFAULT_WEIGHTS: Record<FeatureKey, number> = {
  rsi: 20,
  trend: 20,
  macd: 12,
  volume: 10,
  funding: 12,
  oi: 6,
  stretch: 8,
  btc: 12,
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  mode: 'paper', // paper | live(locked) — TRADING_MODE env is the master default
  equity: '10000',
  maxPositions: '10',
  riskPerTradePct: '5',
  maxPositionPct: '20',
  dailyDrawdownHaltPct: '5',
  brainWeights: JSON.stringify(DEFAULT_WEIGHTS),
  brainAccuracy: '',
  brainHistory: '[]',
  brainTrainedAt: '',
  fearGreed: '',
  globalMetrics: '',
  signalThreshold: '60',
  watchThreshold: '40',
  // bookkeeping
  selftestLastDate: '',
  pruneLastDate: '',
  cmcCallsToday: '0',
  cmcCallsDay: '',
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

export async function ensureDefaults(): Promise<void> {
  const rows = await db.setting.findMany()
  const have = new Set(rows.map((r) => r.key))
  const missing = Object.entries(DEFAULT_SETTINGS).filter(([k]) => !have.has(k))
  if (missing.length) {
    await db.setting.createMany({ data: missing.map(([key, value]) => ({ key, value })) })
  }
}

export async function getMode(): Promise<'paper' | 'live'> {
  const envMode = (process.env.TRADING_MODE ?? 'paper').toLowerCase()
  if (envMode === 'live') {
    const s = await getSetting('mode')
    return s === 'live' ? 'live' : 'paper'
  }
  return 'paper'
}

export async function getBrainWeights(): Promise<Record<FeatureKey, number>> {
  const raw = await getSetting('brainWeights')
  if (!raw) return { ...DEFAULT_WEIGHTS }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<FeatureKey, number>>
    const out = { ...DEFAULT_WEIGHTS }
    for (const k of FEATURE_KEYS) {
      if (typeof parsed[k] === 'number' && Number.isFinite(parsed[k] as number)) {
        out[k] = Math.max(0, Math.min(40, parsed[k] as number))
      }
    }
    return out
  } catch {
    return { ...DEFAULT_WEIGHTS }
  }
}

export async function getRiskConfig() {
  const [equity, maxPositions, riskPerTradePct, maxPositionPct, dailyDrawdownHaltPct] = await Promise.all([
    getSetting('equity').then((v) => Number(v ?? 10000)),
    getSetting('maxPositions').then((v) => Number(v ?? 10)),
    getSetting('riskPerTradePct').then((v) => Number(v ?? 5)),
    getSetting('maxPositionPct').then((v) => Number(v ?? 20)),
    getSetting('dailyDrawdownHaltPct').then((v) => Number(v ?? 5)),
  ])
  return { equity, maxPositions, riskPerTradePct, maxPositionPct, dailyDrawdownHaltPct }
}
