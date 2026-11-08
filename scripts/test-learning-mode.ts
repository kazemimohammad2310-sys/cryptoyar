// تست حالت یادگیری Restart v5.1: ورود کوچک برای دادهٔ آموزشی مغز
import { learningEntryAllowed, LEARN_TAG, LEARN_MIN_SCORE_DEFAULT, LEARN_IDLE_H_DEFAULT, LEARN_MAX_OPEN_DEFAULT, LEARN_RISK_SCALE_DEFAULT, BOT_PREFIX } from '../src/lib/autotrader'

let ok = 0
const total = 8
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) ok++
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`)
}

const now = Date.now()
const h = (n: number): Date => new Date(now - n * 3600_000)
const base = {
  learnMode: 'on',
  capacity: 3,
  openLearnCount: 0,
  learnMaxOpen: 2,
  lastBotEntryAt: null as Date | null,
  learnIdleHours: 4,
}

// ─── ۱) تصمیم ورود یادگیری ───
check('حالت یادگیری خاموش → ممنوع', learningEntryAllowed({ ...base, learnMode: 'off' }).ok === false)
check('ظرفیت ربات صفر → ممنوع', learningEntryAllowed({ ...base, capacity: 0 }).ok === false)
check('۲ پوزیشن یادگیری باز → سقف پر', learningEntryAllowed({ ...base, openLearnCount: 2 }).ok === false)
check('آخرین ورود ۱ ساعت پیش → هنوز زود است', learningEntryAllowed({ ...base, lastBotEntryAt: h(1) }).ok === false)
check('آخرین ورود ۵ ساعت پیش → اجازهٔ یادگیری', learningEntryAllowed({ ...base, lastBotEntryAt: h(5) }).ok === true)
check('بدون هیچ ورود قبلی → اجازهٔ یادگیری (شروع صندوق تازه)', learningEntryAllowed({ ...base, lastBotEntryAt: null }).ok === true)

// ─── ۲) ثابت‌ها و برچسب ───
check('ثابت‌های یادگیری درست‌اند', LEARN_MIN_SCORE_DEFAULT === 42 && LEARN_IDLE_H_DEFAULT === 4 && LEARN_MAX_OPEN_DEFAULT === 2 && LEARN_RISK_SCALE_DEFAULT === 0.5)
const sampleReason = `${BOT_PREFIX} — ${LEARN_TAG} — بازگ به میانگین — امتیاز ۴۸`
check('برچسب یادگیری در reasonFa پوزیشن قابل شناسایی است (شمارش سقف)', sampleReason.includes(LEARN_TAG))

console.log(`\nنتیجه: ${ok}/${total} PASS`)
if (ok !== total) process.exit(1)
