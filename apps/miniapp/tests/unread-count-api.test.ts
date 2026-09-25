import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'

/**
 * `fetchConversationUnreadCount` 的请求构造与契约解析（#67 第三步）。
 *
 * 底栏那颗点的会话分量以前是把**第一页**会话（契约上限 50 条）的未读求和 ——
 * 会话超过一页时那个数字必然偏小，而它没有任何别的来源可以自查（用户看不出
 * 「12」其实是「我只加载了 50 个会话里的 12」）。改成服务端聚合后，这里锁两件事：
 *
 * 1. 真的打 `GET /conversations/unread-count`，而不是又去翻会话列表把分页口径
 *    偷偷带回来；
 * 2. 只认契约的 `{ unreadCount }` 信封 —— 少了这一层解析，调用方拿到的会是对象
 *    而不是数字，`conversations + notifications > 0` 会算成 `NaN`（红点静默失效）。
 *
 * 替换的是 `@/lib/request` 的 `apiRequest`（只此一处），**不**替换 `features/chat/api`：
 * 这样用例同时覆盖真实模块的请求构造与契约解析。手法与 `wishes-api.test.ts` 一致。
 */

type ApiCall = {
  path: string
  query?: Record<string, unknown>
  method?: string
  body?: unknown
}

const calls: ApiCall[] = []
/** 下一次 `apiRequest` 的返回值 / 抛错；`failure` 非空时优先抛 */
let response: unknown = { unreadCount: 0 }
let failure: unknown = null

mock.module('@/lib/request', () => ({
  apiRequest: async (path: string, options?: Omit<ApiCall, 'path'>) => {
    calls.push({ path, ...options })
    if (failure) throw failure
    return response
  },
}))

const { fetchConversationUnreadCount } = await import('../src/features/chat/api')

beforeEach(() => {
  calls.length = 0
  response = { unreadCount: 0 }
  failure = null
})

describe('fetchConversationUnreadCount', () => {
  test('走服务端聚合端点，且不传任何分页参数', async () => {
    response = { unreadCount: 7 }

    await expect(fetchConversationUnreadCount()).resolves.toBe(7)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(CHAT_ROUTES.unreadCount)
    // 聚合口径由服务端定：客户端传 limit / cursor 就等于又把分页带了回来
    expect(calls[0]?.query).toBeUndefined()
  })

  test('0 是「确定没有未读」，必须原样返回而不是被当成空值', async () => {
    response = { unreadCount: 0 }

    await expect(fetchConversationUnreadCount()).resolves.toBe(0)
  })

  test('响应不符合契约时解析失败，而不是把缺字段当成 0', async () => {
    // 例如后端改回了 `{ conversations: 3 }`：这时静默返回 undefined 会让底栏
    // 把 `undefined + 0 > 0` 算成 false —— 又变成「有未读却不见红点」
    response = { conversations: 3 }

    await expect(fetchConversationUnreadCount()).rejects.toThrow()
  })

  test('请求失败照常抛出，由上层记「不知道」（不能吞成 0）', async () => {
    failure = new Error('network down')

    await expect(fetchConversationUnreadCount()).rejects.toThrow('network down')
  })
})
