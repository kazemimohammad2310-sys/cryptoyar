// One-shot local test of the autonomy layer (heal + optimize [+ update]).
// Usage: bun scripts/autonomy-test.ts [update]
import { db, ensurePragmas } from '@/lib/db'
import { ensureDefaults } from '@/lib/settings'
import { runSelfHeal, runSelfOptimize, runSelfUpdate } from '@/lib/autonomy'
import { getSetting } from '@/lib/settings'

async function main(): Promise<void> {
  await ensurePragmas()
  await ensureDefaults()

  console.log('── SELF-HEAL ──')
  console.log(await runSelfHeal())
  console.log('healSnapshot:', await getSetting('healSnapshot'))

  console.log('── SELF-OPTIMIZE ──')
  console.log(await runSelfOptimize())
  console.log('optimizeSnapshot:', await getSetting('optimizeSnapshot'))

  if (process.argv[2] === 'update') {
    console.log('── SELF-UPDATE ──')
    console.log(await runSelfUpdate())
    console.log('versionInfo:', await getSetting('versionInfo'))
  }

  try {
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* degrade */
  }
  await db.$disconnect()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
