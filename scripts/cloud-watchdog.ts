// نگهبان ضربان ابر — اسکریپت مستقل (بدون نیاز به سرور)
// اجرای زمان‌بندی‌شده: اگر کرون رایگان گیت‌هاب چرخهٔ ابری را جا انداخته باشد،
// یک اجرای تازه فعال می‌کند و وضعیت نگهبان را در مخزن منتشر می‌کند.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

async function main(): Promise<void> {
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
  const shouldPush = res.dispatched || Date.now() - lastPushAt > 2 * 3600_000
  if (!shouldPush) {
    console.log('انتشار وضعیت: لازم نبود (تغییری جدید نیست)')
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
