import { NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { jobStatus, isBootstrapped } from '@/lib/nightshift'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()

    const [logs, jobs] = await Promise.all([
      db.jobLog.findMany({ orderBy: { startedAt: 'desc' }, take: 40 }),
      Promise.resolve(jobStatus()),
    ])

    return NextResponse.json({
      bootstrapped: isBootstrapped(),
      jobs: jobs.map((j) => ({
        name: j.name,
        fa: j.fa,
        intervalMs: j.intervalMs,
        running: j.running,
        last: j.last,
      })),
      logs: logs.map((l) => ({
        id: l.id,
        job: l.job,
        startedAt: l.startedAt.getTime(),
        finishedAt: l.finishedAt?.getTime() ?? null,
        ok: l.ok,
        error: l.error,
        detail: l.detail,
      })),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
