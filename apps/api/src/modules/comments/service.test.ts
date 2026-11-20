import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  ContentModerationError,
  type ContentModerationProvider,
  type ModerationSuggestion,
  type ModerationTransport,
} from '../moderation/providers/types'
import type { ModerationDecision, ModerationField } from '../moderation/types'
import { encodeCommentCursor } from './cursor'
import { CommentServiceError, createCommentService } from './service'
import type { CommentCursor, CommentRow, CommentStore } from './store'

const SELLER_ID = '01930000-0000-7000-8000-00000000000a'
/** 只取 `publicUrl`：「公开 URL 怎么拼」只有一个实现（#6 契约 §7.8）。 */
const storage = { publicUrl: (key: string) => `https://cdn.example/${key}` }
const BUYER_ID = '01930000-0000-7000-8000-00000000000b'
const LISTING_ID = '01930000-0000-7000-8000-000000000011'
const COMMENT_ID = '01930000-0000-7000-8000-000000000021'
const REPLY_ID = '01930000-0000-7000-8000-000000000022'

let seq = 0
const uniqueId = () => `01930000-0000-7000-8000-${String(100 + seq++).padStart(12, '0')}`

function row(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: COMMENT_ID,
    listingId: LISTING_ID,
    authorId: BUYER_ID,
    parentId: null,
    content: '还在吗？',
    createdAt: new Date('2026-09-12T03:40:10.000Z'),
    createdAtCursor: '2026-09-12T03:40:10.000000Z',
    authorNickname: '林一',
    authorAvatarUrl: null,
    ...overrides,
  }
}

/** 只实现 service 用到的行为，记录调用参数以便断言。 */
function fakeStore(
  options: {
    sellerId?: string | null
    topLevel?: CommentRow[]
    replies?: CommentRow[]
    byId?: Record<string, CommentRow | undefined>
  } = {},
): CommentStore & { inserts: unknown[]; listCursors: (CommentCursor | null)[] } {
  const rows = [...(options.topLevel ?? [])]
  const inserts: unknown[] = []
  const listCursors: (CommentCursor | null)[] = []
  return {
    inserts,
    listCursors,
    // #195 的四个方法：本文件只覆盖留言读写的老行为，给不会被执行到的最小实现。
    async listByAuthor() {
      return []
    },
    async countByAuthor() {
      return 0
    },
    async countReplies() {
      return 0
    },
    async deleteOwn() {
      return 0
    },
    async findListingSellerId() {
      return options.sellerId === undefined ? SELLER_ID : options.sellerId
    },
    async listTopLevel(_listingId, limit, cursor: CommentCursor | null) {
      // 缩到 limit 行，由 service 自己判断 hasMore（store 约定取 limit 行即可）
      listCursors.push(cursor)
      return rows.slice(0, limit)
    },
    async listReplies(parentIds) {
      return (options.replies ?? []).filter(
        (reply) => reply.parentId !== null && parentIds.includes(reply.parentId),
      )
    },
    async findById(id) {
      if (options.byId) return options.byId[id] ?? null
      return rows.find((entry) => entry.id === id) ?? null
    },
    async insert(input) {
      inserts.push(input)
      const created = row({
        id: uniqueId(),
        listingId: input.listingId,
        authorId: input.authorId,
        parentId: input.parentId,
        content: input.content,
      })
      rows.push(created)
      // 让后续 findById 能取到「刚插入的那条」：以最新插入的行返回即可。
      options.byId = options.byId ?? {}
      options.byId[created.id] = created
      return created.id
    },
  }
}

/**
 * 只实现 `moderateText`：留言只审正文。记录收到的字段，便于断言「正文没有被伪装成 title」
 * 与 dataId 的业务前缀；`REVIEW` 本地词表对 `content` 字段不产出，必须由它来造。
 */
function fakeModerationProvider(
  outcome: ModerationDecision | ContentModerationError,
): ContentModerationProvider & {
  calls: { dataId: string; field: ModerationField; value: string }[]
} {
  const calls: { dataId: string; field: ModerationField; value: string }[] = []
  const transport: ModerationTransport = 'local'
  return {
    calls,
    transport,
    async moderateText(input) {
      calls.push(...input.fields.map((field) => ({ dataId: input.dataId, ...field })))
      if (outcome instanceof ContentModerationError) throw outcome
      const suggestion: ModerationSuggestion =
        outcome === 'BLOCK' ? 'Block' : outcome === 'REVIEW' ? 'Review' : 'Pass'
      return {
        provider: 'LOCAL',
        transport,
        dataId: input.dataId,
        policyVersion: 'test-policy',
        decision: outcome,
        suggestion,
        fields: input.fields.map((field) => ({
          field: field.field,
          decision: outcome,
          suggestion,
          label: 'TEST',
          subLabel: outcome === 'ALLOW' ? null : 'TEST_RULE',
          score: null,
          requestId: null,
        })),
      }
    },
    async moderateImage() {
      throw new Error('留言不审图片')
    },
  }
}

describe('comment service — list', () => {
  test('marks isSeller from the listing seller, not from the client', async () => {
    const store = fakeStore({
      topLevel: [row()],
      replies: [row({ id: REPLY_ID, parentId: COMMENT_ID, authorId: SELLER_ID })],
    })
    const service = createCommentService({ storage, store })

    const result = await service.listComments(LISTING_ID, { limit: 20 })
    expect(result.items[0]?.isSeller).toBe(false)
    expect(result.items[0]?.replies[0]?.isSeller).toBe(true)
    expect(result.nextCursor).toBeNull()
  })

  test('404s when the listing does not exist', async () => {
    const store = fakeStore({ sellerId: null })
    const service = createCommentService({ storage, store })

    await expect(service.listComments(LISTING_ID, { limit: 20 })).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
  })

  test('returns a nextCursor based on the last returned row when there is another page', async () => {
    const store = fakeStore({
      topLevel: [
        row({ id: COMMENT_ID, createdAtCursor: '2026-09-12T03:40:10.000000Z' }),
        row({ id: REPLY_ID, createdAtCursor: '2026-09-12T03:00:00.000000Z' }),
      ],
    })
    const service = createCommentService({ storage, store })

    const result = await service.listComments(LISTING_ID, { limit: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).not.toBeNull()
    expect(result.items[0]?.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.comment, COMMENT_ID))
  })

  test('rejects a malformed cursor with 422 instead of letting it reach SQL', async () => {
    const store = fakeStore()
    const service = createCommentService({ storage, store })

    await expect(
      service.listComments(LISTING_ID, { limit: 20, cursor: 'forged' }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
  })

  // 只钉「非法游标被拒」不够：合法的游标还必须被解出来后原样转发给 store，
  // 否则分页会静默从头开始。
  test('forwards a valid decoded cursor to the store', async () => {
    const store = fakeStore()
    const service = createCommentService({ storage, store })
    const cursor = encodeCommentCursor({
      createdAt: '2026-09-12T03:40:10.123456Z',
      id: COMMENT_ID,
    })

    await service.listComments(LISTING_ID, { limit: 20, cursor })
    expect(store.listCursors).toEqual([
      { createdAt: '2026-09-12T03:40:10.123456Z', id: COMMENT_ID },
    ])
  })
})

describe('comment service — write', () => {
  test('rejects blocked content without inserting', async () => {
    const store = fakeStore()
    const service = createCommentService({ storage, store })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '我有毒品要卖' }),
    ).rejects.toMatchObject({ status: 422, code: 'COMMENT_CONTENT_BLOCKED' })
    expect(store.inserts).toHaveLength(0)
  })

  test('ALLOW 放行，且正文以 publicContent 字段、按留言前缀送审', async () => {
    const store = fakeStore()
    const provider = fakeModerationProvider('ALLOW')
    const service = createCommentService({ storage, store, moderationProvider: provider })

    const dto = await service.createComment(BUYER_ID, LISTING_ID, { content: '还在吗' })
    expect(dto.content).toBe('还在吗')
    const call = provider.calls[0]
    expect(call?.field).toBe('publicContent')
    expect(call?.value).toBe('还在吗')
    expect(call?.dataId.startsWith('comment-')).toBe(true)
  })

  test('REVIEW（待人工确认）拒绝创建，但错误码与 BLOCK 不同', async () => {
    const store = fakeStore()
    const service = createCommentService({
      storage,
      store,
      moderationProvider: fakeModerationProvider('REVIEW'),
    })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '加个微信' }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'COMMENT_CONTENT_REVIEW_REQUIRED',
      details: [{ field: 'content', message: '留言内容待人工复核' }],
    })
    expect(store.inserts).toHaveLength(0)
  })

  test('审核上游超时 → 503 可重试失败，留言不落库', async () => {
    const store = fakeStore()
    const service = createCommentService({
      storage,
      store,
      moderationProvider: fakeModerationProvider(
        new ContentModerationError({ reason: 'timeout', requestId: 'req-1' }),
      ),
    })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 503, code: 'CONTENT_MODERATION_UNAVAILABLE' })
    expect(store.inserts).toHaveLength(0)
  })

  test('回复同样送审：REVIEW 拒绝且 dataId 用 reply 前缀', async () => {
    const store = fakeStore({ byId: { [COMMENT_ID]: row({ id: COMMENT_ID, parentId: null }) } })
    const provider = fakeModerationProvider('REVIEW')
    const service = createCommentService({ storage, store, moderationProvider: provider })

    await expect(
      service.createReply(BUYER_ID, COMMENT_ID, { content: '加个微信' }),
    ).rejects.toMatchObject({ status: 422, code: 'COMMENT_CONTENT_REVIEW_REQUIRED' })
    expect(store.inserts).toHaveLength(0)
    expect(provider.calls[0]?.dataId.startsWith('reply-')).toBe(true)
  })

  test('404s a write to a listing that does not exist', async () => {
    const store = fakeStore({ sellerId: null })
    const service = createCommentService({ storage, store })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
    expect(store.inserts).toHaveLength(0)
  })

  /*
   * 存在性检查（`requireSellerId`）与 INSERT 不在同一事务里，而 #74 给商品加了物理删除：
   * 商品在两步之间被删掉时，`comments_listing_id_listings_id_fk` 会拒绝这次写入。
   * 那是并发下的正常结果（商品没了），语义与「查不到商品」一样 —— 必须是 404，
   * 而不是让 23503 走 `app.onError` 变成 500。
   */
  test('商品在写入瞬间被删（外键冲突）→ 404 LISTING_NOT_FOUND，而不是 500', async () => {
    const store = fakeStore()
    store.insert = async () => {
      throw Object.assign(new Error('Failed query: insert into comments …'), {
        query: 'insert into comments …',
        params: [],
        cause: Object.assign(new Error('violates foreign key constraint'), { errno: '23503' }),
      })
    }
    const service = createCommentService({ storage, store })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
  })

  test('creates a top-level comment and returns it with isSeller=false', async () => {
    const store = fakeStore()
    const service = createCommentService({ storage, store })

    const dto = await service.createComment(BUYER_ID, LISTING_ID, { content: ' 还在吗 ' })
    expect(dto.content).toBe('还在吗')
    expect(dto.isSeller).toBe(false)
    expect(dto.replies).toEqual([])
  })

  test('rejects replying to a reply (one level only)', async () => {
    const store = fakeStore({ byId: { [REPLY_ID]: row({ id: REPLY_ID, parentId: COMMENT_ID }) } })
    const service = createCommentService({ storage, store })

    await expect(
      service.createReply(BUYER_ID, REPLY_ID, { content: '再回一层' }),
    ).rejects.toMatchObject({ status: 422 })
    expect(store.inserts).toHaveLength(0)
  })

  test('404s a reply to a comment that does not exist', async () => {
    const store = fakeStore({ byId: {} })
    const service = createCommentService({ storage, store })

    await expect(
      service.createReply(BUYER_ID, REPLY_ID, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'COMMENT_NOT_FOUND' })
  })

  test('replies inherit the parent listing and are marked isSeller for the seller', async () => {
    const store = fakeStore({ byId: { [COMMENT_ID]: row({ id: COMMENT_ID, parentId: null }) } })
    const service = createCommentService({ storage, store })

    const dto = await service.createReply(SELLER_ID, COMMENT_ID, { content: '还在的' })
    expect(dto.listingId).toBe(encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID))
    expect(dto.isSeller).toBe(true)
  })
})

test('CommentServiceError carries the contract error code', () => {
  const error = new CommentServiceError(404, 'COMMENT_NOT_FOUND', '留言不存在')
  expect(error.name).toBe('CommentServiceError')
  expect(error.status).toBe(404)
})
