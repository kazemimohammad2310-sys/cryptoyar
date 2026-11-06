// تست انتها-به-انتها: دلیل باز شدن و بستن پوزیشن (فقط روی دیتابیس محلی)
process.env.DATABASE_URL ||= 'file:/home/z/my-project/db/custom.db'

async function main() {
  const { openPosition, closePosition } = await import('../src/lib/fund')
  const { db } = await import('../src/lib/db')

  // ۱) باز کردن پوزیشن آزمایشی با دلیل ساختاریافتهٔ ربات
  const r = await openPosition({
    symbol: 'BTCUSDT',
    side: 'short',
    reasonFa: 'ربات خودکار — تست دلیل‌ها — امتیاز ۷۱، همگرایی ۷/۹ فاکتور، بنیاد قوی، هم‌جهت با روند ۴ساعته',
    leverage: 2,
  })
  console.log('opened position', r.positionId, 'lev', r.leverage)

  const pos = await db.fundPosition.findUniqueOrThrow({ where: { id: r.positionId } })
  console.log('open reasonFa:', pos.reasonFa)

  // ۲) بستن با عامل «هدف سود» — غنی‌سازی خودکار باید نتیجه و مدت را اضافه کند
  const c = await closePosition(r.positionId, 'هدف سود محقق شد (نسبت ریسک/سود ۱٫۵ — حد سود به قیمت رسید)', pos.takeProfit)
  console.log('closed pnl:', c.pnlUsdt.toFixed(2), 'USDT /', c.pnlPct.toFixed(2) + '%')

  const closed = await db.fundPosition.findUniqueOrThrow({ where: { id: r.positionId } })
  console.log('closeReasonFa:', closed.closeReasonFa)

  await db.$disconnect()
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
