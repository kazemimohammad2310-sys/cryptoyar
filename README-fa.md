# کریپتویار — نسخهٔ رایگان (GitHub Actions + Pages)

این بسته کل سامانهٔ کریپتویار را **بدون سرور و بدون هزینه** اجرا می‌کند:
هر ۱۵ دقیقه یک چرخهٔ کامل روی GitHub Actions اجرا می‌شود (کندل‌ها، رتبه‌بندی CMC، اسکن رادار، صندوق شبیه‌سازی، آموزش مغز، پاک‌سازی) و داشبورد فارسی روی GitHub Pages منتشر می‌شود.

## راه‌اندازی در ۶ قدم (فقط کلیک — بدون ترمینال)

1. **حساب GitHub** بسازید: `github.com/signup` (فقط ایمیل — رایگان)
2. **ریپوی جدید**: `github.com/new` → نام: `cryptoyar` → Public → Create
3. **آپلود فایل‌ها**: در صفحهٔ ریپو لینک «uploading an existing file» را بزنید و **کل محتویات پوشهٔ cryptoyar-free** (پوشه‌ها و فایل‌ها، نه خود پوشهٔ مادر) را درگ‌ودراپ کنید → Commit changes
4. **Secret (پیشنهادی)**: Settings → Secrets and variables → Actions → New repository secret
   - Name: `CMC_API_KEY`
   - Secret: کلید رایگان خود از pro.coinmarketcap.com/account
   - (اگر نگذارید هم کار می‌کند — فقط رتبه‌بندی از حجم Binance گرفته می‌شود)
5. **اجرای اول**: تب Actions → workflow «cycle» → Run workflow
6. **داشبورد**: Settings → Pages → Source: **GitHub Actions** — بعد از اولین اجرا:
   `https://USERNAME.github.io/cryptoyar/`

## نکته‌ها

- زمان‌بند هر ۱۵ دقیقه است؛ تأخیرهای چنددقیقه‌ای طبیعی GitHub است
- دیتابیس (SQLite) هر چرخه داخل خود ریپو ذخیره می‌شود — بکاپ = خودِ گیت‌هاب
- محدودیت رایگان: ریپوی عمومی = نامحدود؛ ریپوی خصوصی = ۲۰۰۰ دقیقه/ماه (~۳۰۰ دقیقه مصرف ما)
- حالت معامله paper (شبیه‌سازی) است؛ حالت واقعی روی این نسخه فعال نمی‌شود
