'use client'

import { useMemo, useState } from 'react'
import { Coins as CoinsIcon } from 'lucide-react'
import { usePolling } from '@/components/cryptoyar/usePolling'
import { EmptyNote, ErrorNote, SectionTitle, SkeletonBlock } from '@/components/cryptoyar/kit'
import { faBigUsd, faNum, faPct, faPrice, faTimeAgo } from '@/lib/fa'
import type { FundamentalsSnapshot, FundamentalRow } from '@/lib/fundamentals'

// ─── تب «ارزها» — وضعیت بنیادی بازار + جزئیات کامل هر ارز ───
// همان داده‌ای که داشبورد ابری نشان می‌دهد، این‌بار داخل اپ محلی:
// منبع: /api/fundamentals (کش ۱۰ دقیقه‌ای، بدون تماس اضافه به APIها)

const LEVEL_STYLE: Record<string, string> = {
  strong: 'bg-[color:var(--cy-up)]/10 cy-up border-[color:var(--cy-up)]/40',
  mid: 'bg-primary/10 text-primary border-primary/40',
  weak: 'bg-[color:var(--cy-down)]/10 cy-down border-[color:var(--cy-down)]/40',
}

export function CoinsTab() {
  const snap = usePolling<FundamentalsSnapshot>('/api/fundamentals', 300_000)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const rows = useMemo(() => {
    const list = snap.data?.rows ? [...snap.data.rows] : []
    list.sort((a, b) => b.score - a.score)
    return list
  }, [snap.data])

  function toggle(symbol: string): void {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })
  }

  return (
    <div className="space-y-5">
      {/* ─── وضعیت بنیادی کل بازار ─── */}
      <section>
        <SectionTitle icon={<CoinsIcon className="h-4 w-4" />}>
          وضعیت بنیادی بازار چطور سنجیده می‌شود؟
        </SectionTitle>
        {snap.error ? <ErrorNote message={snap.error} onRetry={snap.refresh} /> : null}
        {snap.loading ? <SkeletonBlock className="h-28" /> : null}
        {snap.data ? (
          <div className="space-y-3">
            <p className="rounded-xl border bg-card px-4 py-3 text-sm leading-6 text-muted-foreground">
              امتیاز بنیادی هر ارز از ۰ تا ۱۰۰ از ترکیبِ چند عامل ساخته می‌شود: تیِر رتبهٔ بازار (۰ تا ۴۰)،
              نقدشوندگی حجم روزانه (۱۵+)، فشردگی حجم روزانه به حجم روان (۱۵+)، سبکی/سنگینی فاندینگ (۱۵)
              و رابطهٔ قدرت روند با پول بازار (۱۰+). سپس برچسب قوی/متوسط/ضعیف با آستانه‌های ثابت داده می‌شود؛
              عدد «خنثی» شاخص ترس و طمع هم در همین نوار کنار آن‌ها نمایش داده می‌شود.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {snap.data.fearGreed ? (
                <span className="rounded-lg border bg-card px-3 py-1.5 text-xs">
                  شاخص ترس و طمع: <b className="cy-num">{faNum(snap.data.fearGreed.value, 0)}</b>{' '}
                  <span className="text-muted-foreground">({snap.data.fearGreed.classificationFa})</span>
                </span>
              ) : null}
              {snap.data.global ? (
                <>
                  <span className="rounded-lg border bg-card px-3 py-1.5 text-xs">
                    دامیننس بیت‌کوین: <b className="cy-num">{faNum(snap.data.global.btcDominance, 1)}٪</b>
                  </span>
                  <span className="rounded-lg border bg-card px-3 py-1.5 text-xs">
                    ارزش کل بازار: <b className="cy-num">{faBigUsd(snap.data.global.totalMarketCap)}</b>
                  </span>
                </>
              ) : null}
              <span className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground">
                {faTimeAgo(snap.data.at)} به‌روز
              </span>
            </div>
          </div>
        ) : null}
      </section>

      {/* ─── فهرست ارزها با امتیاز بنیادی ─── */}
      <section>
        <SectionTitle>
          رتبه‌بندی تحت پوشش ({rows.length ? faNum(rows.length, 0) : '—'}) — برای دیدن جزئیات، روی هر ردیف بزنید
        </SectionTitle>
        {rows.length === 0 && !snap.loading && !snap.error ? (
          <EmptyNote>هنوز داده بنیادی ثبت نشده — اولین چرخهٔ داده در جریان است.</EmptyNote>
        ) : null}
        <div className="overflow-hidden rounded-xl border">
          {rows.map((r, i) => (
            <CoinRow
              key={r.symbol}
              row={r}
              index={i + 1}
              open={open.has(r.symbol)}
              onToggle={() => toggle(r.symbol)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function CoinRow({ row, index, open, onToggle }: { row: FundamentalRow; index: number; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-b last:border-b-0 bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-right transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-secondary px-1.5 text-[11px] font-bold text-primary cy-num">
            {faNum(index, 0)}
          </span>
          <span className="flex flex-col items-start">
            <b className="text-sm">{row.symbol}</b>
            <span className="text-[11px] text-muted-foreground">{row.name || row.base}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {row.price !== null ? <span className="text-xs text-muted-foreground cy-num">{faPrice(row.price)}</span> : null}
          {row.change24h !== null ? (
            <span className={`text-xs cy-num ${row.change24h >= 0 ? 'cy-up' : 'cy-down'}`}>
              {faPct(row.change24h, 2, true)}
            </span>
          ) : null}
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${LEVEL_STYLE[row.level] ?? 'border text-muted-foreground'}`}
          >
            {row.levelFa} {faNum(row.score, 0)}
          </span>
        </div>
      </button>

      {open ? (
        <div className="space-y-3 border-t px-4 py-4">
          <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
            <Cell label="حجم روزانه" value={row.volume24h ? faBigUsd(row.volume24h) : '—'} />
            <Cell label="ارزش بازار" value={row.marketCap ? faBigUsd(row.marketCap) : '—'} />
            <Cell
              label="نرخ فاندینگ"
              value={row.fundingRate !== null ? faPct(row.fundingRate * 100, 4, true) : '—'}
            />
            <Cell label="نوسان روزانه" value={row.volatilityPct !== null ? faPct(row.volatilityPct, 2) : '—'} />
            <Cell label="RSI روزانه" value={row.rsi1d !== null ? faNum(row.rsi1d, 0) : '—'} />
            <Cell label="روند روزانه" value={row.trendFa || '—'} />
            <Cell
              label="بازده ۷روزه"
              value={row.perf7d !== null ? faPct(row.perf7d, 2, true) : '—'}
              tone={row.perf7d !== null ? (row.perf7d >= 0 ? 'up' : 'down') : undefined}
            />
            <Cell
              label="بازده ۳۰روزه"
              value={row.perf30d !== null ? faPct(row.perf30d, 2, true) : '—'}
              tone={row.perf30d !== null ? (row.perf30d >= 0 ? 'up' : 'down') : undefined}
            />
          </div>
          {row.reasonsFa.length ? (
            <ul className="space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-[12px] leading-6 text-foreground/90">
              {row.reasonsFa.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-lg border bg-background px-2 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`font-bold cy-num ${tone === 'up' ? 'cy-up' : tone === 'down' ? 'cy-down' : ''}`}>{value}</div>
    </div>
  )
}
