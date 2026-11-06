// اجرای دستی: کاشت دانش‌نامه + کشف درس‌ها از داده‌های واقعی (بدون تغییر وزن‌ها)
import { db, ensurePragmas } from '../src/lib/db'
import { seedTraderKnowledge } from '../src/lib/traderKnowledge'
import { mineLessons } from '../src/lib/lessons'

async function main() {
  await ensurePragmas()
  const seeded = await seedTraderKnowledge()
  console.log(`curriculum seeded: ${seeded} rules`)
  const changed = await mineLessons()
  console.log('mined/changed lessons:')
  for (const c of changed) console.log(`  - ${c}`)
  const all = await db.brainLesson.findMany({ orderBy: [{ kind: 'asc' }, { confidence: 'desc' }] })
  console.log(`\ntotal lessons in DB: ${all.length}`)
  for (const l of all.filter((x) => x.kind === 'pattern')) {
    console.log(
      `  [${l.active ? 'فعال' : 'غیرفعال'}] ${l.titleFa} — delta=${l.delta.toFixed(1)} conf=${l.confidence} | ${l.statsFa}`,
    )
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
