import { describe, expect, mock, test } from 'bun:test'

/**
 * 建会话失败文案的契约对齐（#470 第三轮）。
 *
 * `POST /conversations` 只要求商品**存在**：
 * - 契约明示「对任意已存在的商品都可建会话（不限制 ACTIVE）：商品 OFFLINE/SOLD 后买卖双方
 *   仍可能需要沟通」（`packages/contracts/src/chat/routes.ts:12-15`）；
 * - 服务端也只按 id 查行，无状态过滤（`apps/api/src/modules/conversations/store.ts:233-236` 的
 *   `SELECT id, seller_id FROM listings WHERE id = $1`），商品删除是物理删除
 *   （`apps/api/src/modules/messages/service.ts:197` 注释）。
 *
 * 所以 404 `LISTING_NOT_FOUND` 的真实原因是「不存在 / 已删除」；把「已下架」写进文案，等于把
 * 服务端明确允许的动作说成失败原因（PC 站同名函数仍是旧措辞，属写作用域外的报告项）。
 *
 * 手法与 `tests/chat-media-api.test.ts` / `tests/watchers-api.test.ts` 一致：先替换平台依赖
 * （`apps/miniapp/src/lib/request.ts` 顶层值导入 Taro），再动态导入被测模块。
 */
mock.module('@tarojs/taro', () => ({ default: {} }))

const { describeCreateConversationFailure } = await import('@/features/chat/api')

/** 形状兜底的 ApiError 桩（`isApiError` 认 name + code + status，见 `apps/miniapp/src/lib/request.ts:65-75`） */
function apiError(code: string, status = 404): unknown {
  return { name: 'ApiError', code, status }
}

describe('describeCreateConversationFailure —— 404 只说不存在，不说已下架（#470）', () => {
  test('LISTING_NOT_FOUND 说「不存在或已删除」', () => {
    expect(describeCreateConversationFailure(apiError('LISTING_NOT_FOUND'))).toBe(
      '商品不存在或已删除',
    )
  })

  test('文案不含「下架」「已售」：契约不限制 ACTIVE，二者不是建会话的失败原因', () => {
    const copy = describeCreateConversationFailure(apiError('LISTING_NOT_FOUND'))
    expect(copy, '下架商品也能建会话，不能当成失败原因').not.toContain('下架')
    expect(copy, '已售商品也能建会话，不能当成失败原因').not.toContain('已售')
  })

  test('其余失败（网络错误 / 未识别错误码）仍是通用文案', () => {
    expect(describeCreateConversationFailure(apiError('INTERNAL', 500))).toBe(
      '发起会话失败，请重试',
    )
    expect(describeCreateConversationFailure(new Error('boom'))).toBe('发起会话失败，请重试')
  })
})
