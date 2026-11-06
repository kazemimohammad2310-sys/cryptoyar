import { register } from 'module'
import { pathToFileURL } from 'url'

// standalone general self-test: data sources + brain accuracy + reasons integrity
process.env.DATABASE_URL ||= 'file:/home/z/my-project/db/custom.db'

async function main() {
  const { runSelfTest } = await import('../src/lib/brain')
  const { sourceHealth } = await import('../src/lib/rateLimit')
  const { db } = await import('../src/lib/db')

  console.log('── منابع داده ──')
  const h = sourceHealth()
  for (const [k, v] of Object.entries(h)) console.log(`  ${k}: ${v.ok ? 'OK' : 'FAIL'} ${v.ok ? '' : String(v.lastError ?? '').slice(0, 80)}`)

  console.log('── تست خودکار مغز ──')
  const t = await runSelfTest()
  if (t.overall) {
    console.log(`  دقت کل: ${t.overall.accuracy.toFixed(1)}٪ روی ${t.overall.total} نمونه`)
    for (const s of t.byStrategy ?? []) {
      console.log(`  ${s.label}: ${s.accuracy.toFixed(1)}٪ (${s.total})`)
    }
  } else {
    console.log('  نمونه‌ای برای ارزیابی نیست')
  }

  console.log('── یکپارچگی دلایل معامله ──')
  const cnt = async (sql: string) => Number(((await db.$queryRawUnsafe(sql)) as any[])[0]?.c ?? 0)
  const sixH = Date.now() - 6 * 3600_000
  const openNoReason = await cnt("SELECT COUNT(*) as c FROM FundPosition WHERE status='open' AND (reasonFa IS NULL OR reasonFa='')")
  const closedNoCloseReason = await cnt("SELECT COUNT(*) as c FROM FundPosition WHERE status='closed' AND (closeReasonFa IS NULL OR closeReasonFa='')")
  const recentSignals = await cnt('SELECT COUNT(*) as c FROM Signal WHERE createdAt >= ' + sixH)
  const recentNoGate = await cnt('SELECT COUNT(*) as c FROM Signal WHERE createdAt >= ' + sixH + ' AND gateReasonFa IS NULL')
  console.log(`  پوزیشن باز بدون دلیل ورود: ${openNoReason}`)
  console.log(`  پوزیشن بسته بدون دلیل بستن: ${closedNoCloseReason}`)
  console.log(`  سیگنال ۶ ساعت اخیر: ${recentSignals} — بدون دلیل دروازه: ${recentNoGate}`)

  await db.$disconnect()
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
