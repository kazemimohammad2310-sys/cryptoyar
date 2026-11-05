import { db } from '@/lib/db'
import { getBrainWeights } from '@/lib/settings'
import { loadCandlesRange } from '@/lib/candles'
import { computeFeatures, scoreFeatures, firstTouchScan, outcomeOf, type FeatureVector } from '@/lib/brain'
import { checkMomentumBreakout, checkMeanReversion, checkTrendFollowing, atrStop } from '@/lib/radar'
import type { CandleRow } from '@/lib/fetchers/binance'
import { faNum } from '@/lib/fa'

// ─── Brain v2: historical backfill (بازپرگیری مغز از تاریخچه) ───
// Replays the stored candles through the SAME feature + strategy pipeline the
// live radar uses, creating ALREADY-EVALUATED brain samples from history.
// This is the warm-start: the learning loop begins with hundreds of real
// historical outcomes instead of waiting days for live samples to mature.
//
// Honest limits: historical funding/OI is not stored per-bar, so backfilled
// samples carry funding=0 / oi=0 — those two features simply don't vote from
// backfill data (they keep learning from live samples only).

const ANCHOR_STEP_MS = 8 * 3600_000 // one anchor every 8h
const MAX_ROWS = 6000 // hard cap per run
const MIN_1H_BARS = 170 // same floor as radar's momentum check
const MIN_15M_BARS = 96 // ≥ 24h of 15m bars
const DEEP_WINDOW_MS = 10 * 24 * 3600_000
const INCREMENTAL_WINDOW_MS = 48 * 3600_000

interface DraftRow {
  symbol: string
  strategy: string
  side: string
  entryPrice: number
  stopLoss: number
  takeProfit: number
  featuresJson: string
  horizonHours: number
  predicted: string
  outcome: string | null
  pnlPct: number | null
  ftOutcome: string | null
  ftPnlPct: number | null
  createdAt: Date
  evaluatedAt: Date | null
  source: string
}

/** BTC 24h return (%) as of a historical timestamp (market beta feature). */
function btcRetAt(btc: CandleRow[], ts: number): number {
  let nowBar: CandleRow | null = null
  let pastBar: CandleRow | null = null
  for (const b of btc) {
    if (b.ts <= ts) nowBar = b
    if (b.ts <= ts - 24 * 3600_000) pastBar = b
    if (b.ts > ts) break
  }
  if (nowBar && pastBar && pastBar.close > 0) return (nowBar.close / pastBar.close - 1) * 100
  return 0
}

function featsJson(f: FeatureVector): string {
  return JSON.stringify({
    rsi: f.rsi,
    trend: f.trend,
    macd: f.macd,
    volume: f.volume,
    funding: f.funding,
    oi: f.oi,
    stretch: f.stretch,
    btc: f.btc,
    mtf: f.mtf,
  })
}

/**
 * Backfill brain samples from stored candle history.
 *  - deep: replay the whole available window (first activation / warm start)
 *  - incremental: only the last 48h (daily top-up)
 * Fully-covered horizons are evaluated inline; horizons that end in the future
 * are inserted as pending for the normal evaluator.
 */
export async function backfillBrain(opts: { deep: boolean }): Promise<string> {
  const now = Date.now()
  const windowMs = opts.deep ? DEEP_WINDOW_MS : INCREMENTAL_WINDOW_MS
  const from = now - windowMs

  // dedupe: keys of backfill samples already created near/in the window
  const existing = await db.brainSample.findMany({
    where: { source: 'backfill', createdAt: { gte: new Date(from - ANCHOR_STEP_MS) } },
    select: { symbol: true, strategy: true, createdAt: true },
  })
  const seen = new Set(
    existing.map((r) => `${r.symbol}|${r.strategy}|${Math.floor(r.createdAt.getTime() / ANCHOR_STEP_MS)}`),
  )

  const symbols = await db.coin.findMany({ select: { symbol: true }, orderBy: { rank: 'asc' }, take: 80 })
  const weights = await getBrainWeights()

  // BTC reference series for the market-beta feature
  let btc1h: CandleRow[] = []
  try {
    btc1h = await loadCandlesRange('BTCUSDT', '1h', from - 48 * 3600_000, now)
  } catch {
    /* beta = 0 */
  }

  const drafts: DraftRow[] = []
  let symbolsUsed = 0

  for (const { symbol } of symbols) {
    if (drafts.length >= MAX_ROWS) break
    const c1h = await loadCandlesRange(symbol, '1h', from - 200 * 3600_000, now)
    if (c1h.length < MIN_1H_BARS) continue
    const c15 = await loadCandlesRange(symbol, '15m', from - 2 * 3600_000, now)
    if (c15.length < MIN_15M_BARS) continue
    const max15 = c15[c15.length - 1].ts
    symbolsUsed++

    for (let anchor = Math.ceil(from / ANCHOR_STEP_MS) * ANCHOR_STEP_MS; anchor < now; anchor += ANCHOR_STEP_MS) {
      if (drafts.length >= MAX_ROWS) break
      const window1h = c1h.filter((b) => b.ts <= anchor)
      if (window1h.length < MIN_1H_BARS) continue
      const entry = window1h[window1h.length - 1].close
      if (!(entry > 0)) continue

      const features = computeFeatures({
        candles1h: window1h,
        fundingRaw: null,
        oiNow: null,
        oi24hAgo: null,
        btcRet24h: btcRetAt(btc1h, anchor),
      })
      if (!features) continue
      const { score } = scoreFeatures(features, weights)

      // same strategy checks + momentum coherence as the live radar
      const cands: { side: 'long' | 'short'; strategy: string }[] = []
      const mb = checkMomentumBreakout(window1h)
      if (mb && score >= 0) cands.push({ side: mb, strategy: 'momentum_breakout' })
      const mr = checkMeanReversion(window1h)
      if (mr) cands.push({ side: mr, strategy: 'mean_reversion' })
      const tf = checkTrendFollowing(window1h)
      if (tf && ((tf === 'long' && score >= 0) || (tf === 'short' && score <= 0))) {
        cands.push({ side: tf, strategy: 'trend_following' })
      }
      if (!cands.length) continue

      const json = featsJson(features)
      for (const cand of cands) {
        const key = `${symbol}|${cand.strategy}|${Math.floor(anchor / ANCHOR_STEP_MS)}`
        if (seen.has(key)) continue
        seen.add(key)
        const { stop, target } = atrStop(entry, features.atrPct, cand.side)
        for (const h of [24, 72]) {
          if (drafts.length >= MAX_ROWS) break
          const dueTs = anchor + h * 3600_000
          const base = {
            symbol,
            strategy: cand.strategy,
            side: cand.side,
            entryPrice: entry,
            stopLoss: stop,
            takeProfit: target,
            featuresJson: json,
            horizonHours: h,
            predicted: cand.side === 'long' ? 'up' : 'down',
            createdAt: new Date(anchor),
            source: 'backfill',
          }
          if (dueTs <= now && dueTs <= max15) {
            // fully covered by stored 15m data → evaluate inline NOW
            const path = c15.filter((b) => b.ts > anchor && b.ts <= dueTs)
            if (!path.length) continue
            const { ft, ftPnl } = firstTouchScan(cand.side, entry, stop, target, path)
            const endPrice = path[path.length - 1].close
            const rawPnl = ((cand.side === 'long' ? endPrice - entry : entry - endPrice) / entry) * 100
            drafts.push({
              ...base,
              outcome: outcomeOf(ftPnl ?? rawPnl),
              pnlPct: ftPnl ?? rawPnl,
              ftOutcome: ft,
              ftPnlPct: ftPnl,
              evaluatedAt: new Date(),
            })
          } else if (dueTs > now) {
            // future horizon → normal evaluator handles it when due
            drafts.push({ ...base, outcome: null, pnlPct: null, ftOutcome: null, ftPnlPct: null, evaluatedAt: null })
          }
          // dueTs <= now but beyond stored 15m depth → skip (partial path = biased data)
        }
      }
    }
  }

  // chunked insert
  let inserted = 0
  for (let i = 0; i < drafts.length; i += 400) {
    const chunk = drafts.slice(i, i + 400)
    await db.brainSample.createMany({ data: chunk })
    inserted += chunk.length
  }

  return `بازپرگیری مغز: ${faNum(inserted, 0)} نمونهٔ تاریخی از ${faNum(symbolsUsed, 0)} نماد (${opts.deep ? 'گرم‌سازی کامل' : 'تکمیلی روزانه'})`
}
