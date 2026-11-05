// ─── CryptoYar — env access + key redaction guard (§12 security rules) ───

export const KEYS = {
  cmc: process.env.CMC_API_KEY ?? '',
  toobitKey: process.env.TOOBIT_API_KEY ?? '',
  toobitSecret: process.env.TOOBIT_API_SECRET ?? '',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  tradingMode: (process.env.TRADING_MODE ?? 'paper').toLowerCase(),
}

export function keyStatus() {
  return {
    cmc: KEYS.cmc.length > 0,
    toobitKey: KEYS.toobitKey.length > 0,
    toobitSecret: KEYS.toobitSecret.length > 0,
    adminToken: KEYS.adminToken.length > 0,
  }
}

const REDACT_PATTERNS = [
  /(CMC_API_KEY|TOOBIT_API_KEY|TOOBIT_API_SECRET|ADMIN_TOKEN)\s*[=:]\s*"?[^\s"',;]+/gi,
]

/** Never log or return real key values (§12.1). */
export function redact(text: string): string {
  let out = text
  for (const re of REDACT_PATTERNS) out = out.replace(re, '$1=***')
  return out
}

let guardInstalled = false
export function installRedactionGuard(): void {
  if (guardInstalled) return
  guardInstalled = true
  const methods = ['log', 'error', 'warn', 'info'] as const
  for (const m of methods) {
    const original = console[m].bind(console)
    console[m] = (...args: unknown[]) => {
      try {
        original(
          ...args.map((a) =>
            typeof a === 'string' ? redact(a) : typeof a === 'object' && a !== null ? redact(JSON.stringify(a)) : a,
          ),
        )
      } catch {
        original(...args)
      }
    }
  }
}
