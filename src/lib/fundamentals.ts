import { db } from '@/lib/db'
import { getSetting, setSetting } from '@/lib/settings'
import { atr, ema, rsi, type CandleRow } from '@/lib/indicators'
import { faNum, faPct } from '@/lib/fa'

// ─── Fundamentals: وضعیت بنیادی هر ارز — فقط از داده‌های محلی (بدون تماس API اضافه) ───
// امتیاز ۰ تا ۱۰۰ از ترکیب ۵ عامل:
//   رتبه بازار (۳۰) + نقدشوندگی حجم روزانه (۲۵) + باثباتی نوسان (۲۰) + سلامت روند روزانه (۱۵) + فشار فاندینگ (۱۰)
// منابع: Coin (رتبه/ارزش بازار از CMC)، TickerSnapshot (قیمت/حجم)، FundingSnapshot (فاندینگ)، Candle 1d (روند/نوسان)
// نتیجه در Setting «fundamentalsSnapshot» کش می‌شود تا داشبورد و API سریع باشند.

export type FundamentalLevel = 'strong' | 'mid' | 'weak'

export const FUNDAMENTAL_LEVEL_FA: Record<FundamentalLevel, string> = {
  strong: 'بنیاد قوی',
  mid: 'بنیاد متوسط',
  weak: 'بنیاد ضعیف',
}

export interface FundamentalRow {
  symbol: string
  base: string
  name: string
  rank: number
  price: number | null
  change24h: number | null
  volume24h: number | null
  marketCap: number
  fundingRate: number | null
  rsi1d: number | null
  volatilityPct: number | null // ATR روزانه بر حسب ٪ قیمت
  perf7d: number | null
  perf30d: number | null
  trendFa: string
  score: number // 0..100
  level: FundamentalLevel
  levelFa: string
  reasonsFa: string[]
}

export interface FundamentalsSnapshot {
  at: number
  rows: FundamentalRow[]
  fearGreed: { value: number; classificationFa: string } | null
  global: { totalMarketCap: number; totalVolume24h: number; btcDominance: number } | null
}

/** قالب‌بندی اعداد بزرگ دلاری برای نمایش فارسی */
export function faBigUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e12) return `${faNum(n / 1e12, 2)} هزار میلیارد دلار`
  if (n >= 1e9) return `${faNum(n / 1e9, 2)} میلیارد دلار`
  if (n >= 1e6) return `${faNum(n / 1e6, 1)} میلیون دلار`
  return `${faNum(n, 0)} دلار`
}

// ─── امتیازدهی هر عامل ───

function rankScore(rank: number, hasCmc: boolean): number {
  if (!Number.isFinite(rank) || rank <= 0) return 14
  if (rank <= 5) return 30
  if (rank <= 10) return 26
  if (rank <= 20) return 21
  if (rank <= 35) return 16
  return hasCmc ? 11 : 13 // بدون CMC رتبه بر اساس حجم است — خنثی‌تر
}

function liquidityScore(volume24h: number | null): number {
  if (volume24h === null || !Number.isFinite(volume24h) || volume24h <= 0) return 8 // نامشخص → خنثی
  if (volume24h >= 1e9) return 25
  if (volume24h >= 5e8) return 21
  if (volume24h >= 2e8) return 17
  if (volume24h >= 1e8) return 13
  if (volume24h >= 5e7) return 9
  if (volume24h >= 2e7) return 6
  return 3
}

function stabilityScore(atrPct: number | null): number {
  if (atrPct === null || !Number.isFinite(atrPct)) return 10
  if (atrPct <= 2) return 20
  if (atrPct <= 3) return 16
  if (atrPct <= 4.5) return 12
  if (atrPct <= 6) return 8
  if (atrPct <= 8) return 5
  return 2
}

function trendScore(price: number | null, e20: number | null, e50: number | null): number {
  if (price === null || e20 === null || e50 === null) return 7
  const above20 = price > e20
  const above50 = price > e50
  if (above20 && above50) return 15
  if (above50) return 11
  if (above20) return 7
  return 3
}

function fundingScore(f: number | null): number {
  if (f === null || !Number.isFinite(f)) return 6
  const a = Math.abs(f)
  if (a <= 0.0001) return 10
  if (a <= 0.0003) return 7
  if (a <= 0.0006) return 4
  return 1
}

function trendLabelFa(price: number | null, e20: number | null, e50: number | null, perf7d: number | null): string {
  if (price === null || e20 === null || e50 === null) return 'نامشخص (کندل روزانه کافی نیست)'
  const above20 = price > e20
  const above50 = price > e50
  if (above20 && above50) return perf7d !== null && perf7d < -5 ? 'صعودی اما در حال اصلاح' : 'صعودی'
  if (above50) return 'نیمه‌صعودی'
  if (above20) return 'نیمه‌نزولی در حال بهبود'
  return perf7d !== null && perf7d < -10 ? 'نزولی شدید' : 'نزولی'
}

interface ReasonInput {
  rank: number
  hasCmc: boolean
  volume24h: number | null
  atrPct: number | null
  price: number | null
  e20: number | null
  e50: number | null
  perf7d: number | null
  fundingRate: number | null
  rsi1d: number | null
}

function buildReasonsFa(p: ReasonInput): string[] {
  const out: string[] = []
  if (p.rank <= 10) out.push(`رتبه ${faNum(p.rank, 0)} بازار — از پروژه‌های بزرگ و جاافتاده`)
  else if (p.rank <= 35) out.push(`رتبه ${faNum(p.rank, 0)} بازار — پروژه‌ای شناخته‌شده`)
  else out.push(`رتبه ${faNum(p.rank, 0)} در پوشش سیستم${p.hasCmc ? '' : ' (بر اساس حجم معاملات)'} — پروژهٔ کوچک‌تر و پرریسک‌تر`)

  const v = p.volume24h
  if (v !== null && v > 0) {
    const q = v >= 1e9 ? 'نقدشوندگی عالی' : v >= 1e8 ? 'نقدشوندگی خوب' : v >= 2e7 ? 'نقدشوندگی متوسط' : 'نقدشوندگی کم'
    out.push(`حجم معاملات ۲۴ساعت: ${faBigUsd(v)} — ${q}`)
  }

  if (p.atrPct !== null) {
    const q = p.atrPct <= 3 ? 'باثبات' : p.atrPct <= 6 ? 'نوسان معمول' : 'پرنوسان و پرریسک'
    out.push(`نوسان روزانه حدود ${faNum(p.atrPct, 1)}٪ — ${q}`)
  }

  if (p.price !== null && p.e20 !== null && p.e50 !== null) {
    const above20 = p.price > p.e20
    const above50 = p.price > p.e50
    out.push(
      above20 && above50
        ? 'قیمت بالای میانگین‌های ۲۰ و ۵۰ روزه — روند روزانه صعودی'
        : above50
          ? 'قیمت بالای میانگین ۵۰ روزه — ساختار روزانه سالم'
          : above20
            ? 'فقط بالای میانگین ۲۰ روزه — روند هنوز تثبیت نشده'
            : 'قیمت زیر میانگین‌های متحرک — ساختار روزانه ضعیف',
    )
  }

  if (p.perf7d !== null) out.push(`بازده ۷روزه: ${faPct(p.perf7d, 1, true)}`)

  if (p.fundingRate !== null) {
    const pct = faNum(Math.abs(p.fundingRate) * 100, 3)
    if (Math.abs(p.fundingRate) <= 0.0001) out.push(`نرخ فاندینگ ${pct}٪ — طبیعی، بدون ازدحام`)
    else if (p.fundingRate > 0) out.push(`نرخ فاندینگ +${pct}٪ — ازدحام خریداران (ریسک اصلاح)`)
    else out.push(`نرخ فاندینگ −${pct}٪ — ازدحام فروشندگان (پتانسیل جهش)`)
  }

  if (p.rsi1d !== null && p.rsi1d >= 70) out.push(`RSI روزانه ${faNum(p.rsi1d, 0)} — اشباع خرید؛ احتیاط در ورود جدید`)
  else if (p.rsi1d !== null && p.rsi1d <= 30) out.push(`RSI روزانه ${faNum(p.rsi1d, 0)} — اشباع فروش؛ احتمال برگشت`)

  return out.slice(0, 6)
}

async function buildFundamentals(): Promise<FundamentalsSnapshot> {
  const coins = await db.coin.findMany({ orderBy: { rank: 'asc' } })
  const symbols = coins.map((c) => c.symbol)
  if (!symbols.length) return { at: Date.now(), rows: [], fearGreed: null, global: null }

  const [tickerRows, fundingRows, candleRows, fgRaw, gmRaw] = await Promise.all([
    Promise.all(
      symbols.map((sym) =>
        db.tickerSnapshot.findFirst({
          where: { symbol: sym },
          orderBy: { ts: 'desc' },
          select: { price: true, change24h: true, volume24h: true },
        }),
      ),
    ),
    Promise.all(
      symbols.map((sym) =>
        db.fundingSnapshot.findFirst({
          where: { symbol: sym },
          orderBy: { ts: 'desc' },
          select: { fundingRate: true },
        }),
      ),
    ),
    db.candle.findMany({
      where: { symbol: { in: symbols }, interval: '1d' },
      orderBy: { ts: 'asc' },
      select: { symbol: true, ts: true, open: true, high: true, low: true, close: true, volume: true },
    }),
    getSetting('fearGreed').catch(() => null),
    getSetting('globalMetrics').catch(() => null),
  ])

  const daily = new Map<string, CandleRow[]>()
  for (const r of candleRows) {
    const arr = daily.get(r.symbol) ?? []
    arr.push({ ts: r.ts.getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })
    daily.set(r.symbol, arr)
  }

  let fearGreed: FundamentalsSnapshot['fearGreed'] = null
  try {
    if (fgRaw) {
      const p = JSON.parse(fgRaw) as { value?: number; classificationFa?: string }
      if (p && typeof p.value === 'number') fearGreed = { value: p.value, classificationFa: p.classificationFa ?? '' }
    }
  } catch {
    /* ignore */
  }
  let global: FundamentalsSnapshot['global'] = null
  try {
    if (gmRaw) {
      const p = JSON.parse(gmRaw) as { totalMarketCap?: number; totalVolume24h?: number; btcDominance?: number }
      if (p && typeof p.btcDominance === 'number')
        global = { totalMarketCap: p.totalMarketCap ?? 0, totalVolume24h: p.totalVolume24h ?? 0, btcDominance: p.btcDominance }
    }
  } catch {
    /* ignore */
  }

  const rows: FundamentalRow[] = []
  for (let i = 0; i < coins.length; i++) {
    const c = coins[i]
    const t = tickerRows[i]
    const f = fundingRows[i]
    const candles = daily.get(c.symbol) ?? []
    const closes = candles.map((x) => x.close)
    const price = t?.price ?? (closes.length ? closes[closes.length - 1] : null)

    const rsi1d = closes.length >= 16 ? rsi(closes, 14) : null
    const atrPct = candles.length >= 15 && price ? (atr(candles, 14) / price) * 100 : null
    const e20 = closes.length >= 20 ? ema(closes, 20) : null
    const e50 = closes.length >= 50 ? ema(closes, 50) : null
    const close7 = closes.length >= 8 ? closes[closes.length - 8] : null
    const close30 = closes.length >= 31 ? closes[closes.length - 31] : null
    const perf7d = price && close7 ? (price / close7 - 1) * 100 : null
    const perf30d = price && close30 ? (price / close30 - 1) * 100 : null

    const hasCmc = c.marketCap > 0
    const sRank = rankScore(c.rank, hasCmc)
    const sLiq = liquidityScore(t?.volume24h ?? null)
    const sStab = stabilityScore(atrPct)
    const sTrend = trendScore(price, e20, e50)
    const sFund = fundingScore(f?.fundingRate ?? null)
    const score = Math.round(sRank + sLiq + sStab + sTrend + sFund)
    const level: FundamentalLevel = score >= 70 ? 'strong' : score >= 50 ? 'mid' : 'weak'

    rows.push({
      symbol: c.symbol,
      base: c.base,
      name: c.name || c.base,
      rank: c.rank,
      price,
      change24h: t?.change24h ?? null,
      volume24h: t?.volume24h ?? null,
      marketCap: c.marketCap,
      fundingRate: f?.fundingRate ?? null,
      rsi1d,
      volatilityPct: atrPct,
      perf7d,
      perf30d,
      trendFa: trendLabelFa(price, e20, e50, perf7d),
      score,
      level,
      levelFa: FUNDAMENTAL_LEVEL_FA[level],
      reasonsFa: buildReasonsFa({
        rank: c.rank,
        hasCmc,
        volume24h: t?.volume24h ?? null,
        atrPct,
        price,
        e20,
        e50,
        perf7d,
        fundingRate: f?.fundingRate ?? null,
        rsi1d,
      }),
    })
  }

  rows.sort((a, b) => b.score - a.score || a.rank - b.rank)
  return { at: Date.now(), rows, fearGreed, global }
}

/**
 * محاسبهٔ وضعیت بنیادی کل جهان‌نما.
 * maxAgeMs > 0 → اول کش (Setting «fundamentalsSnapshot») را چک می‌کند؛ اگر تازه بود همان برمی‌گردد.
 */
export async function computeFundamentals(opts?: { maxAgeMs?: number }): Promise<FundamentalsSnapshot> {
  const maxAge = opts?.maxAgeMs ?? 0
  if (maxAge > 0) {
    const raw = await getSetting('fundamentalsSnapshot').catch(() => null)
    if (raw) {
      try {
        const snap = JSON.parse(raw) as FundamentalsSnapshot
        if (snap?.at && Date.now() - snap.at < maxAge && Array.isArray(snap.rows) && snap.rows.length) return snap
      } catch {
        /* recompute */
      }
    }
  }
  const snap = await buildFundamentals()
  try {
    await setSetting('fundamentalsSnapshot', JSON.stringify(snap))
  } catch {
    /* cache failure never blocks */
  }
  return snap
}
