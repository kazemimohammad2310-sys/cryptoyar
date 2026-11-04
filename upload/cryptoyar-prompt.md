# 🚀 CryptoYar (کریپتویار) — Master Build Prompt

> **How to use:** Copy this entire document and paste it as the first instruction into your AI builder (Z.ai / Cursor / Claude Code / v0 …). It is fully self-contained.
> **نحوهٔ استفاده:** کل این سند را کپی کنید و به‌عنوان نخستین دستور در پروژهٔ جدید بچسبانید. کاملاً خودکفا است.

---

## بخش ۰ — خلاصهٔ فارسی برای صاحب پروژه

**کریپتویار** سامانهٔ هوشمند ۲۴/۷ بازار کریپتو است با یک هدف: «بهترین کوین را در بهترین زمان شکار کند تا سود حداکثری شود». نسخهٔ کریپتوی سامانهٔ موفق «بورس‌یار» است. فاز اول **کاملاً شبیه‌سازی** است (پول واقعی درگیر نیست): مغز یادگیرنده روی دادهٔ واقعی Binance و CoinMarketCap آموزش می‌بیند، رادار فرصت‌ها را پیدا می‌کند و صندوق شبیه‌ساز با سرمایهٔ مجازی ۱۰,۰۰۰ USDT معامله می‌کند تا دقت مغز ثابت شود. اتصال به صرافی Toobit (اسپات + فیوچرز USDT-M) در فاز ۲ اسکلت‌گذاری می‌شود و معاملهٔ واقعی فقط با تأیید صریح صاحب حساب باز می‌گردد. رابط کاربری کاملاً فارسی و راست‌به‌چپ است.

---

## 0. Mission (one-liner)

**EN:** Build **CryptoYar** — a 24/7 crypto market intelligence & paper-trading web system whose single goal is: *find the best coins at the best moment to maximize profit*. It must learn from real market data, scan opportunities continuously, trade them in a virtual paper fund first, and be ready for real execution on Toobit (spot + USDT-M futures) in a later phase.
**FA:** سامانهٔ ۲۴/۷ هوشمند کریپتو با هدف «بهترین کوین در بهترین زمان برای حداکثر سود» — اول شبیه‌سازی، بعد اجرای واقعی روی Toobit.

---

## 1. Tech Stack (use exactly this)

- **Framework:** Next.js 16 (App Router) + TypeScript strict mode
- **DB:** Prisma ORM + SQLite (single file `prisma/dev.db`) — easy start, zero setup
- **UI:** Tailwind CSS, **full RTL**, Persian language everywhere, font **Vazirmatn**, Persian digits (`fa-IR` locale) for all numbers
- **State:** server components + React hooks; no heavy client state needed
- **Jobs:** internal long-running scheduler singleton (`src/lib/nightshift.ts`) with Node `setInterval` jobs — must survive hot reloads (guard with `globalThis`)
- **Node:** memory cap guidance `NODE_OPTIONS=--max-old-space-size=700` in dev script
- **Env keys** (never hardcode, never log): `CMC_API_KEY`, `TOOBIT_API_KEY`, `TOOBIT_API_SECRET`, `TRADING_MODE` (default `paper`)

---

## 2. Data Sources & Fetchers

Implement one fetcher module per source + a **unified normalizer**. All fetchers go through a shared **rate limiter + negative cache (60s on errors) + retry with exponential backoff**.

### 2.1 CoinMarketCap (market overview — کلان بازار)
- Auth: header `X-CMC_PRO_API_KEY: ${CMC_API_KEY}` (free Basic tier ≈ 10k calls/month — budget jobs accordingly, cache aggressively: 10 min TTL)
- `GET https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=50` → top-50 universe (the coin list the whole system trades)
- `GET /v1/global-metrics/quotes/latest` → total market cap, BTC dominance
- `GET /v1/cryptocurrency/info?id=...` → metadata (logo, category) — cache 24h
- Persist into `Coin` table + `MarketSnapshot`

### 2.2 Binance Public API (engine data — موتور دادهٔ مغز؛ **no key needed**)
- Spot: `GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=300`, `/api/v3/ticker/24hr`, `/api/v3/depth?limit=20`
- Futures: `GET https://fapi.binance.com/fapi/v1/premiumIndex`, `/fapi/v1/fundingRate?symbol=...&limit=3`, `/fapi/v1/openInterest?symbol=...`
- Intervals to store: `15m`, `1h`, `4h`, `1d`
- Refresh policy: tickers every 60s (top 50), candles every 15 min
- Persist into `Candle`, `TickerSnapshot`, `FundingSnapshot`

### 2.3 Toobit (user's exchange — Phase 2 scaffold, do NOT call in Phase 1)
- User holds an account; API keys come from `.env`. Toobit uses **REST + WebSocket with HMAC-SHA256 signed requests** — at build time consult the official Toobit API docs (`https://toobit-docs.github.io/apidocs/`) for exact base URLs/paths and implement exactly per docs; do not guess endpoints.
- **Design now, wire later:** abstract interface `ExchangeConnector { getBalances(); getPositions(); placeOrder(req); cancelOrder(id); }` with two implementations: `PaperConnector` (used by the fund) and `ToobitConnector` (Phase 2, gated).
- Key permissions note for the owner (show in Settings page in Persian): «کلید باید فقط مجوز معامله داشته باشد، بدون مجوز برداشت وجه، و ترجیحاً با IP whitelist.»

---

## 3. Prisma Schema (create exactly these models)

```prisma
model Coin            { id Int @id @default(autoincrement()) symbol String @unique name String rank Int marketCap Float cmcId Int? updatedAt DateTime @updatedAt }
model Candle          { id Int @id @default(autoincrement()) symbol String interval String ts DateTime open Float high Float low Float close Float volume Float @@unique([symbol, interval, ts]) @@index([symbol, interval]) }
model TickerSnapshot  { id Int @id @default(autoincrement()) symbol String price Float change24h Float volume24h Float high24h Float low24h Float ts DateTime @default(now()) }
model FundingSnapshot { id Int @id @default(autoincrement()) symbol String fundingRate Float openInterest Float? ts DateTime @default(now()) }
model BrainSample     { id Int @id @default(autoincrement()) symbol String featuresJson String horizonHours Int predicted String outcome String? pnlPct Float? createdAt DateTime @default(now()) evaluatedAt DateTime? }
model Signal          { id Int @id @default(autoincrement()) symbol String side String score Float strategy String featuresJson String reasonFa String status String @default("open") createdAt DateTime @default(now()) }
model FundPosition    { id Int @id @default(autoincrement()) symbol String side String qty Float entryPrice Float markPrice Float stopLoss Float? takeProfit Float? status String @default("open") sourceSignalId Int? openedAt DateTime @default(now()) closedAt DateTime? closePrice Float? pnlUsdt Float? pnlPct Float? }
model FundOrder       { id Int @id @default(autoincrement()) kind String symbol String side String qty Float price Float reasonFa String status String @default("filled") createdAt DateTime @default(now()) }
model EquityPoint     { id Int @id @default(autoincrement()) equityUsdt Float ts DateTime @default(now()) }
model JobLog          { id Int @id @default(autoincrement()) job String startedAt DateTime finishedAt DateTime? ok Boolean error String? }
model Setting         { key String @id value String }
```

Seed `Setting`: `mode=paper`, `equity=10000`, `maxPositions=10`, `riskPerTradePct=5`, `maxPositionPct=20`, `dailyDrawdownHaltPct=5`.

---

## 4. Brain (مغز یادگیرنده) — `src/lib/brain.ts`

**EN:** Explainable scoring engine with online learning. Not a black box: every signal must carry a human-readable Persian reason.

- **Features per symbol (compute from stored candles/funding):** RSI(14), MACD(12,26,9), EMA20/EMA50 + slope, volume z-score(20), ATR%(14), funding rate, OI 24h change, distance from 7d high/low, BTC 24h return (market beta).
- **Scoring v1 (rule-based start):** weighted sum → score ∈ [−100, +100]; score ≥ +60 ⇒ `long` signal, ≤ −60 ⇒ `short` signal. Store all features as JSON on the `Signal`/`BrainSample` row.
- **Online learning loop:** every signal is recorded as a `BrainSample`; a scheduled job evaluates each sample at **+24h and +72h** against real prices (`outcome`, `pnlPct`); weights auto-adjust (simple normalized gradient / per-feature bandit) toward features that historically predicted profit. Keep per-feature hit-rate history.
- **Self-test:** `GET /api/brain/selftest` replays the last 200 samples and returns directional accuracy per horizon + per strategy; expose in UI as «دقت مغز».
- **Explainability:** generate `reasonFa` like: «مومنتوم قوی (RSI ۶۳)، حجم ۲.۱ برابر میانگین، فاندینگ منفی — احتمال ادامهٔ روند صعودی».

---

## 5. Radar (رادار فرصت‌ها) — `src/lib/radar.ts`

Scan top-50 universe and emit ranked opportunity cards. **Both long and short allowed** (crypto advantage).

Strategies Phase 1:
1. **Momentum breakout** — close > 7d high × 0.99 with volume z > 1.5 ⇒ long
2. **Mean reversion** — RSI(14) < 30 with support hold ⇒ long; RSI > 70 + rejection ⇒ short
3. **Trend-following** — EMA20/EMA50 cross with slope confirmation ⇒ long/short
4. **Funding anomaly** — extreme funding (|rate| > 0.1%/8h) ⇒ fade the crowd (short if funding very positive, long if very negative)

Radar card shows: symbol, side (خرید/فروش), score, entry price, stop loss (ATR×1.5), target (R:R ≥ 1.5), Persian reason, feature chips.

`GET /api/radar?limit=12` → sorted by |score| desc.

---

## 6. Paper Fund (صندوق شبیه‌ساز) — `src/lib/fund.ts`

Mirrors the proven بورس‌یار design. Virtual equity **10,000 USDT**.

- `openPosition(signalId)` → creates `FundPosition` + `FundOrder` with Persian reason; validates risk rules (§7); deducts nothing (spot-style margin tracking: position size ≤ 20% equity)
- `closePosition(id, reason)` → realizes PnL, updates `EquityPoint`, writes closing `FundOrder` with Persian reason
- `markToMarket()` — every 60s update `markPrice` of open positions from Binance
- `recomputeStats()` → total PnL (USDT & %), win rate, profit factor, max drawdown, best/worst trade, per-strategy performance
- **Auto-manage:** when a signal's stop loss or take profit is hit by mark price → auto-close with reason «حد ضرر فعال شد» / «هدف سود محقق شد»
- Also expose a manual API: `POST /api/fund/orders { action: "open" | "close", symbol, side, qty? }`
- `GET /api/fund` → positions + orders + stats (one call feeds the whole صندوق page)

---

## 7. Risk Rules (قواعد ریسک — enforced **server-side**, never only in UI)

1. Max **10** concurrent open positions
2. Max risk per trade **5%** of equity (position sized so stop-loss hit ≈ 5%)
3. Max single position **20%** of equity
4. Mandatory stop loss on every position (default ATR×1.5) — reject orders without one
5. **Daily circuit breaker:** if daily drawdown ≥ 5% → block new opens, show banner «مدار قطع شد — روز پرریسک»
6. Radar-only entries in Phase 1 (no manual random trading without a reason string)

---

## 8. Nightshift (شیفت‌شب ۲۴/۷) — `src/lib/nightshift.ts`

Crypto never closes — jobs run 24/7. Each job logs to `JobLog` (name, duration, ok, error) and must be idempotent + crash-safe.

| Job | Interval | Task |
|---|---|---|
| `ticker-refresh` | 60s | refresh top-50 tickers (Binance) |
| `candle-refresh` | 15min | refresh 15m/1h/4h/1d candles |
| `funding-refresh` | 60min | funding + OI snapshots |
| `cmc-refresh` | 10min | top-50 ranking + global metrics |
| `radar-scan` | 15min | run strategies, store new Signals |
| `fund-mark` | 60s | mark-to-market + auto stop/TP |
| `brain-train` | 60min | evaluate due samples, adjust weights |
| `self-test` | daily 04:00 | run brain self-test, log accuracy |
| `health` | 5min | write health snapshot |

`GET /api/health` → `{ status: "ok", jobs: {name: {ok, lastRun}}, sources: {binance: true, cmc: true}, uptime }` — HTTP 200 only if core sources respond.

---

## 9. UI Pages (RTL Persian, dark trading-terminal style)

All pages: `<html lang="fa" dir="rtl">`, Vazirmatn, dark background (`#0b0e11`), card style like Binance/بورس‌یار terminal, Persian digits everywhere.

1. **داشبورد `/`** — global market summary (total cap, BTC dominance, fear/greed-colored badge), top-50 movers table, open positions mini-view, health strip (سالم/مشکل‌دار)
2. **رادار `/radar`** — opportunity cards grid: big score badge, side chip (خرید سبز / فروش قرمز — RTL aware), entry/stop/target, Persian reason, «ثبت در صندوق» button
3. **صندوق `/fund`** — one **unified positions table** (longs + shorts together, like an EasyTrader portfolio), orders log, stats cards (سود کل، نرخ برد، حداکثر افت، ضریب سود), equity sparkline
4. **مغز `/brain`** — accuracy per horizon (24h/72h), per-strategy hit rate bars, learning-curve chart, latest evaluated samples table
5. **شیفت‌شب `/nightshift`** — jobs table with status dots, last run, duration, error messages
6. **تنظیمات `/settings`** — show which keys are set (not their values!), mode badge («حالت شبیه‌سازی» vs «حالت واقعی — قفل»), risk limits, Toobit connection status placeholder for Phase 2

---

## 10. UI String Table (use these exact Persian labels)

| Key | FA |
|---|---|
| app.name | کریپتویار |
| app.tagline | شکار بهترین کوین‌ها در بهترین زمان |
| nav.dashboard | داشبورد |
| nav.radar | رادار فرصت‌ها |
| nav.fund | صندوق شبیه‌ساز |
| nav.brain | مغز یادگیرنده |
| nav.nightshift | شیفت‌شب |
| nav.settings | تنظیمات |
| side.long | خرید |
| side.short | فروش |
| radar.register | ثبت در صندوق |
| fund.equity | سرمایهٔ کل |
| fund.pnl | سود/زیان |
| fund.winRate | نرخ برد |
| fund.maxDrawdown | حداکثر افت |
| fund.profitFactor | ضریب سود |
| fund.stopHit | حد ضرر فعال شد |
| fund.tpHit | هدف سود محقق شد |
| brain.accuracy | دقت مغز |
| brain.samples | نمونه‌های یادگیری |
| nightshift.healthy | سالم |
| nightshift.error | خطا |
| settings.mode.paper | حالت شبیه‌سازی |
| settings.mode.live | حالت واقعی — قفل |
| settings.keySet | کلید تنظیم شده |
| settings.keyMissing | کلید ثبت نشده |

---

## 11. API Endpoints (summary)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | health + sources + jobs (200 = ok) |
| GET | `/api/market` | top-50 coins + global metrics |
| GET | `/api/radar` | ranked signals |
| GET | `/api/fund` | positions + orders + stats |
| POST | `/api/fund/orders` | open/close manual paper order |
| GET | `/api/brain` | accuracy + samples |
| GET | `/api/brain/selftest` | replay last 200 samples |
| GET | `/api/nightshift` | job logs |

---

## 12. Security Rules (hard requirements)

1. Keys **only** in `.env`; never returned by any API; never logged (add a redaction guard on console for `CMC_API_KEY|TOOBIT_`)
2. `TRADING_MODE` defaults to `paper`; **live execution is Phase 2+** and must require: keys present + explicit `Setting.mode=live` + a confirmation flag in the request — build the gate now, keep it locked
3. All write endpoints validate input (zod) and reject invalid qty/symbol
4. Toobit key guidance shown to owner: trade-only permission, **no withdrawal**, IP whitelist recommended

---

## 13. Toobit Connector (Phase 2 — scaffold in Phase 1, do not call)

- Implement `src/lib/connector/types.ts` (`ExchangeConnector` interface) + `PaperConnector` (fully working now)
- Stub `ToobitConnector` with TODO markers: signing (HMAC-SHA256, `timestamp` + `signature` query/header per official docs), spot + USDT-M futures endpoints, rate limits — **verify exact endpoints from the official Toobit docs at implementation time**
- Settings page shows Toobit card: «اتصال فاز ۲ — آمادهٔ فعال‌سازی»

---

## 14. Acceptance Criteria (definition of done — check every box)

1. `npx tsc --noEmit` passes with zero errors
2. `GET /api/health` returns 200 with `binance: true` and jobs populated
3. Within 2 minutes of first start: top-50 coins persisted, ≥ 1 candle set per top-10 symbol
4. Radar returns ≥ 1 signal with a Persian reason and feature chips
5. Fund opens a paper position from a radar signal; mark-to-market updates PnL; stop/TP auto-close works (simulate by injecting price)
6. Brain stores samples, selftest returns accuracy numbers
7. Nightshift jobs run on schedule and log to `JobLog`
8. Every page fully Persian RTL with Persian digits; no untranslated label
9. No key ever appears in any response or log
10. `npm run build` succeeds

---

## 15. Build Order (do exactly this sequence)

1. Scaffold Next.js 16 + Tailwind + Prisma schema + `.env.example` + RTL shell (font, dir, nav)
2. Fetchers (Binance → CMC) + normalizer + rate limiter + persistence
3. Nightshift scheduler with `ticker-refresh` + `candle-refresh` running
4. Brain v1 (features → score → reasonFa) + samples + selftest
5. Radar strategies + API
6. Paper fund (open/close/mark/stats/risk gates) + API
7. UI pages in order: داشبورد → رادار → صندوق → مغز → شیفت‌شب → تنظیمات
8. Health endpoint + acceptance pass
9. (Later phases) ToobitConnector real signing → read-only balances → live mode behind the lock

---

## 16. `.env.example`

```env
CMC_API_KEY=your_coinmarketcap_key
TOOBIT_API_KEY=
TOOBIT_API_SECRET=
TRADING_MODE=paper
NODE_OPTIONS=--max-old-space-size=700
```

---

> **Final note to the builder:** The soul of this system is the *learning loop*: fetch real data → signal → paper trade → evaluate → adjust weights → repeat 24/7. Do not fake any data; every number on screen must come from a real API call or a computed value stored in the DB. If a source fails, degrade gracefully (show «منبع در دسترس نیست») instead of crashing.
> **یادداشت پایانی:** روح سامانه حلقهٔ یادگیری است: دادهٔ واقعی ← سیگنال ← معاملهٔ شبیه‌سازی ← ارزیابی ← اصلاح وزن‌ها ← تکرار ۲۴/۷. هیچ دادهٔ جعلی ممنوع؛ در صورت قطع یک منبع، با پیام فارسی «منبع در دسترس نیست» به‌آرامی کاهش حالت بده، نه کرش.
