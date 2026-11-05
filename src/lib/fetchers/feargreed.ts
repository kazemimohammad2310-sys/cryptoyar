import { fetchJson } from '@/lib/rateLimit'

// ─── Fear & Greed index (alternative.me — free, no key) ───
// Fills the gap flagged in review: dashboard «ترس و طمع» badge source.

export interface FearGreed {
  value: number
  classification: string
  classificationFa: string
  ts: number
}

const FA_LABELS: Record<string, string> = {
  'extreme fear': 'ترس شدید',
  fear: 'ترس',
  neutral: 'خنثی',
  greed: 'طمع',
  'extreme greed': 'طمع شدید',
}

export async function getFearGreed(): Promise<FearGreed> {
  const data = await fetchJson<{ data: { value: string; value_classification: string; timestamp: string }[] }>(
    'https://api.alternative.me/fng/?limit=1',
    { source: 'feargreed', retries: 1, timeoutMs: 8000 },
  )
  const d = data.data?.[0]
  if (!d) throw new Error('empty fng response')
  const cls = (d.value_classification || '').toLowerCase()
  return {
    value: Number(d.value),
    classification: d.value_classification,
    classificationFa: FA_LABELS[cls] ?? d.value_classification,
    ts: Number(d.timestamp) * 1000,
  }
}
