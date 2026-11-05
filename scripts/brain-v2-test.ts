// One-shot local test of Brain v2 (no server needed):
// backfill → evaluate → train → report weights/trust/accuracy.
import { db, ensurePragmas } from '@/lib/db'
import { ensureDefaults, getBrainWeights, getSetting } from '@/lib/settings'
import { backfillBrain } from '@/lib/backfill'
import { evaluateDueSamples, trainBrain, runSelfTest, computeFeatures } from '@/lib/brain'
import { loadCandles } from '@/lib/candles'

async function main(): Promise<void> {
  await ensurePragmas()
  await ensureDefaults()

  const w0 = await getBrainWeights()

  console.log('── 1) BACKFILL (deep) ──')
  const t0 = Date.now()
  console.log(await backfillBrain({ deep: true }), `(${Date.now() - t0}ms)`)

  console.log('── 2) EVALUATE due samples ──')
  const ev = await evaluateDueSamples()
  console.log(`evaluated=${ev.evaluated} tp=${ev.tpHits} sl=${ev.slHits} timeout=${ev.timeouts}`)

  console.log('── 3) TRAIN ──')
  const tr = await trainBrain()
  console.log(`trained=${tr.trained} evaluatedCount=${tr.evaluatedCount}`)
  console.log(tr.detail)

  const w1 = await getBrainWeights()
  console.log('── 4) WEIGHTS (before → after) ──')
  for (const k of Object.keys(w1) as (keyof typeof w1)[]) {
    const a = w0[k]
    const b = w1[k]
    console.log(`${k.padEnd(8)} ${a.toFixed(2)} → ${b.toFixed(2)}${Math.abs(a - b) > 0.001 ? '  *changed*' : ''}`)
  }

  console.log('── 5) STRATEGY TRUST ──')
  console.log((await getSetting('strategyTrust')) ?? '{}')

  console.log('── 6) SELF TEST ──')
  const st = await runSelfTest()
  console.log(
    st.overall
      ? `accuracy=${st.overall.accuracy.toFixed(1)}% n=${st.overall.total} avgPnl=${st.overall.avgPnlPct.toFixed(2)}% tp=${st.overall.tpRate.toFixed(0)}% sl=${st.overall.slRate.toFixed(0)}%`
      : 'no evaluated samples',
  )

  console.log('── 7) mtf FEATURE sanity (BTCUSDT live candles) ──')
  const c = await loadCandles('BTCUSDT', '1h', 300)
  const f = computeFeatures({ candles1h: c, fundingRaw: null, oiNow: null, oi24hAgo: null, btcRet24h: 0 })
  console.log(f ? `mtf=${f.mtf.toFixed(3)} trend=${f.trend.toFixed(3)} rsi=${f.rsiRaw.toFixed(1)}` : 'features=null')

  const total = await db.brainSample.count()
  const evaluatedN = await db.brainSample.count({ where: { evaluatedAt: { not: null } } })
  const backfilled = await db.brainSample.count({ where: { source: 'backfill' } })
  console.log(`── TOTALS ── samples=${total} evaluated=${evaluatedN} backfilled=${backfilled}`)

  try {
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* degrade */
  }
  await db.$disconnect()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
