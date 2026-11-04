import { db } from '@/lib/db'
import { getBrainWeights, getSetting, setSetting, FEATURE_KEYS, type FeatureKey } from '@/lib/settings'
import { rsi, macd, emaSeries, atr, volumeZ, slopePct, lastClose } from '@/lib/indicators'
import { loadCandles, type Interval } from '@/lib/candles'
import type { CandleRow } from '@/lib/fetchers/binance'

// ─── Brain v1: explainable scoring engine + online learning loop (§4) ───
// Corrections applied: (a) samples are evaluated with FIRST-TOUCH SL/TP logic
// (matching real fund behaviour), (b) weights adjust only after ≥50 evaluated
// samples (cold-start guard against noise-fitting).

export const MIN_SAMPLES_FOR_TRAINING = 50
export const SCORE_THRESHOLD = 60
export const WATCH_THRESHOLD = 40

export interface FeatureVector {
  rsi: number // raw RSI(14) on 1h
  trend: number // composite trend feature in [-1,1]
  macd: number // in [-1,1]
  volume: number // in [-1,1]
  funding: number // in [-1,1] (fades the crowd)
  oi: number // in [-1,1] (0 = unavailable)
  stretch: number // in [-1,1] overbought/oversold stretch penalty
  btc: number // in [-1,1] market beta
  // raw values for display
  rsiRaw: number
  atrPct: number
  volZ: number
  ema20: number
  ema50: number
  distHigh7dPct: number
  distLow7dPct: number
  fundingRaw: number | null
  oiChangePct: number | null
  btcRet24h: number
}

export interface ScoreResult {
  score: number // -100..+100
  contributions: { key: FeatureKey; fa: string; value: number; weight: number; contribution: number }[]
}

const tanh = Math.tanh

export interface FeatureInput {
  candles1h: CandleRow[]
  fundingRaw: number | null
  oiNow: number | null
  oi24hAgo: number | null
  btcRet24h: number
}

export function computeFeatures(input: FeatureInput): FeatureVector | null {
  const c = input.candles1h
  if (c.length < 60) return null
  const closes = c.map((x) => x.close)
  const price = lastClose(c)
  if (!Number.isFinite(price) || price <= 0) return null

  const rsiRaw = rsi(closes, 14)
  const m = macd(closes)
  const e20s = emaSeries(closes, 20)
  const e50s = emaSeries(closes, 50)
  const ema20 = e20s[e20s.length - 1]
  const ema50 = e50s[e50s.length - 1]
  const slope20 = slopePct(e20s, 5)
  const vZ = volumeZ(c, 20)
  const a = atr(c, 14)
  const atrPct = (a / price) * 100
  const lastRet = closes.length > 1 ? closes[closes.length - 1] / closes[closes.length - 2] - 1 : 0

  const window = c.slice(-168)
  const high7d = Math.max(...window.map((x) => x.high))
  const low7d = Math.min(...window.map((x) => x.low))
  const distHighPct = ((price - high7d) / high7d) * 100 // ≤ 0
  const distLowPct = ((price - low7d) / low7d) * 100 // ≥ 0

  const funding = input.fundingRaw
  const oiChangePct =
    input.oiNow && input.oi24hAgo && input.oi24hAgo > 0 ? ((input.oiNow - input.oi24hAgo) / input.oi24hAgo) * 100 : null

  // normalized features ∈ [-1, 1]
  const fRsi = tanh((rsiRaw - 50) / 18)
  const fTrend = tanh(((ema20 - ema50) / ema50) * 120 + slope20 * 15)
  const fMacd = Number.isFinite(m.hist) ? tanh((m.hist / price) * 400) : 0
  const fVol = tanh(vZ / 2) * Math.sign(lastRet || 1)
  const fFunding = funding === null ? 0 : -tanh(funding / 0.0008)
  const fOi = oiChangePct === null ? 0 : Math.sign(lastRet || 1) * tanh(oiChangePct / 15)
  const fStretch =
    rsiRaw > 75 && distHighPct > -1 ? -0.6 : rsiRaw < 25 && distLowPct < 1 ? 0.6 : 0
  // btcRet24h arrives as PERCENT (radar.ts multiplies the fraction ×100).
  // Scale 2.5% → tanh(1) ≈ 0.76: a typical BTC day maps to a strong-but-not-binary beta.
  const fBtc = tanh(input.btcRet24h / 2.5)

  return {
    rsi: fRsi,
    trend: fTrend,
    macd: fMacd,
    volume: fVol,
    funding: fFunding,
    oi: fOi,
    stretch: fStretch,
    btc: fBtc,
    rsiRaw,
    atrPct,
    volZ: vZ,
    ema20,
    ema50,
    distHigh7dPct: distHighPct,
    distLow7dPct: distLowPct,
    fundingRaw: funding,
    oiChangePct,
    btcRet24h: input.btcRet24h,
  }
}

const FEATURE_FA: Record<FeatureKey, string> = {
  rsi: 'RSI',
  trend: 'روند',
  macd: 'MACD',
  volume: 'حجم',
  funding: 'فاندینگ',
  oi: 'قراردادهای باز',
  stretch: 'اشباع',
  btc: 'بیت‌کوین',
}

export function scoreFeatures(f: FeatureVector, weights: Record<FeatureKey, number>): ScoreResult {
  const vals: Record<FeatureKey, number> = {
    rsi: f.rsi,
    trend: f.trend,
    macd: f.macd,
    volume: f.volume,
    funding: f.funding,
    oi: f.oi,
    stretch: f.stretch,
    btc: f.btc,
  }
  let num = 0
  let den = 0
  const contributions: ScoreResult['contributions'] = []
  for (const k of FEATURE_KEYS) {
    const w = weights[k] ?? 0
    if (w <= 0) continue
    num += w * vals[k]
    den += w
    contributions.push({ key: k, fa: FEATURE_FA[k], value: vals[k], weight: w, contribution: w * vals[k] })
  }
  const score = den > 0 ? Math.max(-100, Math.min(100, (num / den) * 100)) : 0
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return { score, contributions }
}

/**
 * Rebuild the per-feature contribution list from stored featuresJson + current
 * weights — used by /api/radar when serving persisted signals from the DB
 * fast path (contributions are not stored, they are derived).
 */
export function recomputeContributions(
  f: Partial<Record<FeatureKey, number>>,
  weights: Record<FeatureKey, number>,
): ScoreResult['contributions'] {
  const out: ScoreResult['contributions'] = []
  for (const k of FEATURE_KEYS) {
    const w = weights[k] ?? 0
    const v = f[k]
    if (w <= 0 || typeof v !== 'number' || !Number.isFinite(v)) continue
    out.push({ key: k, fa: FEATURE_FA[k], value: v, weight: w, contribution: w * v })
  }
  out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return out
}

const faNum = (n: number, d = 1) =>
  new Intl.NumberFormat('fa-IR', { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n)

/** Body of the Persian reason (feature sentences without the momentum head). */
export function buildReasonBodyFa(f: FeatureVector, top: ScoreResult['contributions']): string {
  const parts: string[] = []
  for (const c of top.slice(0, 3)) {
    if (Math.abs(c.contribution) < 1) continue
    if (c.key === 'rsi') parts.push(`RSI ${faNum(f.rsiRaw, 0)} (${f.rsiRaw > 55 ? 'مومنتوم صعودی' : f.rsiRaw < 45 ? 'فشار نزولی' : 'خنثی'})`)
    else if (c.key === 'trend') parts.push(`${f.ema20 > f.ema50 ? 'EMA20 بالای EMA50' : 'EMA20 زیر EMA50'} — روند ${f.trend > 0 ? 'صعودی' : 'نزولی'}`)
    else if (c.key === 'volume') parts.push(`حجم ${faNum(Math.abs(f.volZ), 1)} انحراف معیار ${f.volZ > 0 ? 'بالاتر' : 'پایین‌تر'} از میانگین`)
    else if (c.key === 'funding' && f.fundingRaw !== null) parts.push(`فاندینگ ${f.fundingRaw > 0 ? 'مثبت' : 'منفی'} (${faNum(f.fundingRaw * 100, 3)}٪)`)
    else if (c.key === 'macd') parts.push(`MACD ${f.macd > 0 ? 'مثبت' : 'منفی'}`)
    else if (c.key === 'oi' && f.oiChangePct !== null) parts.push(`قراردادهای باز ${faNum(f.oiChangePct, 1)}٪ ${f.oiChangePct > 0 ? 'رشد' : 'افت'}`)
    else if (c.key === 'btc') parts.push(`بازگشت ۲۴س بیت‌کوین ${faNum(f.btcRet24h, 1)}٪`)
    else if (c.key === 'stretch') parts.push(f.stretch < 0 ? 'اشباع خرید' : 'اشباع فروش')
  }
  return parts.length ? parts.join('، ') : 'سیگنال ترکیبی از میانگین ویژگی‌ها'
}

/** Human-readable Persian reason (explainability — §4). */
export function buildReasonFa(f: FeatureVector, score: number, side: 'long' | 'short', top: ScoreResult['contributions']): string {
  const dir = side === 'long' ? 'صعودی' : 'نزولی'
  const head = score >= 0 ? 'مومنتوم' : 'فشار فروش'
  return `${head} ${dir} (امتیاز ${faNum(Math.round(score))}) — ${buildReasonBodyFa(f, top)}`
}

// ─── Sample creation & evaluation ───

export async function recordSamples(params: {
  symbol: string
  strategy: string
  side: 'long' | 'short'
  entryPrice: number
  stopLoss: number
  takeProfit: number
  features: FeatureVector
}): Promise<void> {
  const base = {
    symbol: params.symbol,
    strategy: params.strategy,
    side: params.side,
    entryPrice: params.entryPrice,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    featuresJson: JSON.stringify({
      rsi: params.features.rsi,
      trend: params.features.trend,
      macd: params.features.macd,
      volume: params.features.volume,
      funding: params.features.funding,
      oi: params.features.oi,
      stretch: params.features.stretch,
      btc: params.features.btc,
    }),
    predicted: params.side === 'long' ? 'up' : 'down',
  }
  await db.brainSample.createMany({ data: [{ ...base, horizonHours: 24 }, { ...base, horizonHours: 72 }] })
}

export interface SampleEvalResult {
  evaluated: number
  tpHits: number
  slHits: number
  timeouts: number
}

/** Evaluate due samples with first-touch SL/TP (uses 15m candles) + raw move. */
export async function evaluateDueSamples(now = Date.now()): Promise<SampleEvalResult> {
  const due = await db.brainSample.findMany({
    where: { evaluatedAt: null, createdAt: { lt: new Date(now) } },
  })
  let evaluated = 0
  let tpHits = 0
  let slHits = 0
  let timeouts = 0

  // group by symbol to load candles once
  const bySymbol = new Map<string, typeof due>()
  for (const s of due) {
    const arr = bySymbol.get(s.symbol) ?? []
    arr.push(s)
    bySymbol.set(s.symbol, arr)
  }

  for (const [symbol, samples] of bySymbol) {
    const candles = await loadCandles(symbol, '15m', 700) // ~7 days
    if (candles.length < 2) continue
    for (const s of samples) {
      const dueTs = s.createdAt.getTime() + s.horizonHours * 3600_000
      if (dueTs > now) continue
      const path = candles.filter((c) => c.ts > s.createdAt.getTime() && c.ts <= dueTs)
      if (!path.length) continue

      const entry = s.entryPrice
      const sl = s.stopLoss
      const tp = s.takeProfit
      const endPrice = path[path.length - 1].close
      const rawPnl = ((s.side === 'long' ? endPrice - entry : entry - endPrice) / entry) * 100
      const outcome = rawPnl > 0.15 ? 'win' : rawPnl < -0.15 ? 'loss' : 'flat'

      // first-touch SL/TP (correction #3) — only when levels exist
      let ft: 'tp' | 'sl' | 'timeout' = 'timeout'
      let ftPnl: number | null = null
      if (sl !== null && tp !== null) {
        for (const bar of path) {
          if (s.side === 'long') {
            const hitSl = bar.low <= sl
            const hitTp = bar.high >= tp
            if (hitSl && hitTp) {
              ft = 'sl' // conservative: assume stop first when both in one bar
              ftPnl = ((sl - entry) / entry) * 100
              break
            }
            if (hitSl) {
              ft = 'sl'
              ftPnl = ((sl - entry) / entry) * 100
              break
            }
            if (hitTp) {
              ft = 'tp'
              ftPnl = ((tp - entry) / entry) * 100
              break
            }
          } else {
            const hitSl = bar.high >= sl
            const hitTp = bar.low <= tp
            if (hitSl && hitTp) {
              ft = 'sl'
              ftPnl = ((entry - sl) / entry) * 100
              break
            }
            if (hitSl) {
              ft = 'sl'
              ftPnl = ((entry - sl) / entry) * 100
              break
            }
            if (hitTp) {
              ft = 'tp'
              ftPnl = ((entry - tp) / entry) * 100
              break
            }
          }
        }
      }

      await db.brainSample.update({
        where: { id: s.id },
        data: {
          outcome,
          pnlPct: rawPnl,
          ftOutcome: ft,
          ftPnlPct: ftPnl,
          evaluatedAt: new Date(),
        },
      })
      evaluated++
      if (ft === 'tp') tpHits++
      else if (ft === 'sl') slHits++
      else timeouts++
    }
  }
  return { evaluated, tpHits, slHits, timeouts }
}

// ─── Training (per-feature bandit, gated by MIN_SAMPLES_FOR_TRAINING) ───

export async function trainBrain(): Promise<{ trained: boolean; detail: string; evaluatedCount: number }> {
  const evaluated = await db.brainSample.findMany({
    where: { evaluatedAt: { not: null } },
    select: { featuresJson: true, ftPnlPct: true, pnlPct: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  })
  if (evaluated.length < MIN_SAMPLES_FOR_TRAINING) {
    const detail = `در انتظار نمونهٔ کافی برای آموزش: ${faNum(evaluated.length, 0)}/${faNum(MIN_SAMPLES_FOR_TRAINING, 0)}`
    await setSetting('brainTrainedAt', JSON.stringify({ at: Date.now(), trained: false, detail }))
    return { trained: false, detail, evaluatedCount: evaluated.length }
  }
  const weights = await getBrainWeights()
  const hits: Record<FeatureKey, { agree: number; total: number }> = Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, { agree: 0, total: 0 }]),
  ) as Record<FeatureKey, { agree: number; total: number }>

  for (const s of evaluated) {
    const pnl = s.ftPnlPct ?? s.pnlPct ?? 0
    if (pnl === 0) continue
    try {
      const feats = JSON.parse(s.featuresJson) as Partial<Record<FeatureKey, number>>
      for (const k of FEATURE_KEYS) {
        const v = feats[k]
        if (typeof v !== 'number' || Math.abs(v) < 0.05) continue
        hits[k].total++
        if (Math.sign(v) === Math.sign(pnl)) hits[k].agree++
      }
    } catch {
      /* skip malformed */
    }
  }

  const changes: string[] = []
  for (const k of FEATURE_KEYS) {
    const h = hits[k]
    if (h.total < 20) continue
    const rate = h.agree / h.total
    const before = weights[k]
    if (rate > 0.55) weights[k] = Math.min(DEFAULT_MAX[k] ?? 40, before * 1.05)
    else if (rate < 0.45) weights[k] = Math.max(1, before * 0.96)
    if (Math.abs(weights[k] - before) > 0.001) {
      changes.push(`${FEATURE_FA[k]}: ${rate > 0.55 ? '↑' : '↓'} (نرخ ${faNum(rate * 100, 0)}٪)`)
    }
  }
  await setSetting('brainWeights', JSON.stringify(weights))
  const detail = changes.length ? `وزن‌ها تنظیم شد — ${changes.join('، ')}` : 'وزن‌ها بدون تغییر (سیگنال کافی نیست)'
  await setSetting('brainTrainedAt', JSON.stringify({ at: Date.now(), trained: true, detail }))
  return { trained: true, detail, evaluatedCount: evaluated.length }
}

const DEFAULT_MAX: Partial<Record<FeatureKey, number>> = {
  rsi: 32,
  trend: 32,
  macd: 20,
  volume: 16,
  funding: 20,
  oi: 10,
  stretch: 13,
  btc: 20,
}

// ─── Self-test: directional accuracy over the last 200 evaluated samples ───

export interface AccuracyRow {
  label: string
  total: number
  accuracy: number // 0..100
  avgPnlPct: number
  tpRate: number
  slRate: number
}

export interface SelfTestResult {
  at: number
  overall: AccuracyRow | null
  byHorizon: AccuracyRow[]
  byStrategy: AccuracyRow[]
  samplesUsed: number
}

export async function runSelfTest(): Promise<SelfTestResult> {
  const samples = await db.brainSample.findMany({
    where: { evaluatedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const agg = (rows: typeof samples, label: string): AccuracyRow | null => {
    if (!rows.length) return null
    const wins = rows.filter((r) => {
      const pnl = r.ftPnlPct ?? r.pnlPct ?? 0
      return pnl > 0
    }).length
    const pnlList = rows.map((r) => r.ftPnlPct ?? r.pnlPct ?? 0)
    const avg = pnlList.reduce((a, b) => a + b, 0) / pnlList.length
    return {
      label,
      total: rows.length,
      accuracy: (wins / rows.length) * 100,
      avgPnlPct: avg,
      tpRate: (rows.filter((r) => r.ftOutcome === 'tp').length / rows.length) * 100,
      slRate: (rows.filter((r) => r.ftOutcome === 'sl').length / rows.length) * 100,
    }
  }

  const byHorizon: AccuracyRow[] = []
  for (const h of [24, 72]) {
    const row = agg(samples.filter((s) => s.horizonHours === h), `${h} ساعت`)
    if (row) byHorizon.push(row)
  }
  const strategies = [...new Set(samples.map((s) => s.strategy).filter((x): x is string => !!x))]
  const byStrategy: AccuracyRow[] = []
  for (const st of strategies) {
    const row = agg(samples.filter((s) => s.strategy === st), STRATEGY_FA[st] ?? st)
    if (row) byStrategy.push(row)
  }
  const overall = agg(samples, 'کلی')
  const result: SelfTestResult = {
    at: Date.now(),
    overall,
    byHorizon,
    byStrategy,
    samplesUsed: samples.length,
  }
  await setSetting('brainAccuracy', JSON.stringify(result))
  // learning-curve history (capped 90 points)
  try {
    const hist = JSON.parse((await getSetting('brainHistory')) ?? '[]') as { at: number; accuracy: number; n: number }[]
    if (overall) {
      hist.push({ at: result.at, accuracy: overall.accuracy, n: overall.total })
      await setSetting('brainHistory', JSON.stringify(hist.slice(-90)))
    }
  } catch {
    /* ignore history errors */
  }
  return result
}

export const STRATEGY_FA: Record<string, string> = {
  momentum_breakout: 'شکست مومنتوم',
  mean_reversion: 'بازگشت به میانگین',
  trend_following: 'روندیابی',
  funding_anomaly: 'ناهنجاری فاندینگ',
}
