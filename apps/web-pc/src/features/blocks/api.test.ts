import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  blockRelationPath,
  fetchBlockState,
  fetchMyBlocks,
  myBlocksPath,
  requestBlock,
  requestUnblock,
} from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const userId = 'usr_01jc000000e00800000000000c'

describe('myBlocksPath / blockRelationPath', () => {
  test('恒带 limit，cursor 缺省不带；翻页原样带上', () => {
    expect(myBlocksPath({ limit: 20 })).toBe('/me/blocks?limit=20')
    expect(myBlocksPath({ limit: 20, cursor: 'abc+/=' })).toBe(
      '/me/blocks?limit=20&cursor=abc%2B%2F%3D',
    )
  })

  test('非规范用户 ID 不拼 URL，直接判不可用', () => {
    expect(blockRelationPath(userId)).toBe(`/users/${userId}/block`)
    expect(blockRelationPath('3f9d1c2e-0000-4000-8000-000000000000')).toBeNull()
    expect(blockRelationPath('1234567890')).toBeNull()
  })
})

describe('fetchBlockState', () => {
  test('GET 关系并用契约收口响应', async () => {
    globalThis.fetch = mock(async () => Response.json({ blocked: true })) as unknown as typeof fetch
    expect(await fetchBlockState(userId)).toEqual({ kind: 'loaded', blocked: true })
  })

  test('404 USER_NOT_FOUND 降级 notFound（不是网络失败）', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' } },
        { status: 404 },
      ),
    ) as unknown as typeof fetch
    expect(await fetchBlockState(userId)).toEqual({ kind: 'notFound' })
  })

  test('500 归 failed 且保留服务端文案', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } },
        { status: 500 },
      ),
    ) as unknown as typeof fetch
    expect(await fetchBlockState(userId)).toEqual({ kind: 'failed', message: '服务器内部错误' })
  })
})

describe('requestBlock / requestUnblock', () => {
  test('POST 拉黑、DELETE 解除，都以服务端结论为准', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({ blocked: (init?.method ?? 'GET') === 'POST' })
    }) as unknown as typeof fetch

    expect(await requestBlock(userId)).toEqual({ kind: 'written', blocked: true })
    expect(await requestUnblock(userId)).toEqual({ kind: 'written', blocked: false })
    expect(calls).toEqual([
      { url: `/api/users/${userId}/block`, method: 'POST' },
      { url: `/api/users/${userId}/block`, method: 'DELETE' },
    ])
  })

  test('422 CANNOT_BLOCK_SELF 落 failed（兜底：端上不渲染自己的拉黑钮）', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'CANNOT_BLOCK_SELF', message: '不能拉黑自己' } },
        { status: 422 },
      ),
    ) as unknown as typeof fetch
    expect(await requestBlock(userId)).toEqual({ kind: 'failed', message: '不能拉黑自己' })
  })
})

describe('fetchMyBlocks', () => {
  test('列表按契约收口', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        items: [
          {
            id: userId,
            nickname: '林一',
            avatarUrl: null,
            authStatus: 'VERIFIED',
            blockedAt: '2026-10-05T02:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    ) as unknown as typeof fetch
    const page = await fetchMyBlocks({ limit: 20 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.nickname).toBe('林一')
    expect(page.nextCursor).toBeNull()
  })
})
