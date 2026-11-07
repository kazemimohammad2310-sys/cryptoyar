// تست عملی پامپ-پک v4: CVD + رژیم OI + موج حجم روی دادهٔ واقعی Binance
import { getKlines, getFundingRate, getOpenInterest } from '../src/lib/fetchers/binance'
import { computeFeatures, scoreFeatures } from '../src/lib/brain'
import { checkMomentumBreakout } from '../src/lib/radar'
import { getBrainWeights } from '../src/lib/settings'

const SYMBOLS = ['BTCUSDT', 'SOLUSDT', 'DOGEUSDT']
const weights = await getBrainWeights()
console.log('WEIGHTS:', JSON.stringify(weights))

for (const s of SYMBOLS) {
  const c = await getKlines(s, '1h', 300)
  const funding = await getFundingRate(s).catch(() => null)
  const oiNow = await getOpenInterest(s).catch(() => null)
  const btc = s === 'BTCUSDT' ? c : await getKlines('BTCUSDT', '1h', 26)
  const btcRet = btc.length > 25 ? (btc[btc.length - 1].close / btc[btc.length - 25].close - 1) * 100 : 0
  const f = computeFeatures({
    candles1h: c,
    fundingRaw: funding?.fundingRate ?? null,
    oiNow,
    oi24hAgo: null, // بدون تاریخچه — رژیم OI باید ۰ شود
    btcRet24h: btcRet,
  })
  if (!f) { console.log(`${s}: features=null`); continue }
  const { score } = scoreFeatures(f, weights)
  const tb = c[c.length - 1].takerBuyBase ?? 0
  const share = c[c.length - 1].volume > 0 ? ((tb / c[c.length - 1].volume) * 100).toFixed(1) : '-'
  console.log(
    `${s}: cvd=${f.cvd.toFixed(2)} oiRegime=${f.oiRegime.toFixed(2)}(oi:null→0) volSurge=${f.volSurge.toFixed(2)} takerShare=${share}% score=${score.toFixed(1)} breakout=${checkMomentumBreakout(c) ?? '-'}`,
  )
}
console.log('PUMP-PACK TEST DONE')
