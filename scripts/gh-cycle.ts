// ─── CryptoYar Free — one full cycle for GitHub Actions (runs every 5 min) ───
// Reuses the exact same job functions as the 24/7 scheduler (nightshift.ts),
// with wall-clock guard + hourly gates so the 5-min cron never overruns budget.
// بهینه‌سازی یکپارچگی (2026-11-08): خطاهای گذرای شبکه/قفل دیتابیس یک تلاش دوم فوری می‌گیرند
// تا یک لغزش کوچک، یک چرخهٔ کامل (۵ دقیقه ضربان) را هدر ندهد.

import { db, ensurePragmas } from '@/lib/db'
import { ensureDefaults } from '@/lib/settings'
import { jobDefs } from '@/lib/nightshift'
import { seedTraderKnowledge } from '@/lib/traderKnowledge'

const ORDER = [
  'ticker-refresh',
  'candle-refresh',
  'cmc-refresh',
  'funding-refresh',
  'radar-scan',
  'fund-mark',
  'bot-trade',
  'equity-snapshot',
  'brain-train',
  'health',
  'self-heal',
  'self-optimize',
  'self-update',
  'self-test',
  'data-prune',
] as const

const HOURLY = new Set(['funding-refresh', 'brain-train', 'equity-snapshot', 'self-optimize', 'self-update'])
const DEADLINE = Date.now() + 7.5 * 60_000 // hard wall-clock guard (job timeout is 12 min)

async function lastOkAt(job: string): Promise<number> {
  const r = await db.jobLog.findFirst({
    where: { job, ok: true },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  return r?.startedAt ? r.startedAt.getTime() : 0
}

async function main(): Promise<void> {
  await ensurePragmas()
  await ensureDefaults()
  // کاشت دانش‌نامهٔ تریدر حرفه‌ای (idempotent — روی ابر هیچ route اپ اجرا نمی‌شود)
  await seedTraderKnowledge().catch(() => undefined)

  const defs = jobDefs()
  let ran = 0
  let fails = 0
  let retriedOk = 0

  for (const name of ORDER) {
    const def = defs.find((d) => d.name === name)
    if (!def) continue
    if (Date.now() > DEADLINE) {
      console.log(`SKIP ${name} — سقف زمانی چرخه`)
      continue
    }
    if (HOURLY.has(name) && Date.now() - (await lastOkAt(name)) < 55 * 60_000) {
      console.log(`SKIP ${name} — گارد ساعتی (کمتر از ۵۵ دقیقه از آخرین اجرای موفق)`)
      continue
    }

    const startedAt = new Date()
    const t0 = Date.now()
    let ok = true
    let detail = ''
    let error: string | null = null
    try {
      detail = await def.run()
    } catch (e) {
      // رفع خودکار خطای گذرا: یک تلاش دوم فوری (شبکهٔ لحظه‌ای/قفل DB معمولاً بار دوم می‌گذرد)
      await new Promise((r) => setTimeout(r, 2000))
      try {
        detail = `${await def.run()} — تلاش دوم موفق شد (رفع خودکار خطا)`
        retriedOk++
        console.log(`FIX ${name} — تلاش اول خطا داشت، تلاش دوم موفق بود`)
      } catch (e2) {
        ok = false
        error = e2 instanceof Error ? e2.message : String(e2)
        detail = 'خطا در اجرا — تلاش دوم هم ناموفق'
      }
    }
    ran++
    if (!ok) fails++
    try {
      await db.jobLog.create({
        data: {
          job: name,
          startedAt,
          finishedAt: new Date(),
          ok,
          error: error ? error.slice(0, 500) : null,
          detail: detail.slice(0, 500),
        },
      })
    } catch {
      /* never crash on logging */
    }
    console.log(`${ok ? 'OK ' : 'ERR'} ${name} (${Date.now() - t0}ms) — ${detail}`)
  }

  // self-contained DB file for the git commit
  // (wal_checkpoint returns a result row → must use $queryRawUnsafe, not execute)
  try {
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* degrade */
  }

  console.log(`CYCLE DONE ran=${ran} fails=${fails} retriedOk=${retriedOk}`)
  if (fails >= 6) process.exit(1) // catastrophic failure only — individual sources degrade gracefully
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
