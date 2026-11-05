import { db } from '@/lib/db'
import { getBotConfig, getRiskConfig } from '@/lib/settings'
import { openPosition, closePosition, latestPrice, isCircuitBreakerTripped } from '@/lib/fund'
import { faNum } from '@/lib/fa'

// ─── Auto-Trader Bot (paper) ───
// Converts the strongest fresh radar signals into paper positions automatically,
// with server-side risk caps, per-symbol cooldowns and open-position management
// (breakeven stop → trailing stop → time-stop for dead trades).
// Every entry is tagged with BOT_PREFIX so the UI and reports can attribute it.

export const BOT_PREFIX = 'ربات خودکار'
const SIGNAL_MAX_AGE_H = 8 // never chase signals older than this
const CANDIDATES_PER_RUN = 10
const BREAKEVEN_AT_PCT = 1.0 // move stop to entry at +1%
const TRAIL_AT_PCT = 1.6 // start trailing at +1.6%
const TRAIL_GAP_PCT = 1.2 // trail distance from mark price
const TIME_STOP_H = 72 // exit dead trades after 72h
const TIME_STOP_EPS_PCT = 0.5 // ...only if |pnl| is negligible

function pnlPctOf(side: string, entry: number, price: number): number {
  return side === 'long' ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100
}

/** Better stop for the position? (long: higher is better, short: lower is better) */
function stopImproved(side: string, current: number, candidate: number): boolean {
  return side === 'long' ? candidate > current : candidate < current
}

/** Breakeven + trailing management for one position; returns a detail string or null. */
async function manageOne(p: {
  id: number
  symbol: string
  side: string
  entryPrice: number
  markPrice: number
  stopLoss: number
  openedAt: Date
}): Promise<string | null> {
  const price = (await latestPrice(p.symbol)) ?? p.markPrice
  const pnlPct = pnlPctOf(p.side, p.entryPrice, price)

  // time-stop: dead trade → free the slot
  const hoursOpen = (Date.now() - p.openedAt.getTime()) / 3600_000
  if (hoursOpen >= TIME_STOP_H && Math.abs(pnlPct) <= TIME_STOP_EPS_PCT) {
    const r = await closePosition(p.id, `${BOT_PREFIX} — خروج زمانی: بازده ناچیز پس از ${faNum(TIME_STOP_H, 0)} ساعت`)
    return `${p.symbol}: خروج زمانی (${r.pnlUsdt.toFixed(2)} USDT)`
  }

  let newStop: number | null = null
  // breakeven: protect capital once the trade is +1%
  if (pnlPct >= BREAKEVEN_AT_PCT) {
    const be = p.side === 'long' ? p.entryPrice * 1.001 : p.entryPrice * 0.999
    if (stopImproved(p.side, p.stopLoss, be)) newStop = be
  }
  // trailing: lock in profit beyond +1.6%
  if (pnlPct >= TRAIL_AT_PCT) {
    const trail = p.side === 'long' ? price * (1 - TRAIL_GAP_PCT / 100) : price * (1 + TRAIL_GAP_PCT / 100)
    if (newStop === null || stopImproved(p.side, newStop, trail)) newStop = trail
  }
  if (newStop !== null && stopImproved(p.side, p.stopLoss, newStop)) {
    await db.fundPosition.update({ where: { id: p.id }, data: { stopLoss: newStop } })
    await db.fundOrder.create({
      data: {
        kind: 'adjust',
        symbol: p.symbol,
        side: p.side,
        qty: 0,
        price: newStop,
        reasonFa: `${BOT_PREFIX} — ${pnlPct >= TRAIL_AT_PCT ? 'حد ضرر متحرک' : 'حد ضرر به سر‌به‌سر'} (سود لحظه‌ای ${faNum(pnlPct, 2)}٪)`,
      },
    })
    return `${p.symbol}: حد ضرر → ${newStop.toFixed(6)} (${pnlPct >= TRAIL_AT_PCT ? 'تریلینگ' : 'سر‌به‌سر'})`
  }
  return null
}

/** Manage all open positions (breakeven/trailing/time-stop). */
export async function manageOpenPositions(): Promise<string[]> {
  const positions = await db.fundPosition.findMany({ where: { status: 'open' } })
  const out: string[] = []
  for (const p of positions) {
    try {
      const d = await manageOne(p)
      if (d) out.push(d)
    } catch {
      /* single-position failure must not stop the loop */
    }
  }
  return out
}

/** One full bot tick: manage open positions, then open new entries from fresh signals. */
export async function runAutoTrader(): Promise<string> {
  const bot = await getBotConfig()

  const managed = await manageOpenPositions()
  const manageFa = managed.length ? `مدیریت: ${managed.length} اصلاح حد ضرر/خروج` : 'مدیریت: بدون تغییر'

  if (bot.enabled !== 'on') {
    return `ربات خاموش است — ${manageFa}`
  }

  const risk = await getRiskConfig()
  const cb = await isCircuitBreakerTripped()
  if (cb.tripped) {
    return `مدار روزانه قطع شده (افت ${faNum(cb.drawdownPct, 1)}٪) — ورود جدید ممنوع — ${manageFa}`
  }

  const botOpen = await db.fundPosition.count({
    where: { status: 'open', reasonFa: { startsWith: BOT_PREFIX } },
  })
  const capacity = Math.min(bot.maxOpen, risk.maxPositions) - botOpen

  if (capacity <= 0) {
    return `ظرفیت ربات پر است (${faNum(botOpen, 0)}/${faNum(Math.min(bot.maxOpen, risk.maxPositions), 0)}) — ${manageFa}`
  }

  // fresh actionable signals, strongest first
  const since = new Date(Date.now() - SIGNAL_MAX_AGE_H * 3600_000)
  const rows = await db.signal.findMany({
    where: { status: 'open', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })
  const candidates = rows
    .filter((s) => Math.abs(s.score) >= bot.minScore)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, CANDIDATES_PER_RUN)

  if (!candidates.length) {
    return `سیگنال تازهٔ بالای امتیاز ${faNum(bot.minScore, 0)} نداریم — ${manageFa}`
  }

  let opened = 0
  let skipped = 0
  const openedFa: string[] = []
  const skipFa: string[] = []

  for (const s of candidates) {
    if (opened >= capacity) break
    try {
      const dup = await db.fundPosition.findFirst({
        where: { symbol: s.symbol, status: 'open' },
        select: { id: true },
      })
      if (dup) {
        skipped++
        skipFa.push(`${s.symbol}: پوزیشن باز دارد`)
        continue
      }
      // cooldown after a recent close on the same symbol (loss 6h default, win 1h)
      const lastClosed = await db.fundPosition.findFirst({
        where: { symbol: s.symbol, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true, pnlUsdt: true },
      })
      if (lastClosed?.closedAt) {
        const wasLoss = (lastClosed.pnlUsdt ?? 0) <= 0
        const cooldownH = wasLoss ? bot.cooldownHours : 1
        const sinceClose = (Date.now() - lastClosed.closedAt.getTime()) / 3600_000
        if (sinceClose < cooldownH) {
          skipped++
          skipFa.push(`${s.symbol}: خنک‌شدن پس از ${wasLoss ? 'ضرر' : 'سود'}`)
          continue
        }
      }

      const r = await openPosition({
        symbol: s.symbol,
        side: s.side,
        signalId: s.id,
        reasonFa: `${BOT_PREFIX} — ${s.strategy}`,
      })
      // tag the position so reports can attribute it to the bot
      await db.fundPosition.update({
        where: { id: r.positionId },
        data: { reasonFa: { set: `${BOT_PREFIX} — ${s.strategy} — امتیاز ${faNum(Math.round(Math.abs(s.score)), 0)}` } },
      })
      opened++
      openedFa.push(`${s.symbol} ${s.side === 'long' ? 'خرید' : 'فروش'}`)
    } catch {
      skipped++
    }
  }

  const parts = [`ورود: ${faNum(opened, 0)}`]
  if (openedFa.length) parts.push(`(${openedFa.join('، ')})`)
  parts.push(`ردشده: ${faNum(skipped, 0)} — ${manageFa}`)
  return parts.join(' ')
}
