import { describe, expect, test } from 'bun:test'
import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { MemoryMessageStore } from '../messages/memory-store.fixture'
import { createTransactionService, TransactionServiceError } from './service'
import type {
  ConversationLookup,
  MeetupConsumeInput,
  MeetupConsumeResult,
  MeetupTokenRow,
  TransactionRow,
  TransactionStore,
} from './store'
import { MeetupConsumeRaceError } from './store'

const buyer = '00000000-0000-4000-8000-0000000000a1'
const seller = '00000000-0000-4000-8000-0000000000a2'
const outsider = '00000000-0000-4000-8000-0000000000a3'
const conversationA = '00000000-0000-4000-8000-0000000000c1'
const listingA = '00000000-0000-4000-8000-0000000000b1'

/** 模拟 SQL store 的 to_char 微秒游标键（JS Date 只有毫秒，毫秒段补零到 6 位）。 */
function microIso(value: Date | string): string {
  return new Date(value).toISOString().replace('Z', '000Z')
}

function withCursor(row: TransactionRow): TransactionRow & { created_at_cursor: string } {
  return { ...row, created_at_cursor: microIso(row.created_at) }
}

/** 行值元组 (created_at, id) 是否严格小于游标（DESC 翻页的入选条件）。 */
function tupleLess(row: TransactionRow, cursor: { sortKey: string; id: string }): boolean {
  const key = microIso(row.created_at)
  if (key !== cursor.sortKey) return key < cursor.sortKey
  return row.id < cursor.id
}

class MemoryTxStore implements TransactionStore {
  conversations = new Map<string, ConversationLookup>([
    [
      conversationA,
      {
        kind: 'ok',
        brief: {
          id: conversationA,
          buyerId: buyer,
          sellerId: seller,
          listingId: listingA,
          listingStatus: 'ACTIVE',
        },
      },
    ],
  ])
  rows: TransactionRow[] = []
  /** 模拟 SQL store 的脏数据：被隐藏的 listing 查不到摘要（FK下不可达，防御分支用）。 */
  hiddenListings = new Set<string>()
  private seq = 0

  async listingBriefs(listingIds: string[]) {
    return new Map(
      listingIds
        .filter((id) => !this.hiddenListings.has(id))
        .map((id) => [
          id,
          { id, title: 'K380 键盘', priceCents: 16000, status: 'RESERVED', coverObjectKey: null },
        ]),
    )
  }

  async userBriefs(userIds: string[]) {
    return new Map(
      userIds.map((id) => [id, { id, nickname: `用户${id.slice(-2)}`, avatarUrl: null }]),
    )
  }

  async findConversation(conversationId: string, viewerId: string): Promise<ConversationLookup> {
    const lookup = this.conversations.get(conversationId)
    if (lookup?.kind !== 'ok') return { kind: 'not-found' }
    if (viewerId !== lookup.brief.buyerId && viewerId !== lookup.brief.sellerId) {
      return { kind: 'not-found' }
    }
    return lookup
  }

  /**
   * 内存替身也模拟生产语义：`tx.accepted` 与交易行**同一事务**写入（#40-3），
   * 因此消息写失败时要把已推入的交易行撤回。
   */
  messages: MemoryMessageStore

  constructor(messages: MemoryMessageStore) {
    this.messages = messages
  }

  async accept(
    brief: Extract<ConversationLookup, { kind: 'ok' }>['brief'],
    amountCents: number,
    buildSystemContent: (transactionId: string) => string,
  ) {
    if (brief.listingStatus !== 'ACTIVE') return { kind: 'listing-not-active' as const }
    if (
      this.rows.some((row) => row.listing_id === brief.listingId && row.status === 'PENDING_MEETUP')
    ) {
      return { kind: 'listing-not-active' as const }
    }
    const row: TransactionRow = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
      conversation_id: brief.id,
      listing_id: brief.listingId,
      buyer_id: brief.buyerId,
      seller_id: brief.sellerId,
      amount_cents: amountCents,
      status: 'PENDING_MEETUP',
      buyer_confirmed_at: null,
      seller_confirmed_at: null,
      completed_at: null,
      cancelled_at: null,
      created_at: new Date(`2026-09-12T10:00:0${this.seq}.000000Z`),
      updated_at: new Date(`2026-09-12T10:00:0${this.seq}.000000Z`),
    }
    this.rows.push(row)
    try {
      const message = await this.messages.insertSystem(brief.id, buildSystemContent(row.id))
      return { kind: 'created' as const, row, message }
    } catch (error) {
      this.rows.pop() // 同一事务：消息写失败 → 交易行一并回滚
      throw error
    }
  }

  async findById(id: string) {
    return this.rows.find((row) => row.id === id) ?? null
  }

  async listForUser(
    viewerId: string,
    filter: {
      role?: 'buyer' | 'seller'
      status?: 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'
      limit: number
      cursor: { sortKey: string; id: string } | null
    },
  ) {
    const all = this.rows
      .filter((row) => row.buyer_id === viewerId || row.seller_id === viewerId)
      .filter((row) => !filter.status || row.status === filter.status)
      // 与 SQL 同一排序键：(created_at DESC, id DESC)，用微秒 ISO 文本而不是 Date.toString
      .sort((a, b) => {
        const key = (r: TransactionRow) => microIso(r.created_at)
        return key(b).localeCompare(key(a)) || b.id.localeCompare(a.id)
      })
    if (filter.cursor) {
      // 与 SQL 同一语义：行值元组 (created_at, id) 严格小于游标才入选（而非按 id 找下标）
      const cursor = filter.cursor
      const older = all.filter((row) => tupleLess(row, cursor))
      return older.slice(0, filter.limit + 1).map(withCursor)
    }
    return all.slice(0, filter.limit + 1).map(withCursor)
  }

  async confirm(
    id: string,
    viewerId: string,
    role: 'buyer' | 'seller',
  ): Promise<{ kind: 'ok'; row: TransactionRow } | { kind: 'cancelled' }> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || (row.buyer_id !== viewerId && row.seller_id !== viewerId)) {
      return { kind: 'cancelled' }
    }
    if (row.status === 'CANCELLED') return { kind: 'cancelled' }
    if (row.status === 'COMPLETED') return { kind: 'ok', row }
    if (role === 'buyer') row.buyer_confirmed_at = new Date()
    else row.seller_confirmed_at = new Date()
    if (row.buyer_confirmed_at && row.seller_confirmed_at) {
      row.status = 'COMPLETED'
      row.completed_at = new Date()
    }
    return { kind: 'ok', row }
  }

  async cancel(
    id: string,
    viewerId: string,
  ): Promise<{ kind: 'ok'; row: TransactionRow } | { kind: 'not-cancellable' | 'not-found' }> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || (row.buyer_id !== viewerId && row.seller_id !== viewerId)) {
      return { kind: 'not-found' }
    }
    if (row.status === 'COMPLETED') return { kind: 'not-cancellable' }
    if (row.status === 'CANCELLED') return { kind: 'ok', row }
    row.status = 'CANCELLED'
    row.cancelled_at = new Date()
    return { kind: 'ok', row }
  }

  // ---- 面交凭证（#70）：镜像 SQL store 的语义（含核销盖卖家确认的事务性） ----

  meetupTokens = new Map<string, MeetupTokenRow>()

  async findMeetupToken(transactionId: string): Promise<MeetupTokenRow | null> {
    return this.meetupTokens.get(transactionId) ?? null
  }

  async upsertMeetupToken(
    transactionId: string,
    input: { tokenHash: string; codeHash: string; issuedBy: string; ttlSeconds: number },
  ): Promise<MeetupTokenRow | null> {
    // 对齐 SQL：事务内 FOR UPDATE 校验 PENDING + 卖家，终态交易签发返回 null
    const live = this.rows.find((r) => r.id === transactionId)
    if (live?.status !== 'PENDING_MEETUP' || live.seller_id !== input.issuedBy) return null
    const issuedAt = new Date()
    const row: MeetupTokenRow = {
      transaction_id: transactionId,
      token_hash: input.tokenHash,
      code_hash: input.codeHash,
      issued_by: input.issuedBy,
      issued_at: issuedAt,
      expires_at: new Date(issuedAt.getTime() + input.ttlSeconds * 1000),
      consumed_at: null,
      consumed_by: null,
      failed_attempts: 0,
      locked_until: null,
    }
    this.meetupTokens.set(transactionId, row)
    return row
  }

  async consumeMeetupToken(
    transactionId: string,
    userId: string,
    presented: MeetupConsumeInput,
  ): Promise<MeetupConsumeResult> {
    const row = this.meetupTokens.get(transactionId)
    if (!row) return { kind: 'not-found' }
    if (row.consumed_at != null) return { kind: 'consumed' }
    // MeetupTokenRow 的时间戳是 Date | string（对齐 SQL 行），统一经 Date 规整
    if (new Date(row.expires_at).getTime() <= Date.now()) return { kind: 'expired' }
    if (row.locked_until != null && new Date(row.locked_until).getTime() > Date.now()) {
      return { kind: 'locked' }
    }
    const expected = presented.kind === 'qr' ? row.token_hash : row.code_hash
    if (presented.hash !== expected) return { kind: 'invalid' }
    // 对齐 SQL：哈希命中后（stamp 落 0 行）才因交易离开 PENDING 抛错回滚
    const tx = this.rows.find((r) => r.id === transactionId)
    if (tx?.status !== 'PENDING_MEETUP') throw new MeetupConsumeRaceError(transactionId)
    row.consumed_at = new Date()
    row.consumed_by = userId
    // 与 SQL 同一事务语义：核销成功即盖卖家确认（已值保持）；买家已先行确认时
    // 本次核销是第二侧确认事件 → 同一事务推进 COMPLETED（镜像 confirm 的合并）
    if (tx.seller_confirmed_at == null) tx.seller_confirmed_at = new Date()
    if (tx.buyer_confirmed_at != null) {
      tx.status = 'COMPLETED'
      tx.completed_at = new Date()
    }
    tx.updated_at = new Date()
    return { kind: 'ok', row }
  }

  async recordMeetupTokenFailure(
    transactionId: string,
    generation: { tokenHash: string; codeHash: string },
    maxAttempts: number,
    lockSeconds: number,
  ): Promise<{ failedAttempts: number; lockedUntil: Date | string | null } | null> {
    const row = this.meetupTokens.get(transactionId)
    // 对齐 SQL：行缺失或已刷新成新一代凭证（哈希不匹配）→ 计数被丢弃
    if (!row || row.token_hash !== generation.tokenHash || row.code_hash !== generation.codeHash) {
      return null
    }
    row.failed_attempts += 1
    if (row.failed_attempts >= maxAttempts) {
      row.locked_until = new Date(Date.now() + lockSeconds * 1000)
    }
    return { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until }
  }
}

async function build() {
  const messages = new MemoryMessageStore()
  const store = new MemoryTxStore(messages)
  const storage = {
    presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
    stat: async () => null,
    publicUrl: (key: string) => `https://cdn.test/${key}`,
  }
  const systemEvents: string[] = []
  const service = createTransactionService({
    store,
    messages,
    storage,
    meetupSecret: 'test-meetup-secret',
    onSystemMessage: (_p, message) => systemEvents.push(message.content),
  })
  return { store, service, messages, systemEvents }
}

describe('transaction service: propose / reject / accept', () => {
  test('buyer proposes → SYSTEM tx.proposal message written', async () => {
    const { service, messages } = await build()
    const message = await service.propose(buyer, {
      conversationId: conversationA,
      amountCents: 16000,
    })
    expect(message.type).toBe('SYSTEM')
    const event = JSON.parse(message.content)
    expect(event).toEqual({ type: 'tx.proposal', amountCents: 16000 })
    // SYSTEM 消息也进了 messages 列表
    expect(messages.messages).toHaveLength(1)
  })

  test('403 NOT_CONVERSATION_BUYER when the seller proposes; 404 for outsiders', async () => {
    const { service } = await build()
    expect(
      service.propose(seller, { conversationId: conversationA, amountCents: 1 }),
    ).rejects.toMatchObject({ status: 403, code: 'NOT_CONVERSATION_BUYER' })
    expect(
      service.propose(outsider, { conversationId: conversationA, amountCents: 1 }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })

  test('409 LISTING_NOT_ACTIVE when the listing is not ACTIVE', async () => {
    const { store, service } = await build()
    store.conversations.set(conversationA, {
      kind: 'ok',
      brief: {
        id: conversationA,
        buyerId: buyer,
        sellerId: seller,
        listingId: listingA,
        listingStatus: 'RESERVED',
      },
    })
    expect(
      service.propose(buyer, { conversationId: conversationA, amountCents: 1 }),
    ).rejects.toMatchObject({ status: 409, code: 'LISTING_NOT_ACTIVE' })
  })

  test('seller accepts → transaction created with PENDING_MEETUP + tx.accepted message', async () => {
    const { service, messages } = await build()
    const dto: TransactionDto = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })
    expect(dto.status).toBe('PENDING_MEETUP')
    expect(dto.role).toBe('seller')
    expect(dto.amountCents).toBe(15000)
    // DTO 内嵌商品摘要与查看者视角的对方用户（前端订单卡直接渲染，N+1 由服务端消掉）
    expect(dto.listing).toMatchObject({ id: listingA, title: 'K380 键盘', priceCents: 16000 })
    expect(dto.counterpart).toMatchObject({ id: buyer })
    const event = JSON.parse(messages.messages[0]?.content ?? '{}')
    expect(event).toEqual({
      type: 'tx.accepted',
      transactionId: dto.id,
      amountCents: 15000,
    })
  })

  test('403 NOT_CONVERSATION_SELLER when the buyer tries to accept or reject', async () => {
    const { service } = await build()
    expect(
      service.accept(buyer, { conversationId: conversationA, amountCents: 1 }),
    ).rejects.toMatchObject({ status: 403, code: 'NOT_CONVERSATION_SELLER' })
    expect(service.reject(buyer, { conversationId: conversationA })).rejects.toMatchObject({
      status: 403,
      code: 'NOT_CONVERSATION_SELLER',
    })
  })

  test('reject writes tx.rejected and creates no transaction', async () => {
    const { service, store } = await build()
    const message = await service.reject(seller, { conversationId: conversationA })
    expect(JSON.parse(message.content).type).toBe('tx.rejected')
    expect(store.rows).toHaveLength(0)
  })
})

describe('transaction service: state machine', () => {
  test('double confirm completes the transaction (second confirm returns COMPLETED)', async () => {
    const { service } = await build()
    const created = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })

    const first = await service.confirm(buyer, created.id)
    expect(first.status).toBe('PENDING_MEETUP')
    expect(first.buyerConfirmedAt).not.toBeNull()
    expect(first.completedAt).toBeNull()

    const second = await service.confirm(seller, created.id)
    expect(second.status).toBe('COMPLETED')
    expect(second.completedAt).not.toBeNull()
  })

  test('confirm is idempotent on COMPLETED; on CANCELLED → 409', async () => {
    const { service } = await build()
    const created = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })
    await service.confirm(buyer, created.id)
    const done = await service.confirm(seller, created.id)

    // COMPLETED 上重复 confirm：幂等返回现状
    const again = await service.confirm(buyer, created.id)
    expect(again.status).toBe(done.status)

    // 另一笔交易取消后 confirm：409
    const pending = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })
    await service.cancel(buyer, pending.id)
    expect(service.confirm(seller, pending.id)).rejects.toMatchObject({
      status: 409,
      code: 'TRANSACTION_NOT_IN_PENDING',
    })
  })

  test('cancel on COMPLETED → 409; re-cancel on CANCELLED is idempotent', async () => {
    const { service } = await build()
    const created = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })
    await service.confirm(buyer, created.id)
    await service.confirm(seller, created.id)

    expect(service.cancel(buyer, created.id)).rejects.toMatchObject({
      status: 409,
      code: 'TRANSACTION_NOT_IN_PENDING',
    })

    const pending = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })
    const cancelled = await service.cancel(buyer, pending.id)
    expect(cancelled.status).toBe('CANCELLED')
    const repeat = await service.cancel(seller, pending.id)
    expect(repeat.status).toBe('CANCELLED')
  })

  test('rows with missing embedded summary are skipped, not 500 (决策 C)', async () => {
    const { store, service } = await build()
    const dto = await service.accept(seller, {
      conversationId: conversationA,
      amountCents: 15000,
    })
    // 摘要查询"查不到"该商品：列表里这一行被丢弃，详情 404（不泄漏存在性）
    store.hiddenListings.add(listingA)
    const list = await service.listTransactions(buyer, { limit: 20 })
    expect(list.items).toHaveLength(0)
    await expect(service.getTransaction(buyer, dto.id)).rejects.toMatchObject({ status: 404 })
  })

  test('listTransactions filters by role and pages with cursor', async () => {
    const { store, service } = await build()
    // 部分唯一索引的内存镜像：同一 listing 只允许一笔 live 交易，
    // 所以每笔接受后先完成，再开下一笔（3 笔 COMPLETED 供翻页）。
    for (let i = 0; i < 3; i++) {
      const dto = await service.accept(seller, {
        conversationId: conversationA,
        amountCents: 10000 + i,
      })
      await service.confirm(buyer, dto.id)
      await service.confirm(seller, dto.id)
    }
    void store

    const page1 = await service.listTransactions(seller, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.role).toBe('seller')
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await service.listTransactions(seller, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    })
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()
  })

  test('getTransaction 404 for outsiders (不泄漏存在性)', async () => {
    const { service } = await build()
    const created = await service.accept(seller, { conversationId: conversationA, amountCents: 1 })
    expect(service.getTransaction(outsider, created.id)).rejects.toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
    })
  })
})

describe('TransactionServiceError', () => {
  test('carries status and contract error code', () => {
    const error = new TransactionServiceError(409, 'LISTING_NOT_ACTIVE', 'x')
    expect(error.status).toBe(409)
    expect(error.code).toBe('LISTING_NOT_ACTIVE')
  })
})

describe('transaction service: meetup token (#70)', () => {
  /** 建一笔 PENDING_MEETUP 交易（买家 buyer × 卖家 seller），作为面交码用例的底座。 */
  async function buildWithPendingTx() {
    const ctx = await build()
    const tx = await ctx.service.accept(seller, {
      conversationId: conversationA,
      amountCents: 16000,
    })
    return { ...ctx, txId: tx.id }
  }

  test('卖家签发：6 位码 + 可解析 qrPayload；DB 只有哈希，状态派生为 ISSUED', async () => {
    const { service, store, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    expect(token.code).toMatch(/^\d{6}$/)
    expect(token.transactionId).toBe(txId)
    expect(parseMeetupQrPayload(token.qrPayload)).toEqual({
      transactionId: txId,
      token: expect.any(String),
    })
    const row = await store.findMeetupToken(txId)
    expect(row).not.toBeNull()
    // 明文不落库：DB 存的是 HMAC，与响应里的明文不同
    expect(row?.code_hash).not.toBe(token.code)
    expect(row?.token_hash).not.toContain(parseMeetupQrPayload(token.qrPayload)?.token)
    const status = await service.getMeetupTokenStatus(seller, txId)
    expect(status.status).toBe('ISSUED')
    expect(status.consumedAt).toBeNull()
  })

  test('签发权限：买家 403、外人 404、畸形 id 404', async () => {
    const { service, txId } = await buildWithPendingTx()
    await expect(service.issueMeetupToken(buyer, txId)).rejects.toMatchObject({
      status: 403,
      code: 'MEETUP_TOKEN_NOT_ALLOWED',
    })
    await expect(service.issueMeetupToken(outsider, txId)).rejects.toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
    })
    await expect(service.issueMeetupToken(seller, 'not-a-uuid')).rejects.toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
    })
  })

  test('终态不可签发：CANCELLED 上 409；签发时无凭证 → status NONE', async () => {
    const { service, txId } = await buildWithPendingTx()
    expect(await service.getMeetupTokenStatus(buyer, txId)).toMatchObject({ status: 'NONE' })
    await service.cancel(seller, txId)
    await expect(service.issueMeetupToken(seller, txId)).rejects.toMatchObject({
      status: 409,
      code: 'TRANSACTION_NOT_IN_PENDING',
    })
  })

  test('刷新换码：旧 6 位码与旧 qrToken 立即失效（重放旧码 → INVALID）', async () => {
    const { service, txId } = await buildWithPendingTx()
    const first = await service.issueMeetupToken(seller, txId)
    const second = await service.issueMeetupToken(seller, txId)
    expect(second.code).not.toBe(first.code)
    expect(second.qrPayload).not.toBe(first.qrPayload)
    // 旧码核销：不匹配当前行 → 计失败 → INVALID
    await expect(
      service.redeemMeetupToken(buyer, txId, {
        qrToken: parseMeetupQrPayload(first.qrPayload)?.token ?? '',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'MEETUP_TOKEN_INVALID' })
    await expect(service.verifyMeetupCode(buyer, txId, { code: first.code })).rejects.toMatchObject(
      { status: 422, code: 'MEETUP_TOKEN_INVALID' },
    )
    // 新码可用
    const status = await service.getMeetupTokenStatus(buyer, txId)
    expect(status.status).toBe('ISSUED')
  })

  test('买家 redeem 成功 → verified + CONFIRM_DELIVERY；卖家确认被盖上；买家 confirm → COMPLETED', async () => {
    const { service, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    const verification = await service.redeemMeetupToken(buyer, txId, {
      qrToken: parseMeetupQrPayload(token.qrPayload)?.token ?? '',
    })
    expect(verification).toMatchObject({
      transactionId: txId,
      verified: true,
      verifiedBy: buyer,
      nextAction: 'CONFIRM_DELIVERY',
    })
    // 核销即盖卖家确认（展示码 = 卖家同意），交易仍在 PENDING 等买家侧 confirm
    const afterRedeem = await service.getTransaction(buyer, txId)
    expect(afterRedeem.sellerConfirmedAt).not.toBeNull()
    expect(afterRedeem.buyerConfirmedAt).toBeNull()
    const dto = await service.confirm(buyer, txId)
    expect(dto.status).toBe('COMPLETED')
    expect(dto.completedAt).not.toBeNull()
  })

  test('6 位码核销成功，且重放旧码 → MEETUP_TOKEN_CONSUMED；完成后 → TRANSACTION_NOT_IN_PENDING', async () => {
    const { service, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    await service.verifyMeetupCode(buyer, txId, { code: token.code })
    await expect(service.verifyMeetupCode(buyer, txId, { code: token.code })).rejects.toMatchObject(
      { status: 409, code: 'MEETUP_TOKEN_CONSUMED' },
    )
    await expect(
      service.redeemMeetupToken(buyer, txId, {
        qrToken: parseMeetupQrPayload(token.qrPayload)?.token ?? '',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'MEETUP_TOKEN_CONSUMED' })
    // 买家 confirm 完成交易后，重放同一枚码 → 终态 409（不是 CONSUMED，别掩盖真实状态）
    await service.confirm(buyer, txId)
    await expect(service.verifyMeetupCode(buyer, txId, { code: token.code })).rejects.toMatchObject(
      { status: 409, code: 'TRANSACTION_NOT_IN_PENDING' },
    )
  })

  test('过期凭证 → MEETUP_TOKEN_EXPIRED；状态派生 EXPIRED；刷新后恢复 ISSUED', async () => {
    const { service, store, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    const row = store.meetupTokens.get(txId)
    expect(row).toBeDefined()
    if (row) row.expires_at = new Date(Date.now() - 1000)
    await expect(service.verifyMeetupCode(buyer, txId, { code: token.code })).rejects.toMatchObject(
      { status: 409, code: 'MEETUP_TOKEN_EXPIRED' },
    )
    expect((await service.getMeetupTokenStatus(buyer, txId)).status).toBe('EXPIRED')
    await service.issueMeetupToken(seller, txId)
    expect((await service.getMeetupTokenStatus(buyer, txId)).status).toBe('ISSUED')
  })

  test('卖家不能核销自己出示的码 → 403 MEETUP_TOKEN_NOT_ALLOWED', async () => {
    const { service, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    await expect(
      service.verifyMeetupCode(seller, txId, { code: token.code }),
    ).rejects.toMatchObject({ status: 403, code: 'MEETUP_TOKEN_NOT_ALLOWED' })
  })

  test('形状非法的 qrToken（超长/非 base64url）→ 422 且不计失败（审查非阻断项）', async () => {
    const { service, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    await expect(
      service.redeemMeetupToken(buyer, txId, { qrToken: `${'x'.repeat(200)}` }),
    ).rejects.toMatchObject({ status: 422, code: 'MEETUP_TOKEN_INVALID' })
    await expect(
      service.redeemMeetupToken(buyer, txId, { qrToken: 'bad token with space' }),
    ).rejects.toMatchObject({ status: 422, code: 'MEETUP_TOKEN_INVALID' })
    // 形状拒绝不累计失败：真实码仍可正常核销
    await expect(
      service.redeemMeetupToken(buyer, txId, {
        qrToken: parseMeetupQrPayload(token.qrPayload)?.token ?? '',
      }),
    ).resolves.toMatchObject({ verified: true })
  })

  test('错误 6 位码计失败，第 5 次起 429 MEETUP_TOKEN_LOCKED', async () => {
    const { service, txId } = await buildWithPendingTx()
    await service.issueMeetupToken(seller, txId)
    for (let i = 0; i < 4; i++) {
      await expect(service.verifyMeetupCode(buyer, txId, { code: '000000' })).rejects.toMatchObject(
        { status: 422, code: 'MEETUP_TOKEN_INVALID' },
      )
    }
    await expect(service.verifyMeetupCode(buyer, txId, { code: '000001' })).rejects.toMatchObject({
      status: 429,
      code: 'MEETUP_TOKEN_LOCKED',
    })
    // 锁定期间即使出示正确码也拒绝
    const token = await service.issueMeetupToken(seller, txId) // 刷新同时清零失败计数
    await expect(
      service.verifyMeetupCode(buyer, txId, { code: token.code }),
    ).resolves.toMatchObject({ verified: true })
  })

  test('无凭证核销 → 404 MEETUP_TOKEN_NOT_FOUND', async () => {
    const { service, txId } = await buildWithPendingTx()
    await expect(service.verifyMeetupCode(buyer, txId, { code: '123456' })).rejects.toMatchObject({
      status: 404,
      code: 'MEETUP_TOKEN_NOT_FOUND',
    })
  })

  test('非参与者核销 → 404（Done：非参与者不能完成交易）', async () => {
    const { service, txId } = await buildWithPendingTx()
    await service.issueMeetupToken(seller, txId)
    await expect(
      service.redeemMeetupToken(outsider, txId, { qrToken: 'x'.repeat(22) }),
    ).rejects.toMatchObject({ status: 404, code: 'TRANSACTION_NOT_FOUND' })
    await expect(
      service.verifyMeetupCode(outsider, txId, { code: '123456' }),
    ).rejects.toMatchObject({ status: 404, code: 'TRANSACTION_NOT_FOUND' })
  })

  test('QR 路径错误同样计失败并锁定 → 429', async () => {
    const { service, txId } = await buildWithPendingTx()
    await service.issueMeetupToken(seller, txId)
    for (let i = 0; i < 4; i++) {
      await expect(
        service.redeemMeetupToken(buyer, txId, { qrToken: 'wrong' }),
      ).rejects.toMatchObject({ status: 422, code: 'MEETUP_TOKEN_INVALID' })
    }
    await expect(
      service.redeemMeetupToken(buyer, txId, { qrToken: 'wrong-again' }),
    ).rejects.toMatchObject({ status: 429, code: 'MEETUP_TOKEN_LOCKED' })
  })

  test('买家先单侧 confirm，核销即第二侧确认事件 → 交易直接 COMPLETED（审查 F1）', async () => {
    const { service, txId } = await buildWithPendingTx()
    // 买家在订单里先点了单侧确认：交易仍停 PENDING_MEETUP
    await service.confirm(buyer, txId)
    expect((await service.getTransaction(buyer, txId)).status).toBe('PENDING_MEETUP')
    const token = await service.issueMeetupToken(seller, txId)
    await service.redeemMeetupToken(buyer, txId, {
      qrToken: parseMeetupQrPayload(token.qrPayload)?.token ?? '',
    })
    // 核销盖了卖家确认 + 与买家既有确认合并 → COMPLETED；客户端随后的 confirm 幂等
    const dto = await service.getTransaction(buyer, txId)
    expect(dto.status).toBe('COMPLETED')
    expect(dto.completedAt).not.toBeNull()
  })

  test('status 响应含消费人与时间（CONSUMED 派生）', async () => {
    const { service, txId } = await buildWithPendingTx()
    const token = await service.issueMeetupToken(seller, txId)
    await service.verifyMeetupCode(buyer, txId, { code: token.code })
    const status = await service.getMeetupTokenStatus(seller, txId)
    expect(status).toMatchObject({
      status: 'CONSUMED',
      consumedBy: buyer,
    })
    expect(status.consumedAt).not.toBeNull()
    expect(status.expiresAt).not.toBeNull()
  })
})
