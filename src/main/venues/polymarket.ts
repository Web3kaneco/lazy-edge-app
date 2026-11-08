// Polymarket through the official CLOB client, pinned at 1.2.0 (a month old;
// the unified @polymarket/client was 0.14 and three days old when this was
// written, without signature types or balance reads documented). Kept to this
// one file so the move to the unified SDK touches nothing else.
//
// The API key, secret and passphrase authenticate a request but cannot place
// an order: every order is EIP-712 signed by the account key (decision 8). The
// key stays in the vault and signs locally; it never leaves the machine.
import { AssetType, Chain, ClobClient, OrderType, Side, SignatureTypeV2, type ApiKeyCreds, type TickSize } from '@polymarket/clob-client-v2'
import { createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import type { AccountSettings } from '@shared/schema'
import type { ContractSide } from '@shared/signal'
import type { TradeDecision, VenueState } from '../rules/gates'
import { vault } from '../store/vault'
import { DRY_RUN_RESULT, type OrderUpdate, type PlaceResult, type Quote, type Venue } from './types'

const HOST = 'https://clob.polymarket.com'
// The exchange refuses a GTD order expiring sooner than a minute out.
const GTD_SECURITY_S = 60

const SIGNATURE_TYPE: Record<AccountSettings['venues']['polymarket']['accountType'], SignatureTypeV2> = {
  email: SignatureTypeV2.POLY_PROXY,
  browser_wallet: SignatureTypeV2.POLY_GNOSIS_SAFE,
  eoa: SignatureTypeV2.EOA
}

export class PolymarketVenue implements Venue {
  readonly id = 'polymarket' as const
  private readonly publicClient = new ClobClient({ host: HOST, chain: Chain.POLYGON })
  private client: ClobClient | null = null
  private clientFor = ''
  private feeRates = new Map<string, number>()

  constructor(private readonly accountType: () => AccountSettings['venues']['polymarket']['accountType']) {}

  configured(): boolean {
    const type = this.accountType()
    return Boolean(vault.get('polymarket.privateKey') && (type === 'eoa' || vault.get('polymarket.funder')))
  }

  private async trading(): Promise<ClobClient> {
    const pk = vault.get('polymarket.privateKey')
    if (!pk) throw new Error('Polymarket private key is not set')
    const type = this.accountType()
    const funder = type === 'eoa' ? undefined : (vault.get('polymarket.funder') ?? undefined)
    if (type !== 'eoa' && !funder) throw new Error('Polymarket profile address is not set')
    const fingerprint = `${type}|${funder ?? ''}|${pk.slice(-6)}`
    if (this.client && this.clientFor === fingerprint) return this.client

    const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex)
    const signer = createWalletClient({ account, chain: polygon, transport: http() })
    const signatureType = SIGNATURE_TYPE[type]

    let creds: ApiKeyCreds | null = null
    const stored = vault.get('polymarket.apiCreds')
    if (stored) {
      try { creds = JSON.parse(stored) as ApiKeyCreds } catch { creds = null }
    }
    if (!creds) {
      // L1: derive the L2 credentials once from the key, then keep them vaulted.
      creds = await new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, signatureType, funderAddress: funder }).createOrDeriveApiKey()
      await vault.set('polymarket.apiCreds', JSON.stringify(creds))
    }
    this.client = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, creds, signatureType, funderAddress: funder, throwOnError: true })
    this.clientFor = fingerprint
    return this.client
  }

  async quote(tokenId: string, side: ContractSide): Promise<Quote | null> {
    // Each outcome is its own token, bought directly. There is no NO side of a
    // token to buy, so a NO request is refused rather than mapped.
    if (side !== 'yes') return null
    const book = await this.publicClient.getOrderBook(tokenId)
    const asks = (book.asks ?? []).map((a) => ({ p: Number(a.price), s: Number(a.size) })).filter((a) => a.p > 0)
    const best = asks.reduce<{ p: number; s: number } | null>((m, a) => (!m || a.p < m.p ? a : m), null)
    const ageS = book.timestamp ? Math.max(0, (Date.now() - Number(book.timestamp)) / 1000) : 0
    return { ask: best?.p ?? null, askSize: best?.s ?? null, priceAgeS: Math.round(ageS) }
  }

  async feeRate(tokenId: string): Promise<number | null> {
    if (this.feeRates.has(tokenId)) return this.feeRates.get(tokenId)!
    try {
      const rate = (await this.publicClient.getFeeRateBps(tokenId)) / 10_000
      this.feeRates.set(tokenId, rate)
      return rate
    } catch {
      return null
    }
  }

  async state(): Promise<VenueState> {
    if (!this.configured()) return { balanceUsd: null, equityUsd: null }
    try {
      const b = await (await this.trading()).getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      const usd = Number(b.balance) / 1e6 // USDC has six decimals
      // Open positions are not marked here, so equity is cash alone. That makes
      // the per game cap smaller, never larger, than the true one.
      return { balanceUsd: usd, equityUsd: usd }
    } catch {
      return { balanceUsd: null, equityUsd: null }
    }
  }

  async place(order: TradeDecision): Promise<PlaceResult> {
    if (order.dryRun) return DRY_RUN_RESULT(order)
    try {
      const client = await this.trading()
      const [tickSize, negRisk] = await Promise.all([client.getTickSize(order.contract), client.getNegRisk(order.contract)])
      const tick = Number(tickSize)
      // Round DOWN to the tick: a limit buy never pays more than the gates approved.
      const price = Math.floor(order.limitPriceC / 100 / tick) * tick
      if (price <= 0) throw new Error(`price ${order.limitPriceC}c is below one tick (${tickSize})`)
      const res = await client.createAndPostOrder(
        {
          tokenID: order.contract,
          price: Number(price.toFixed(4)),
          size: order.contracts,
          side: Side.BUY,
          expiration: Math.floor(Date.now() / 1000) + GTD_SECURITY_S + order.autoCancelS
        },
        { tickSize: tickSize as TickSize, negRisk },
        OrderType.GTD
      )
      if (!res.success) throw new Error(res.errorMsg || `order not accepted (${res.status})`)
      const matched = res.status?.toLowerCase() === 'matched'
      return {
        ok: true,
        venueOrderId: res.orderID,
        status: matched ? 'filled' : 'resting',
        filledContracts: matched ? order.contracts : 0,
        avgFillC: matched ? Math.round(price * 10000) / 100 : null,
        feeUsd: 0,
        error: null
      }
    } catch (err) {
      return { ok: false, venueOrderId: null, status: 'rejected', filledContracts: 0, avgFillC: null, feeUsd: 0, error: (err as Error).message }
    }
  }

  async status(id: string): Promise<OrderUpdate | null> {
    if (id.startsWith('dryrun')) return null
    try {
      const o = await (await this.trading()).getOrder(id)
      const filled = Number(o.size_matched ?? 0)
      const size = Number(o.original_size ?? 0)
      const st = String(o.status ?? '').toUpperCase()
      const px = filled > 0 ? Math.round(Number(o.price) * 10000) / 100 : null
      const done = filled > 0 && filled >= size
      return {
        status: done ? 'filled' : st.includes('CANCEL') || st.includes('EXPIRE') ? (filled > 0 ? 'partial' : 'cancelled') : filled > 0 ? 'partial' : 'resting',
        filledContracts: filled,
        avgFillC: px,
        feeUsd: null
      }
    } catch {
      return null
    }
  }

  async cancel(id: string): Promise<void> {
    if (id.startsWith('dryrun')) return
    await (await this.trading()).cancelOrder({ orderID: id })
  }

  // A resolved token's book is gone and its last price pins to 1 or 0. Read it
  // from the public book; anything short of a clear 0.99 / 0.01 stays open.
  async settlement(tokenId: string): Promise<'yes' | 'no' | null> {
    try {
      const book = await this.publicClient.getOrderBook(tokenId)
      const last = Number(book.last_trade_price)
      if ((book.bids ?? []).length || (book.asks ?? []).length) return null
      return last >= 0.99 ? 'yes' : last <= 0.01 ? 'no' : null
    } catch {
      return null
    }
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const s = await this.state()
      if (s.balanceUsd === null) return { ok: false, detail: 'Polymarket did not return a balance. Check the key, the account type and the profile address.' }
      return { ok: true, detail: `Connected. USDC balance $${s.balanceUsd.toFixed(2)}.` }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }
}
