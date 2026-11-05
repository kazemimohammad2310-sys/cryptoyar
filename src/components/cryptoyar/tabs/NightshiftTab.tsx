'use client'

import { MoonStar } from 'lucide-react'
import { usePolling } from '@/components/cryptoyar/usePolling'
import { EmptyNote, ErrorNote, SectionTitle, SkeletonBlock, StatusDot } from '@/components/cryptoyar/kit'
import { faDateTime, faDuration, faInterval, faNum, faTimeAgo } from '@/lib/fa'
import type { NightshiftResp } from '@/components/cryptoyar/types'

const JOB_FA_EXTRA: Record<string, string> = {
  'self-test': 'آزمون خودکار مغز',
  'data-prune': 'پاک‌سازی داده‌ها',
}

export function NightshiftTab() {
  const night = usePolling<NightshiftResp>('/api/nightshift', 60_000)

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle icon={<MoonStar className="h-4 w-4" />}>
          وظایف شیفت‌شب (اجرای ۲۴/۷ — کریپتو هرگز بسته نمی‌شود)
        </SectionTitle>
        {night.error ? <ErrorNote message={night.error} onRetry={night.refresh} /> : null}
        {night.loading ? (
          <SkeletonBlock className="h-64" />
        ) : night.data ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-right font-medium">وظیفه</th>
                  <th className="px-3 py-2 text-right font-medium">دورهٔ اجرا</th>
                  <th className="px-3 py-2 text-right font-medium">وضعیت</th>
                  <th className="px-3 py-2 text-right font-medium">آخرین نتیجه</th>
                  <th className="px-3 py-2 text-right font-medium">مدت</th>
                  <th className="px-3 py-2 text-right font-medium">زمان</th>
                </tr>
              </thead>
              <tbody>
                {night.data.jobs.map((j) => {
                  const last = j.last
                  return (
                    <tr key={j.name} className="border-b last:border-b-0">
                      <td className="px-3 py-2.5 font-bold">{j.fa || JOB_FA_EXTRA[j.name] || j.name}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{faInterval(j.intervalMs)}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2 text-xs">
                          <StatusDot ok={j.running ? true : (last?.ok ?? false)} pulse={j.running} />
                          {j.running ? 'در حال اجرا' : last ? (last.ok ? 'سالم' : 'خطا') : 'در انتظار اولین اجرا'}
                        </span>
                      </td>
                      <td className="max-w-[240px] px-3 py-2.5 text-xs text-muted-foreground">
                        {last ? (
                          <span title={last.error ?? undefined}>
                            {last.detail}
                            {last.error ? <span className="cy-down"> — {last.error}</span> : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs cy-num">{last ? faDuration(last.durationMs) : '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{last ? faTimeAgo(last.at) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section>
        <SectionTitle>گزارش اجرا (۴۰ رویداد اخیر)</SectionTitle>
        {night.loading ? (
          <SkeletonBlock className="h-40" />
        ) : night.data && night.data.logs.length > 0 ? (
          <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-xl border bg-card p-3 text-sm">
            {night.data.logs.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-1.5 text-xs last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <StatusDot ok={l.ok} />
                  <span className="font-bold">{l.job}</span>
                  <span className="text-muted-foreground">{l.detail}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  {l.error ? <span className="cy-down">{l.error}</span> : null}
                  <span title={faDateTime(l.startedAt)}>{faTimeAgo(l.startedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyNote>هنوز لاگی ثبت نشده — وظایف به‌محض راه‌افتادن زمان‌بند اینجا گزارش می‌شوند. {faNum(night.data?.jobs.length ?? 0, 0)} وظیفهٔ فعال.</EmptyNote>
        )}
      </section>
    </div>
  )
}
