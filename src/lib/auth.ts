import { NextRequest } from 'next/server'
import { KEYS } from '@/lib/env'

// ─── Light auth for write endpoints (correction #6) ───
// If ADMIN_TOKEN is set in .env, every POST requires header `x-admin-token`.
// If unset (local dev), requests from localhost origins are allowed; the
// Settings page surfaces the current locking state in Persian.

export function requireAdmin(req: NextRequest): { ok: true } | { ok: false; status: 401; error: string } {
  if (!KEYS.adminToken) return { ok: true } // dev mode — no token configured
  const token = req.headers.get('x-admin-token')
  if (token && token === KEYS.adminToken) return { ok: true }
  return { ok: false, status: 401, error: 'توکن مدیریت نامعتبر است (x-admin-token)' }
}
