'use client'

import { useState } from 'react'
import { Activity, Brain, MoonStar, Radar, Settings as SettingsIcon, Wallet } from 'lucide-react'
import { usePolling } from '@/components/cryptoyar/usePolling'
import { StatusDot } from '@/components/cryptoyar/kit'
import { DashboardTab } from '@/components/cryptoyar/tabs/DashboardTab'
import { RadarTab } from '@/components/cryptoyar/tabs/RadarTab'
import { FundTab } from '@/components/cryptoyar/tabs/FundTab'
import { BrainTab } from '@/components/cryptoyar/tabs/BrainTab'
import { NightshiftTab } from '@/components/cryptoyar/tabs/NightshiftTab'
import { SettingsTab } from '@/components/cryptoyar/tabs/SettingsTab'

// ─── Custom tab bar (hydration-safe by design) ───
// Radix Tabs generate useId-based DOM ids that diverge when anything above
// them renders differently on the server; a plain controlled tab list has no
// generated ids at all, so server HTML and first client render always match.

const TABS = [
  { key: 'dashboard', fa: 'داشبورد', icon: Activity },
  { key: 'radar', fa: 'رادار فرصت‌ها', icon: Radar },
  { key: 'fund', fa: 'صندوق شبیه‌ساز', icon: Wallet },
  { key: 'brain', fa: 'مغز یادگیرنده', icon: Brain },
  { key: 'nightshift', fa: 'شیفت‌شب', icon: MoonStar },
  { key: 'settings', fa: 'تنظیمات', icon: SettingsIcon },
] as const

type TabKey = (typeof TABS)[number]['key']

interface HealthLite {
  status: string
  mode: string
  sources: { binance: boolean; cmc: boolean }
}

export function CryptoyarApp() {
  const [tab, setTab] = useState<TabKey>('dashboard')
  const health = usePolling<HealthLite>('/api/health', 30_000)

  const coreOk = health.data ? health.data.sources.binance : null

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 pb-6 sm:px-5">
      {/* ─── Header ─── */}
      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-lg font-black text-primary">
            CY
          </div>
          <div>
            <h1 className="text-base font-bold leading-5">کریپتویار</h1>
            <p className="text-xs text-muted-foreground">شکار بهترین کوین‌ها در بهترین زمان</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-bold text-primary">
            حالت شبیه‌سازی
          </span>
          <span className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-muted-foreground">
            <StatusDot ok={coreOk === true} pulse={coreOk === true} />
            {coreOk === null ? 'در حال اتصال…' : coreOk ? 'سامانه سالم' : 'اتصال داده قطع'}
          </span>
        </div>
      </header>

      {/* ─── Tab bar ─── */}
      <nav aria-label="بخش‌های سامانه" className="-mx-1 overflow-x-auto pb-1">
        <div role="tablist" className="flex min-w-max items-center gap-1 border-b px-1">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${t.key}`}
                id={`tab-${t.key}`}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? 'border-primary font-bold text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.fa}
              </button>
            )
          })}
        </div>
      </nav>

      {/* ─── Panels (only the active one mounts — state resets on switch) ─── */}
      <main className="flex-1 py-4">
        <div role="tabpanel" id="panel-dashboard" aria-labelledby="tab-dashboard" hidden={tab !== 'dashboard'}>
          {tab === 'dashboard' ? <DashboardTab /> : null}
        </div>
        <div role="tabpanel" id="panel-radar" aria-labelledby="tab-radar" hidden={tab !== 'radar'}>
          {tab === 'radar' ? <RadarTab /> : null}
        </div>
        <div role="tabpanel" id="panel-fund" aria-labelledby="tab-fund" hidden={tab !== 'fund'}>
          {tab === 'fund' ? <FundTab /> : null}
        </div>
        <div role="tabpanel" id="panel-brain" aria-labelledby="tab-brain" hidden={tab !== 'brain'}>
          {tab === 'brain' ? <BrainTab /> : null}
        </div>
        <div role="tabpanel" id="panel-nightshift" aria-labelledby="tab-nightshift" hidden={tab !== 'nightshift'}>
          {tab === 'nightshift' ? <NightshiftTab /> : null}
        </div>
        <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== 'settings'}>
          {tab === 'settings' ? <SettingsTab /> : null}
        </div>
      </main>

      {/* ─── Footer (sticky bottom via mt-auto on the flex column) ─── */}
      <footer className="mt-auto border-t pt-3 text-center text-xs text-muted-foreground">
        کریپتویار — نسخهٔ شبیه‌سازی آموزشی؛ هیچ‌کدام از اعداد توصیهٔ سرمایه‌گذاری نیستند. داده‌ها: Binance و
        CoinMarketCap.
      </footer>
    </div>
  )
}
