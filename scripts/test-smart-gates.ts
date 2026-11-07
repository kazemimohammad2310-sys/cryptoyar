// تست دروازه‌های هوشمند Restart v5: سقف هم‌جهت، قطع‌کن استراتژی، آستانهٔ اعتماد مغز
import { sameSideBlock, strategyCooldownBlock, trustAdjustedMinScore, MAX_SAME_SIDE, STRAT_LOSS_STREAK } from '../src/lib/autotrader'

let ok = 0
const total = 13
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) ok++
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`)
}

// ─── ۱) سقف هم‌جهت ───
check('۲ خرید باز → خرید سوم رد شود', sameSideBlock('long', { long: 2 }) !== null)
check('۱ خرید باز → خرید دوم عبور کند', sameSideBlock('long', { long: 1 }) === null)
check('۲ خرید باز → فروش (شورت) عبور کند — جهات مستقل‌اند', sameSideBlock('short', { long: 2 }) === null)
check('بدون پوزیشن باز → عبور', sameSideBlock('long', {}) === null)

// ─── ۲) قطع‌کن مدار استراتژی ───
const now = Date.now()
const h = (n: number): Date => new Date(now - n * 3600_000)
check('۳ ضرر پیاپی اخیر → توقف موقت', strategyCooldownBlock([{ pnlUsdt: -5, closedAt: h(2) }, { pnlUsdt: -3, closedAt: h(5) }, { pnlUsdt: -8, closedAt: h(9) }]) !== null)
check('۲ ضرر + ۱ سود → بدون توقف', strategyCooldownBlock([{ pnlUsdt: -5, closedAt: h(2) }, { pnlUsdt: 4, closedAt: h(5) }, { pnlUsdt: -8, closedAt: h(9) }]) === null)
check('۳ ضرر ولی قدیمی (بیش از ۲۴ ساعت) → بدون توقف', strategyCooldownBlock([{ pnlUsdt: -5, closedAt: h(30) }, { pnlUsdt: -3, closedAt: h(40) }, { pnlUsdt: -8, closedAt: h(50) }]) === null)
check('فقط ۲ معاملهٔ بسته → بدون توقف (شواهد ناکافی)', strategyCooldownBlock([{ pnlUsdt: -5, closedAt: h(2) }, { pnlUsdt: -3, closedAt: h(5) }]) === null)

// ─── ۳) آستانهٔ اعتماد مغز ───
check('اعتماد پایین (×۰٫۷۵) → آستانهٔ ۶۵+۵=۷۰', trustAdjustedMinScore(65, 0.75).min === 70)
check('اعتماد خنثی (×۱) → آستانهٔ بدون تغییر ۶۵', trustAdjustedMinScore(65, 1).min === 65)
check('اعتماد بالا (×۱٫۲) → آستانهٔ ۶۵−۲=۶۳', trustAdjustedMinScore(65, 1.2).min === 63)
check('اعتماد نامشخص → بدون تغییر', trustAdjustedMinScore(65, undefined).min === 65)

// sanity of exported constants
check('ثابت‌ها درست‌اند', MAX_SAME_SIDE === 2 && STRAT_LOSS_STREAK === 3)

console.log(`\nنتیجه: ${ok}/${total} PASS`)
if (ok !== total) process.exit(1)
