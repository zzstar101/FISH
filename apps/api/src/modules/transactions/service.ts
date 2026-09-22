import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  type MeetupTokenRedeemInput,
  type MeetupTokenResponse,
  type MeetupTokenStatusResponse,
  type MeetupTokenVerifyCodeInput,
  type MeetupVerificationResponse,
  meetupTokenResponseSchema,
  meetupTokenStatusResponseSchema,
  meetupVerificationResponseSchema,
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
import { MeetupTokenCrypto } from './meetup-token'
import {
  MeetupConsumeRaceError,
  type TransactionRow,
  type TransactionStore,
  type TxListingBrief,
  type TxUserBrief,
} from './store'

export class TransactionServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TransactionServiceError'
  }
}

/**
 * #147：凭证随交易生命周期（PENDING_MEETUP 内长期有效，终态同事务销毁），
 * 不再有 TTL / 过期路径；刷新即重签（旧码立即作废）。
 */
/** 6 位码爆破防护：累计 5 次失败锁 10 分钟（QR token 高熵，计数共用同一防线）。 */
export const MEETUP_TOKEN_MAX_ATTEMPTS = 5
export const MEETUP_TOKEN_LOCK_SECONDS = 10 * 60

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
    conversationId: row.conversation_id,
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
  /** 卖家签发/刷新面交码（明文只出现在本次响应）。 */
  issueMeetupToken(userId: string, id: string): Promise<MeetupTokenResponse>
  /** 当前面交凭证状态（无明文；非参与者 404 不泄漏存在性）。 */
  getMeetupTokenStatus(userId: string, id: string): Promise<MeetupTokenStatusResponse>
  /** 买家出示二维码核销（qrToken 是 payload `t` 参数的原始 token）。 */
  redeemMeetupToken(
    userId: string,
    id: string,
    input: MeetupTokenRedeemInput,
  ): Promise<MeetupVerificationResponse>
  /** 买家手动输入 6 位码核销。 */
  verifyMeetupCode(
    userId: string,
    id: string,
    input: MeetupTokenVerifyCodeInput,
  ): Promise<MeetupVerificationResponse>
}

/**
 * 面交核销共用的前置校验：参与者（404 不泄漏）→ 交易仍在 PENDING_MEETUP（409）。
 * 角色检查刻意放在这之后：终态交易对任何人都是「已结束」409，先于「能不能消费」403。
 */
async function loadPendingTxForMeetup(
  store: TransactionStore,
  userId: string,
  id: string,
): Promise<TransactionRow> {
  if (!isTransactionId(id)) throw notFound()
  const row = await store.findById(id)
  if (!row || (row.buyer_id !== userId && row.seller_id !== userId)) throw notFound()
  if (row.status !== 'PENDING_MEETUP') {
    throw new TransactionServiceError(
      409,
      'TRANSACTION_NOT_IN_PENDING',
      '交易已结束，面交码不再可用',
    )
  }
  return row
}

export function createTransactionService({
  store,
  messages,
  storage,
  /** 面交码 HMAC 密钥（#70，MEETUP_TOKEN_SECRET；明文不落库的前提）。 */
  meetupSecret,
  /** SYSTEM 消息写入后回调（实时推送）；推送失败不得影响响应。 */
  onSystemMessage,
}: {
  store: TransactionStore
  messages: MessageStore
  storage: MediaStorage
  meetupSecret: string
  onSystemMessage?: TxSideEffect
}): TransactionService {
  const meetupCrypto = new MeetupTokenCrypto(meetupSecret)
  async function writeSystem(
    participants: { buyerId: string; sellerId: string },
    conversationId: string,
    event: Parameters<typeof transactionSystemEventSchema.parse>[0],
  ) {
    const row = await messages.insertSystem(conversationId, systemEventContent(event))
    onSystemMessage?.(participants, row)
    return row
  }

  /**
   * QR 核销与 6 位码核销共用：除出示的凭证串与比对列不同外，校验顺序与错误码一致。
   * 顺序 = 参与者(404) → 终态(409) → 非消费方(403) → 无凭证(404) → 锁定(429) →
   * 原子核销（ok / consumed / locked / invalid；#147 无 expired）。
   */
  async function consumeMeetup(
    userId: string,
    id: string,
    input: { kind: 'qr' | 'code'; presented: string },
  ): Promise<MeetupVerificationResponse> {
    const row = await loadPendingTxForMeetup(store, userId, id)
    if (row.seller_id === userId) {
      throw new TransactionServiceError(403, 'MEETUP_TOKEN_NOT_ALLOWED', '不能核销自己出示的面交码')
    }
    const tokenRow = await store.findMeetupToken(id)
    if (!tokenRow) {
      throw new TransactionServiceError(404, 'MEETUP_TOKEN_NOT_FOUND', '这笔交易还没有可用的面交码')
    }
    // 契约对 qrToken 只约束非空（#88 冻结）；服务端在此收紧形状——超长 / 非
    // base64url（与签发侧 token 字符集一致）的输入不进入 HMAC，直接按无效处理。
    // 6 位码已由契约正则约束，无需重复。
    if (
      input.kind === 'qr' &&
      (input.presented.length > 128 || !/^[A-Za-z0-9_-]+$/.test(input.presented))
    ) {
      throw new TransactionServiceError(422, 'MEETUP_TOKEN_INVALID', '面交码不正确')
    }
    if (tokenRow.locked_until != null && new Date(tokenRow.locked_until).getTime() > Date.now()) {
      throw new TransactionServiceError(429, 'MEETUP_TOKEN_LOCKED', '错误次数过多，请稍后再试')
    }
    let result: Awaited<ReturnType<TransactionStore['consumeMeetupToken']>>
    try {
      result = await store.consumeMeetupToken(id, userId, {
        kind: input.kind,
        hash: meetupCrypto.hash(input.presented),
      })
    } catch (error) {
      // 窗口期（前置检查之后）交易被取消/完成：核销已随事务回滚，按终态给 409
      if (error instanceof MeetupConsumeRaceError) {
        throw new TransactionServiceError(
          409,
          'TRANSACTION_NOT_IN_PENDING',
          '交易已结束，面交码不再可用',
        )
      }
      throw error
    }
    if (result.kind === 'ok') {
      return meetupVerificationResponseSchema.parse({
        transactionId: id,
        verified: true,
        verifiedBy: userId,
        verifiedAt: toIso(result.row.consumed_at),
        nextAction: 'CONFIRM_DELIVERY',
      })
    }
    if (result.kind === 'invalid') {
      // 失败计数绑定「诊断不匹配时」读到的凭证代际：卖家刷新（换哈希）后，
      // 并发旧请求的失败被丢弃，不会累计到新一代凭证上（审查 P1）。
      const failure = await store.recordMeetupTokenFailure(
        id,
        { tokenHash: tokenRow.token_hash, codeHash: tokenRow.code_hash },
        MEETUP_TOKEN_MAX_ATTEMPTS,
        MEETUP_TOKEN_LOCK_SECONDS,
      )
      if (failure?.lockedUntil != null && new Date(failure.lockedUntil).getTime() > Date.now()) {
        throw new TransactionServiceError(429, 'MEETUP_TOKEN_LOCKED', '错误次数过多，请稍后再试')
      }
      throw new TransactionServiceError(422, 'MEETUP_TOKEN_INVALID', '面交码不正确')
    }
    if (result.kind === 'consumed') {
      throw new TransactionServiceError(
        409,
        'MEETUP_TOKEN_CONSUMED',
        '面交码已被使用，不能重复核销',
      )
    }
    if (result.kind === 'locked') {
      throw new TransactionServiceError(429, 'MEETUP_TOKEN_LOCKED', '错误次数过多，请稍后再试')
    }
    // not-found：前置检查后凭证被删（#147 终态销毁），防御性归 NOT_FOUND
    throw new TransactionServiceError(404, 'MEETUP_TOKEN_NOT_FOUND', '这笔交易还没有可用的面交码')
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

      // content 由本层序列化（契约的唯一出口 systemEventContent），但 transactionId 只有
      // 插入后才存在，因此以回调交给 store，在**同一个事务**里连同交易行一起写入（#40-3）。
      const result = await store.accept(brief, input.amountCents, (transactionId) =>
        systemEventContent({ type: 'tx.accepted', transactionId, amountCents: input.amountCents }),
      )
      if (result.kind === 'listing-not-active') {
        // 契约冻结语义：并发输给另一买家 / 商品已非 ACTIVE。重试恢复口径见 routes 注释。
        throw new TransactionServiceError(409, 'LISTING_NOT_ACTIVE', '商品当前不可交易')
      }

      // 消息已随交易落库，这里只负责推给在线端（落库失败则根本走不到这一步）。
      onSystemMessage?.({ buyerId: brief.buyerId, sellerId: brief.sellerId }, result.message)
      // 刚建的行 FK 必然齐备；拿不到摘要属于不可达防御分支。此刻交易已创建且
      // listing 已锁定、SYSTEM 消息已推送——不能复用 409 业务码（会诱导客户端把
      // "实际已成功"当失败重试），交给 onError 统一成 500 INTERNAL_ERROR。
      const [dto] = await toDtos(store, storage, [result.row], userId)
      if (!dto) {
        throw new Error(`accept 后组装 DTO 失败：transaction=${result.row.id} 摘要缺失（不可达）`)
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

    async issueMeetupToken(userId, id) {
      const row = await loadPendingTxForMeetup(store, userId, id)
      // 签发人是卖家（契约冻结：routes.ts「卖家签发一次性面交码」）；买家是参与者，
      // 但他的页面只负责扫码/输码 —— 403 MEETUP_TOKEN_NOT_ALLOWED（与消费方约束同码）。
      if (row.seller_id !== userId) {
        throw new TransactionServiceError(403, 'MEETUP_TOKEN_NOT_ALLOWED', '只有卖家可以出示面交码')
      }
      const token = meetupCrypto.generateToken()
      const code = meetupCrypto.generateCode()
      const tokenRow = await store.upsertMeetupToken(id, {
        tokenHash: meetupCrypto.hash(token),
        codeHash: meetupCrypto.hash(code),
        issuedBy: row.seller_id,
      })
      if (!tokenRow) {
        // 前置检查后、持锁写入前，交易被并发 cancel/complete 推入终态（store 内
        // FOR UPDATE 校验落 0 行）。与 loadPendingTxForMeetup 同一口径给 409。
        throw new TransactionServiceError(
          409,
          'TRANSACTION_NOT_IN_PENDING',
          '交易已结束，面交码不再可用',
        )
      }
      // 刷新 = 整行覆写：旧码立即作废（重放旧 payload / 旧 6 位码都到不了匹配那一步）。
      return meetupTokenResponseSchema.parse({
        transactionId: id,
        code,
        qrPayload: meetupCrypto.qrPayload(id, token),
      })
    },

    async getMeetupTokenStatus(userId, id) {
      if (!isTransactionId(id)) throw notFound()
      const row = await store.findById(id)
      if (!row || (row.buyer_id !== userId && row.seller_id !== userId)) throw notFound()
      // #147：终态以**交易**为唯一真相。终态时凭证行必已同事务删除，这里再显式判一次
      // 交易状态，保证「凭证行仍在」（迁移前遗留的旧行 / 任何未来漂移）也不会让卖家
      // 页面显示「有效」而后端实际已失效——即不出现「页面显示有效、后端已过期」。
      if (row.status !== 'PENDING_MEETUP') {
        return meetupTokenStatusResponseSchema.parse({
          transactionId: id,
          status: 'NONE',
          consumedAt: null,
          consumedBy: null,
        })
      }
      const tokenRow = await store.findMeetupToken(id)
      if (!tokenRow) {
        return meetupTokenStatusResponseSchema.parse({
          transactionId: id,
          status: 'NONE',
          consumedAt: null,
          consumedBy: null,
        })
      }
      // 状态全部派生，不落列：CONSUMED / ISSUED（#147：终态行已删，无 EXPIRED）。
      return meetupTokenStatusResponseSchema.parse({
        transactionId: id,
        status: tokenRow.consumed_at != null ? 'CONSUMED' : 'ISSUED',
        consumedAt: toIso(tokenRow.consumed_at),
        consumedBy: tokenRow.consumed_by,
      })
    },

    async redeemMeetupToken(userId, id, input) {
      return consumeMeetup(userId, id, { kind: 'qr', presented: input.qrToken })
    },

    async verifyMeetupCode(userId, id, input) {
      return consumeMeetup(userId, id, { kind: 'code', presented: input.code })
    },
  }
}
