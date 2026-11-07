// نگهبان ضربان ابر — اسکریپت مستقل (بدون نیاز به سرور)
// اجرای زمان‌بندی‌شده: اگر کرون رایگان گیت‌هاب چرخهٔ ابری را جا انداخته باشد،
// یک اجرای تازه فعال می‌کند و وضعیت نگهبان را در مخزن منتشر می‌کند.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { db, ensurePragmas } from '../src/lib/db'
import { runCloudWatchdog } from '../src/lib/autonomy'
import { getSetting, setSetting } from '../src/lib/settings'

const execFileP = promisify(execFile)

async function git(args: string[], timeoutMs = 90_000): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await execFileP('git', args, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    })
    return { ok: true, out: r.stdout.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

// ─── خودترمیم دیتابیس محلی (حادثهٔ 2026-11-07) ───
// محیط اجرا بین پیام‌ها گاهی پروژه را به اسنپ‌شات قدیمی برمی‌گرداند و فایل
// دیتابیس محلی خراب می‌شود («database disk image is malformed») و نگهبان را
// می‌کُشد. راه‌حل: قبل از هر اجرا سلامت فایل با sqlite خام (بدون prisma) چک
// می‌شود و اگر خراب بود، نسخهٔ معتبر مستقیم از origin/main بازیابی می‌شود.
function dbIntegrity(path: string): string {
  try {
    const probe = new Database(path, { readonly: true })
    const row = probe.query('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    probe.close()
    return row?.integrity_check ?? 'no-result'
  } catch (e) {
    return `open-failed: ${String(e).slice(0, 100)}`
  }
}

async function selfHealDb(): Promise<void> {
  const verdict = dbIntegrity('db/custom.db')
  if (verdict === 'ok') return
  console.log(`خودترمیم دیتابیس: فایل سالم نیست (${verdict}) — بازیابی از مخزن…`)
  for (const f of ['db/custom.db-wal', 'db/custom.db-shm']) if (existsSync(f)) rmSync(f)
  await git(['fetch', 'origin', 'main'], 120_000)
  const co = await git(['checkout', 'origin/main', '--', 'db/custom.db'])
  if (!co.ok) {
    console.log('خودترمیم دیتابیس: ناموفق — ادامه با احتیاط')
    return
  }
  const after = dbIntegrity('db/custom.db')
  console.log(
    after === 'ok'
      ? 'خودترمیم دیتابیس: انجام شد ✓ (نسخهٔ معتبر از origin/main)'
      : `خودترمیم دیتابیس: بعد از بازیابی هم سالم نیست (${after})`,
  )
}

async function main(): Promise<void> {
  await selfHealDb()
  await ensurePragmas()
  const res = await runCloudWatchdog()
  console.log(res.fa || 'ضربان ابر طبیعی است — نیازی به اقدام نبود')

  // انتشار وضعیت نگهبان در مخزن (تا داشبورد ابری هم نشان دهد):
  // بلافاصله بعد از اقدام، یا هر ۲ ساعت یک‌بار برای تازه‌سازی وضعیت
  const raw = await getSetting('cloudWatchdog')
  if (!raw) return
  let snap: Record<string, unknown> = {}
  try {
    snap = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  const lastPushAt = Number(snap.lastPushAt ?? 0)
  // حادثهٔ 2026-11-07: وقتی چرخهٔ تازه فعال شده، هارت‌بیت نفرست — کامیت نگهبان
  // یک ثانیه بعد از dispatch به مخزن می‌رسد و push رانر را با «fetch first» می‌کُشد
  // (اجرای 18:13، 18:53 و 21:51 UTC همه همین‌طور مردند). خودِ رانر حدود یک دقیقه
  // بعد دیتابیس تازه را منتشر می‌کند؛ وضعیت نگهبان هم داخل همان دیتابیس می‌رود.
  if (res.dispatched) {
    console.log('انتشار وضعیت: به چرخهٔ تازه واگذار شد (جلوگیری از تصادم با رانر)')
    return
  }
  const shouldPush = Date.now() - lastPushAt > 2 * 3600_000
  if (!shouldPush) {
    console.log('انتشار وضعیت: لازم نبود (تغییری جدید نیست)')
    return
  }

  // هرگز دیتابیس خراب را منتشر نکن (حادثهٔ خرابی دیتابیس محلی 2026-11-07)
  try {
    const integ = (await db.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check')) as Array<{
      integrity_check: string
    }>
    if (!integ.length || integ[0]?.integrity_check !== 'ok') {
      console.log('انتشار وضعیت: دیتابیس محلی سالم نیست — انتشار متوقف شد (برای جلوگیری از آلوده‌شدن ابر)')
      return
    }
  } catch {
    console.log('انتشار وضعیت: بررسی سلامت دیتابیس ناموفق بود — انتشار متوقف شد')
    return
  }

  const dirty = (await git(['status', '--porcelain', '--', 'db/custom.db'])).out
  if (!dirty) {
    console.log('انتشار وضعیت: تغییر دیتابیسی وجود ندارد')
    return
  }

  const pull = await git(['pull', '--rebase', '--autostash', 'origin', 'main'], 180_000)
  if (!pull.ok) {
    await git(['rebase', '--abort'], 30_000).catch(() => undefined)
    console.log('انتشار وضعیت: همگام‌سازی با مخزن ناموفق بود — در بررسی بعدی تلاش می‌شود')
    return
  }
  await snap2push(snap)
  await git(['add', 'db/custom.db'])
  const cm = await git(['commit', '-m', 'data: cloud heartbeat (watchdog)'])
  if (!cm.ok) {
    console.log('انتشار وضعیت: چیزی برای ثبت نبود')
    return
  }
  const push = await git(['push', 'origin', 'main'], 120_000)
  console.log(push.ok ? 'انتشار وضعیت: انجام شد ✓' : 'انتشار وضعیت: push ناموفق — بعداً تلاش می‌شود')
}

async function snap2push(snap: Record<string, unknown>): Promise<void> {
  await setSetting('cloudWatchdog', JSON.stringify({ ...snap, lastPushAt: Date.now() }))
}

main()
  .then(() => db.$disconnect())
  .catch((e) => {
    console.error('WATCHDOG ERR:', String(e).slice(0, 300))
    process.exit(1)
  })
