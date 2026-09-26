import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { encodeCommentCursor } from './cursor'
import { CommentServiceError, createCommentService } from './service'
import type { CommentCursor, CommentRow, CommentStore } from './store'

const SELLER_ID = '01930000-0000-7000-8000-00000000000a'
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

describe('comment service — list', () => {
  test('marks isSeller from the listing seller, not from the client', async () => {
    const store = fakeStore({
      topLevel: [row()],
      replies: [row({ id: REPLY_ID, parentId: COMMENT_ID, authorId: SELLER_ID })],
    })
    const service = createCommentService({ store })

    const result = await service.listComments(LISTING_ID, { limit: 20 })
    expect(result.items[0]?.isSeller).toBe(false)
    expect(result.items[0]?.replies[0]?.isSeller).toBe(true)
    expect(result.nextCursor).toBeNull()
  })

  test('404s when the listing does not exist', async () => {
    const store = fakeStore({ sellerId: null })
    const service = createCommentService({ store })

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
    const service = createCommentService({ store })

    const result = await service.listComments(LISTING_ID, { limit: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).not.toBeNull()
    expect(result.items[0]?.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.comment, COMMENT_ID))
  })

  test('rejects a malformed cursor with 422 instead of letting it reach SQL', async () => {
    const store = fakeStore()
    const service = createCommentService({ store })

    await expect(
      service.listComments(LISTING_ID, { limit: 20, cursor: 'forged' }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
  })

  // 只钉「非法游标被拒」不够：合法的游标还必须被解出来后原样转发给 store，
  // 否则分页会静默从头开始。
  test('forwards a valid decoded cursor to the store', async () => {
    const store = fakeStore()
    const service = createCommentService({ store })
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
    const service = createCommentService({ store })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '我有毒品要卖' }),
    ).rejects.toMatchObject({ status: 422, code: 'COMMENT_CONTENT_BLOCKED' })
    expect(store.inserts).toHaveLength(0)
  })

  test('404s a write to a listing that does not exist', async () => {
    const store = fakeStore({ sellerId: null })
    const service = createCommentService({ store })

    await expect(
      service.createComment(BUYER_ID, LISTING_ID, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
    expect(store.inserts).toHaveLength(0)
  })

  test('creates a top-level comment and returns it with isSeller=false', async () => {
    const store = fakeStore()
    const service = createCommentService({ store })

    const dto = await service.createComment(BUYER_ID, LISTING_ID, { content: ' 还在吗 ' })
    expect(dto.content).toBe('还在吗')
    expect(dto.isSeller).toBe(false)
    expect(dto.replies).toEqual([])
  })

  test('rejects replying to a reply (one level only)', async () => {
    const store = fakeStore({ byId: { [REPLY_ID]: row({ id: REPLY_ID, parentId: COMMENT_ID }) } })
    const service = createCommentService({ store })

    await expect(
      service.createReply(BUYER_ID, REPLY_ID, { content: '再回一层' }),
    ).rejects.toMatchObject({ status: 422 })
    expect(store.inserts).toHaveLength(0)
  })

  test('404s a reply to a comment that does not exist', async () => {
    const store = fakeStore({ byId: {} })
    const service = createCommentService({ store })

    await expect(
      service.createReply(BUYER_ID, REPLY_ID, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'COMMENT_NOT_FOUND' })
  })

  test('replies inherit the parent listing and are marked isSeller for the seller', async () => {
    const store = fakeStore({ byId: { [COMMENT_ID]: row({ id: COMMENT_ID, parentId: null }) } })
    const service = createCommentService({ store })

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
