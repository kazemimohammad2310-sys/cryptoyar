import { db } from '@/lib/db'
import { getRiskConfig, getFuturesConfig } from '@/lib/settings'
import { loadCandles } from '@/lib/candles'
import { atr } from '@/lib/indicators'
import { STRATEGY_FA } from '@/lib/brain'
import { faNum } from '@/lib/fa'
import type { FundamentalLevel } from '@/lib/fundamentals'

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
  leverage?: number // optional override — otherwise auto per futures config
  fundamentalLevel?: FundamentalLevel | null // از ربات: سطح بنیاد برای اهرم متناسب
}

export class FundError extends Error {}

// ─── فیوچرز (paper) ───
// اهرم فقط مارجین و ROE و لیکوییدیشن را تغییر می‌دهد؛ سود/زیان مطلق همان qty × حرکت قیمت است.
// اهرم متناسب (حالت auto): لیکوییدیشن حداقل ‎۲٫۵ برابرِ‌ دورتر از حد ضرر می‌ماند + سقف بنیادی:
//   بنیاد قوی → تا سقف تنظیمات | متوسط → تا ×۳ | ضعیف → ×۱ (بدون اهرم)

const LIQ_MAINT_BUFFER = 0.95 // ۵٪ بافر نگهداشت مارجین (ساده‌سازی صندوق شبیه‌ساز)
const LIQ_SAFETY = 2.5 // فاصلهٔ لیکوییدیشن ≥ این‌ضریب × فاصلهٔ حد ضرر

/** قیمت لیکوییدیشن تقریبی (فقط برای اهرم > ۱) */
export function liquidationPrice(p: { side: string; entryPrice: number; leverage: number }): number {
  const lev = Math.max(1, p.leverage || 1)
  const dist = (LIQ_MAINT_BUFFER / lev) * p.entryPrice
  return p.side === 'long' ? p.entryPrice - dist : p.entryPrice + dist
}

/** بازده روی مارجین (ROE) بر حسب ٪ */
export function roeOf(p: { side: string; qty: number; entryPrice: number; markPrice: number; leverage: number; marginUsdt: number }): number {
  const margin = p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, p.leverage || 1)
  if (margin <= 0) return 0
  const pnl = p.side === 'long' ? (p.markPrice - p.entryPrice) * p.qty : (p.entryPrice - p.markPrice) * p.qty
  return (pnl / margin) * 100
}

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

/** Open a paper position with full risk validation (§7) + futures leverage. */
export async function openPosition(params: OpenParams): Promise<{ positionId: number; qty: number; entry: number; stop: number; target: number; leverage: number; marginUsdt: number }> {
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

  // ─── فیوچرز: انتخاب اهرم متناسب (§7-futures) ───
  const fut = await getFuturesConfig()
  const clampLev = (n: number): number => Math.min(fut.maxLev, Math.max(1, Math.round(n * 10) / 10))
  let leverage = 1
  if (params.leverage && Number.isFinite(params.leverage) && params.leverage > 1) {
    leverage = clampLev(params.leverage) // override دستی/ربات — باز هم سقف مطلق
  } else if (fut.mode === 'fixed') {
    leverage = fut.fixedLev
  } else {
    // اهرم متناسب: لیکوییدیشن حداقل ۲٫۵ برابر دورتر از حد ضرر + سقف بر اساس بنیاد
    const levByRisk = (LIQ_MAINT_BUFFER / (slPct * LIQ_SAFETY))
    const levByFund = params.fundamentalLevel === 'strong' ? fut.maxLev : params.fundamentalLevel === 'mid' ? 3 : 1
    leverage = clampLev(Math.min(levByRisk, levByFund))
  }
  const marginUsdt = finalNotional / leverage

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
    // دلیل ورود: ربات دلیل ساختاریافتهٔ خودش را می‌فرستد (امتیاز/همگرایی/بنیاد/روند)؛
    // اگر نیامده باشد (ثبت دستی از رادار)، دلیل کامل سیگنال رادار ثبت می‌شود.
    if (!reasonFa) reasonFa = sig.reasonFa
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
      leverage,
      marginUsdt,
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
      reasonFa: `${reasonFa} — فیوچرز اهرم ×${leverage % 1 === 0 ? leverage.toFixed(0) : leverage.toFixed(1)}، مارجین ${marginUsdt.toFixed(2)} USDT، حد ضرر ${stop.toFixed(6)}، هدف ${target.toFixed(6)}`,
    },
  })
  return { positionId: pos.id, qty, entry, stop, target, leverage, marginUsdt }
}

/** Close a position, realize PnL, write order + equity point.
 *  دلیل بستن به‌صورت خودکار غنی‌سازی می‌شود: عامل بستن + نتیجهٔ نهایی (٪ و USDT) + مدت نگهداری.
 *  متن نهایی هم روی خود پوزیشن (closeReasonFa) و هم در دفتر سفارش‌ها ذخیره می‌شود. */
export async function closePosition(id: number, reasonFa: string, closePrice?: number): Promise<{ pnlUsdt: number; pnlPct: number }> {
  const pos = await db.fundPosition.findUnique({ where: { id } })
  if (!pos || pos.status !== 'open') throw new FundError('پوزیشن باز یافت نشد')
  const price = closePrice ?? (await latestPrice(pos.symbol)) ?? pos.markPrice
  const pnlUsdt = pos.side === 'long' ? (price - pos.entryPrice) * pos.qty : (pos.entryPrice - price) * pos.qty
  const pnlPct = (pnlUsdt / (pos.entryPrice * pos.qty)) * 100

  // غنی‌سازی دلیل: نتیجهٔ نهایی + مدت نگهداری (جملهٔ کامل «چرا بسته شد»)
  const durH = Math.max(0, (Date.now() - pos.openedAt.getTime()) / 3600_000)
  const durFa = durH >= 1 ? `${faNum(Math.round(durH), 0)} ساعت` : `${faNum(Math.max(1, Math.round(durH * 60)), 0)} دقیقه`
  const finalReasonFa = `${reasonFa} — نتیجه: ${pnlUsdt >= 0 ? 'سود' : 'زیان'} ${faNum(Math.abs(pnlPct), 2)}٪ (${faNum(Math.abs(pnlUsdt), 2)} USDT) — مدت نگهداری ${durFa}`

  await db.fundPosition.update({
    where: { id },
    data: { status: 'closed', closedAt: new Date(), closePrice: price, pnlUsdt, pnlPct, markPrice: price, closeReasonFa: finalReasonFa },
  })
  await db.fundOrder.create({
    data: { kind: 'close', symbol: pos.symbol, side: pos.side, qty: pos.qty, price, reasonFa: finalReasonFa },
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
    // فیوچرز: لیکوییدیشن به‌عنوان سپر نهایی (معمولاً حد ضرر زودتر فعال می‌شود)
    if ((p.leverage ?? 1) > 1) {
      const liq = liquidationPrice(p)
      const liqHit = p.side === 'long' ? price <= liq : price >= liq
      if (liqHit) {
        const r = await closePosition(p.id, 'لیکوییدیشن — مارجین از دست رفت (سپر نهایی)', liq)
        closed++
        details.push(`${p.symbol}: لیکوییدیشن ×${p.leverage.toFixed(0)} (${r.pnlUsdt.toFixed(2)} USDT)`)
        continue
      }
    }
    const hitSl = p.side === 'long' ? price <= p.stopLoss : price >= p.stopLoss
    const hitTp = p.side === 'long' ? price >= p.takeProfit : price <= p.takeProfit
    if (hitSl) {
      // نوع حد ضرر را صادقانه بگو: اولیهٔ ATR یا محافظت‌شده (سر‌به‌سر/متحرک)
      const protectedStop = p.side === 'long' ? p.stopLoss >= p.entryPrice : p.stopLoss <= p.entryPrice
      const cause = protectedStop
        ? 'حد ضرر محافظت‌شده فعال شد (سر‌به‌سر/متحرک — سود قفل شد و معامله بسته شد)'
        : 'حد ضرر اولیه فعال شد (ATR — جلوگیری از بزرگ‌تر شدن ضرر)'
      const r = await closePosition(p.id, cause, p.stopLoss)
      closed++
      details.push(`${p.symbol}: حد ضرر (${r.pnlUsdt.toFixed(2)} USDT)`)
    } else if (hitTp) {
      const r = await closePosition(p.id, 'هدف سود محقق شد (نسبت ریسک/سود ۱٫۵ — حد سود به قیمت رسید)', p.takeProfit)
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
  futures: {
    marginUsed: number // مجموع مارجین درگیر پوزیشن‌های باز
    notionalExposure: number // مجموع حجم اسمی
    avgLeverage: number // اهرم میانگین وزنی با حجم اسمی
    maxLeverage: number // اهرم بیشینهٔ باز
    leveragedCount: number // تعداد پوزیشن‌های اهرم‌دار (‎>×۱)
    unrealizedRoe: number // ROE موزون کل روی مارجین
  }
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

  // ─── فیوچرز: تجمیع مارجین/اهرم پوزیشن‌های باز ───
  const marginUsed = open.reduce((a, p) => a + (p.marginUsdt > 0 ? p.marginUsdt : (p.entryPrice * p.qty) / Math.max(1, p.leverage || 1)), 0)
  const notionalExposure = open.reduce((a, p) => a + p.entryPrice * p.qty, 0)
  const avgLeverage = notionalExposure > 0
    ? open.reduce((a, p) => a + (p.leverage || 1) * p.entryPrice * p.qty, 0) / notionalExposure
    : 1
  const maxLeverage = open.reduce((a, p) => Math.max(a, p.leverage || 1), 1)
  const leveragedCount = open.filter((p) => (p.leverage || 1) > 1).length
  const unrealizedRoe = marginUsed > 0 ? (unrealized / marginUsed) * 100 : 0

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
    futures: { marginUsed, notionalExposure, avgLeverage, maxLeverage, leveragedCount, unrealizedRoe },
  }
}

/** Hourly equity snapshot (correction #8: sparkline needs periodic points). */
export async function snapshotEquity(): Promise<number> {
  const eq = await currentEquity()
  await db.equityPoint.create({ data: { equityUsdt: eq } })
  return eq
}
