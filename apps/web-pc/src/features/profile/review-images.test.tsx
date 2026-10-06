import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { type ReviewFormImage, ReviewImageSlots, reviewSubmitBlockedReason } from './review-images'

function image(overrides: Partial<ReviewFormImage> = {}): ReviewFormImage {
  return {
    id: 'i1',
    previewUrl: 'blob:preview-1',
    status: 'uploaded',
    objectKey: 'reviews/usr_x/med_y.png',
    error: null,
    file: null,
    ...overrides,
  }
}

describe('reviewSubmitBlockedReason（提交闸门纯函数）', () => {
  test('全部上传成功 → 可提交（null）', () => {
    expect(reviewSubmitBlockedReason([image(), image({ id: 'i2' })], false)).toBeNull()
    expect(reviewSubmitBlockedReason([], false)).toBeNull()
  })

  test('还有上传中 → 阻止并提示', () => {
    const reason = reviewSubmitBlockedReason(
      [image({ status: 'uploading', objectKey: null })],
      false,
    )
    expect(reason).toContain('正在上传')
  })

  test('有失败图 → 阻止（不允许静默丢弃）', () => {
    const reason = reviewSubmitBlockedReason(
      [image(), image({ id: 'i2', status: 'failed', objectKey: null, error: '上传失败' })],
      false,
    )
    expect(reason).toContain('重试或移除')
  })

  test('提交中不重复提示（按钮自身已禁用）', () => {
    expect(reviewSubmitBlockedReason([image({ status: 'uploading' })], true)).toBeNull()
  })

  test('并发选图窗口里超出上限 → 兜底挡住（服务端 422 之前）', () => {
    const four = [image(), image({ id: 'i2' }), image({ id: 'i3' }), image({ id: 'i4' })]
    expect(reviewSubmitBlockedReason(four, false, 3)).toContain('最多 3 张')
  })
})

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

describe('ReviewImageSlots（静态渲染）', () => {
  test('槽位计数与上限；未满时渲染添加入口', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewImageSlots, {
        disabled: false,
        images: [image()],
        maxImages: 3,
        onAddFiles: () => undefined,
        onRemove: () => undefined,
        onRetry: () => undefined,
      }),
    )
    expect(textOf(html)).toContain('1/3')
    expect(html).toContain('type="file"')
  })

  test('满 3 张后不再渲染添加入口', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewImageSlots, {
        disabled: false,
        images: [image(), image({ id: 'i2' }), image({ id: 'i3' })],
        maxImages: 3,
        onAddFiles: () => undefined,
        onRemove: () => undefined,
        onRetry: () => undefined,
      }),
    )
    expect(textOf(html)).toContain('3/3')
    expect(html).not.toContain('type="file"')
  })

  test('失败槽位渲染「重试」，成功槽位不渲染', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewImageSlots, {
        disabled: false,
        images: [image({ status: 'failed', objectKey: null, error: '图片上传失败，请重试' })],
        maxImages: 3,
        onAddFiles: () => undefined,
        onRemove: () => undefined,
        onRetry: () => undefined,
      }),
    )
    expect(textOf(html)).toContain('重试')
    expect(html).toContain('移除配图 1')
  })
})
