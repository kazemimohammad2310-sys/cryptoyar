import type { ExchangeConnector, OrderRequest, OrderResult, BalanceInfo, PositionInfo } from '@/lib/connector/types'

// ─── ToobitConnector — Phase 2 SCAFFOLD ONLY (§13). Do NOT call in Phase 1. ───
// TODO(Phase 2, per official docs at https://toobit-docs.github.io/apidocs/):
//  1. Verify exact base URLs (spot vs USDT-M futures) from the docs.
//  2. Implement HMAC-SHA256 signing: timestamp + signature via query/header
//     exactly as documented — do NOT guess endpoints or parameter names.
//  3. Respect documented rate limits; wire the shared rate limiter.
//  4. Gate activation behind: keys present + Setting.mode=live + explicit
//     confirmation flag in the request (§12.2).
//  5. Owner key guidance (Settings page): trade-only permission, NO withdrawal
//     permission, IP whitelist recommended.

export class ToobitConnector implements ExchangeConnector {
  readonly name = 'toobit'

  private locked(): never {
    throw new Error('ToobitConnector در فاز ۲ فعال می‌شود — حالت واقعی قفل است')
  }

  async getBalances(): Promise<BalanceInfo> {
    this.locked()
  }
  async getPositions(): Promise<PositionInfo[]> {
    this.locked()
  }
  async placeOrder(_req: OrderRequest): Promise<OrderResult> {
    this.locked()
  }
  async cancelOrder(_id: number): Promise<{ ok: boolean; error?: string }> {
    this.locked()
  }
}
