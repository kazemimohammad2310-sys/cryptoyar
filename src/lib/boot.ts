import { bootNightshift } from '@/lib/nightshift'
import { ensurePragmas } from '@/lib/db'

// Lazy, idempotent boot — guarantees the 24/7 scheduler is alive on the first
// API request (covers dev hot-reload where instrumentation may not re-run).

let pending: Promise<void> | null = null

export async function ensureBooted(): Promise<void> {
  if (!pending) {
    pending = (async () => {
      await ensurePragmas()
      await bootNightshift()
    })().catch((e) => {
      pending = null
      throw e
    })
  }
  try {
    await pending
  } catch {
    /* degrade — routes still respond */
  }
}
