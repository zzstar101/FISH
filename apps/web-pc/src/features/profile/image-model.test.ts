import { describe, expect, test } from 'bun:test'
import {
  collectObjectKeys,
  enterImageEditMode,
  existingImagesFromDetail,
  remainingImageSlots,
} from './image-model'

describe('编辑商品弹窗的图片模型（#446）', () => {
  test('existingImagesFromDetail：objectKey 缺席读作 null（不可重新引用）', () => {
    const existing = existingImagesFromDetail([
      { url: 'https://cdn/a.jpg', sortOrder: 0, objectKey: 'listings/u/a.jpg' },
      { url: 'https://cdn/b.jpg', sortOrder: 1 },
    ])
    expect(existing[0]?.objectKey).toBe('listings/u/a.jpg')
    expect(existing[1]?.objectKey).toBeNull()
  })

  test('enterImageEditMode：不可引用的原图被强制标记移除，可引用的保持保留', () => {
    const existing = existingImagesFromDetail([
      { url: 'https://cdn/a.jpg', sortOrder: 0, objectKey: 'listings/u/a.jpg' },
      { url: 'https://cdn/b.jpg', sortOrder: 1 },
    ])
    const after = enterImageEditMode(existing)
    expect(after[0]?.removed).toBe(false)
    expect(after[1]?.removed).toBe(true)
  })

  test('collectObjectKeys：保留的现有图 + 上传完成的新图，跳过被移除与未完成的', () => {
    const existing = [
      { id: 'e1', url: 'a', objectKey: 'listings/u/a.jpg', moderationStatus: null, removed: false },
      { id: 'e2', url: 'b', objectKey: 'listings/u/b.jpg', moderationStatus: null, removed: true },
    ]
    const added = [
      { id: 'n1', previewUrl: 'p', objectKey: 'listings/u/c.jpg', error: null },
      { id: 'n2', previewUrl: 'p', objectKey: null, error: '上传失败' },
    ]
    expect(collectObjectKeys(existing, added)).toEqual({
      ok: true,
      keys: ['listings/u/a.jpg', 'listings/u/c.jpg'],
    })
  })

  test('collectObjectKeys：一张不剩 → 至少 1 张', () => {
    const existing = [
      { id: 'e1', url: 'a', objectKey: 'listings/u/a.jpg', moderationStatus: null, removed: true },
    ]
    expect(collectObjectKeys(existing, [])).toEqual({ ok: false, error: '至少上传 1 张图片' })
  })

  test('collectObjectKeys：存在不可引用却未移除的行 → 拦下提交，不静默丢图', () => {
    const existing = [
      { id: 'e1', url: 'a', objectKey: null, moderationStatus: null, removed: false },
    ]
    expect(collectObjectKeys(existing, [])).toEqual({
      ok: false,
      error: '有原图无法保留，请先移除它再保存',
    })
  })

  test('remainingImageSlots：上限 - 保留的现有图 - 新图（含失败的也占位）', () => {
    const existing = [
      { id: 'e1', url: 'a', objectKey: 'k', moderationStatus: null, removed: false },
      { id: 'e2', url: 'b', objectKey: 'k2', moderationStatus: null, removed: true },
    ]
    const added = [
      { id: 'n1', previewUrl: 'p', objectKey: 'k3', error: null },
      { id: 'n2', previewUrl: 'p', objectKey: null, error: 'x' },
    ]
    expect(remainingImageSlots(existing, added, 9)).toBe(6)
  })
})
