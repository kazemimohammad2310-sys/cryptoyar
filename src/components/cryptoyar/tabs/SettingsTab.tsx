'use client'

import { useEffect, useState } from 'react'
import { Bot, KeyRound, Lock, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { getAdminToken, postJson, setAdminToken, usePolling } from '@/components/cryptoyar/usePolling'
import { ErrorNote, FEATURE_FA, SectionTitle, SkeletonBlock } from '@/components/cryptoyar/kit'
import { faNum } from '@/lib/fa'
import type { SettingsResp } from '@/components/cryptoyar/types'

export function SettingsTab() {
  const settings = usePolling<SettingsResp>('/api/settings', 120_000)
  const [token, setTokenInput] = useState('')
  const [tokenState, setTokenState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle')
  const [tokenMsg, setTokenMsg] = useState('')
  const [loadedFromStorage, setLoadedFromStorage] = useState(false)
  const [botToggling, setBotToggling] = useState(false)
  const [botMsg, setBotMsg] = useState('')

  // read the saved token only after mount (hydration-safe)
  useEffect(() => {
    const saved = getAdminToken()
    if (saved) setTokenInput(saved)
    setLoadedFromStorage(true)
  }, [])

  async function saveToken(): Promise<void> {
    setTokenState('checking')
    setTokenMsg('')
    try {
      const t = token.trim()
      if (!t) {
        setAdminToken('')
        setTokenState('bad')
        setTokenMsg('توکن خالی است — اگر می‌خواهید قفل برداشته شود این قسمت را خالی بگذارید و دوباره ذخیره کنید.')
        return
      }
      setAdminToken(t)
      await postJson<{ ok: boolean }>('/api/settings', {})
      setTokenState('ok')
      setTokenMsg('توکن تأیید شد و روی این دستگاه ذخیره شد (localStorage).')
    } catch (e) {
      setTokenState('bad')
      setTokenMsg(e instanceof Error ? e.message : 'توکن نامعتبر است')
    }
  }

  async function toggleBot(next: 'on' | 'off'): Promise<void> {
    setBotToggling(true)
    setBotMsg('')
    try {
      const r = await postJson<{ ok: boolean; message?: string }>('/api/settings', { botEnabled: next })
      setBotMsg(r.message ?? (next === 'on' ? 'ربات روشن شد' : 'ربات خاموش شد'))
      settings.refresh()
    } catch (e) {
      setBotMsg(e instanceof Error ? e.message : 'خطا در تغییر وضعیت ربات')
    } finally {
      setBotToggling(false)
    }
  }

  // ─── فیوچرز: اهرم قابل تنظیم (مقدار اولیه از سرور، پس از لود) ───
  const [maxLev, setMaxLev] = useState('')
  const [fixedLev, setFixedLev] = useState('')
  const [futMsg, setFutMsg] = useState('')
  const [futBusy, setFutBusy] = useState(false)
  useEffect(() => {
    if (settings.data) {
      setMaxLev(String(settings.data.futures.maxLev))
      setFixedLev(String(settings.data.futures.fixedLev))
    }
  }, [settings.data])

  async function saveFutures(patch: {
    futuresLeverageMode?: 'auto' | 'fixed'
    futuresMaxLeverage?: number
    futuresFixedLeverage?: number
    botExpertGate?: 'on' | 'off'
  }): Promise<void> {
    setFutBusy(true)
    setFutMsg('')
    try {
      const r = await postJson<{ ok: boolean; message?: string }>('/api/settings', patch)
      setFutMsg(r.message ?? 'ثبت شد')
      settings.refresh()
    } catch (e) {
      setFutMsg(
        e instanceof Error && e.message.includes('توکن')
          ? 'تغییر اهرم به توکن مدیریت نیاز دارد — اول توکن را در بخش پایین ذخیره کنید.'
          : e instanceof Error
            ? e.message
            : 'خطا در ثبت اهرم',
      )
    } finally {
      setFutBusy(false)
    }
  }

  const d = settings.data

  return (
    <div className="space-y-5">
      {/* mode */}
      <section>
        <SectionTitle icon={<ShieldCheck className="h-4 w-4" />}>حالت معامله</SectionTitle>
        {settings.loading ? (
          <SkeletonBlock className="h-20" />
        ) : d ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
            {d.mode === 'paper' ? (
              <span className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-bold text-primary">
                حالت شبیه‌سازی — پول واقعی درگیر نیست
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-lg border border-[color:var(--cy-down)]/50 bg-[color:var(--cy-down)]/10 px-3 py-1.5 text-sm font-bold cy-down">
                <Lock className="h-4 w-4" /> حالت واقعی — قفل
              </span>
            )}
            <p className="text-xs text-muted-foreground">
              معاملات واقعی فقط در فاز ۲ و با تأیید صریح شما باز می‌شود؛ تا آن زمان صندوق فقط با سرمایهٔ مجازی
              می‌چرخد.
            </p>
          </div>
        ) : null}
      </section>

      {/* auto-trader bot */}
      <section>
        <SectionTitle icon={<Bot className="h-4 w-4" />}>ربات معامله‌گر خودکار (شبیه‌سازی)</SectionTitle>
        {settings.loading ? (
          <SkeletonBlock className="h-20" />
        ) : d ? (
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold">
                  وضعیت ربات:{" "}
                  {d.bot.enabled === 'on' ? (
                    <span className="cy-up">روشن — خودش معامله می‌کند</span>
                  ) : (
                    <span className="cy-down">خاموش — فقط ثبت دستی</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  قوانین ربات: ورود فقط از سیگنال‌های تازه با امتیاز ≥ {faNum(d.bot.minScore, 0)} · حداکثر{" "}
                  {faNum(d.bot.maxOpen, 0)} پوزیشن ربات · خنک‌شدن {faNum(d.bot.cooldownHours, 0)} ساعته پس از ضرر هر
                  نماد · بعد از سود +۱٪ حد ضرر به سر‌به‌سر و بعد +۱٫۶٪ متحرک می‌شود · معاملهٔ بی‌تحرک بعد از ۷۲ ساعت
                  بسته می‌شود.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void toggleBot(d.bot.enabled === 'on' ? 'off' : 'on')}
                disabled={botToggling}
                className={`rounded-lg px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50 ${
                  d.bot.enabled === 'on' ? 'bg-[color:var(--cy-down)]' : 'bg-[color:var(--cy-up)]'
                }`}
              >
                {botToggling ? 'در حال انجام…' : d.bot.enabled === 'on' ? 'خاموش کردن ربات' : 'روشن کردن ربات'}
              </button>
            </div>
            {botMsg ? <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs">{botMsg}</p> : null}
            <p className="text-[11px] text-muted-foreground">
              تغییر وضعیت ربات به توکن مدیریت نیاز دارد — اول توکن را در بخش پایین ذخیره کنید.
            </p>
          </div>
        ) : null}
      </section>

      {/* ─── فیوچرز و اهرم ─── */}
      <section>
        <SectionTitle icon={<Zap className="h-4 w-4" />}>فیوچرز و اهرم (شبیه‌سازی)</SectionTitle>
        {settings.loading ? (
          <SkeletonBlock className="h-24" />
        ) : d ? (
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold">حالت اهرم:</span>
              <button
                type="button"
                onClick={() => void saveFutures({ futuresLeverageMode: 'auto' })}
                disabled={futBusy}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold ${d.futures.mode === 'auto' ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted'}`}
              >
                خودکار (متناسب)
              </button>
              <button
                type="button"
                onClick={() => void saveFutures({ futuresLeverageMode: 'fixed' })}
                disabled={futBusy}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold ${d.futures.mode === 'fixed' ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted'}`}
              >
                ثابت
              </button>
              <span className="text-xs text-muted-foreground">
                الان: {d.futures.mode === 'auto' ? 'اهرم هر معامله با ریسک، نوسان و بنیاد همان ارز تنظیم می‌شود' : `همهٔ معامله‌ها با اهرم ثابت ×${faNum(d.futures.fixedLev, 0)}`}
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">سقف اهرم (×۱ تا ×۲۵)</span>
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={maxLev}
                  onChange={(e) => setMaxLev(e.target.value)}
                  dir="ltr"
                  className="w-24 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <button
                type="button"
                onClick={() => void saveFutures({ futuresMaxLeverage: Number(maxLev) })}
                disabled={futBusy || !maxLev}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                ذخیرهٔ سقف
              </button>
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">اهرم ثابت (فقط حالت ثابت)</span>
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={fixedLev}
                  onChange={(e) => setFixedLev(e.target.value)}
                  dir="ltr"
                  className="w-24 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <button
                type="button"
                onClick={() => void saveFutures({ futuresFixedLeverage: Number(fixedLev) })}
                disabled={futBusy || !fixedLev}
                className="rounded-lg border px-4 py-2 text-sm font-bold hover:bg-muted disabled:opacity-50"
              >
                ذخیرهٔ ثابت
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs leading-6 text-muted-foreground">
                دروازهٔ استادی ربات: {d.futures.expertGate === 'on' ? <b className="cy-up">روشن</b> : <b className="cy-down">خاموش</b>} — پیش از هر ورود،
                بنیاد، اشباع RSI، نوسان ATR، فاندینگ ازدحام و روند ۴ساعته بررسی می‌شود و همگرایی ۹ فاکتور ثبت می‌گردد.
              </p>
              <button
                type="button"
                onClick={() => void saveFutures({ botExpertGate: d.futures.expertGate === 'on' ? 'off' : 'on' })}
                disabled={futBusy}
                className="rounded-lg border px-3 py-1.5 text-xs font-bold hover:bg-muted disabled:opacity-50"
              >
                {d.futures.expertGate === 'on' ? 'خاموش کردن دروازهٔ استادی' : 'روشن کردن دروازهٔ استادی'}
              </button>
            </div>
            {futMsg ? <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs">{futMsg}</p> : null}
            <p className="text-[11px] text-muted-foreground">
              قاعدهٔ حرفه‌ای: اهرم زیاد فقط با بنیاد قوی و حد ضرر نزدیک مجاز است (لیکوییدیشن همیشه حداقل ۲٫۵ برابر دورتر از
              حد ضرر می‌ماند). بنیاد ضعیف = بدون اهرم، متوسط = تا ×۳، قوی = تا سقفی که همین‌جا تعیین می‌کنید.
            </p>
          </div>
        ) : null}
      </section>

      {/* admin token */}
      <section>
        <SectionTitle icon={<KeyRound className="h-4 w-4" />}>قفل توکن مدیریت (POST)</SectionTitle>
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <p className="text-xs leading-6 text-muted-foreground">
            عملیات نوشتن (ثبت سیگنال در صندوق، بستن پوزیشن) به توکن مدیریت نیاز دارد. این توکن فقط در همین مرورگر
            ذخیره می‌شود — اگر از گوشی یا دستگاه دیگری وارد می‌شوید، یک‌بار همان توکن را آنجا هم وارد کنید.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => {
                setTokenInput(e.target.value)
                setTokenState('idle')
              }}
              placeholder="توکن مدیریت را اینجا بچسبانید…"
              dir="ltr"
              className="min-w-56 flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={() => void saveToken()}
              disabled={tokenState === 'checking' || !loadedFromStorage}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {tokenState === 'checking' ? 'در حال بررسی…' : 'ذخیره'}
            </button>
          </div>
          {tokenMsg ? (
            <p className={`rounded-lg px-3 py-2 text-xs ${tokenState === 'ok' ? 'bg-[color:var(--cy-up)]/10 cy-up' : 'bg-[color:var(--cy-down)]/10 cy-down'}`}>
              {tokenMsg}
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {d?.adminLockEnabled
              ? 'وضعیت: قفل فعال است — توکن از متغیر محیطی ADMIN_TOKEN سرور خوانده می‌شود.'
              : 'وضعیت: سرور بدون توکن راه‌اندازی شده (فقط محلی).'}
          </p>
        </div>
      </section>

      {/* keys */}
      <section>
        <SectionTitle>وضعیت کلیدها (فقط تنظیم‌شده/تنظیم‌نشده — مقدار هرگز نمایش داده نمی‌شود)</SectionTitle>
        {settings.loading ? (
          <SkeletonBlock className="h-24" />
        ) : d ? (
          <div className="grid gap-2 rounded-xl border bg-card p-4 sm:grid-cols-2">
            <KeyRow label="CoinMarketCap (CMC_API_KEY)" ok={d.keys.cmc} hint="رتبه‌بندی و سنجه‌های کلان بازار" />
            <KeyRow label="Toobit — کلید (TOOBIT_API_KEY)" ok={d.keys.toobitKey} hint="فاز ۲ — معاملهٔ واقعی" />
            <KeyRow label="Toobit — رمز (TOOBIT_API_SECRET)" ok={d.keys.toobitSecret} hint="فاز ۲ — معاملهٔ واقعی" />
            <KeyRow label="توکن مدیریت (ADMIN_TOKEN)" ok={d.keys.adminToken} hint="قفل عملیات نوشتن" />
          </div>
        ) : null}
      </section>

      {/* risk limits */}
      <section>
        <SectionTitle>حدود ریسک (سمت سرور اعمال می‌شود)</SectionTitle>
        {settings.loading ? (
          <SkeletonBlock className="h-24" />
        ) : d ? (
          <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 text-sm lg:grid-cols-4">
            <RiskRow label="سرمایهٔ پایه" value={`${faNum(d.risk.equity, 0)} USDT`} />
            <RiskRow label="حداکثر پوزیشن همزمان" value={faNum(d.risk.maxPositions, 0)} />
            <RiskRow label="ریسک هر معامله" value={`${faNum(d.risk.riskPerTradePct, 0)}٪`} />
            <RiskRow label="سقف هر پوزیشن" value={`${faNum(d.risk.maxPositionPct, 0)}٪`} />
            <RiskRow label="مدار قطع روزانه" value={`${faNum(d.risk.dailyDrawdownHaltPct, 0)}٪ افت`} />
          </div>
        ) : null}
      </section>

      {/* brain weights (read-only summary) */}
      {d ? (
        <section>
          <SectionTitle>وزن‌های مغز (خلاصه — جزئیات در تب مغز)</SectionTitle>
          <div className="flex flex-wrap gap-2 rounded-xl border bg-card p-4 text-xs">
            {d.weights.map((w) => (
              <span key={w.key} className="rounded-md bg-secondary px-2 py-1">
                {FEATURE_FA[w.key] ?? w.key}: <span className="font-bold cy-num">{faNum(w.weight, 1)}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {/* Toobit phase 2 */}
      <section>
        <SectionTitle>اتصال صرافی Toobit</SectionTitle>
        <div className="rounded-xl border border-dashed bg-card p-4 text-sm">
          <p className="font-bold">اتصال فاز ۲ — آمادهٔ فعال‌سازی</p>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            راهنمای امنیتی کلید: کلید باید فقط مجوز معامله داشته باشد، بدون مجوز برداشت وجه، و ترجیحاً با IP
            whitelist. تا فعال‌سازی فاز ۲، هیچ درخواستی به صرافی ارسال نمی‌شود.
          </p>
        </div>
      </section>

      {settings.error ? <ErrorNote message={settings.error} onRetry={settings.refresh} /> : null}

      <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span>نسخهٔ ابری: چرخهٔ کامل هر ۱۵ دقیقه روی GitHub Actions — بکاپ دیتابیس در خود مخزن.</span>
        <button
          type="button"
          onClick={settings.refresh}
          className="flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" /> به‌روزرسانی
        </button>
      </div>
    </div>
  )
}

function KeyRow({ label, ok, hint }: { label: string; ok: boolean; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
      <div>
        <div className="text-sm font-bold" dir="auto">
          {label}
        </div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold ${ok ? 'bg-[color:var(--cy-up)]/15 cy-up' : 'bg-muted text-muted-foreground'}`}>
        {ok ? 'کلید تنظیم شده' : 'کلید ثبت نشده'}
      </span>
    </div>
  )
}

function RiskRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-bold cy-num">{value}</div>
    </div>
  )
}
