// ─── Shared fetch layer: rate limiter + negative cache (60s) + retry/backoff ───
// Every external call goes through here (§2). Also tracks live source health
// for /api/health and graceful degradation («منبع در دسترس نیست»).

export type SourceKey = 'binance-spot' | 'binance-futures' | 'cmc' | 'feargreed'

type HealthEntry = { ok: boolean; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null }

type GlobalState = {
  health: Record<SourceKey, HealthEntry>
  buckets: Map<string, { tokens: number; last: number }>
  negCache: Map<string, number> // url-key -> unban timestamp
  binanceSpotBase: string | null
}

const g = globalThis as unknown as { __cryptoyar_net?: GlobalState }

function state(): GlobalState {
  if (!g.__cryptoyar_net) {
    g.__cryptoyar_net = {
      health: {
        'binance-spot': { ok: false, lastOkAt: null, lastErrorAt: null, lastError: null },
        'binance-futures': { ok: false, lastOkAt: null, lastErrorAt: null, lastError: null },
        cmc: { ok: false, lastOkAt: null, lastErrorAt: null, lastError: null },
        feargreed: { ok: false, lastOkAt: null, lastErrorAt: null, lastError: null },
      },
      buckets: new Map(),
      negCache: new Map(),
      binanceSpotBase: null,
    }
  }
  return g.__cryptoyar_net
}

export function sourceHealth() {
  return JSON.parse(JSON.stringify(state().health)) as Record<SourceKey, HealthEntry>
}

function mark(key: SourceKey, ok: boolean, err?: string) {
  const h = state().health[key]
  if (ok) {
    h.ok = true
    h.lastOkAt = Date.now()
  } else {
    h.ok = false
    h.lastErrorAt = Date.now()
    h.lastError = (err ?? 'unknown').slice(0, 300)
  }
}

export class SourceUnavailableError extends Error {
  constructor(
    public source: SourceKey,
    message: string,
  ) {
    super(message)
    this.name = 'SourceUnavailableError'
  }
}

// token bucket: capacity/maxPerSec per host key
const LIMITS: Record<SourceKey, { rate: number; burst: number }> = {
  'binance-spot': { rate: 6, burst: 8 },
  'binance-futures': { rate: 3, burst: 4 },
  cmc: { rate: 1.5, burst: 3 },
  feargreed: { rate: 0.2, burst: 1 },
}

async function takeToken(key: SourceKey): Promise<void> {
  const s = state()
  const lim = LIMITS[key]
  let b = s.buckets.get(key)
  if (!b) {
    b = { tokens: lim.burst, last: Date.now() }
    s.buckets.set(key, b)
  }
  for (let i = 0; i < 400; i++) {
    const now = Date.now()
    b.tokens = Math.min(lim.burst, b.tokens + ((now - b.last) / 1000) * lim.rate)
    b.last = now
    if (b.tokens >= 1) {
      b.tokens -= 1
      return
    }
    await sleep(Math.max(30, Math.ceil(1000 / lim.rate)))
  }
  throw new SourceUnavailableError(key, 'rate limiter timeout')
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface FetchOptions {
  source: SourceKey
  /** extra wait before retry (used after HTTP 418/429 bans) */
  banMs?: number
  timeoutMs?: number
  retries?: number
  headers?: Record<string, string>
}

/** JSON GET with limiter, 60s negative cache, retry with exponential backoff. */
export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const s = state()
  const negKey = `${opts.source}:${url}`
  const bannedUntil = s.negCache.get(negKey)
  if (bannedUntil && Date.now() < bannedUntil) {
    throw new SourceUnavailableError(opts.source, `negative cache (${Math.ceil((bannedUntil - Date.now()) / 1000)}s)`)
  }
  const retries = opts.retries ?? 2
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await takeToken(opts.source)
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000)
      let res: Response
      try {
        res = await fetch(url, {
          signal: ctrl.signal,
          headers: { accept: 'application/json', 'user-agent': 'CryptoYar/1.0', ...(opts.headers ?? {}) },
          cache: 'no-store',
        })
      } finally {
        clearTimeout(t)
      }
      if (res.status === 418 || res.status === 429 || res.status === 451 || res.status === 403) {
        mark(opts.source, false, `HTTP ${res.status}`)
        s.negCache.set(negKey, Date.now() + (opts.banMs ?? 65_000))
        throw new SourceUnavailableError(opts.source, `HTTP ${res.status}`)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as T
      mark(opts.source, true)
      s.negCache.delete(negKey)
      if (opts.source === 'binance-spot') s.binanceSpotBase = new URL(url).origin
      return data
    } catch (e) {
      lastErr = e
      const isAbort = e instanceof Error && e.name === 'AbortError'
      if (e instanceof SourceUnavailableError) {
        mark(opts.source, false, e.message)
        throw e // don't retry on bans / negative cache
      }
      mark(opts.source, false, e instanceof Error ? e.message : String(e))
      if (attempt < retries) await sleep(isAbort ? 1200 : 500 * 2 ** attempt)
    }
  }
  throw new SourceUnavailableError(opts.source, lastErr instanceof Error ? lastErr.message : String(lastErr))
}

/** Rotate to the next Binance spot base after repeated failures. */
export const BINANCE_SPOT_BASES = ['https://api.binance.com', 'https://data-api.binance.vision']
export function currentBinanceSpotBase(): string {
  const s = state()
  return s.binanceSpotBase ?? BINANCE_SPOT_BASES[0]
}
