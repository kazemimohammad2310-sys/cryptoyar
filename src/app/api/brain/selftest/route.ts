import { NextResponse } from 'next/server'
import { ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { runSelfTest } from '@/lib/brain'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()
    const r = await runSelfTest()
    return NextResponse.json(r)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
