// ─── Technical indicators (pure functions, ascending candle arrays) ───

export interface CandleRow {
  ts: number // ms epoch
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]
  return sum / period
}

export function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return []
  const k = 2 / (period + 1)
  const out: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k))
  return out
}

export function ema(values: number[], period: number): number {
  const s = emaSeries(values, period)
  return s[s.length - 1] ?? NaN
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN
  let gain = 0
  let loss = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  const avgG = gain / period
  const avgL = loss / period
  if (avgL === 0) return avgG === 0 ? 50 : 100
  const rs = avgG / avgL
  return 100 - 100 / (1 + rs)
}

export interface MacdResult {
  macd: number
  signal: number
  hist: number
}

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MacdResult {
  if (closes.length < slow + sig) return { macd: NaN, signal: NaN, hist: NaN }
  const f = emaSeries(closes, fast)
  const s = emaSeries(closes, slow)
  const line: number[] = []
  for (let i = 0; i < closes.length; i++) line.push(f[i] - s[i])
  const sigSeries = emaSeries(line.slice(slow - 1), sig)
  const macdVal = line[line.length - 1]
  const signalVal = sigSeries[sigSeries.length - 1]
  return { macd: macdVal, signal: signalVal, hist: macdVal - signalVal }
}

export function atr(candles: CandleRow[], period = 14): number {
  if (candles.length < period + 1) return NaN
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    sum += tr
  }
  return sum / period
}

/** volume z-score over last `period` bars (excluding current bar optional). */
export function volumeZ(candles: CandleRow[], period = 20): number {
  if (candles.length < period + 1) return NaN
  const vols = candles.slice(-period - 1, -1).map((c) => c.volume)
  const last = candles[candles.length - 1].volume
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length
  const sd = Math.sqrt(vols.reduce((a, b) => a + (b - mean) ** 2, 0) / vols.length)
  if (sd === 0) return 0
  return (last - mean) / sd
}

/** percent slope of a series over `lookback` bars (per-bar %). */
export function slopePct(series: number[], lookback = 5): number {
  if (series.length < lookback + 1) return NaN
  const a = series[series.length - 1 - lookback]
  const b = series[series.length - 1]
  if (!a || Number.isNaN(a)) return NaN
  return ((b - a) / a) * 100
}

export const lastClose = (candles: CandleRow[]): number => candles[candles.length - 1]?.close ?? NaN
