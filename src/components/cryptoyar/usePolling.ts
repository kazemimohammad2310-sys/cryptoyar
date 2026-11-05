'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Polling hook — all dashboard data is client-fetched AFTER mount ───
// Hydration safety rule: the server render and the first client render both
// show the same skeleton; any Date.now()/localStorage access happens only
// inside effects or event handlers, never during render.

export interface PollState<T> {
  data: T | null
  error: string | null
  loading: boolean
  updatedAt: number | null
  refresh: () => void
}

export function usePolling<T>(url: string, intervalMs = 30_000): PollState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const alive = useRef(true)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const run = async (): Promise<void> => {
      try {
        const res = await fetch(url, { cache: 'no-store' })
        const json: unknown = await res.json().catch(() => null)
        if (!alive.current) return
        if (!res.ok) {
          const msg = (json as { error?: string } | null)?.error
          throw new Error(msg ?? `خطای سرور (${res.status})`)
        }
        setData(json as T)
        setError(null)
        setUpdatedAt(Date.now())
      } catch (e) {
        if (!alive.current) return
        setError(e instanceof Error ? e.message : 'خطای ارتباط با سرور')
      } finally {
        if (alive.current) setLoading(false)
      }
      if (alive.current && intervalMs > 0) timer = setTimeout(() => void run(), intervalMs)
    }

    void run()
    return () => {
      alive.current = false
      if (timer) clearTimeout(timer)
    }
  }, [url, intervalMs, tick])

  return { data, error, loading, updatedAt, refresh }
}

// ─── Admin token (per-device, stored in localStorage by the Settings tab) ───

export const ADMIN_TOKEN_KEY = 'cy_admin_token'

export function getAdminToken(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token)
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY)
  } catch {
    /* private mode — degrade */
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
  if (!res.ok) throw new Error(json.error ?? `خطای سرور (${res.status})`)
  return json as T
}
