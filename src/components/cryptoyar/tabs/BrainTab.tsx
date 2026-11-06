'use client'

import { Brain, GraduationCap, Lightbulb } from 'lucide-react'
import { usePolling } from '@/components/cryptoyar/usePolling'
import { EmptyNote, ErrorNote, FEATURE_FA, MiniBar, SectionTitle, SkeletonBlock, Sparkline, StatCard } from '@/components/cryptoyar/kit'
import { faDateTime, faNum, faPct } from '@/lib/fa'
import type { BrainResp } from '@/components/cryptoyar/types'

const OUTCOME_FA: Record<string, string> = {
  tp: 'رسید به هدف',
  sl: 'خورد حد ضرر',
  timeout: 'پایان افق زمانی',
  win: 'برد',
  loss: 'باخت',
  flat: 'خنثی',
}

const PREDICTED_FA: Record<string, string> = { up: 'صعودی', down: 'نزولی' }

export function BrainTab() {
  const brain = usePolling<BrainResp>('/api/brain', 120_000)

  const d = brain.data
  const overall = d?.selfTest?.overall ?? null
  const maxWeight = d ? Math.max(...d.weights.map((w) => w.weight), 1) : 1

  return (
    <div className="space-y-5">
      {/* cold-start banner */}
      {d && d.counts.coldStart ? (
        <div className="rounded-xl border border-primary/40 bg-primary/10 p-4 text-sm">
          <span className="font-bold text-primary">مغز در حال جمع‌آوری تجربه است.</span>{' '}
          <span className="text-foreground/80">
            تا رسیدن به {faNum(d.counts.minForTraining, 0)} نمونهٔ ارزیابی‌شده، وزن‌ها روی مقدار پیش‌فرض می‌مانند.
            وضعیت فعلی: {faNum(d.counts.evaluated, 0)} ارزیابی‌شده از {faNum(d.counts.total, 0)} نمونهٔ ثبت‌شده
            ({faNum(d.counts.pending, 0)} نمونه در صف ارزیابی).
          </span>
        </div>
      ) : null}

      {/* accuracy stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {brain.loading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonBlock key={i} className="h-[84px]" />)
        ) : (
          <>
            <StatCard
              label="دقت مغز (کل)"
              tone={overall ? (overall.accuracy >= 50 ? 'up' : 'down') : 'plain'}
              value={overall ? `${faNum(overall.accuracy, 1)}٪` : '—'}
              sub={overall ? `روی ${faNum(overall.total, 0)} نمونهٔ اخیر` : 'هنوز نمونهٔ ارزیابی‌شده نیست'}
            />
            <StatCard
              label="میانگین سود هر نمونه"
              value={overall ? faPct(overall.avgPnlPct, 2, true) : '—'}
              sub="حرکت واقعی قیمت در افق"
            />
            <StatCard
              label="نمونه‌های یادگیری"
              value={d ? faNum(d.counts.total, 0) : '—'}
              sub={d ? `${faNum(d.counts.pending, 0)} در صف ارزیابی` : '—'}
            />
            <StatCard
              label="آخرین آموزش"
              value={d?.training ? (d.training.trained ? 'انجام شد' : 'در انتظار') : '—'}
              sub={d?.training ? faDateTime(d.training.at) : 'پس از ۵۰ نمونهٔ اول'}
            />
          </>
        )}
      </div>

      {brain.error ? <ErrorNote message={brain.error} onRetry={brain.refresh} /> : null}

      {d?.training ? (
        <p className="rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">آخرین چرخهٔ آموزش: {d.training.detail}</p>
      ) : null}

      {/* learning curve */}
      {d && d.history.length >= 2 ? (
        <section>
          <SectionTitle icon={<Brain className="h-4 w-4" />}>منحنی یادگیری (دقت در طول زمان)</SectionTitle>
          <div className="rounded-xl border bg-card p-4">
            <Sparkline points={d.history.map((h) => h.accuracy)} />
          </div>
        </section>
      ) : null}

      {/* accuracy per horizon + per strategy */}
      <section className="grid gap-4 lg:grid-cols-2">
        <AccuracyBars
          title="دقت بر اساس افق زمانی"
          rows={d?.selfTest?.byHorizon ?? []}
          loading={brain.loading}
          emptyText="پس از ارزیابی نمونه‌ها در افق ۲۴ و ۷۲ ساعته، این بخش پر می‌شود."
        />
        <AccuracyBars
          title="نرخ برد بر اساس استراتژی"
          rows={d?.selfTest?.byStrategy ?? []}
          loading={brain.loading}
          emptyText="هر استراتژی پس از ثبت و ارزیابی نمونه‌هایش اینجا گزارش می‌شود."
        />
      </section>

      {/* weights */}
      <section>
        <SectionTitle icon={<Brain className="h-4 w-4" />}>وزن فعلی ویژگی‌ها (خروجی یادگیری)</SectionTitle>
        {brain.loading ? (
          <SkeletonBlock className="h-24" />
        ) : d ? (
          <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 lg:grid-cols-4">
            {d.weights.map((w) => (
              <div key={w.key}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{FEATURE_FA[w.key] ?? w.key}</span>
                  <span className="font-bold cy-num">{faNum(w.weight, 1)}</span>
                </div>
                <MiniBar pct={(w.weight / maxWeight) * 100} />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* trader knowledge: curriculum + mined lessons (Brain v3) */}
      {d?.lessons?.length ? (
        <section className="space-y-4">
          <SectionTitle icon={<GraduationCap className="h-4 w-4" />}>دانش‌نامهٔ تریدر حرفه‌ای</SectionTitle>
          <div className="grid gap-2 lg:grid-cols-2">
            {d.lessons
              .filter((l) => l.kind === 'curriculum')
              .map((l) => (
                <div key={l.key} className="rounded-xl border bg-card px-4 py-3">
                  <div className="text-sm font-bold">{l.titleFa}</div>
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">{l.bodyFa}</div>
                  <div className="mt-1 text-[11px] text-primary/80">{l.statsFa}</div>
                </div>
              ))}
          </div>
          <SectionTitle icon={<Lightbulb className="h-4 w-4" />}>درس‌هایی که از بازار آموخت</SectionTitle>
          {(() => {
            const mined = d.lessons.filter((l) => l.kind === 'pattern' && l.active)
            if (!mined.length) {
              return (
                <EmptyNote>
                  هنوز الگویی با شواهد کافی کشف نشده — با ارزیابی نمونه‌های بیشتر، درس‌های تازه همین‌جا ثبت می‌شوند.
                </EmptyNote>
              )
            }
            return (
              <div className="space-y-2">
                {mined.map((l) => (
                  <div key={l.key} className="rounded-xl border bg-card px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold">{l.titleFa}</div>
                        <div className="mt-1 text-xs leading-5 text-muted-foreground">{l.bodyFa}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">{l.statsFa}</div>
                      </div>
                      <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold ${l.delta >= 0 ? 'cy-up' : 'cy-down'}`}>
                        {l.delta > 0 ? '+' : ''}
                        {faNum(l.delta, 1)} امتیاز
                      </span>
                    </div>
                    <div className="mt-2">
                      <MiniBar pct={l.confidence} ok={l.delta >= 0} />
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </section>
      ) : null}

      <section>
        <SectionTitle>آخرین نمونه‌های ارزیابی‌شده</SectionTitle>
        {brain.loading ? (
          <SkeletonBlock className="h-40" />
        ) : d && d.samples.length > 0 ? (
          <div className="max-h-96 overflow-x-auto overflow-y-auto rounded-xl border bg-card">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-right font-medium">نماد</th>
                  <th className="px-3 py-2 text-right font-medium">پیش‌بینی</th>
                  <th className="px-3 py-2 text-right font-medium">افق</th>
                  <th className="px-3 py-2 text-right font-medium">نتیجه</th>
                  <th className="px-3 py-2 text-right font-medium">سود/زیان</th>
                  <th className="px-3 py-2 text-right font-medium">ارزیابی</th>
                </tr>
              </thead>
              <tbody>
                {d.samples.map((smp) => (
                  <tr key={smp.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-bold">{smp.symbol}</td>
                    <td className="px-3 py-2">
                      <span className={smp.side === 'long' ? 'cy-up' : 'cy-down'}>
                        {smp.side === 'long' ? 'خرید' : 'فروش'} ({PREDICTED_FA[smp.predicted] ?? smp.predicted})
                      </span>
                    </td>
                    <td className="px-3 py-2 cy-num">{faNum(smp.horizonHours, 0)} ساعت</td>
                    <td className="px-3 py-2 text-xs">
                      {smp.ftOutcome ? OUTCOME_FA[smp.ftOutcome] ?? smp.ftOutcome : smp.outcome ? OUTCOME_FA[smp.outcome] ?? smp.outcome : '—'}
                    </td>
                    <td className={`px-3 py-2 cy-num ${(smp.ftPnlPct ?? smp.pnlPct ?? 0) > 0 ? 'cy-up' : (smp.ftPnlPct ?? smp.pnlPct ?? 0) < 0 ? 'cy-down' : ''}`}>
                      {faPct(smp.ftPnlPct ?? smp.pnlPct, 2, true)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{smp.evaluatedAt ? faDateTime(smp.evaluatedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyNote>
            هنوز نمونه‌ای ارزیابی نشده — هر سیگنال ثبت‌شده در افق ۲۴ و ۷۲ ساعته با قیمت واقعی سنجیده می‌شود و همین‌جا
            گزارش می‌گردد.
          </EmptyNote>
        )}
      </section>
    </div>
  )
}

function AccuracyBars({
  title,
  rows,
  loading,
  emptyText,
}: {
  title: string
  rows: { label: string; total: number; accuracy: number; tpRate: number; slRate: number }[]
  loading: boolean
  emptyText: string
}) {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {loading ? (
        <SkeletonBlock className="h-28" />
      ) : rows.length === 0 ? (
        <EmptyNote>{emptyText}</EmptyNote>
      ) : (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          {rows.map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span>{r.label}</span>
                <span className="cy-num text-muted-foreground">
                  دقت {faNum(r.accuracy, 1)}٪ — هدف {faNum(r.tpRate, 0)}٪ / حد ضرر {faNum(r.slRate, 0)}٪ ({faNum(r.total, 0)} نمونه)
                </span>
              </div>
              <MiniBar pct={r.accuracy} ok={r.accuracy >= 50} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
