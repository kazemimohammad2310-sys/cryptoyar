'use client'

import { useState } from 'react'
import { Radar as RadarIcon } from 'lucide-react'
import { usePolling, postJson } from '@/components/cryptoyar/usePolling'
import { EmptyNote, ErrorNote, FEATURE_FA, ScoreBadge, SectionTitle, SideChip, SkeletonBlock } from '@/components/cryptoyar/kit'
import { faNum, faPrice, faTimeAgo } from '@/lib/fa'
import type { RadarResp, RadarSignal } from '@/components/cryptoyar/types'

type RegState = { id: number; ok: boolean; message: string } | null

export function RadarTab() {
  const radar = usePolling<RadarResp>('/api/radar?limit=12', 60_000)
  const [reg, setReg] = useState<RegState>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  async function registerInFund(s: RadarSignal): Promise<void> {
    setBusyId(s.id)
    setReg(null)
    try {
      await postJson<{ ok: boolean; positionId: number }>('/api/fund/orders', {
        action: 'open',
        signalId: s.id,
        symbol: s.symbol,
        side: s.side,
      })
      setReg({ id: s.id, ok: true, message: `در صندوق شبیه‌ساز ثبت شد (پوزیشن #${s.id}) — جزئیات در تب صندوق` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'خطای نامشخص'
      setReg({
        id: s.id,
        ok: false,
        message: msg.includes('توکن')
          ? 'برای ثبت در صندوق، توکن مدیریت لازم است — از تب «تنظیمات» توکن را وارد کنید.'
          : msg,
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle icon={<RadarIcon className="h-4 w-4" />}>فرصت‌های بالای آستانه (امتیاز ≥ ۶۰)</SectionTitle>
        {radar.error ? <ErrorNote message={radar.error} onRetry={radar.refresh} /> : null}
        {radar.loading ? (
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-52" />
            ))}
          </div>
        ) : radar.data && radar.data.signals.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {radar.data.signals.map((s) => (
              <SignalCard
                key={s.id}
                s={s}
                busy={busyId === s.id}
                reg={reg && reg.id === s.id ? reg : null}
                onRegister={() => void registerInFund(s)}
              />
            ))}
          </div>
        ) : (
          <EmptyNote>
            در حال حاضر سیگنالی بالای آستانه نیست — رادار هر ۱۵ دقیقه کل بازار top-50 را اسکن می‌کند.
          </EmptyNote>
        )}
      </section>

      {radar.data && radar.data.watch.length > 0 ? (
        <section>
          <SectionTitle>دوربین‌های زیر آستانه (امتیاز ۴۰ تا ۶۰ — فقط تماشا)</SectionTitle>
          <div className="space-y-2">
            {radar.data.watch.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-bold">{s.symbol}</span>
                  <SideChip side={s.side} />
                  <span className="text-xs text-muted-foreground">{s.strategyFa}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground cy-num">ورود {faPrice(s.entryPrice)}</span>
                  <ScoreBadge score={s.score} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function SignalCard({
  s,
  busy,
  reg,
  onRegister,
}: {
  s: RadarSignal
  busy: boolean
  reg: RegState
  onRegister: () => void
}) {
  const rr = Math.abs(s.takeProfit - s.entryPrice) / Math.max(Math.abs(s.entryPrice - s.stopLoss), 1e-9)
  const chips = Object.entries(s.features)
    .filter(([k]) => FEATURE_FA[k])
    .slice(0, 6)

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold">{s.symbol}</span>
          <SideChip side={s.side} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{s.strategyFa}</span>
          <ScoreBadge score={s.score} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-2 text-center text-xs">
        <div>
          <div className="text-muted-foreground">ورود</div>
          <div className="font-bold cy-num">{faPrice(s.entryPrice)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">حد ضرر</div>
          <div className="font-bold cy-num cy-down">{faPrice(s.stopLoss)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">هدف سود</div>
          <div className="font-bold cy-num cy-up">{faPrice(s.takeProfit)}</div>
        </div>
      </div>

      <p className="text-sm leading-6 text-foreground/90">{s.reasonFa}</p>

      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map(([k, v]) => (
            <span key={k} className="rounded-md bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
              {FEATURE_FA[k]} <span className="cy-num">{faNum(v, 2)}</span>
            </span>
          ))}
          <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
            نسبت ریسک/سود <span className="cy-num">{faNum(rr, 2)}</span>
          </span>
        </div>
      ) : null}

      {reg ? (
        <p className={`rounded-lg px-3 py-2 text-xs ${reg.ok ? 'bg-[color:var(--cy-up)]/10 cy-up' : 'bg-[color:var(--cy-down)]/10 cy-down'}`}>
          {reg.message}
        </p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{faTimeAgo(s.createdAt)}</span>
        <button
          type="button"
          onClick={onRegister}
          disabled={busy}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'در حال ثبت…' : 'ثبت در صندوق'}
        </button>
      </div>
    </div>
  )
}
