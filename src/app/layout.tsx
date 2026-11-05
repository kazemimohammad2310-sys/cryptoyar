import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'کریپتویار — شکار بهترین کوین‌ها در بهترین زمان',
  description:
    'سامانهٔ ۲۴/۷ هوشمند بازار کریپتو: رادار فرصت‌ها، صندوق شبیه‌ساز و مغز یادگیرنده — کاملاً فارسی و راست‌به‌چپ.',
}

export const viewport: Viewport = {
  themeColor: '#0b0e11',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className="dark" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
