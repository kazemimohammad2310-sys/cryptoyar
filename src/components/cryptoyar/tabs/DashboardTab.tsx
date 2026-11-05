'use client'

import { Activity, CircleDollarSign, Wallet } from 'lucide-react'
import { usePolling } from '@/components/cryptoyar/usePolling'
import { EmptyNote, PnlText, SectionTitle, SideChip, SkeletonBlock, Sparkline, StatCard } from '@/components/cryptoyar/kit'
import { faNum, faPct, faPrice } from '@/lib/fa'
import type { FundResp, MarketResp } from '@/components/cryptoyar/types'

function faCompactUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const units: [number, string][] = [
    [1e12, 'تریلیون'],
    [1e9, 'میلیارد'],
    [1e6, 'میلیون'],
  ]
  for (const [div, fa] of units) {
    if (Math.abs(n) >= div) return `${faNum(n / div, 2)} ${fa} دلار`
  }
  return `${faNum(n, 0)} دلار`
}

function fearColor(v: number): string {
  if (v <= 25) return 'cy-down' // ترس شدید
  if (v >= 55) return 'cy-up' // طمع
  return 'text-primary' // خنثی
}

export function DashboardTab() {
  const market = usePolling<MarketResp>('/api/market', 60_000)
  const fund = usePolling<FundResp>('/api/fund', 30_000)

  const g = market.data?.global ?? null
  const fg = market.data?.fearGreed ?? null
  const stats = fund.data?.stats ?? null
  const coins = market.data?.coins ?? []
  const gainers = coins.filter((c) => (c.change24h ?? 0) > 0).sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0)).slice(0, 6)
  const losers = coins.filter((c) => (c.change24h ?? 0) < 0).sort((a, b) => (a.change24h ?? 0) - (b.change24h ?? 0)).slice(0, 6)
  const openPositions = fund.data?.positions ?? []

  return (
    <div className="space-y-5">
      {/* stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {market.loading && fund.loading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonBlock key={i} className="h-[84px]" />)
        ) : (
          <>
            <StatCard
              label="سرمایهٔ صندوق شبیه‌ساز"
              tone="gold"
              value={stats ? `${faNum(fund.data?.equityNow ?? stats.equity, 2)} USDT` : '—'}
              sub={
                stats ? (
                  <>
                    سود کل: <PnlText usdt={stats.totalPnlUsdt} pct={stats.totalPnlPct} />
                  </>
                ) : (
                  '—'
                )
              }
            />
            <StatCard
              label="کلان بازار"
              value={g ? faCompactUsd(g.totalMarketCap) : 'در دسترس نیست'}
              sub={g ? (Number.isFinite(g.btcDominance) && g.btcDominance > 0 ? `سلطنت بیت‌کوین: ${faNum(g.btcDominance, 1)}٪` : 'به‌روزرسانی بعدی: چرخهٔ CMC') : 'کلید CMC در این نسخه ثبت نشده'}
            />
            <StatCard
              label="شاخص ترس و طمع"
              tone={fg ? undefined : 'plain'}
              value={
                fg ? (
                  <span className={fearColor(fg.value)}>
                    {faNum(fg.value, 0)} — {fg.classificationFa}
                  </span>
                ) : (
                  'در دسترس نیست'
                )
              }
              sub="مقیاس ۰ تا ۱۰۰"
            />
            <StatCard
              label="پوزیشن‌های باز"
              value={stats ? `${faNum(openPositions.length, 0)} از ${faNum(10, 0)}` : '—'}
              sub={stats ? `معاملات بسته‌شده: ${faNum(stats.closedCount, 0)}` : '—'}
            />
          </>
        )}
      </div>

      {/* equity curve */}
      <section>
        <SectionTitle icon={<Wallet className="h-4 w-4" />}>نمودار سرمایه (۴۸ نقطهٔ اخیر)</SectionTitle>
        <div className="rounded-xl border bg-card p-4">
          {fund.loading ? (
            <SkeletonBlock className="h-[60px]" />
          ) : (
            <Sparkline points={(fund.data?.equityCurve ?? []).map((p) => p.v)} />
          )}
        </div>
      </section>

      {/* movers */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle icon={<Activity className="h-4 w-4" />}>صدرنشینان ۲۴ ساعت</SectionTitle>
          <MoverList rows={gainers} loading={market.loading} />
        </div>
        <div>
          <SectionTitle icon={<Activity className="h-4 w-4" />}>قعرنشینان ۲۴ ساعت</SectionTitle>
          <MoverList rows={losers} loading={market.loading} />
        </div>
      </section>

      {/* open positions mini */}
      <section>
        <SectionTitle icon={<CircleDollarSign className="h-4 w-4" />}>پوزیشن‌های باز صندوق</SectionTitle>
        {fund.loading ? (
          <SkeletonBlock className="h-24" />
        ) : openPositions.length === 0 ? (
          <EmptyNote>هنوز پوزیشن بازی وجود ندارد — از تب «رادار فرصت‌ها» سیگنال‌ها را در صندوق ثبت کنید.</EmptyNote>
        ) : (
          <div className="space-y-2">
            {openPositions.slice(0, 5).map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-bold">{p.symbol}</span>
                  <SideChip side={p.side} />
                </div>
                <div className="text-xs text-muted-foreground">
                  ورود {faPrice(p.entryPrice)} ← لحظه‌ای {faPrice(p.markPrice)}
                </div>
                <PnlText usdt={p.pnlUsdt} pct={p.pnlPct} />
              </div>
            ))}
            {openPositions.length > 5 ? (
              <p className="text-center text-xs text-muted-foreground">و {faNum(openPositions.length - 5, 0)} پوزیشن دیگر — تب صندوق</p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

function MoverList({ rows, loading }: { rows: import('@/components/cryptoyar/types').CoinRow[]; loading: boolean }) {
  if (loading) return <SkeletonBlock className="h-40" />
  if (!rows.length) {
    return <EmptyNote>هنوز تیکری ثبت نشده — موتور داده در حال گرم‌شدن است (یک تا دو دقیقه).</EmptyNote>
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((c) => {
            const ch = c.change24h ?? 0
            return (
              <tr key={c.symbol} className="border-b last:border-b-0">
                <td className="px-3 py-2 font-bold">{c.base || c.symbol}</td>
                <td className="px-3 py-2 text-left cy-num">{faPrice(c.price)}</td>
                <td className={`px-3 py-2 text-left cy-num ${ch > 0 ? 'cy-up' : ch < 0 ? 'cy-down' : ''}`}>
                  {faPct(ch, 2, true)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
