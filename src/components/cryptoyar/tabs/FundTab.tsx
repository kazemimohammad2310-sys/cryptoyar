'use client'

import { useState } from 'react'
import { Wallet, Zap } from 'lucide-react'
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

      {/* ─── فیوچرز: مارجین و اهرم ─── */}
      {s ? (
        <section>
          <SectionTitle icon={<Zap className="h-4 w-4" />}>
            فیوچرز — مارجین و اهرم (قابل تنظیم از تب تنظیمات)
          </SectionTitle>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="مارجین درگیر" tone="gold" value={`${faNum(s.futures.marginUsed, 2)} USDT`} sub={`حجم اسمی ${faNum(s.futures.notionalExposure, 0)} USDT`} />
            <StatCard label="اهرم میانگین" value={`×${faNum(s.futures.avgLeverage, 1)}`} sub={`بیشینهٔ باز: ×${faNum(s.futures.maxLeverage, 0)}`} />
            <StatCard
              label="ROE باز"
              value={<PnlText usdt={null} pct={s.futures.unrealizedRoe} />}
              tone={s.futures.unrealizedRoe >= 0 ? 'up' : 'down'}
              sub={`${faNum(s.futures.leveragedCount, 0)} پوزیشن اهرم‌دار`}
            />
            <StatCard label="پوزیشن‌های باز" value={faNum(fund.data?.positions.length ?? 0, 0)} sub="لیکوییدیشن هر پوزیشن در جدول زیر" />
          </div>
        </section>
      ) : null}

      {closeMsg ? (
        <div className={`rounded-xl px-4 py-3 text-sm ${closeMsg.ok ? 'bg-[color:var(--cy-up)]/10 cy-up' : 'bg-[color:var(--cy-down)]/10 cy-down'}`}>
          {closeMsg.text}
        </div>
      ) : null}

      {/* positions */}
      <section>
        <SectionTitle>پوزیشن‌های باز فیوچرز (خرید و فروش با هم)</SectionTitle>
        {fund.loading ? (
          <SkeletonBlock className="h-40" />
        ) : fund.data && fund.data.positions.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-right font-medium">نماد</th>
                  <th className="px-3 py-2 text-right font-medium">جهت</th>
                  <th className="px-3 py-2 text-center font-medium">اهرم</th>
                  <th className="px-3 py-2 text-right font-medium">مارجین</th>
                  <th className="px-3 py-2 text-right font-medium">ورود</th>
                  <th className="px-3 py-2 text-right font-medium">لحظه‌ای</th>
                  <th className="px-3 py-2 text-right font-medium">حد ضرر</th>
                  <th className="px-3 py-2 text-right font-medium">لیکوییدیشن</th>
                  <th className="px-3 py-2 text-right font-medium">هدف</th>
                  <th className="px-3 py-2 text-right font-medium">سود/زیان</th>
                  <th className="px-3 py-2 text-right font-medium">ROE</th>
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
                    <td className="px-3 py-2.5 text-center">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${p.leverage > 1 ? 'bg-primary/15 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
                        ×{faNum(p.leverage, p.leverage % 1 === 0 ? 0 : 1)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 cy-num">{faNum(p.marginUsdt, 2)}</td>
                    <td className="px-3 py-2.5 cy-num">{faPrice(p.entryPrice)}</td>
                    <td className="px-3 py-2.5 cy-num">{faPrice(p.markPrice)}</td>
                    <td className="px-3 py-2.5 cy-num cy-down">{faPrice(p.stopLoss)}</td>
                    <td className="px-3 py-2.5 cy-num text-[color:var(--cy-down)]/70">{p.leverage > 1 ? faPrice(p.liquidationPrice) : '—'}</td>
                    <td className="px-3 py-2.5 cy-num cy-up">{faPrice(p.takeProfit)}</td>
                    <td className="px-3 py-2.5">
                      <PnlText usdt={p.pnlUsdt} pct={p.pnlPct} />
                    </td>
                    <td className={`px-3 py-2.5 cy-num ${p.roe >= 0 ? 'cy-up' : 'cy-down'}`}>{faNum(p.roe, 1)}٪</td>
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
        <p className="mt-2 px-1 text-[11px] leading-5 text-muted-foreground">
          در فیوچرز، سود/زیان همان حرکت قیمت × حجم است؛ اهرم مارجین و ROE را چند برابر می‌کند. حد ضرر معمولاً پیش از
          لیکوییدیشن فعال می‌شود — اهرم از تب «تنظیمات» قابل تغییر است: در حالت ثابت همهٔ معامله‌ها با اهرم انتخابی شما (الان
          ×۲۰) باز می‌شوند و در حالت خودکار، اهرم هر معامله با ریسک، نوسان و بنیاد همان ارز تنظیم می‌شود.
        </p>
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
