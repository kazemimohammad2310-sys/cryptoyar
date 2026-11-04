import { NextResponse } from 'next/server'
import { db, ensurePragmas } from '@/lib/db'
import { ensureBooted } from '@/lib/boot'
import { getBrainWeights, getSetting, FEATURE_KEYS, type FeatureKey } from '@/lib/settings'
import { runSelfTest, MIN_SAMPLES_FOR_TRAINING } from '@/lib/brain'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensurePragmas()
    await ensureBooted()

    const [total, evaluated, pending, weights, trainedAt, accuracyRaw, historyRaw] = await Promise.all([
      db.brainSample.count(),
      db.brainSample.count({ where: { evaluatedAt: { not: null } } }),
      db.brainSample.count({ where: { evaluatedAt: null } }),
      getBrainWeights(),
      getSetting('brainTrainedAt'),
      getSetting('brainAccuracy'),
      getSetting('brainHistory'),
    ])

    const selfTest = await runSelfTest().catch(() => null)

    const samples = await db.brainSample.findMany({
      where: { evaluatedAt: { not: null } },
      orderBy: { evaluatedAt: 'desc' },
      take: 20,
    })

    let history: { at: number; accuracy: number }[] = []
    try {
      if (historyRaw) history = JSON.parse(historyRaw) as { at: number; accuracy: number }[]
    } catch {
      history = []
    }

    // brainTrainedAt is a JSON snapshot { at, trained, detail } written by trainBrain
    let training: { at: number; trained: boolean; detail: string } | null = null
    try {
      if (trainedAt) training = JSON.parse(trainedAt) as { at: number; trained: boolean; detail: string }
    } catch {
      training = null
    }

    return NextResponse.json({
      counts: { total, evaluated, pending, coldStart: total < MIN_SAMPLES_FOR_TRAINING, minForTraining: MIN_SAMPLES_FOR_TRAINING },
      weights: FEATURE_KEYS.map((k: FeatureKey) => ({ key: k, weight: weights[k] })),
      training,
      selfTest,
      history,
      samples: samples.map((s) => ({
        id: s.id,
        symbol: s.symbol,
        side: s.side,
        strategy: s.strategy,
        horizonHours: s.horizonHours,
        predicted: s.predicted,
        outcome: s.outcome,
        pnlPct: s.pnlPct,
        ftOutcome: s.ftOutcome,
        ftPnlPct: s.ftPnlPct,
        createdAt: s.createdAt.getTime(),
        evaluatedAt: s.evaluatedAt?.getTime() ?? null,
      })),
      cachedAccuracy: accuracyRaw || null,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'خطای ناشناخته' },
      { status: 500 },
    )
  }
}
