import { describe, expect, test } from 'bun:test'
import {
  appendWithinLimit,
  type ReviewImageSlot,
  reviewSubmitBlockedReason,
  uploadedObjectKeys,
} from '../src/features/transaction/review-form'

/**
 * 评价配图表单的纯逻辑（#475 小程序半边）。状态机语义与 PC 端
 * `apps/web-pc/src/features/profile/review-images.test.tsx` 同源：原子槽位、
 * 提交闸门（在途 / 失败 / 超限）、只收 uploaded 的键。
 */

const slot = (over: Partial<ReviewImageSlot> = {}): ReviewImageSlot => ({
  id: 's1',
  path: 'wxfile://tmp/pick.png',
  mime: 'image/png',
  sizeBytes: 123,
  status: 'uploading',
  objectKey: null,
  error: null,
  ...over,
})

const uploaded = (id: string, key: string) => slot({ id, status: 'uploaded', objectKey: key })

describe('评价配图 · 原子槽位预留', () => {
  test('未满槽：追加成功，且是**新数组**（不原地改）', () => {
    const prev = [uploaded('a', 'reviews/u/a.jpg')]
    const entry = slot({ id: 'b' })
    const next = appendWithinLimit(prev, entry, 3)
    expect(next).not.toBeNull()
    expect(next?.map((item) => item.id)).toEqual(['a', 'b'])
    expect(prev).toHaveLength(1)
  })

  test('已满槽：返回 null，调用方不得建条目 / 开上传（孤儿对象防线的最后一段）', () => {
    const full = [uploaded('a', 'k1'), uploaded('b', 'k2'), uploaded('c', 'k3')]
    expect(appendWithinLimit(full, slot({ id: 'd' }), 3)).toBeNull()
  })
})

describe('评价配图 · 提交闸门', () => {
  test('全部已上传（含零张）：可以提交', () => {
    const all = [uploaded('a', 'k1'), uploaded('b', 'k2')]
    expect(reviewSubmitBlockedReason(all)).toBeNull()
    expect(reviewSubmitBlockedReason([])).toBeNull()
  })

  test('还有上传中的图：挡下（提交载荷会缺键，服务端不会补）', () => {
    const mixed = [uploaded('a', 'k1'), slot({ id: 'b', status: 'uploading' })]
    expect(reviewSubmitBlockedReason(mixed)).toBe('还有图片正在上传，请稍候')
  })

  test('有失败图：挡下并要求重试或移除 —— 不允许静默丢图', () => {
    const mixed = [
      uploaded('a', 'k1'),
      slot({ id: 'b', status: 'failed', error: '图片上传失败，请重试' }),
    ]
    expect(reviewSubmitBlockedReason(mixed)).toBe('有图片未上传成功，请重试或移除后再提交')
  })

  test('超限兜底：并发选图窗口里多于上限时宁可挡住，不让 422 变成看不懂的失败', () => {
    const over = [slot({ id: 'a' }), slot({ id: 'b' }), slot({ id: 'c' }), slot({ id: 'd' })]
    expect(reviewSubmitBlockedReason(over)).toBe('最多 3 张配图，请先移除多余的')
  })
})

describe('评价配图 · 提交载荷的键', () => {
  test('只收 uploaded 的 objectKey，槽位序即 sort_order；uploading / failed 不进来', () => {
    const slots = [
      uploaded('a', 'reviews/u/1.jpg'),
      slot({ id: 'b', status: 'uploading' }),
      slot({ id: 'c', status: 'failed' }),
      uploaded('d', 'reviews/u/2.jpg'),
    ]
    expect(uploadedObjectKeys(slots)).toEqual(['reviews/u/1.jpg', 'reviews/u/2.jpg'])
  })

  test('uploaded 但键为 null（不该出现的状态）不进载荷', () => {
    const slots = [slot({ id: 'a', status: 'uploaded', objectKey: null })]
    expect(uploadedObjectKeys(slots)).toEqual([])
  })
})
