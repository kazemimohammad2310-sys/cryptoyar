import { db } from '@/lib/db'
import { getSetting, getBrainWeights, getStrategyTrust } from '@/lib/settings'
import { assertUniverse } from '@/lib/universe'
import { loadCandles, type Interval } from '@/lib/candles'
import { getFundingRate, getOpenInterest, type CandleRow } from '@/lib/fetchers/binance'
import {
  computeFeatures,
  scoreFeatures,
  buildReasonFa,
  buildReasonBodyFa,
  recordSamples,
  SCORE_THRESHOLD,
  WATCH_THRESHOLD,
  STRATEGY_FA,
  type FeatureVector,
  type ScoreResult,
} from '@/lib/brain'
import { faNum } from '@/lib/fa'

// ─── Radar: scan universe, emit ranked opportunity cards (§5) ───
// Correction applied: response includes a calibrated «زیر آستانه» watch list so
// the ±60 threshold never leaves the radar silently empty.

export type StrategyId = 'momentum_breakout' | 'mean_reversion' | 'trend_following' | 'funding_anomaly'

/** Momentum-aligned strategies must not fire against the brain's score sign. */
const MOMENTUM_ALIGNED: Set<StrategyId> = new Set(['momentum_breakout', 'trend_following'])

/** Honest Persian reason per strategy trigger (contrarian strategies get contrarian wording). */
function strategyReasonFa(
  strategy: StrategyId,
  side: 'long' | 'short',
  f: FeatureVector,
  score: number,
  top: ScoreResult['contributions'],
): string {
  const s = faNum(Math.round(score))
  let trigger: string
  if (strategy === 'momentum_breakout') {
    trigger = `شکست مومنتوم — شکست سقف ۷روزه با حجم ${faNum(Math.abs(f.volZ), 1)} انحراف معیار بالاتر از میانگین`
  } else if (strategy === 'mean_reversion') {
    trigger =
      side === 'long'
        ? `بازگشت به میانگین — RSI ${faNum(f.rsiRaw, 0)} در اشباع فروش با حفظ حمایت — خرید خلاف‌روند`
        : `بازگشت به میانگین — RSI ${faNum(f.rsiRaw, 0)} در اشباع خرید با کندل نزولی و سایهٔ بالایی — فروش خلاف‌روند`
  } else if (strategy === 'trend_following') {
    trigger = `روندیابی — تقاطع EMA20/EMA50 در ۵ کندل اخیر با تأیید شیب — ورود ${side === 'long' ? 'خرید' : 'فروش'}`
  } else {
    const fr = f.fundingRaw
    trigger = `ناهنجاری فاندینگ — فاندینگ ${fr === null ? 'نامشخص' : `${faNum(fr * 100, 3)}٪ ${fr >= 0 ? 'مثبت' : 'منفی'}`} — معامله خلاف جهت ازدحام (${side === 'long' ? 'خرید' : 'فروش'})`
  }
  return `${trigger} (امتیاز ${s}) — ${buildReasonBodyFa(f, top)}`
}

export interface RadarCandidate {
  symbol: string
  side: 'long' | 'short'
  score: number
  strategy: StrategyId
  entry: number
  stop: number
  target: number
  features: FeatureVector
  reasonFa: string
  contributions: ScoreResult['contributions']
}

export interface RadarResult {
  signals: RadarCandidate[]
  watch: RadarCandidate[]
  scanned: number
  errors: { symbol: string; error: string }[]
}

function atrStop(entry: number, atrPct: number, side: 'long' | 'short'): { stop: number; target: number } {
  const dist = Math.max(entry * (Math.max(atrPct, 0.4) / 100) * 1.5, entry * 0.004) // min 0.4% distance
  if (side === 'long') return { stop: entry - dist, target: entry + dist * 1.5 }
  return { stop: entry + dist, target: entry - dist * 1.5 }
}
export { atrStop }

// strategy conditions on 1h candles (§5 Phase-1 strategies)
// (exported for the brain's historical backfill — backfill.ts replays these
// exact checks on stored candles to warm-start the learning loop)
export function checkMomentumBreakout(c: CandleRow[]): 'long' | null {
  if (c.length < 170) return null
  const prev = c.slice(-169, -1)
  const high7d = Math.max(...prev.map((x) => x.high))
  const last = c[c.length - 1]
  const volZ = recentVolZ(c)
  return last.close > high7d * 0.99 && volZ > 1.5 ? 'long' : null
}

export function checkMeanReversion(c: CandleRow[]): 'long' | 'short' | null {
  if (c.length < 40) return null
  const closes = c.map((x) => x.close)
  const last = c[c.length - 1]
  const { rsiOf } = rsiCache(closes)
  const lows = c.slice(-20, -1).map((x) => x.low)
  const support = Math.min(...lows)
  const body = Math.abs(last.close - last.open)
  const upperWick = last.high - Math.max(last.open, last.close)
  if (rsiOf < 30 && last.close > support * 1.002) return 'long'
  if (rsiOf > 70 && last.close < last.open && upperWick > body * 1.5) return 'short'
  return null
}

export function checkTrendFollowing(c: CandleRow[]): 'long' | 'short' | null {
  if (c.length < 60) return null
  const closes = c.map((x) => x.close)
  const k = 2 / 21
  const k50 = 2 / 51
  const e20: number[] = [closes[0]]
  const e50: number[] = [closes[0]]
  for (let i = 1; i < closes.length; i++) {
    e20.push(closes[i] * k + e20[i - 1] * (1 - k))
    e50.push(closes[i] * k50 + e50[i - 1] * (1 - k50))
  }
  const n = closes.length - 1
  let crossUp = false
  let crossDown = false
  for (let i = Math.max(1, n - 5); i <= n; i++) {
    if (e20[i - 1] <= e50[i - 1] && e20[i] > e50[i]) crossUp = true
    if (e20[i - 1] >= e50[i - 1] && e20[i] < e50[i]) crossDown = true
  }
  const slope = e20[n] - e20[Math.max(0, n - 5)]
  if (crossUp && slope > 0) return 'long'
  if (crossDown && slope < 0) return 'short'
  return null
}

export function checkFundingAnomaly(funding: number | null): 'long' | 'short' | null {
  if (funding === null) return null
  if (funding > 0.001) return 'short' // crowd too long → fade
  if (funding < -0.001) return 'long' // crowd too short → fade
  return null
}

function recentVolZ(c: CandleRow[]): number {
  if (c.length < 22) return 0
  const vols = c.slice(-21, -1).map((x) => x.volume)
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length
  const sd = Math.sqrt(vols.reduce((a, b) => a + (b - mean) ** 2, 0) / vols.length)
  if (sd === 0) return 0
  return (c[c.length - 1].volume - mean) / sd
}

function rsiOfCloses(closes: number[]): number {
  if (closes.length < 15) return 50
  let gain = 0
  let loss = 0
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  const avgL = loss / 14
  if (avgL === 0) return 100
  return 100 - 100 / (1 + gain / 14 / avgL)
}

function rsiCache(closes: number[]): { rsiOf: number } {
  return { rsiOf: rsiOfCloses(closes) }
}

export async function scanRadar(): Promise<RadarResult> {
  const symbols = await assertUniverse()
  const weights = await getBrainWeights()
  // Brain v2: per-strategy trust multipliers (learned from real outcomes)
  const trust = await getStrategyTrust()
  const signals: RadarCandidate[] = []
  const watch: RadarCandidate[] = []
  const errors: { symbol: string; error: string }[] = []

  // BTC 24h return for market beta
  let btcRet = 0
  try {
    const btc = await loadCandles('BTCUSDT', '1h', 26)
    if (btc.length > 25) btcRet = (btc[btc.length - 1].close / btc[btc.length - 25].close - 1) * 1
  } catch {
    /* beta = 0 */
  }

  for (const symbol of symbols) {
    try {
      const c = await loadCandles(symbol, '1h', 300)
      if (c.length < 60) continue
      const [fundingRow, oiNow] = await Promise.all([getFundingRate(symbol), getOpenInterest(symbol)])
      const oi24hAgo = oiNow === null ? null : await db.fundingSnapshot.findFirst({
        where: { symbol, ts: { lte: new Date(Date.now() - 23 * 3600_000) } },
        orderBy: { ts: 'desc' },
        select: { openInterest: true },
      })

      const features = computeFeatures({
        candles1h: c,
        fundingRaw: fundingRow?.fundingRate ?? null,
        oiNow,
        oi24hAgo: oi24hAgo?.openInterest ?? null,
        btcRet24h: btcRet * 100,
      })
      if (!features) continue

      const entry = c[c.length - 1].close
      const { score, contributions } = scoreFeatures(features, weights)
      const candidates: { side: 'long' | 'short'; strategy: StrategyId }[] = []

      const mb = checkMomentumBreakout(c)
      if (mb) candidates.push({ side: mb, strategy: 'momentum_breakout' })
      const mr = checkMeanReversion(c)
      if (mr) candidates.push({ side: mr, strategy: 'mean_reversion' })
      const tf = checkTrendFollowing(c)
      if (tf) candidates.push({ side: tf, strategy: 'trend_following' })
      const fa = checkFundingAnomaly(fundingRow?.fundingRate ?? null)
      if (fa) candidates.push({ side: fa, strategy: 'funding_anomaly' })

      for (const cand of candidates) {
        // coherence: momentum strategies must agree with the brain's direction
        if (MOMENTUM_ALIGNED.has(cand.strategy)) {
          if (cand.side === 'long' && score < 0) continue
          if (cand.side === 'short' && score > 0) continue
        }
        // Brain v2: calibrated score = raw score × strategy trust
        const calibrated = score * (trust[cand.strategy] ?? 1)
        const { stop, target } = atrStop(entry, features.atrPct, cand.side)
        const reasonFa = strategyReasonFa(cand.strategy, cand.side, features, calibrated, contributions)
        const card: RadarCandidate = {
          symbol,
          side: cand.side,
          score: calibrated,
          strategy: cand.strategy,
          entry,
          stop,
          target,
          features,
          reasonFa,
          contributions,
        }
        if (Math.abs(calibrated) >= SCORE_THRESHOLD) signals.push(card)
        else if (Math.abs(calibrated) >= WATCH_THRESHOLD) watch.push(card)
      }
    } catch (e) {
      errors.push({ symbol, error: e instanceof Error ? e.message : String(e) })
    }
  }

  signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
  watch.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
  return { signals, watch: watch.slice(0, 12), scanned: symbols.length, errors: errors.slice(0, 5) }
}

/** Persist new signals + watch cards (dedup per bucket, symbol+strategy within 3h) + brain samples. */
export async function persistRadarResult(result: RadarResult): Promise<number> {
  let created = 0
  const cutoff = new Date(Date.now() - 3 * 3600_000)

  async function persistBucket(cards: RadarCandidate[], status: 'open' | 'watch'): Promise<void> {
    for (const s of cards) {
      const dup = await db.signal.findFirst({
        where: { symbol: s.symbol, strategy: s.strategy, status, createdAt: { gte: cutoff } },
        select: { id: true },
      })
      if (dup) continue
      await db.signal.create({
        data: {
          symbol: s.symbol,
          side: s.side,
          score: s.score,
          strategy: s.strategy,
          entryPrice: s.entry,
          stopLoss: s.stop,
          takeProfit: s.target,
          status,
          featuresJson: JSON.stringify({
            rsi: s.features.rsi,
            trend: s.features.trend,
            macd: s.features.macd,
            volume: s.features.volume,
            funding: s.features.funding,
            oi: s.features.oi,
            stretch: s.features.stretch,
            btc: s.features.btc,
            mtf: s.features.mtf,
            rsiRaw: s.features.rsiRaw,
            volZ: s.features.volZ,
            atrPct: s.features.atrPct,
          }),
          reasonFa: s.reasonFa,
        },
      })
      // brain samples only for actionable signals (score ≥ 60)
      if (status === 'open') {
        await recordSamples({
          symbol: s.symbol,
          strategy: s.strategy,
          side: s.side,
          entryPrice: s.entry,
          stopLoss: s.stop,
          takeProfit: s.target,
          features: s.features,
        })
      }
      created++
    }
  }

  await persistBucket(result.signals, 'open')
  await persistBucket(result.watch, 'watch') // v1.1: below-threshold list is persisted so the DB fast path can serve it

  // expire stale open/watch signals (>12h)
  await db.signal.updateMany({
    where: { status: { in: ['open', 'watch'] }, createdAt: { lt: new Date(Date.now() - 12 * 3600_000) } },
    data: { status: 'expired' },
  })
  return created
}

export { STRATEGY_FA, SCORE_THRESHOLD, WATCH_THRESHOLD }
