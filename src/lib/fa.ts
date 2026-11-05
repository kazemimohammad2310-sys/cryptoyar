// ─── Persian formatting helpers (fa-IR, Persian digits everywhere) ───
// Client-side only usage (all data arrives via fetch) → no SSR hydration risk.

const numFmt = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat('fa-IR', opts)

export function faNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return numFmt({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n)
}

/** price: adaptive decimals — big coins 2, small coins up to 6 */
export function faPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7
  return numFmt({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n)
}

/** قالب‌بندی اعداد بزرگ دلاری برای نمایش فارسی (هزار میلیارد/میلیارد/میلیون) */
export function faBigUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e12) return `${faNum(n / 1e12, 2)} هزار میلیارد دلار`
  if (n >= 1e9) return `${faNum(n / 1e9, 2)} میلیارد دلار`
  if (n >= 1e6) return `${faNum(n / 1e6, 1)} میلیون دلار`
  return `${faNum(n, 0)} دلار`
}

export function faUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${faNum(n, digits)} دلار`
}

export function faMoneySigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const s = faNum(Math.abs(n), digits)
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${s}`
}

export function faPct(n: number | null | undefined, digits = 2, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const s = faNum(Math.abs(n), digits)
  const sign = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : ''
  return `${sign}${s}٪`
}

const dtFmt = new Intl.DateTimeFormat('fa-IR', {
  dateStyle: 'short',
  timeStyle: 'short',
})

export function faDateTime(ts: number | Date | string | null | undefined): string {
  if (!ts) return '—'
  try {
    return dtFmt.format(new Date(ts))
  } catch {
    return '—'
  }
}

export function faTimeAgo(ts: number | Date | string | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 0) return 'لحظه‌ای دیگر'
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'لحظه‌ای پیش'
  const m = Math.floor(s / 60)
  if (m < 60) return `${faNum(m, 0)} دقیقه پیش`
  const h = Math.floor(m / 60)
  if (h < 24) return `${faNum(h, 0)} ساعت پیش`
  return `${faNum(Math.floor(h / 24), 0)} روز پیش`
}

export function faDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${faNum(ms, 0)} میلی‌ثانیه`
  const s = ms / 1000
  if (s < 60) return `${faNum(s, 1)} ثانیه`
  const m = Math.floor(s / 60)
  return `${faNum(m, 0)} دقیقه و ${faNum(Math.round(s % 60), 0)} ثانیه`
}

export function faInterval(ms: number | null): string {
  if (!ms) return 'روزانه (۰۴:۰۰ تهران)'
  const m = ms / 60000
  if (m < 60) return `هر ${faNum(m, 0)} دقیقه`
  const h = m / 60
  if (h < 24) return `هر ${faNum(h, 0)} ساعت`
  return `هر ${faNum(h / 24, 0)} روز`
}

export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'cy-up' : 'cy-down'
}
