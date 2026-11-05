// DB integrity check (run: bun scripts/db-check.ts)
import { db, ensurePragmas } from '@/lib/db'

async function main(): Promise<void> {
  await ensurePragmas()
  const qc = await db.$queryRawUnsafe('PRAGMA quick_check;')
  console.log('quick_check:', JSON.stringify(qc))
  const [settings, jobs, positions, signals] = await Promise.all([
    db.setting.count(),
    db.jobLog.count(),
    db.fundPosition.count(),
    db.signal.count(),
  ])
  console.log(`rows: settings=${settings} jobLog=${jobs} positions=${positions} signals=${signals}`)
  await db.$disconnect()
}

void main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e)
  process.exit(1)
})
