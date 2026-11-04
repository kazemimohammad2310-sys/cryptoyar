import { ensureBooted } from '@/lib/boot'

// Next.js instrumentation hook — boots the 24/7 scheduler once per process.
// boot.ts is single-flight + hot-reload safe (guards via globalThis).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  await ensureBooted()
}
