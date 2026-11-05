import type { MetadataRoute } from 'next'

// ─── PWA manifest for the local app (same identity as the cloud dashboard) ───

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'کریپتویار — شکار بهترین کوین‌ها در بهترین زمان',
    short_name: 'کریپتویار',
    description: 'داشبورد شبیه‌سازی معامله ارز دیجیتال با مغز یادگیرنده و ربات معامله‌گر',
    dir: 'rtl',
    lang: 'fa',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0e11',
    theme_color: '#0d1220',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
