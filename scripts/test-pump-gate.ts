// تست گیت پامپ (Brain v4): استراتژی شکست مومنتوم فقط با تأیید حجم + CVD وارد می‌شود
import { pumpGateFailReason } from '../src/lib/autotrader'

const cases: { name: string; f: Parameters<typeof pumpGateFailReason>[0]; expect: 'pass' | 'reject' }[] = [
  { name: 'حجم قوی + CVD مثبت → عبور', f: { volZ: 2.1, cvd: 0.45 }, expect: 'pass' },
  { name: 'موج حجم + CVD مثبت (مسیر volSurge) → عبور', f: { volSurge: 0.3, cvd: 0.2 }, expect: 'pass' },
  { name: 'CVD مرزی مثبت (۰٫۰۱) + حجم → عبور', f: { volZ: 1.5, cvd: 0.01 }, expect: 'pass' },
  { name: 'شکست بی‌حجم → رد', f: { volZ: 0.8, cvd: 0.9 }, expect: 'reject' },
  { name: 'حجم هست اما فروش تهاجمی (CVD منفی) → رد', f: { volZ: 2.0, cvd: -0.3 }, expect: 'reject' },
  { name: 'سیگنال قدیمی بدون CVD → رد صادقانه', f: { volZ: 2.0 }, expect: 'reject' },
  { name: 'موج حجم هست اما CVD صفر/منفی → رد', f: { volSurge: 0.2, cvd: -0.1 }, expect: 'reject' },
]

let ok = 0
for (const c of cases) {
  const r = pumpGateFailReason(c.f)
  const pass = r === null
  const good = pass === (c.expect === 'pass')
  if (good) ok++
  console.log(`${good ? 'PASS' : 'FAIL'} | ${c.name} | ${r ?? 'عبور'}`)
}
console.log(`GATE TEST: ${ok}/${cases.length} OK`)
if (ok !== cases.length) process.exit(1)
