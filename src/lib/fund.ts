import { db } from '@/lib/db'
import { getRiskConfig } from '@/lib/settings'
import { loadCandles } from '@/lib/candles'
import { atr } from '@/lib/indicators'
import { STRATEGY_FA } from '@/lib/brain'

// ─── Paper Fund (§6/§7) — all risk rules enforced SERVER-SIDE ───
// Corrections applied: explicit short-PnL accounting, hourly equity snapshots,
// Tehran-midnight circuit-breaker baseline.

export interface OpenParams {
  symbol: string
  side: 'long' | 'short'
  signalId?: number
  strategy?: string
  reasonFa?: string
  entryPrice?: number // optional override (uses latest ticker price by default)
  qty?: number // optional manual qty (still risk-capped)
}

export class FundError extends Error {}

export async function latestPrice(symbol: string): Promise<number | null> {
  const t = await db.tickerSnapshot.findFirst({ where: { symbol }, orderBy: { ts: 'desc' }, select: { price: true } })
  return t?.price ?? null
}

export async function computeUnrealized(): Promise<number> {
  const positions = await db.fundPosition.findMany({ where: { status: 'open' } })
  return positions.reduce((acc, p) => acc + positionPnl(p), 0)
}

export function positionPnl(p: { side: string; qty: number; entryPrice: number; markPrice: number }): number {
  // Short accounting (correction #8): shorts profit when mark < entry.
  return p.side === 'long' ? (p.markPrice - p.entryPrice) * p.qty : (p.entryPrice - p.markPrice) * p.qty
}

export async function currentEquity(): Promise<number> {
  const cfg = await getRiskConfig()
  const realized = await db.fundPosition.aggregate({
    where: { status: 'closed' },
    _sum: { pnlUsdt: true },
  })
  const unrealized = await computeUnrealized()
  return cfg.equity + (realized._sum.pnlUsdt ?? 0) + unrealized
}

/** Equity at Tehran-midnight (circuit-breaker baseline). */
export async function equityAtTehranMidnight(): Promise<number> {
  const now = new Date()
  const tehran = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const midnightMs = new Date(`${tehran}T00:00:00+03:30`).getTime() // Tehran midnight in epoch ms
  const point = await db.equityPoint.findFirst({
    where: { ts: { lte: new Date(midnightMs) } },
    orderBy: { ts: 'desc' },
    select: { equityUsdt: true },
  })
  if (point) return point.equityUsdt
  const cfg = await getRiskConfig()
  const realized = await db.fundPosition.aggregate({ where: { status: 'closed' }, _sum: { pnlUsdt: true } })
  return cfg.equity + (realized._sum.pnlUsdt ?? 0)
}

export async function isCircuitBreakerTripped(): Promise<{ tripped: boolean; drawdownPct: number; limitPct: number }> {
  const cfg = await getRiskConfig()
  const [start, now] = await Promise.all([equityAtTehranMidnight(), currentEquity()])
  const dd = start > 0 ? ((start - now) / start) * 100 : 0
  return { tripped: dd >= cfg.dailyDrawdownHaltPct, drawdownPct: dd, limitPct: cfg.dailyDrawdownHaltPct }
}

/** Open a paper position with full risk validation (§7). */
export async function openPosition(params: OpenParams): Promise<{ positionId: number; qty: number; entry: number; stop: number; target: number }> {
  const cfg = await getRiskConfig()

  // 7.1 max concurrent positions
  const openCount = await db.fundPosition.count({ where: { status: 'open' } })
  if (openCount >= cfg.maxPositions) {
    throw new FundError(`حداکثر ${cfg.maxPositions} پوزیشن همزمان مجاز است`)
  }
  // 7.5 daily circuit breaker
  const cb = await isCircuitBreakerTripped()
  if (cb.tripped) {
    throw new FundError('مدار قطع شد — روز پرریسک؛ افت روزانه از حد مجاز گذشته است')
  }

  const entry = params.entryPrice ?? (await latestPrice(params.symbol))
  if (!entry || entry <= 0) throw new FundError('قیمت لحظه‌ای در دسترس نیست')

  // 7.4 mandatory stop loss (ATR×1.5 from 1h candles)
  const candles = await loadCandles(params.symbol, '1h', 30)
  const a = candles.length > 15 ? atr(candles, 14) : NaN
  const slDist = Number.isFinite(a) ? Math.max(a * 1.5, entry * 0.004) : entry * 0.02
  const stop = params.side === 'long' ? entry - slDist : entry + slDist
  const target = params.side === 'long' ? entry + slDist * 1.5 : entry - slDist * 1.5 // R:R = 1.5

  // 7.2 risk per trade → notional; 7.3 cap 20% equity
  const slPct = slDist / entry
  let notional = (cfg.riskPerTradePct / 100) * cfg.equity / slPct
  const capNotional = (cfg.maxPositionPct / 100) * cfg.equity
  if (notional > capNotional) notional = capNotional
  if (notional < 10) throw new FundError('حجم معامله پس از اعمال قواعد ریسک بیش از حد کوچک است')

  let qty = notional / entry
  if (params.qty && params.qty > 0) {
    qty = Math.min(params.qty, capNotional / entry) // manual qty still capped
  }
  const finalNotional = qty * entry

  // duplicate guard: same symbol open position
  const dup = await db.fundPosition.findFirst({ where: { symbol: params.symbol, status: 'open' }, select: { id: true } })
  if (dup) throw new FundError('برای این نماد قبلاً پوزیشن باز دارید')

  let signalId = params.signalId ?? null
  let strategy = params.strategy ?? 'manual'
  let reasonFa = params.reasonFa ?? ''
  if (signalId) {
    const sig = await db.signal.findUnique({ where: { id: signalId } })
    if (!sig) throw new FundError('سیگنال یافت نشد')
    if (sig.symbol !== params.symbol) throw new FundError('نماد با سیگنال همخوان نیست')
    strategy = sig.strategy
    reasonFa = sig.reasonFa
    await db.signal.update({ where: { id: signalId }, data: { status: 'registered' } })
  } else {
    // 7.6 radar-only entries: manual opens need an explicit reason
    if (!reasonFa) reasonFa = 'ثبت دستی توسط کاربر (بدون سیگنال رادار)'
  }

  const pos = await db.fundPosition.create({
    data: {
      symbol: params.symbol,
      side: params.side,
      qty,
      entryPrice: entry,
      markPrice: entry,
      stopLoss: stop,
      takeProfit: target,
      strategy,
      reasonFa,
      sourceSignalId: signalId,
    },
  })
  await db.fundOrder.create({
    data: {
      kind: 'open',
      symbol: params.symbol,
      side: params.side,
      qty,
      price: entry,
      reasonFa: `${reasonFa} — حجم ${qty.toFixed(6)}، حد ضرر ${stop.toFixed(6)}، هدف ${target.toFixed(6)}`,
    },
  })
  void finalNotional
  return { positionId: pos.id, qty, entry, stop, target }
}

/** Close a position, realize PnL, write order + equity point. */
export async function closePosition(id: number, reasonFa: string, closePrice?: number): Promise<{ pnlUsdt: number; pnlPct: number }> {
  const pos = await db.fundPosition.findUnique({ where: { id } })
  if (!pos || pos.status !== 'open') throw new FundError('پوزیشن باز یافت نشد')
  const price = closePrice ?? (await latestPrice(pos.symbol)) ?? pos.markPrice
  const pnlUsdt = pos.side === 'long' ? (price - pos.entryPrice) * pos.qty : (pos.entryPrice - price) * pos.qty
  const pnlPct = (pnlUsdt / (pos.entryPrice * pos.qty)) * 100
  await db.fundPosition.update({
    where: { id },
    data: { status: 'closed', closedAt: new Date(), closePrice: price, pnlUsdt, pnlPct, markPrice: price },
  })
  await db.fundOrder.create({
    data: { kind: 'close', symbol: pos.symbol, side: pos.side, qty: pos.qty, price, reasonFa },
  })
  const eq = await currentEquity()
  await db.equityPoint.create({ data: { equityUsdt: eq } })
  return { pnlUsdt, pnlPct }
}

/** Mark-to-market + auto SL/TP (runs every 60s). */
export async function markToMarket(): Promise<{ closed: number; details: string[] }> {
  const positions = await db.fundPosition.findMany({ where: { status: 'open' } })
  const details: string[] = []
  let closed = 0
  for (const p of positions) {
    const price = await latestPrice(p.symbol)
    if (!price) continue
    if (price !== p.markPrice) {
      await db.fundPosition.update({ where: { id: p.id }, data: { markPrice: price } })
    }
    const hitSl = p.side === 'long' ? price <= p.stopLoss : price >= p.stopLoss
    const hitTp = p.side === 'long' ? price >= p.takeProfit : price <= p.takeProfit
    if (hitSl) {
      const r = await closePosition(p.id, 'حد ضرر فعال شد', p.stopLoss)
      closed++
      details.push(`${p.symbol}: حد ضرر (${r.pnlUsdt.toFixed(2)} USDT)`)
    } else if (hitTp) {
      const r = await closePosition(p.id, 'هدف سود محقق شد', p.takeProfit)
      closed++
      details.push(`${p.symbol}: هدف سود (+${r.pnlUsdt.toFixed(2)} USDT)`)
    }
  }
  return { closed, details }
}

export interface FundStats {
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

export async function computeStats(): Promise<FundStats> {
  const cfg = await getRiskConfig()
  const closed = await db.fundPosition.findMany({ where: { status: 'closed' } })
  const open = await db.fundPosition.findMany({ where: { status: 'open' } })
  const realized = closed.reduce((a, p) => a + (p.pnlUsdt ?? 0), 0)
  const unrealized = open.reduce((a, p) => a + positionPnl(p), 0)
  const equity = cfg.equity + realized + unrealized

  const wins = closed.filter((p) => (p.pnlUsdt ?? 0) > 0)
  const losses = closed.filter((p) => (p.pnlUsdt ?? 0) <= 0)
  const grossWin = wins.reduce((a, p) => a + (p.pnlUsdt ?? 0), 0)
  const grossLoss = Math.abs(losses.reduce((a, p) => a + (p.pnlUsdt ?? 0), 0))

  // max drawdown from equity curve
  const points = await db.equityPoint.findMany({ orderBy: { ts: 'asc' }, select: { equityUsdt: true } })
  let peak = cfg.equity
  let maxDd = 0
  const series = [cfg.equity, ...points.map((p) => p.equityUsdt)]
  for (const v of series) {
    if (v > peak) peak = v
    const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0
    if (dd > maxDd) maxDd = dd
  }

  const stratMap = new Map<string, { count: number; pnl: number; wins: number }>()
  for (const p of closed) {
    const cur = stratMap.get(p.strategy) ?? { count: 0, pnl: 0, wins: 0 }
    cur.count++
    cur.pnl += p.pnlUsdt ?? 0
    if ((p.pnlUsdt ?? 0) > 0) cur.wins++
    stratMap.set(p.strategy, cur)
  }
  const perStrategy = [...stratMap.entries()].map(([strategy, v]) => ({
    strategy,
    fa: STRATEGY_FA[strategy] ?? (strategy === 'manual' ? 'دستی' : strategy),
    count: v.count,
    pnlUsdt: v.pnl,
    winRate: (v.wins / v.count) * 100,
  }))

  const best = closed.length ? closed.reduce((a, p) => ((p.pnlUsdt ?? 0) > (a.pnlUsdt ?? 0) ? p : a)) : null
  const worst = closed.length ? closed.reduce((a, p) => ((p.pnlUsdt ?? 0) < (a.pnlUsdt ?? 0) ? p : a)) : null

  return {
    equity,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    totalPnlUsdt: realized + unrealized,
    totalPnlPct: ((realized + unrealized) / cfg.equity) * 100,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    maxDrawdownPct: maxDd,
    bestTrade: best ? { symbol: best.symbol, pnlUsdt: best.pnlUsdt ?? 0 } : null,
    worstTrade: worst ? { symbol: worst.symbol, pnlUsdt: worst.pnlUsdt ?? 0 } : null,
    closedCount: closed.length,
    perStrategy,
    circuitBreaker: await isCircuitBreakerTripped(),
  }
}

/** Hourly equity snapshot (correction #8: sparkline needs periodic points). */
export async function snapshotEquity(): Promise<number> {
  const eq = await currentEquity()
  await db.equityPoint.create({ data: { equityUsdt: eq } })
  return eq
}
