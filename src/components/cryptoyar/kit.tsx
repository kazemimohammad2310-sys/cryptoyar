'use client'

import { cn } from '@/lib/utils'
import { faNum } from '@/lib/fa'

// ─── Shared presentation kit — deterministic render only (hydration-safe) ───

export function StatCard({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'up' | 'down' | 'gold' | 'plain'
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border bg-card p-4', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 text-lg font-bold cy-num',
          tone === 'up' && 'cy-up',
          tone === 'down' && 'cy-down',
          tone === 'gold' && 'text-primary',
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

export function PnlText({ usdt, pct, digits = 2 }: { usdt: number | null; pct?: number | null; digits?: number }) {
  if (usdt === null || !Number.isFinite(usdt)) return <span className="text-muted-foreground">—</span>
  const cls = usdt > 0 ? 'cy-up' : usdt < 0 ? 'cy-down' : ''
  const sign = usdt > 0 ? '+' : usdt < 0 ? '−' : ''
  return (
    <span className={cn('cy-num', cls)}>
      {sign}
      {faNum(Math.abs(usdt), digits)} {pct !== undefined && pct !== null ? `(${pct > 0 ? '+' : pct < 0 ? '−' : ''}${faNum(Math.abs(pct), 2)}٪)` : ''}
    </span>
  )
}

export function SideChip({ side }: { side: string }) {
  const long = side === 'long'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold',
        long ? 'bg-[color:var(--cy-up)]/15 text-[color:var(--cy-up)]' : 'bg-[color:var(--cy-down)]/15 text-[color:var(--cy-down)]',
      )}
    >
      {long ? 'خرید' : 'فروش'}
    </span>
  )
}

export function ScoreBadge({ score }: { score: number }) {
  const abs = Math.abs(score)
  const long = score > 0
  return (
    <span
      className={cn(
        'inline-flex min-w-12 items-center justify-center rounded-lg px-2 py-1 text-sm font-bold cy-num',
        long ? 'bg-[color:var(--cy-up)]/15 text-[color:var(--cy-up)]' : 'bg-[color:var(--cy-down)]/15 text-[color:var(--cy-down)]',
      )}
      title="امتیاز سیگنال (از −۱۰۰ تا +۱۰۰)"
    >
      {long ? '+' : '−'}
      {faNum(abs, 0)}
    </span>
  )
}

export function StatusDot({ ok, pulse }: { ok: boolean; pulse?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        ok ? 'bg-[color:var(--cy-up)]' : 'bg-[color:var(--cy-down)]',
        pulse && 'cy-live',
      )}
    />
  )
}

export function Sparkline({
  points,
  width = 300,
  height = 60,
}: {
  points: number[]
  width?: number
  height?: number
}) {
  if (points.length < 2) {
    return <div className="flex h-[60px] items-center justify-center text-xs text-muted-foreground">دادهٔ نمودار هنوز کافی نیست</div>
  }
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const pts = points
    .map((v, i) => `${((i / (points.length - 1)) * width).toFixed(1)},${(height - 4 - ((v - min) / span) * (height - 8)).toFixed(1)}`)
    .join(' ')
  const color = points[points.length - 1] >= points[0] ? 'var(--cy-up)' : 'var(--cy-down)'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[60px] w-full" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  )
}

export function MiniBar({ pct, ok }: { pct: number; ok?: boolean }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full', ok === false ? 'bg-[color:var(--cy-down)]' : w >= 50 ? 'bg-[color:var(--cy-up)]' : 'bg-primary')}
        style={{ width: `${w}%` }}
      />
    </div>
  )
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-muted/60', className ?? 'h-20')} />
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--cy-down)]/40 bg-[color:var(--cy-down)]/10 p-3 text-sm">
      <span className="cy-down">{message}</span>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
          type="button"
        >
          تلاش مجدد
        </button>
      ) : null}
    </div>
  )
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</div>
  )
}

export function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground/90">
      {icon ? <span className="text-primary">{icon}</span> : null}
      {children}
    </h2>
  )
}

// feature key → Persian label (radar chips / brain weights)
export const FEATURE_FA: Record<string, string> = {
  rsi: 'RSI',
  trend: 'روند',
  macd: 'MACD',
  volume: 'حجم',
  funding: 'فاندینگ',
  oi: 'سود باز',
  stretch: 'فاصله از سقف',
  btc: 'بتای BTC',
}
