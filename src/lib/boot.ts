import { bootNightshift } from '@/lib/nightshift'
import { ensurePragmas } from '@/lib/db'
import { seedTraderKnowledge } from '@/lib/traderKnowledge'

// Lazy, idempotent boot — guarantees the 24/7 scheduler is alive on the first
// API request (covers dev hot-reload where instrumentation may not re-run).

let pending: Promise<void> | null = null

export async function ensureBooted(): Promise<void> {
  if (!pending) {
    pending = (async () => {
      await ensurePragmas()
      // دانش‌نامهٔ تریدر حرفه‌ای را در دیتابیس کاشت کن (idempotent)
      await seedTraderKnowledge().catch(() => undefined)
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
