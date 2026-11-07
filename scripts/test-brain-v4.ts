// تست عملی مغز v4: ارزیابی + آموزش + کشف درس‌ها روی دیتابیس محلی
import { evaluateDueSamples, trainBrain, runSelfTest } from '../src/lib/brain'
import { mineLessons } from '../src/lib/lessons'

const t0 = Date.now()
const ev = await evaluateDueSamples()
console.log(`EVAL: evaluated=${ev.evaluated} tp=${ev.tpHits} sl=${ev.slHits} timeout=${ev.timeouts} (${Date.now() - t0}ms)`)

const t1 = Date.now()
const tr = await trainBrain()
console.log(`TRAIN: trained=${tr.trained} (${Date.now() - t1}ms)`)
console.log(`DETAIL: ${tr.detail.slice(0, 400)}`)

const t2 = Date.now()
const st = await runSelfTest()
console.log(`SELFTEST: n=${st.overall?.total ?? 0} accuracy=${st.overall ? st.overall.accuracy.toFixed(1) : '-'}% (${Date.now() - t2}ms)`)
console.log(`TOTAL_TIME: ${Date.now() - t0}ms`)
