import { describe, expect, test } from 'bun:test'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { MemoryMessageStore } from '../messages/service.test'
import { createTransactionService, TransactionServiceError } from './service'
import type { ConversationLookup, TransactionRow, TransactionStore } from './store'

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

  async accept(brief: Extract<ConversationLookup, { kind: 'ok' }>['brief'], amountCents: number) {
    if (brief.listingStatus !== 'ACTIVE') return { kind: 'listing-not-active' as const }
    if (
      this.rows.some((row) => row.listing_id === brief.listingId && row.status === 'PENDING_MEETUP')
    ) {
      return { kind: 'listing-not-active' as const }
    }
    const row: TransactionRow = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
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
    return { kind: 'created' as const, row }
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
}

async function build() {
  const store = new MemoryTxStore()
  const messages = new MemoryMessageStore()
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
