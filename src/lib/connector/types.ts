// ─── ExchangeConnector abstraction (§2.3 / §13) ───
// PaperConnector: fully working now (fund trades through it).
// ToobitConnector: Phase-2 scaffold — signing/paths MUST be implemented per the
// official docs (https://toobit-docs.github.io/apidocs/) at activation time.

export interface OrderRequest {
  symbol: string
  side: 'long' | 'short'
  qty: number
  price: number
  stopLoss: number
  takeProfit: number
  reasonFa: string
}

export interface OrderResult {
  ok: boolean
  positionId?: number
  error?: string
}

export interface BalanceInfo {
  equityUsdt: number
  realizedPnl: number
  unrealizedPnl: number
}

export interface PositionInfo {
  id: number
  symbol: string
  side: string
  qty: number
  entryPrice: number
  markPrice: number
  pnlUsdt: number
}

export interface ExchangeConnector {
  readonly name: string
  getBalances(): Promise<BalanceInfo>
  getPositions(): Promise<PositionInfo[]>
  placeOrder(req: OrderRequest): Promise<OrderResult>
  cancelOrder(id: number): Promise<{ ok: boolean; error?: string }>
}

export class PaperConnector implements ExchangeConnector {
  readonly name = 'paper'
  constructor(
    private readonly api: {
      getBalances(): Promise<BalanceInfo>
      getPositions(): Promise<PositionInfo[]>
      placeOrder(req: OrderRequest): Promise<OrderResult>
      cancelOrder(id: number): Promise<{ ok: boolean; error?: string }>
    },
  ) {}
  getBalances() {
    return this.api.getBalances()
  }
  getPositions() {
    return this.api.getPositions()
  }
  placeOrder(req: OrderRequest) {
    return this.api.placeOrder(req)
  }
  cancelOrder(id: number) {
    return this.api.cancelOrder(id)
  }
}
