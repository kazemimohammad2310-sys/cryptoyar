import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __cryptoyar_pragmas?: Promise<void>
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'], // query logging removed — it flooded dev.log and slowed jobs
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ─── SQLite pragmas (§1: WAL) ───
// journal_mode=WAL is persistent (stored in the DB file); busy_timeout is
// per-connection, so we re-apply it on every process boot. Called from boot.
export function ensurePragmas(): Promise<void> {
  if (!globalForPrisma.__cryptoyar_pragmas) {
    globalForPrisma.__cryptoyar_pragmas = (async () => {
      try {
        await db.$executeRawUnsafe('PRAGMA journal_mode=WAL;')
        await db.$executeRawUnsafe('PRAGMA busy_timeout=5000;')
        await db.$executeRawUnsafe('PRAGMA synchronous=NORMAL;')
      } catch {
        /* degrade — never block boot on pragma failure */
      }
    })()
  }
  return globalForPrisma.__cryptoyar_pragmas
}
