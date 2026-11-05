import { NextResponse } from 'next/server'
import { ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { computeFundamentals } from '@/lib/fundamentals'

export const dynamic = 'force-dynamic'

/** وضعیت بنیادی + جزییات هر ارز (کش ۱۰ دقیقه‌ای — بدون تماس API اضافه) */
export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()
    const snap = await computeFundamentals({ maxAgeMs: 10 * 60_000 })
    return NextResponse.json(snap)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
