import { NextRequest, NextResponse } from 'next/server'
import { ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { keyStatus, KEYS } from '@/lib/env'
import { getMode, getRiskConfig, getBrainWeights, getBotConfig, setSetting, FEATURE_KEYS, type FeatureKey } from '@/lib/settings'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()
    const [mode, risk, weights, bot] = await Promise.all([getMode(), getRiskConfig(), getBrainWeights(), getBotConfig()])
    return NextResponse.json({
      mode,
      keys: keyStatus(),
      risk,
      weights: FEATURE_KEYS.map((k: FeatureKey) => ({ key: k, weight: weights[k] })),
      bot,
      adminLockEnabled: KEYS.adminToken.length > 0,
      connector: {
        name: 'Toobit',
        phase: 2,
        note: 'اتصال فاز ۲ — آمادهٔ فعال‌سازی',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}

/** Verify the admin token the user pasted in Settings (stored client-side),
 *  or — with a botEnabled payload — toggle the auto-trader bot. */
export async function POST(req: NextRequest) {
  const auth = requireAdmin(req)
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  await ensurePragmas()

  let body: { botEnabled?: string } = {}
  try {
    body = (await req.json()) as { botEnabled?: string }
  } catch {
    /* empty body → token verification only */
  }

  if (body.botEnabled === 'on' || body.botEnabled === 'off') {
    await setSetting('botEnabled', body.botEnabled)
    return NextResponse.json({
      ok: true,
      message: body.botEnabled === 'on' ? 'ربات معامله‌گر روشن شد' : 'ربات معامله‌گر خاموش شد',
      botEnabled: body.botEnabled,
    })
  }

  return NextResponse.json({ ok: true, message: 'توکن مدیریت تأیید شد' })
}
