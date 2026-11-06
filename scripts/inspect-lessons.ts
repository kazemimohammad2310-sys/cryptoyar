// بررسی درس‌های مغز: قواعد دانش‌نامه + درس‌های کشف‌شده
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const lessons = await db.brainLesson.findMany({ orderBy: [{ kind: 'asc' }, { id: 'asc' }] })
  console.log(`TOTAL_LESSONS: ${lessons.length}`)
  const cur = lessons.filter((l) => l.kind === 'curriculum')
  const pat = lessons.filter((l) => l.kind === 'pattern')
  console.log(`CURRICULUM: ${cur.length} | PATTERN: ${pat.length} (فعال: ${pat.filter((p) => p.active).length})`)
  console.log('--- CURRICULUM ---')
  for (const l of cur) console.log(`• [${l.key}] ${l.titleFa}`)
  console.log('--- PATTERNS ---')
  for (const l of pat)
    console.log(
      `${l.active ? '✓' : '✗'} [${l.key}] ${l.titleFa} | delta=${l.delta} conf=${l.confidence} | ${l.statsFa}`,
    )
  // آخرین آموزش مغز
  const bt = await db.setting.findUnique({ where: { key: 'brainTrainedAt' } })
  if (bt) console.log('--- brainTrainedAt ---\n' + bt.value.slice(0, 800))
}

main()
  .then(() => db.$disconnect())
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
