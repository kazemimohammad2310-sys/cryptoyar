'use client'

import { useState } from 'react'
import { Wallet } from 'lucide-react'
import { usePolling, postJson } from '@/components/cryptoyar/usePolling'
import { EmptyNote, ErrorNote, PnlText, SectionTitle, SideChip, SkeletonBlock, Sparkline, StatCard } from '@/components/cryptoyar/kit'
import { faDateTime, faNum, faPrice, faTimeAgo } from '@/lib/fa'
import type { FundResp } from '@/components/cryptoyar/types'

export function FundTab() {
  const fund = usePolling<FundResp>('/api/fund', 30_000)
  const [closeMsg, setCloseMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  async function closePosition(id: number): Promise<void> {
    setBusyId(id)
    setCloseMsg(null)
    try {
      const r = await postJson<{ ok: boolean; pnlUsdt: number; pnlPct: number }>('/api/fund/orders', {
        action: 'close',
        positionId: id,
        reasonFa: 'بستن دستی توسط کاربر',
      })
      setCloseMsg({ ok: true, text: `پوزیشن بسته شد — سود/زیان محقق‌شده: ${faNum(r.pnlUsdt, 2)} USDT` })
      fund.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'خطای نامشخص'
      setCloseMsg({
        ok: false,
        text: msg.includes('توکن') ? 'بستن پوزیشن به توکن مدیریت نیاز دارد — از تب «تنظیمات» وارد کنید.' : msg,
      })
    } finally {
      setBusyId(null)
    }
  }

  const s = fund.data?.stats ?? null
  const cb = s?.circuitBreaker

  return (
    <div className="space-y-5">
      {cb?.tripped ? (
        <div className="rounded-xl border border-[color:var(--cy-down)]/50 bg-[color:var(--cy-down)]/10 p-4 text-sm">
          <span className="font-bold cy-down">مدار قطع شد — روز پرریسک.</span>{' '}
          <span className="text-foreground/80">
            افت روزانه {faNum(cb.drawdownPct, 2)}٪ از حد مجاز {faNum(cb.limitPct, 0)}٪ گذشته است؛ بازکردن پوزیشن جدید تا پایان روز مسدود است.
          </span>
        </div>
      ) : null}

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {fund.loading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonBlock key={i} className="h-[84px]" />)
        ) : (
          <>
            <StatCard label="سرمایهٔ کل" tone="gold" value={s ? `${faNum(fund.data?.equityNow ?? s.equity, 2)} USDT` : '—'} sub="پایه: ۱۰٬۰۰۰ USDT" />
            <StatCard
              label="سود / زیان کل"
              value={s ? <PnlText usdt={s.totalPnlUsdt} /> : '—'}
              tone={s ? (s.totalPnlUsdt > 0 ? 'up' : s.totalPnlUsdt < 0 ? 'down' : 'plain') : 'plain'}
              sub={s ? `${faNum(s.totalPnlPct, 2)}٪ از سرمایهٔ پایه` : '—'}
            />
            <StatCard
              label="نرخ برد"
              value={s ? `${faNum(s.winRate, 1)}٪` : '—'}
              sub={s ? `${faNum(s.closedCount, 0)} معاملهٔ بسته‌شده` : '—'}
            />
            <StatCard
              label="حداکثر افت (Drawdown)"
              value={s ? `${faNum(s.maxDrawdownPct, 2)}٪` : '—'}
              sub={s?.profitFactor != null ? `ضریب سود: ${faNum(s.profitFactor, 2)}` : s ? 'ضریب سود: —' : '—'}
            />
          </>
        )}
      </div>

      {/* equity curve */}
      <section>
        <SectionTitle icon={<Wallet className="h-4 w-4" />}>منحنی سرمایه</SectionTitle>
        <div className="rounded-xl border bg-card p-4">
          {fund.loading ? <SkeletonBlock className="h-[60px]" /> : <Sparkline points={(fund.data?.equityCurve ?? []).map((p) => p.v)} />}
        </div>
      </section>

      {closeMsg ? (
        <div className={`rounded-xl px-4 py-3 text-sm ${closeMsg.ok ? 'bg-[color:var(--cy-up)]/10 cy-up' : 'bg-[color:var(--cy-down)]/10 cy-down'}`}>
          {closeMsg.text}
        </div>
      ) : null}

      {/* positions */}
      <section>
        <SectionTitle>پوزیشن‌های باز (خرید و فروش با هم)</SectionTitle>
        {fund.loading ? (
          <SkeletonBlock className="h-40" />
        ) : fund.data && fund.data.positions.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-right font-medium">نماد</th>
                  <th className="px-3 py-2 text-right font-medium">جهت</th>
                  <th className="px-3 py-2 text-right font-medium">ورود</th>
                  <th className="px-3 py-2 text-right font-medium">لحظه‌ای</th>
                  <th className="px-3 py-2 text-right font-medium">حد ضرر</th>
                  <th className="px-3 py-2 text-right font-medium">هدف</th>
                  <th className="px-3 py-2 text-right font-medium">سود/زیان</th>
                  <th className="px-3 py-2 text-center font-medium">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {fund.data.positions.map((p) => (
                  <tr key={p.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2.5 font-bold">{p.symbol}</td>
                    <td className="px-3 py-2.5">
                      <SideChip side={p.side} />
                    </td>
                    <td className="px-3 py-2.5 cy-num">{faPrice(p.entryPrice)}</td>
                    <td className="px-3 py-2.5 cy-num">{faPrice(p.markPrice)}</td>
                    <td className="px-3 py-2.5 cy-num cy-down">{faPrice(p.stopLoss)}</td>
                    <td className="px-3 py-2.5 cy-num cy-up">{faPrice(p.takeProfit)}</td>
                    <td className="px-3 py-2.5">
                      <PnlText usdt={p.pnlUsdt} pct={p.pnlPct} />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={() => void closePosition(p.id)}
                        disabled={busyId === p.id}
                        className="rounded-md border border-[color:var(--cy-down)]/50 px-3 py-1 text-xs text-[color:var(--cy-down)] hover:bg-[color:var(--cy-down)]/10 disabled:opacity-50"
                      >
                        {busyId === p.id ? '…' : 'بستن'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyNote>پوزیشن بازی وجود ندارد — از تب رادار یک فرصت را در صندوق ثبت کنید.</EmptyNote>
        )}
      </section>

      {/* orders log */}
      <section>
        <SectionTitle>دفتر سفارش‌ها (۵۰ مورد اخیر)</SectionTitle>
        {fund.loading ? (
          <SkeletonBlock className="h-32" />
        ) : fund.data && fund.data.orders.length > 0 ? (
          <div className="max-h-96 space-y-2 overflow-y-auto rounded-xl border bg-card p-3">
            {fund.data.orders.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${o.kind === 'open' ? 'bg-[color:var(--cy-up)]/15 cy-up' : 'bg-secondary text-secondary-foreground'}`}>
                    {o.kind === 'open' ? 'بازکردن' : 'بستن'}
                  </span>
                  <span className="font-bold">{o.symbol}</span>
                  <SideChip side={o.side} />
                  <span className="text-xs text-muted-foreground cy-num">حجم {faNum(o.qty, 6)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="cy-num">{faPrice(o.price)}</span>
                  <span title={faDateTime(o.createdAt)}>{faTimeAgo(o.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyNote>هنوز سفارشی ثبت نشده است.</EmptyNote>
        )}
      </section>
    </div>
  )
}
