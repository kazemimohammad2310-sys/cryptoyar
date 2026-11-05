import { db } from '@/lib/db'

// ─── Typed settings store (Setting table) with defaults from §3 ───

export type FeatureKey = 'rsi' | 'trend' | 'macd' | 'volume' | 'funding' | 'oi' | 'stretch' | 'btc' | 'mtf'
export const FEATURE_KEYS: FeatureKey[] = ['rsi', 'trend', 'macd', 'volume', 'funding', 'oi', 'stretch', 'btc', 'mtf']

export const DEFAULT_WEIGHTS: Record<FeatureKey, number> = {
  rsi: 20,
  trend: 20,
  macd: 12,
  volume: 10,
  funding: 12,
  oi: 6,
  stretch: 8,
  btc: 12,
  mtf: 14, // Brain v2: 4h multi-timeframe trend confirmation
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
  // auto-trader bot (paper)
  botEnabled: 'on',
  botMinScore: '65',
  botMaxOpen: '6',
  botCooldownHours: '6',
  // futures (paper) — اهرم متناسب و قابل تنظیم (الان: ثابت ×۲۰ به درخواست کاربر)
  futuresLeverageMode: 'fixed', // auto = اهرم متناسب با ریسک/بنیاد | fixed = ثابت
  futuresMaxLeverage: '20', // سقف مطلق اهرم
  futuresFixedLeverage: '20', // اهرم ثابت وقتی حالت fixed است
  botExpertGate: 'on', // دروازهٔ استادی: فیلترهای حرفه‌ای پیش از ورود
  // bookkeeping
  selftestLastDate: '',
  pruneLastDate: '',
  cmcCallsToday: '0',
  cmcCallsDay: '',
  // Brain v2: per-strategy trust multipliers + historical backfill gates
  strategyTrust: '{}',
  brainBackfillDone: '',
  backfillLastDate: '',
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

/** Brain v2: per-strategy trust multipliers (1 = neutral). Missing/invalid strategy → 1. */
export async function getStrategyTrust(): Promise<Record<string, number>> {
  const raw = await getSetting('strategyTrust')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0.5 && v < 2) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export async function getBotConfig() {
  const [enabled, minScore, maxOpen, cooldownHours] = await Promise.all([
    getSetting('botEnabled').then((v) => (v === 'off' ? 'off' : 'on')),
    getSetting('botMinScore').then((v) => {
      const n = Number(v ?? 65)
      return Number.isFinite(n) ? Math.min(95, Math.max(40, n)) : 65
    }),
    getSetting('botMaxOpen').then((v) => {
      const n = Number(v ?? 6)
      return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.round(n))) : 6
    }),
    getSetting('botCooldownHours').then((v) => {
      const n = Number(v ?? 6)
      return Number.isFinite(n) ? Math.min(72, Math.max(0, n)) : 6
    }),
  ])
  return { enabled, minScore, maxOpen, cooldownHours } as const
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

/** فیوچرز (paper): پیکربندی اهرم — قابل تنظیم از تب تنظیمات (توکن مدیریت) */
export async function getFuturesConfig() {
  const [mode, maxLev, fixedLev, expertGate] = await Promise.all([
    getSetting('futuresLeverageMode').then((v) => (v === 'fixed' ? 'fixed' : 'auto')),
    getSetting('futuresMaxLeverage').then((v) => {
      const n = Number(v ?? 10)
      return Number.isFinite(n) ? Math.min(25, Math.max(1, Math.round(n))) : 10
    }),
    getSetting('futuresFixedLeverage').then((v) => {
      const n = Number(v ?? 3)
      return Number.isFinite(n) ? Math.min(25, Math.max(1, Math.round(n))) : 3
    }),
    getSetting('botExpertGate').then((v) => (v === 'off' ? 'off' : 'on')),
  ])
  return { mode, maxLev, fixedLev: Math.min(fixedLev, maxLev), expertGate } as const
}
