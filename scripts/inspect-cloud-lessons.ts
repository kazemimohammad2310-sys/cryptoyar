// بررسی دیتابیس ابری (فایل جدا) — درس‌های مغز
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const lessons = await db.brainLesson.findMany({ orderBy: [{ kind: 'asc' }, { id: 'asc' }] })
  console.log(`TOTAL_LESSONS: ${lessons.length}`)
  const cur = lessons.filter((l) => l.kind === 'curriculum')
  const pat = lessons.filter((l) => l.kind === 'pattern')
  console.log(`CURRICULUM: ${cur.length} | PATTERN: ${pat.length} (فعال: ${pat.filter((p) => p.active).length})`)
  for (const l of cur) console.log(`• ${l.titleFa}`)
  console.log('--- PATTERNS ---')
  for (const l of pat)
    console.log(`${l.active ? '✓فعال' : '✗خاموش'} ${l.titleFa} | delta=${l.delta} | ${l.statsFa}`)
  const bt = await db.setting.findUnique({ where: { key: 'brainTrainedAt' } })
  if (bt) console.log('--- brainTrainedAt ---\n' + bt.value.slice(0, 600))
}

main()
  .then(() => db.$disconnect())
  .catch((e) => {
    console.error('ERR:', String(e).slice(0, 300))
    process.exit(1)
  })
