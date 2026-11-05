import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { db } from '@/lib/db'
import { getSetting, setSetting, getRiskConfig, getBotConfig } from '@/lib/settings'
import { refreshUniverse } from '@/lib/universe'
import { BOT_PREFIX } from '@/lib/autotrader'
import { faNum } from '@/lib/fa'

// ─── Autonomy Layer (لایهٔ خودکار) ───
// Three self-running engines, wired into BOTH schedulers (local nightshift + cloud cycle):
//   1) runSelfHeal     — watches job logs for failing jobs and auto-remediates
//                        (stale universe, DB locks, stale signals, corrupt marks).
//   2) runSelfOptimize — daily DB maintenance (PRAGMA optimize / VACUUM) +
//                        adaptive risk tuning from real bot performance (self-growth).
//   3) runSelfUpdate   — checks the repo for newer code and updates itself
//                        (locally: safe ff-merge + prisma push; in cloud the 15-min
//                        cycle already always runs the newest pushed code).

const execFileP = promisify(execFile)

const PIPELINE_JOBS = [
  'ticker-refresh',
  'candle-refresh',
  'funding-refresh',
  'cmc-refresh',
  'radar-scan',
  'fund-mark',
  'brain-train',
  'equity-snapshot',
  'health',
]
const SICK_STREAK = 3 // consecutive failures ⇒ job is "sick"
const SIGNAL_TTL_H = 24 // open signals older than this → expired
const DB_VACUUM_MB = 40 // vacuum threshold
const TUNE_MIN_SAMPLES = 10 // bot trades in 14d before risk tuning engages
const RISK_MAX = 7
const RISK_MIN = 2

function parseSnap<T>(raw: string | null): Partial<T> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Partial<T>
  } catch {
    return {}
  }
}

function tehranDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date())
}

function dbFilePath(): string | null {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.startsWith('file:')) return null
  const p = url.slice(5).split('?')[0]
  return isAbsolute(p) ? p : join(process.cwd(), p)
}

function dbSizeMB(): number | null {
  try {
    const p = dbFilePath()
    if (!p) return null
    return statSync(p).size / (1024 * 1024)
  } catch {
    return null
  }
}

// ─── 1) Self-Heal (خودترمیمی) ───

export async function runSelfHeal(): Promise<string> {
  const actions: string[] = []

  // 0. DB integrity FIRST — on a corrupt DB every later query would throw and
  // self-heal would never reach its own repairs. db-doctor.py rebuilds a clean
  // file from all readable rows (meaningful data survives, hot caches
  // repopulate from the API). Cloud cycles are fresh processes → repaired file
  // is picked up immediately.
  let dbWasRepaired = false
  try {
    const qc = await db.$queryRawUnsafe<{ quick_check: string }[]>('PRAGMA quick_check(1);')
    const verdict0 = Array.isArray(qc) && qc[0] ? String(qc[0].quick_check) : 'ok'
    if (verdict0 !== 'ok') {
      const p = dbFilePath()
      if (p) {
        try {
          const r = await execFileP('python3', ['scripts/db-doctor.py', p], {
            cwd: process.cwd(),
            timeout: 240_000,
            maxBuffer: 16 * 1024 * 1024,
          })
          const out = r.stdout.trim().split('\n').pop() ?? ''
          if (out.startsWith('REPAIR OK')) {
            dbWasRepaired = true
            actions.push('دیتابیس خراب شناسایی و به‌صورت خودکار بازسازی شد — داده‌های مهم سالم منتقل شدند')
          } else {
            actions.push(`خرابی دیتابیس شناسایی شد ولی ترمیم خودکار کامل نشد (${out.slice(0, 60)})`)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 60) : 'خطا'
          actions.push(`خرابی دیتابیس شناسایی شد — اجرای ترمیم‌گر ناموفق (${msg})`)
        }
      }
    }
  } catch {
    /* even the probe failing must not kill self-heal */
  }
  if (dbWasRepaired) {
    await setSetting(
      'healSnapshot',
      JSON.stringify({ at: Date.now(), totalHeals: 1, recentActions: actions.slice(0, 8), sickNow: [] }),
    )
    return `ترمیم خودکار: ${actions.join(' | ')}`
  }

  // 1a. detect sick jobs (N consecutive failures)
  const sick: { job: string; err: string }[] = []
  for (const job of PIPELINE_JOBS) {
    const rows = await db.jobLog.findMany({ where: { job }, orderBy: { startedAt: 'desc' }, take: SICK_STREAK })
    if (rows.length >= SICK_STREAK && rows.every((r) => !r.ok)) {
      sick.push({ job, err: rows[0]?.error ?? '' })
    }
  }

  // 1b. remediation: data jobs failing ⇒ the universe list is the usual culprit
  // (delisted symbols make every fetch fail) → refresh it from the source.
  if (sick.some((s) => !['fund-mark', 'brain-train', 'equity-snapshot', 'health'].includes(s.job))) {
    try {
      await refreshUniverse()
      actions.push('فهرست نمادها از منبع اصلی تازه‌سازی شد (رفع نمادهای حذف‌شده)')
    } catch {
      actions.push('منبع داده در دسترس نیست — پایش و تلاش مجدد ادامه دارد')
    }
  }

  // 1c. DB lock errors ⇒ release with WAL checkpoint
  const recentErrs = await db.jobLog.findMany({ where: { ok: false }, orderBy: { startedAt: 'desc' }, take: 20 })
  if (recentErrs.some((r) => (r.error ?? '').includes('locked'))) {
    try {
      await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
      actions.push('قفل دیتابیس با checkpoint آزاد شد')
    } catch {
      /* ignore */
    }
  }

  // 1d. hygiene: expire stale open signals so radar & bot never chase them
  const expired = await db.signal.updateMany({
    where: { status: 'open', createdAt: { lt: new Date(Date.now() - SIGNAL_TTL_H * 3600_000) } },
    data: { status: 'expired' },
  })
  if (expired.count) actions.push(`${faNum(expired.count, 0)} سیگنال کهنه (بیش از ۲۴ ساعت) منقضی شد`)

  // 1e. data-corruption heal: open positions with impossible mark price
  const broken = await db.fundPosition.findMany({ where: { status: 'open', markPrice: { lte: 0 } }, select: { id: true, entryPrice: true } })
  for (const b of broken) {
    await db.fundPosition.update({ where: { id: b.id }, data: { markPrice: b.entryPrice } })
  }
  if (broken.length) actions.push(`${faNum(broken.length, 0)} پوزیشن با قیمت خراب اصلاح شد`)

  // snapshot for UI/reports
  const prev = parseSnap<{ totalHeals: number; recentActions: string[] }>(await getSetting('healSnapshot'))
  const snap = {
    at: Date.now(),
    totalHeals: (prev.totalHeals ?? 0) + (actions.length ? 1 : 0),
    recentActions: [...actions, ...(prev.recentActions ?? [])].slice(0, 8),
    sickNow: sick.map((s) => s.job),
  }
  await setSetting('healSnapshot', JSON.stringify(snap))

  if (!actions.length) {
    return sick.length
      ? `${faNum(sick.length, 0)} وظیفهٔ ناسالم دیده شد (${sick.map((s) => s.job).join('، ')}) — پایش و تلاش خودکار ادامه دارد`
      : 'سامانه سالم است — نیازی به ترمیم نبود'
  }
  return `ترمیم خودکار: ${actions.join(' | ')}`
}

// ─── 2) Self-Optimize + Self-Growth (خودبهینه‌سازی و خودرشد) ───

export async function runSelfOptimize(): Promise<string> {
  // cheap maintenance on every run
  try {
    await db.$queryRawUnsafe('PRAGMA optimize;')
  } catch {
    /* degrade */
  }

  const today = tehranDate()
  const last = (await getSetting('optimizeLastDate')) ?? ''
  const sizeMB = dbSizeMB()
  if (last === today) {
    return `بهینه‌سازی روزانه انجام شده — پایش ادامه دارد (حجم دیتابیس ${faNum(sizeMB ?? 0, 1)} مگابایت)`
  }
  await setSetting('optimizeLastDate', today)

  // VACUUM only when the DB file grew large
  let vacuumed = false
  if ((sizeMB ?? 0) > DB_VACUUM_MB) {
    try {
      await db.$queryRawUnsafe('VACUUM;')
      vacuumed = true
    } catch {
      /* degrade */
    }
  }

  // daily integrity probe — catch corruption early and surface it loudly
  let integrityFa = ''
  try {
    const qc = await db.$queryRawUnsafe<{ quick_check: string }[]>('PRAGMA quick_check;')
    const verdict = Array.isArray(qc) && qc[0] ? String(qc[0].quick_check) : 'unknown'
    if (verdict === 'ok') {
      integrityFa = ' · سلامت دیتابیس: تأیید شد'
    } else {
      integrityFa = ' · ⚠️ دیتابیس خرابی نشان می‌دهد — نیاز به ترمیم دستی'
    }
  } catch {
    integrityFa = ' · ⚠️ بررسی سلامت دیتابیس ناموفق بود'
  }

  // adaptive risk (self-growth): tune risk & entry threshold from the bot's own
  // closed trades of the last 14 days — reinforce what works, restrain what doesn't.
  const since14 = new Date(Date.now() - 14 * 24 * 3600_000)
  const closed = await db.fundPosition.findMany({
    where: { status: 'closed', reasonFa: { startsWith: BOT_PREFIX }, closedAt: { gte: since14 } },
    select: { pnlUsdt: true },
  })
  const [risk, botCfg] = await Promise.all([getRiskConfig(), getBotConfig()])
  const n = closed.length
  const wins = closed.filter((p) => (p.pnlUsdt ?? 0) > 0)
  const grossWin = wins.reduce((a, p) => a + (p.pnlUsdt ?? 0), 0)
  const grossLoss = Math.abs(closed.filter((p) => (p.pnlUsdt ?? 0) <= 0).reduce((a, p) => a + (p.pnlUsdt ?? 0), 0))
  const winRate = n ? wins.length / n : 0
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0

  let riskAfter = risk.riskPerTradePct
  let minScoreAfter = botCfg.minScore
  let tuned = false
  let actionFa: string
  if (n >= TUNE_MIN_SAMPLES) {
    if (winRate >= 0.55 && pf >= 1.2 && riskAfter < RISK_MAX) {
      riskAfter = Math.min(RISK_MAX, riskAfter + 0.5)
      tuned = true
      actionFa = `عملکرد خوب (برد ${faNum(winRate * 100, 0)}٪) — ریسک هر معامله از ${faNum(risk.riskPerTradePct, 1)} به ${faNum(riskAfter, 1)}٪ افزایش یافت (رشد)`
    } else if (winRate < 0.4 || pf < 0.7) {
      riskAfter = Math.max(RISK_MIN, riskAfter - 1)
      minScoreAfter = Math.min(90, minScoreAfter + 5)
      tuned = true
      actionFa = `عملکرد ضعیف (برد ${faNum(winRate * 100, 0)}٪) — ریسک به ${faNum(riskAfter, 1)}٪ کاهش و حداقل امتیاز ورود به ${faNum(minScoreAfter, 0)} سخت‌گیرانه‌تر شد (حفظ سرمایه)`
    } else {
      actionFa = `عملکرد متعادل (برد ${faNum(winRate * 100, 0)}٪، ضریب سود ${faNum(pf, 2)}) — پارامترها بدون تغییر`
    }
  } else {
    actionFa = `نمونهٔ کافی برای تنظیم خودکار نیست (${faNum(n, 0)} از ${faNum(TUNE_MIN_SAMPLES, 0)} معاملهٔ ربات در ۱۴ روز)`
  }
  if (tuned) {
    await setSetting('riskPerTradePct', String(riskAfter))
    await setSetting('botMinScore', String(minScoreAfter))
  }

  await setSetting(
    'optimizeSnapshot',
    JSON.stringify({
      at: Date.now(),
      sizeMB,
      vacuumed,
      integrity: integrityFa,
      riskBefore: risk.riskPerTradePct,
      riskAfter,
      minScoreAfter,
      samples: n,
      winRate,
      action: actionFa,
    }),
  )
  return `بهینه‌سازی روزانه: PRAGMA optimize${vacuumed ? ' + VACUUM' : ''} — ${actionFa}${integrityFa}`
}

// ─── 3) Self-Update (خودبروزرسانی) ───

interface GitRes {
  ok: boolean
  out: string
  err: string
}

async function git(args: string[], timeoutMs = 90_000): Promise<GitRes> {
  try {
    const r = await execFileP('git', args, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    })
    return { ok: true, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: (err.stdout ?? '').trim(), err: (err.stderr ?? '').trim() || err.message || 'خطای گیت' }
  }
}

async function saveVersionInfo(v: Record<string, unknown>): Promise<void> {
  const prev = parseSnap<{ updatedCount: number; syncCount: number }>(await getSetting('versionInfo'))
  await setSetting(
    'versionInfo',
    JSON.stringify({
      at: Date.now(),
      updatedCount: prev.updatedCount ?? 0,
      syncCount: prev.syncCount ?? 0,
      ...v,
    }),
  )
}

/** After a successful pull: schema push + dependency install when those files changed. */
async function postUpdateSteps(changed: string[]): Promise<string> {
  let extra = ''
  if (changed.includes('prisma/schema.prisma')) {
    try {
      await execFileP('npx', ['prisma', 'db', 'push'], { cwd: process.cwd(), timeout: 240_000 })
      extra += ' + ساختار دیتابیس همگام شد'
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : ''
      extra += ` (همگام‌سازی دیتابیس ناموفق: ${msg})`
    }
  }
  if (changed.includes('package.json')) {
    try {
      await execFileP('bun', ['install'], { cwd: process.cwd(), timeout: 300_000 })
      extra += ' + کتابخانه‌ها نصب شد'
    } catch {
      try {
        await execFileP('npm', ['install'], { cwd: process.cwd(), timeout: 420_000 })
        extra += ' + کتابخانه‌ها نصب شد'
      } catch {
        extra += ' (نصب کتابخانه‌ها ناموفق)'
      }
    }
  }
  return extra
}

export async function runSelfUpdate(): Promise<string> {
  // Cloud: the 15-min workflow always checks out the newest pushed code —
  // here "self-update" just records which version is live.
  if (process.env.GITHUB_ACTIONS === 'true') {
    const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7)
    const ls = await git(['log', '-1', '--format=%s'])
    const subject = ls.ok ? ls.out : ''
    await saveVersionInfo({ mode: 'cloud', sha, subject, updated: false, note: '' })
    return `نسخهٔ فعال ابری: ${sha} — هر چرخهٔ ۱۵ دقیقه‌ای خودش آخرین کد را اجرا می‌کند`
  }

  // Local: fetch → compare → safe fast-forward update (never rebase/force).
  const fetchRes = await git(['fetch', 'origin', 'main'], 60_000)
  if (!fetchRes.ok) {
    await saveVersionInfo({ mode: 'local', updated: false, note: 'دسترسی به مخزن برقرار نشد' })
    return 'خودبروزرسانی: دسترسی به مخزن برقرار نشد — بعداً تلاش می‌شود'
  }

  const head = (await git(['rev-parse', 'HEAD'])).out
  const remote = (await git(['rev-parse', 'origin/main'])).out
  if (!head || !remote) {
    await saveVersionInfo({ mode: 'local', updated: false, note: 'وضعیت گیت خوانده نشد' })
    return 'خودبروزرسانی: وضعیت مخزن خوانده نشد — بعداً تلاش می‌شود'
  }

  const subject = (await git(['log', '-1', '--format=%s', remote])).out || ''

  // up to date?
  if (head === remote) {
    await saveVersionInfo({ mode: 'local', sha: remote.slice(0, 7), subject, updated: false, note: '' })
    return 'کد سامانه از قبل جدیدترین نسخه است'
  }

  const behind = (await git(['merge-base', '--is-ancestor', head, remote])).ok
  const ahead = (await git(['merge-base', '--is-ancestor', remote, head])).ok

  // strictly behind → safe update (rebase keeps our newest local DB snapshot on top)
  if (behind && !ahead) {
    // protect the local DB state as a snapshot commit first
    const dirty = (await git(['status', '--porcelain', '--', 'db/custom.db'])).out
    if (dirty) {
      await git(['add', 'db/custom.db'])
      await git(['commit', '-m', 'data: local snapshot (self-update)'])
    }
    // replay the local db snapshot onto remote tip; on binary conflict OUR newer DB wins
    const merged = await git(['pull', '--rebase', '--autostash', '-X', 'theirs', 'origin', 'main'], 180_000)
    if (!merged.ok) {
      await git(['rebase', '--abort'], 30_000).catch(() => undefined) // leave a clean state
      await saveVersionInfo({ mode: 'local', updated: false, note: 'ادغام خودکار ناموفق' })
      return `خودبروزرسانی: ادغام خودکار ناموفق — نیاز به بررسی (${merged.err.slice(0, 60)})`
    }
    const changed = (await git(['diff', '--name-only', head, 'HEAD'])).out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const extra = await postUpdateSteps(changed)
    const prev = parseSnap<{ updatedCount: number }>(await getSetting('versionInfo'))
    await saveVersionInfo({
      mode: 'local',
      sha: remote.slice(0, 7),
      subject,
      updated: true,
      updatedCount: (prev.updatedCount ?? 0) + 1,
      note: '',
    })
    return `سامانه خودش را به نسخهٔ ${remote.slice(0, 7)} به‌روزرسانی کرد${extra}`
  }

  // strictly ahead → local has newer commits (usually just local data snapshots)
  if (ahead && !behind) {
    await saveVersionInfo({ mode: 'local', sha: head.slice(0, 7), subject, updated: false, note: 'محلی جلوتر است' })
    return 'کد به‌روز است — نسخهٔ محلی جلوتر از مخزن قرار دارد'
  }

  // diverged → auto-reconcile ONLY when local-only commits are pure DB snapshots
  const names = (await git(['log', '--format=', '--name-only', `${remote}..${head}`])).out
  const files = [...new Set(names.split('\n').map((s) => s.trim()).filter(Boolean))]
  if (files.length && files.every((f) => f === 'db/custom.db')) {
    const rs = await git(['reset', '--soft', remote])
    if (rs.ok) {
      await git(['add', 'db/custom.db'])
      const cm = await git(['commit', '-m', 'data: local db snapshot (self-update sync)'])
      if (cm.ok) {
        const prev = parseSnap<{ syncCount: number }>(await getSetting('versionInfo'))
        await saveVersionInfo({
          mode: 'local',
          sha: remote.slice(0, 7),
          subject,
          updated: false,
          syncCount: (prev.syncCount ?? 0) + 1,
          note: 'همگام‌سازی خودکار داده',
        })
        return 'همگام‌سازی خودکار انجام شد (دادهٔ محلی با مخزن یکپارچه شد)'
      }
    }
  }
  await saveVersionInfo({ mode: 'local', updated: false, note: 'واگرایی تاریخچه — نیاز به بررسی' })
  return 'خودبروزرسانی: تاریخچهٔ مخزن واگراست — برای ایمنی، به‌روزرسانی خودکار متوقف ماند (نیاز به بررسی)'
}
