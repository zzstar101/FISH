import { describe, expect, test } from 'bun:test'
import { visualSearchFailureMessage } from '@/features/visual-search/messages'

/**
 * 识图失败 → 用户可见提示。
 *
 * 契约的 5 个错误码（`packages/contracts/src/visual/schema.ts` 的 `VISUAL_SEARCH_ERROR_CODES`）
 * 各有一条专文、429 要带上剩余秒数、未知码与本地失败都透传自己的 message —— 三段都不能被吞成
 * 一句通用话，否则用户除了「失败了」拿不到任何可行动信息。
 */
describe('visualSearchFailureMessage', () => {
  test('5 个契约错误码各有专文', () => {
    expect(
      visualSearchFailureMessage({ code: 'VISUAL_SEARCH_IMAGE_INVALID', message: '查询图不可用' }),
    ).toBe('这张图没法用来搜索，重新拍一张试试')
    expect(
      visualSearchFailureMessage({
        code: 'VISUAL_SEARCH_IMAGE_TOO_LARGE',
        message: '查询图超过大小上限',
      }),
    ).toBe('图片超过大小上限，换一张小一点的试试')
    expect(
      visualSearchFailureMessage({
        code: 'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
        message: '识图服务不可用',
      }),
    ).toBe('识图服务暂时不可用，请稍后重试')
    expect(
      visualSearchFailureMessage({
        code: 'VISUAL_SEARCH_RATE_LIMITED',
        message: '请求过于频繁',
      }),
    ).toBe('识图请求太频繁，请稍后再试')
    expect(
      visualSearchFailureMessage({ code: 'VISUAL_SEARCH_NO_EMBEDDING', message: '数据未就绪' }),
    ).toBe('识图数据还在准备中，请稍后再试')
  })

  test('NO_EMBEDDING 说「数据没就绪」，不说「没找到同款」', () => {
    // 服务端把它与「确实没有相似商品」（200 + 空 items）刻意分开：这是回填还没跑过
    const copy = visualSearchFailureMessage({
      code: 'VISUAL_SEARCH_NO_EMBEDDING',
      message: '视觉检索数据尚未就绪，请稍后再试',
    })
    expect(copy).not.toContain('没找到')
    expect(copy).toContain('准备中')
  })

  test('429 带剩余秒数：说清要等多久', () => {
    expect(
      visualSearchFailureMessage({
        code: 'VISUAL_SEARCH_RATE_LIMITED',
        message: '请求过于频繁',
        retryAfterSeconds: 45,
      }),
    ).toBe('识图请求太频繁，请 45 秒后再试')
  })

  test('未知契约错误码：透传后端 message，不吞成通用句', () => {
    expect(
      visualSearchFailureMessage({ code: 'VALIDATION_FAILED', message: '请求参数不合法' }),
    ).toBe('请求参数不合法')
  })

  test('本地失败（无错误码）：透传自己的文案', () => {
    expect(visualSearchFailureMessage({ code: '', message: '图片上传失败,请重试' })).toBe(
      '图片上传失败,请重试',
    )
  })

  test('抛出来的不是 Error：给中性提示', () => {
    expect(visualSearchFailureMessage(null)).toBe('识图失败，请稍后重试')
  })
})
