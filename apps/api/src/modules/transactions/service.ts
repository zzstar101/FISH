import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  type TransactionAcceptInput,
  type TransactionDto,
  type TransactionListQuery,
  type TransactionListResponse,
  type TransactionProposalInput,
  type TransactionRejectInput,
  transactionDtoSchema,
  transactionListResponseSchema,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'
import { decodeCursor, encodeCursor } from '../conversations/cursor'
import { toMessageDto } from '../messages/service'
import type { MessageRow, MessageStore } from '../messages/store'
import type { MediaStorage } from '../uploads/storage'
import type { TransactionRow, TransactionStore, TxListingBrief, TxUserBrief } from './store'

export class TransactionServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TransactionServiceError'
  }
}

const notFound = () => new TransactionServiceError(404, 'TRANSACTION_NOT_FOUND', '交易不存在')
const conversationNotFound = () =>
  new TransactionServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')

/** 交易 id 的形状校验（DB 列是 uuid）：畸形 id 必须报 404 而不是让 PG 报 500。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isTransactionId(id: string): boolean {
  return UUID_RE.test(id)
}

/** SYSTEM 消息 content 的唯一出口：先经契约 parse 保证形状，再序列化进 messages.content。 */
function systemEventContent(event: Parameters<typeof transactionSystemEventSchema.parse>[0]) {
  return JSON.stringify(transactionSystemEventSchema.parse(event))
}

function toTransactionDto(
  row: TransactionRow,
  viewerId: string,
  listing: TxListingBrief,
  counterpart: TxUserBrief,
  storage: MediaStorage,
): TransactionDto {
  return transactionDtoSchema.parse({
    id: row.id,
    listingId: row.listing_id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    role: row.buyer_id === viewerId ? 'buyer' : 'seller',
    listing: {
      id: listing.id,
      title: listing.title,
      priceCents: listing.priceCents,
      status: listing.status,
      coverUrl: listing.coverObjectKey ? storage.publicUrl(listing.coverObjectKey) : null,
    },
    counterpart,
    amountCents: row.amount_cents,
    status: row.status,
    buyerConfirmedAt: toIso(row.buyer_confirmed_at),
    sellerConfirmedAt: toIso(row.seller_confirmed_at),
    completedAt: toIso(row.completed_at),
    cancelledAt: toIso(row.cancelled_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  })
}

/**
 * 批量组装：两次 IN 查询取全部 listing / 对方用户摘要（coverObjectKeys 先例），
 * 列表页不做逐行回查。会话严格双人，counterpart 由查看者角色二选一。
 * FK 保证行必然存在；摘要缺失的行按脏数据跳过（#6 决策 C 同口径），不 500。
 */
async function toDtos(
  store: TransactionStore,
  storage: MediaStorage,
  rows: TransactionRow[],
  viewerId: string,
): Promise<TransactionDto[]> {
  const counterpartOf = (row: TransactionRow) =>
    row.buyer_id === viewerId ? row.seller_id : row.buyer_id
  const [listings, users] = await Promise.all([
    store.listingBriefs([...new Set(rows.map((row) => row.listing_id))]),
    store.userBriefs([...new Set(rows.map(counterpartOf))]),
  ])
  const dtos: TransactionDto[] = []
  for (const row of rows) {
    const listing = listings.get(row.listing_id)
    const counterpart = users.get(counterpartOf(row))
    if (!listing || !counterpart) continue
    dtos.push(toTransactionDto(row, viewerId, listing, counterpart, storage))
  }
  return dtos
}

function toIso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString()
}

export type TxSideEffect = (
  participants: { buyerId: string; sellerId: string },
  message: MessageRow,
) => void

export interface TransactionService {
  /** 响应是写入的 SYSTEM 消息（契约 MessageDto，camelCase）。 */
  propose(userId: string, input: TransactionProposalInput): Promise<MessageDto>
  reject(userId: string, input: TransactionRejectInput): Promise<MessageDto>
  accept(userId: string, input: TransactionAcceptInput): Promise<TransactionDto>
  listTransactions(userId: string, query: TransactionListQuery): Promise<TransactionListResponse>
  getTransaction(userId: string, id: string): Promise<TransactionDto>
  confirm(userId: string, id: string): Promise<TransactionDto>
  cancel(userId: string, id: string): Promise<TransactionDto>
}

export function createTransactionService({
  store,
  messages,
  storage,
  /** SYSTEM 消息写入后回调（实时推送）；推送失败不得影响响应。 */
  onSystemMessage,
}: {
  store: TransactionStore
  messages: MessageStore
  storage: MediaStorage
  onSystemMessage?: TxSideEffect
}): TransactionService {
  async function writeSystem(
    participants: { buyerId: string; sellerId: string },
    conversationId: string,
    event: Parameters<typeof transactionSystemEventSchema.parse>[0],
  ) {
    const row = await messages.insertSystem(conversationId, systemEventContent(event))
    onSystemMessage?.(participants, row)
    return row
  }

  return {
    async propose(userId, input) {
      const lookup = await store.findConversation(input.conversationId, userId)
      if (lookup.kind === 'not-found') throw conversationNotFound()
      const { brief } = lookup
      if (brief.buyerId !== userId) {
        throw new TransactionServiceError(403, 'NOT_CONVERSATION_BUYER', '只有买家可以发起交易确认')
      }
      if (brief.listingStatus !== 'ACTIVE') {
        throw new TransactionServiceError(409, 'LISTING_NOT_ACTIVE', '商品当前不可交易')
      }
      return toMessageDto(
        await writeSystem({ buyerId: brief.buyerId, sellerId: brief.sellerId }, brief.id, {
          type: 'tx.proposal',
          amountCents: input.amountCents,
        }),
      )
    },

    async reject(userId, input) {
      const lookup = await store.findConversation(input.conversationId, userId)
      if (lookup.kind === 'not-found') throw conversationNotFound()
      const { brief } = lookup
      if (brief.sellerId !== userId) {
        throw new TransactionServiceError(
          403,
          'NOT_CONVERSATION_SELLER',
          '只有卖家可以拒绝交易确认',
        )
      }
      return toMessageDto(
        await writeSystem({ buyerId: brief.buyerId, sellerId: brief.sellerId }, brief.id, {
          type: 'tx.rejected',
        }),
      )
    },

    async accept(userId, input) {
      const lookup = await store.findConversation(input.conversationId, userId)
      if (lookup.kind === 'not-found') throw conversationNotFound()
      const { brief } = lookup
      if (brief.sellerId !== userId) {
        throw new TransactionServiceError(
          403,
          'NOT_CONVERSATION_SELLER',
          '只有卖家可以接受交易确认',
        )
      }

      const result = await store.accept(brief, input.amountCents)
      if (result.kind === 'listing-not-active') {
        // 契约冻结语义：并发输给另一买家 / 商品已非 ACTIVE。重试恢复口径见 routes 注释。
        throw new TransactionServiceError(409, 'LISTING_NOT_ACTIVE', '商品当前不可交易')
      }

      await writeSystem({ buyerId: brief.buyerId, sellerId: brief.sellerId }, brief.id, {
        type: 'tx.accepted',
        transactionId: result.row.id,
        amountCents: input.amountCents,
      })
      // 刚建的行 FK 必然齐备；拿不到摘要属于不可达防御分支，按并发失败口径拒绝。
      const [dto] = await toDtos(store, storage, [result.row], userId)
      if (!dto) {
        throw new TransactionServiceError(409, 'LISTING_NOT_ACTIVE', '商品当前不可交易')
      }
      return dto
    },

    async listTransactions(userId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) {
        throw new TransactionServiceError(422, 'VALIDATION_FAILED', '游标不合法')
      }

      const rows = await store.listForUser(userId, {
        role: query.role,
        status: query.status,
        limit: query.limit,
        cursor,
      })
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1) as (TransactionRow & { created_at_cursor?: string }) | undefined
      return transactionListResponseSchema.parse({
        items: await toDtos(store, storage, page, userId),
        nextCursor:
          hasMore && last?.created_at_cursor
            ? encodeCursor({ sortKey: last.created_at_cursor, id: last.id })
            : null,
      })
    },

    async getTransaction(userId, id) {
      if (!isTransactionId(id)) throw notFound() // 畸形 id：404 而不是 PG 的 500
      const row = await store.findById(id)
      if (!row || (row.buyer_id !== userId && row.seller_id !== userId)) throw notFound()
      const [dto] = await toDtos(store, storage, [row], userId)
      if (!dto) throw notFound()
      return dto
    },

    async confirm(userId, id) {
      if (!isTransactionId(id)) throw notFound()
      const existing = await store.findById(id)
      if (!existing || (existing.buyer_id !== userId && existing.seller_id !== userId)) {
        throw notFound()
      }
      const role = existing.buyer_id === userId ? 'buyer' : 'seller'
      const result = await store.confirm(id, userId, role)
      if (result.kind === 'cancelled') {
        throw new TransactionServiceError(409, 'TRANSACTION_NOT_IN_PENDING', '交易已取消，无法确认')
      }
      const [dto] = await toDtos(store, storage, [result.row], userId)
      if (!dto) throw notFound()
      return dto
    },

    async cancel(userId, id) {
      if (!isTransactionId(id)) throw notFound()
      const existing = await store.findById(id)
      if (!existing || (existing.buyer_id !== userId && existing.seller_id !== userId)) {
        throw notFound()
      }
      const result = await store.cancel(id, userId)
      if (result.kind === 'not-cancellable') {
        throw new TransactionServiceError(409, 'TRANSACTION_NOT_IN_PENDING', '已完成的交易不可取消')
      }
      if (result.kind !== 'ok') throw notFound()
      const [dto] = await toDtos(store, storage, [result.row], userId)
      if (!dto) throw notFound()
      return dto
    },
  }
}
