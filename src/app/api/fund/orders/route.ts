import { NextRequest, NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { requireAdmin } from '@/lib/auth'
import { openPosition, closePosition, FundError } from '@/lib/fund'

export const dynamic = 'force-dynamic'

interface OpenBody {
  action: 'open'
  signalId?: number
  symbol?: string
  side?: 'long' | 'short'
  reasonFa?: string
}
interface CloseBody {
  action: 'close'
  positionId: number
  reasonFa?: string
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    await ensurePragmas()
    await ensureBooted()

    const body = (await req.json().catch(() => null)) as OpenBody | CloseBody | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'بدنهٔ درخواست نامعتبر است' }, { status: 400 })
    }

    if (body.action === 'open') {
      if (!body.symbol || (body.side !== 'long' && body.side !== 'short')) {
        return NextResponse.json(
          { error: 'برای باز کردن پوزیشن، نماد و جهت (long/short) لازم است' },
          { status: 400 },
        )
      }
      const r = await openPosition({
        symbol: body.symbol.toUpperCase(),
        side: body.side,
        signalId: typeof body.signalId === 'number' ? body.signalId : undefined,
        reasonFa: body.reasonFa,
      })
      return NextResponse.json({ ok: true, ...r })
    }

    if (body.action === 'close') {
      if (typeof body.positionId !== 'number') {
        return NextResponse.json({ error: 'شناسهٔ پوزیشن لازم است' }, { status: 400 })
      }
      const r = await closePosition(body.positionId, body.reasonFa ?? 'بستن دستی توسط کاربر')
      return NextResponse.json({ ok: true, ...r })
    }

    return NextResponse.json({ error: 'عملیات پشتیبانی نمی‌شود (open|close)' }, { status: 400 })
  } catch (e) {
    if (e instanceof FundError) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
