import { NextRequest, NextResponse } from 'next/server'
import { ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { keyStatus, KEYS } from '@/lib/env'
import { getMode, getRiskConfig, getBrainWeights, getBotConfig, getFuturesConfig, setSetting, getSetting, FEATURE_KEYS, type FeatureKey } from '@/lib/settings'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function parseSnap<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()
    const [mode, risk, weights, bot, futures, healRaw, optRaw, verRaw] = await Promise.all([
      getMode(),
      getRiskConfig(),
      getBrainWeights(),
      getBotConfig(),
      getFuturesConfig(),
      getSetting('healSnapshot'),
      getSetting('optimizeSnapshot'),
      getSetting('versionInfo'),
    ])
    return NextResponse.json({
      mode,
      keys: keyStatus(),
      risk,
      weights: FEATURE_KEYS.map((k: FeatureKey) => ({ key: k, weight: weights[k] })),
      bot,
      futures,
      adminLockEnabled: KEYS.adminToken.length > 0,
      connector: {
        name: 'Toobit',
        phase: 2,
        note: 'اتصال فاز ۲ — آمادهٔ فعال‌سازی',
      },
      autonomy: {
        heal: parseSnap<{ at: number; totalHeals: number; recentActions: string[]; sickNow: string[] }>(healRaw),
        optimize: parseSnap<{ at: number; sizeMB: number | null; riskBefore: number; riskAfter: number; samples: number; winRate: number; action: string }>(optRaw),
        version: parseSnap<{ at: number; sha: string; subject: string; updatedCount: number; syncCount: number }>(verRaw),
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

  let body: {
    botEnabled?: string
    futuresLeverageMode?: string
    futuresMaxLeverage?: number
    futuresFixedLeverage?: number
    botExpertGate?: string
  } = {}
  try {
    body = (await req.json()) as typeof body
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

  // ─── فیوچرز: اهرم قابل تنظیم ───
  const futuresMsg: string[] = []
  if (body.futuresLeverageMode === 'auto' || body.futuresLeverageMode === 'fixed') {
    await setSetting('futuresLeverageMode', body.futuresLeverageMode)
    futuresMsg.push(body.futuresLeverageMode === 'auto' ? 'اهرم خودکار (متناسب با ریسک و بنیاد)' : 'اهرم ثابت')
  }
  if (typeof body.futuresMaxLeverage === 'number' && Number.isFinite(body.futuresMaxLeverage)) {
    const n = Math.min(25, Math.max(1, Math.round(body.futuresMaxLeverage)))
    await setSetting('futuresMaxLeverage', String(n))
    futuresMsg.push(`سقف اهرم ×${n}`)
  }
  if (typeof body.futuresFixedLeverage === 'number' && Number.isFinite(body.futuresFixedLeverage)) {
    const n = Math.min(25, Math.max(1, Math.round(body.futuresFixedLeverage)))
    await setSetting('futuresFixedLeverage', String(n))
    futuresMsg.push(`اهرم ثابت ×${n}`)
  }
  if (body.botExpertGate === 'on' || body.botExpertGate === 'off') {
    await setSetting('botExpertGate', body.botExpertGate)
    futuresMsg.push(body.botExpertGate === 'on' ? 'دروازهٔ استادی روشن' : 'دروازهٔ استادی خاموش')
  }
  if (futuresMsg.length) {
    return NextResponse.json({ ok: true, message: `ثبت شد: ${futuresMsg.join(' — ')}` })
  }

  return NextResponse.json({ ok: true, message: 'توکن مدیریت تأیید شد' })
}
