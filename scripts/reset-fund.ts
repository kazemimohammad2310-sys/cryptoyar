// Restart v5 — بازنشانی صندوق کاغذی کریپتویار به درخواست کاربر:
//   ۱) بستن همهٔ پوزیشن‌های باز با قیمت واقعی لحظه‌ای بازار (صادقانه، نه پاک‌سازی خام)
//   ۲) آرشیو خلاصهٔ دورهٔ قبلی در Setting (فقط بار اول — بازنویسی نمی‌شود)
//   ۳) پاک‌کردن دفتر صندوق (پوزیشن‌ها/سفارش‌ها/نمودار سرمایه)
//   ۴) شروع دوباره با سرمایهٔ ۱۰۰۰ USDT + تنظیمات سخت‌گیرانهٔ ربات
//   ۵) مغز، درس‌ها، سیگنال‌ها و نمونه‌های آموزشی دست‌نخورده می‌مانند (همهٔ آموخته‌ها حفظ می‌شود)
// اجرا: DATABASE_URL=... bun scripts/reset-fund.ts
import { db } from '../src/lib/db'
import { setSetting } from '../src/lib/settings'
import { getKlines } from '../src/lib/fetchers/binance'

const NEW_EQUITY = '1000'
const BOT_MIN_SCORE = '70'
const BOT_MAX_OPEN = '4'

async function livePrice(symbol: string): Promise<number | null> {
  try {
    const k = await getKlines(symbol, '1m', 2)
    return k.length ? k[k.length - 1].close : null
  } catch {
    return null
  }
}

async function main() {
  const open = await db.fundPosition.findMany({ where: { status: 'open' } })
  const closedAll = await db.fundPosition.findMany({ where: { status: 'closed' } })
  const realizedOld = closedAll.reduce((a, p) => a + (p.pnlUsdt ?? 0), 0)
  const winsOld = closedAll.filter((p) => (p.pnlUsdt ?? 0) > 0).length
  const eqRows = await db.equityPoint.findMany({ orderBy: { ts: 'desc' }, take: 1 })
  const equityBefore = eqRows[0]?.equityUsdt ?? null

  console.log(`پوزیشن باز: ${open.length} | معاملهٔ بسته: ${closedAll.length} | سود محقق‌شدهٔ قبلی: ${realizedOld.toFixed(2)} USDT`)

  // ۱) بستن صادقانهٔ پوزیشن‌های باز با قیمت واقعی بازار
  let closedNow = 0
  for (const p of open) {
    const price = (await livePrice(p.symbol)) ?? p.markPrice
    const pnl = p.side === 'long' ? (price - p.entryPrice) * p.qty : (p.entryPrice - price) * p.qty
    const pnlPct = (pnl / (p.entryPrice * p.qty)) * 100
    await db.fundPosition.update({
      where: { id: p.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        closePrice: price,
        markPrice: price,
        pnlUsdt: pnl,
        pnlPct,
        closeReasonFa: `بستن همهٔ پوزیشن‌ها — شروع دوبارهٔ صندوق با سرمایهٔ جدید — نتیجه: ${pnl >= 0 ? 'سود' : 'زیان'} ${Math.abs(pnlPct).toFixed(2)}٪ (${Math.abs(pnl).toFixed(2)} USDT)`,
      },
    })
    console.log(`بسته شد: ${p.symbol} ${p.side} @ ${price} → ${pnl.toFixed(2)} USDT`)
    closedNow++
  }

  // ۲) آرشیو خلاصهٔ دورهٔ قبلی (فقط بار اول)
  const archiveKey = 'fundRestartArchive'
  const existing = await db.setting.findUnique({ where: { key: archiveKey } })
  if (!existing) {
    const total = closedAll.length + closedNow
    const allClosed = await db.fundPosition.findMany({ where: { status: 'closed' } })
    const realizedTotal = allClosed.reduce((a, p) => a + (p.pnlUsdt ?? 0), 0)
    const winsTotal = allClosed.filter((p) => (p.pnlUsdt ?? 0) > 0).length
    await setSetting(
      archiveKey,
      JSON.stringify({
        at: new Date().toISOString(),
        note: 'شروع دوبارهٔ صندوق با ۱۰۰۰ USDT به درخواست کاربر',
        previousPeriod: {
          trades: total,
          wins: winsTotal,
          winRatePct: total ? Math.round((winsTotal / total) * 1000) / 10 : 0,
          realizedPnl: Math.round(realizedTotal * 100) / 100,
          lastEquity: equityBefore,
        },
      }),
    )
    console.log(`آرشیو دورهٔ قبلی ذخیره شد: ${total} معامله، برد ${winsTotal}/${total}`)
  }

  // ۳) پاک‌کردن دفتر صندوق (مغز/درس‌ها/سیگنال‌ها دست‌نخورده)
  const delP = await db.fundPosition.deleteMany({})
  const delO = await db.fundOrder.deleteMany({})
  const delE = await db.equityPoint.deleteMany({})
  console.log(`دفتر صندوق پاک شد: ${delP.count} پوزیشن، ${delO.count} سفارش، ${delE.count} نقطهٔ نمودار`)

  // ۴) شروع دوباره با ۱۰۰۰ USDT + تنظیمات سخت‌گیرانه
  await setSetting('equity', NEW_EQUITY)
  await setSetting('botMinScore', BOT_MIN_SCORE)
  await setSetting('botMaxOpen', BOT_MAX_OPEN)
  await db.equityPoint.create({ data: { equityUsdt: Number(NEW_EQUITY) } })

  // ۵) گواهی سلامت: مغز حفظ شده؟
  const [samples, lessons, signals] = await Promise.all([
    db.brainSample.count(),
    db.brainLesson.count(),
    db.signal.count(),
  ])
  console.log(`شروع دوباره انجام شد — سرمایهٔ جدید: ${NEW_EQUITY} USDT | آستانهٔ ربات: ${BOT_MIN_SCORE} | سقف پوزیشن: ${BOT_MAX_OPEN}`)
  console.log(`مغز دست‌نخورده: ${samples} نمونهٔ آموزشی، ${lessons} درس، ${signals} سیگنال سابقه`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('خطا:', e)
    process.exit(1)
  })
