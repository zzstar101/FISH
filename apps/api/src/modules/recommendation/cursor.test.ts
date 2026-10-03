import { describe, expect, test } from 'bun:test'
import { RECOMMENDATION_SNAPSHOT_MAX_ITEMS } from '@fish/contracts/recommendation/rank'
import {
  decodeRecommendationCursor,
  encodeRecommendationCursor,
  type RecommendationCursor,
} from './cursor'

/**
 * 游标编解码单测（#323 N4 / M7）。
 *
 * 游标是**服务端自己编、前端只回传**的不透明串，因此这里最该钉的不是"能编能解"，而是
 * **解码失败的边界**：一个被伪造/截断/跨版本拼出来的游标必须解码成 `null`（路由层 422），
 * 绝不能"宽容解析"成一个看起来合理的起点。
 */

const REQUEST_ID = '018f2b9c-1d2e-7a3b-8c4d-5e6f7a8b9c0d'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

describe('往返', () => {
  test('snapshot 游标往返保持 kind/requestId/offset', () => {
    const cursor: RecommendationCursor = { kind: 'snapshot', requestId: REQUEST_ID, offset: 20 }
    const encoded = encodeRecommendationCursor(cursor)

    expect(decodeRecommendationCursor(encoded)).toEqual(cursor)
    // base64url：URL 安全、无 `=` 填充（游标会出现在 query string 里）。
    expect(encoded).not.toContain('=')
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('passthrough 游标往返保持内层 listingCursor 原样', () => {
    const cursor: RecommendationCursor = {
      kind: 'passthrough',
      requestId: REQUEST_ID,
      listingCursor: 'inner-cursor+/=',
    }
    expect(decodeRecommendationCursor(encodeRecommendationCursor(cursor))).toEqual(cursor)
  })

  test('offset 的边界值 0 与上限都能往返（第一页/最后一页都要能编出来）', () => {
    for (const offset of [0, 1, RECOMMENDATION_SNAPSHOT_MAX_ITEMS]) {
      const cursor: RecommendationCursor = { kind: 'snapshot', requestId: REQUEST_ID, offset }
      expect(decodeRecommendationCursor(encodeRecommendationCursor(cursor))).toEqual(cursor)
    }
  })
})

describe('R1/R2/R3 的旧游标天然兼容（N4）', () => {
  test('旧形状 `{listingCursor, requestId}` 解码成 passthrough，而不是报错', () => {
    // 部署瞬间在途的会话还在用旧游标；判成非法会让用户翻页直接 422。
    expect(
      decodeRecommendationCursor(b64url({ listingCursor: 'legacy', requestId: REQUEST_ID })),
    ).toEqual({ kind: 'passthrough', requestId: REQUEST_ID, listingCursor: 'legacy' })
  })

  test('旧形状的键顺序不影响解码（JSON 对象键序不参与判断）', () => {
    expect(
      decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, listingCursor: 'legacy' })),
    ).toEqual({ kind: 'passthrough', requestId: REQUEST_ID, listingCursor: 'legacy' })
  })
})

describe('解码必须严格拒绝', () => {
  test('非 base64 / 非 JSON / 非对象（数组、字符串、null、数字）一律 null', () => {
    expect(decodeRecommendationCursor('not-base64!!')).toBeNull()
    expect(decodeRecommendationCursor('')).toBeNull()
    expect(decodeRecommendationCursor(b64url([REQUEST_ID, 0]))).toBeNull()
    expect(decodeRecommendationCursor(b64url('snapshot'))).toBeNull()
    expect(decodeRecommendationCursor(b64url(null))).toBeNull()
    expect(decodeRecommendationCursor(b64url(42))).toBeNull()
  })

  test('键数不是恰好 2 就拒：多一个键说明是伪造或另一个版本的编码', () => {
    expect(decodeRecommendationCursor(b64url({ requestId: REQUEST_ID }))).toBeNull()
    expect(
      decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, offset: 0, listingCursor: 'x' })),
    ).toBeNull()
    // `offset` 与 `listingCursor` 同时出现会被键数挡住 —— 判别联合不存在"两个都像"的歧义。
  })

  test('requestId 必须是 UUID 形状（否则它会带着一个查不到的行去翻页）', () => {
    expect(decodeRecommendationCursor(b64url({ requestId: 'nope', offset: 0 }))).toBeNull()
    expect(decodeRecommendationCursor(b64url({ requestId: 42, offset: 0 }))).toBeNull()
    expect(decodeRecommendationCursor(b64url({ requestId: null, offset: 0 }))).toBeNull()
  })

  test('offset 必须是非负整数且不超过快照上限', () => {
    expect(decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, offset: -1 }))).toBeNull()
    expect(decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, offset: 1.5 }))).toBeNull()
    expect(
      decodeRecommendationCursor(
        b64url({ requestId: REQUEST_ID, offset: RECOMMENDATION_SNAPSHOT_MAX_ITEMS + 1 }),
      ),
    ).toBeNull()
    // `offset: null` 不是数字 ⇒ 落进 passthrough 分支，而那里没有 `listingCursor` ⇒ null。
    expect(decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, offset: null }))).toBeNull()
  })

  test('listingCursor 必须是非空字符串', () => {
    expect(
      decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, listingCursor: '' })),
    ).toBeNull()
    expect(
      decodeRecommendationCursor(b64url({ requestId: REQUEST_ID, listingCursor: 7 })),
    ).toBeNull()
  })
})
