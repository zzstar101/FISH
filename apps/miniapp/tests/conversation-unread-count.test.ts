import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { NOTIFICATION_ROUTES } from '@fish/contracts/notifications/routes'
import { encodePublicId } from '@fish/shared/public-id'
import { API_BASE } from '@/lib/api-base'

/**
 * 会话未读总数的取数口径（#291）。
 *
 * 修复前 `fetchConversationUnreadCount()` 拉 `GET /conversations`（第一页，契约上限
 * 50 条）再把 `items` 的 `unreadCount` 求和：会话多于 50 且更早那批里还有未读时会
 * **漏计**。红点时代只影响「亮不亮」，改成精确数字后就是用户可见的错误。
 *
 * 现在走专用聚合端点 `GET /conversations/unread-count`。这里在**端点层**（真
 * `@/features/chat/api` + 真 `@/lib/request`，只顶替 `Taro.request`）锁三件事：
 *
 * 1. 冷启动只发一次 unread-count，**不发** `/conversations` 列表 —— 漏计的病根就是
 *    靠列表首页求和；
 * 2. 数字就是端点返回的那个值（>50 时不再等于首页求和）；
 * 3. 接口失败/未知时**没有 0**：`null` 是「不知道」的唯一表达，不拿 0 或 fixture 冒充。
 *
 * 为什么用 `mock.module` 顶替 Taro：`./api` 经 `@/lib/request` 必须 `import Taro`，
 * Bun 下加载真 Taro 会抛 `ENABLE_INNER_HTML is not defined`（手法同
 * `tests/visual-search-upload.test.ts`）。
 */

type RequestCall = {
  url: string
  method?: string
  header: Record<string, string>
  data?: unknown
}

type MockResponse = { statusCode: number; data: unknown; header: Record<string, string> }

/**
 * 会话列表第一页。**只有实现回退到「对列表求和」时才会被请求到**：给满一页（契约上限
 * 50 条）、每条 1 条未读，那样求和最多只能得到 50 —— 端点给的是 137。
 *
 * 刻意用真的 `ConversationDto` 形状（而不是随手一个 `{ items: [...] }`）：这样把实现改回
 * 旧写法时，这条用例是以 `50 ≠ 137` 失败，而不是以「首页形状不合法、读不到」失败。
 */
function firstPage(): { items: unknown[]; nextCursor: string } {
  const createdAt = '2026-09-14T00:00:00.000Z'
  const items = Array.from({ length: 50 }, (_, index) => ({
    id: encodePublicId('cnv', Bun.randomUUIDv7()),
    listingId: encodePublicId('lst', Bun.randomUUIDv7()),
    role: 'buyer',
    listing: {
      id: encodePublicId('lst', Bun.randomUUIDv7()),
      title: `闲置 ${index}`,
      priceCents: 1000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: {
      id: encodePublicId('usr', Bun.randomUUIDv7()),
      nickname: '对方',
      avatarUrl: null,
    },
    counterpartPresence: { online: false, lastActiveAt: null },
    unreadCount: 1,
    counterpartLastReadAt: null,
    lastMessage: {
      type: 'TEXT',
      content: '在吗',
      senderId: encodePublicId('usr', Bun.randomUUIDv7()),
      createdAt,
    },
    lastMessageAt: createdAt,
    createdAt,
  }))
  return { items, nextCursor: 'page-2' }
}

const calls: RequestCall[] = []
/** unread-count 端点的响应（用例里各自改；函数形态是为了能模拟网络异常） */
let unreadCountResponse: () => Promise<MockResponse> = () => Promise.resolve(ok({ unreadCount: 0 }))
let notificationCountResponse: MockResponse = ok({ unreadCount: 0 })
/** 会话列表第一页：旧实现（对首页求和）会拿到它，最多算出 50 */
const conversationListResponse: MockResponse = ok(firstPage())

const UNREAD_COUNT_URL = `${API_BASE}${CHAT_ROUTES.unreadCount}`
const NOTIFICATION_COUNT_URL = `${API_BASE}${NOTIFICATION_ROUTES.unreadCount}`
const CONVERSATION_LIST_PREFIX = `${API_BASE}${CHAT_ROUTES.base}`

function ok(data: unknown): MockResponse {
  return { statusCode: 200, data, header: {} }
}

function serverError(): MockResponse {
  return {
    statusCode: 500,
    data: { error: { code: 'INTERNAL_ERROR', message: '服务开小差了' } },
    header: {},
  }
}

/** 会话列表请求（旧实现的第一页求和走这条）：路径是 `/conversations` 或 `/conversations?…` */
function listCalls(): RequestCall[] {
  return calls.filter(
    (call) => call.url.startsWith(CONVERSATION_LIST_PREFIX) && call.url !== UNREAD_COUNT_URL,
  )
}

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: () => '',
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    request: (options: RequestCall): Promise<MockResponse> => {
      calls.push(options)
      if (options.url === UNREAD_COUNT_URL) return unreadCountResponse()
      if (options.url === NOTIFICATION_COUNT_URL) return Promise.resolve(notificationCountResponse)
      return Promise.resolve(conversationListResponse)
    },
  },
}))

const { fetchConversationUnreadCount } = await import('@/features/chat/api')
const { clearUnread, hydrateUnread, unreadBadgeText, unreadSnapshot } = await import(
  '@/features/chat/unread'
)

/** store 是模块级单例：每个用例前把内部快照清掉，避免互相污染 */
beforeEach(() => {
  clearUnread()
  calls.length = 0
  unreadCountResponse = () => Promise.resolve(ok({ unreadCount: 0 }))
  notificationCountResponse = ok({ unreadCount: 0 })
})

/** 等 hydrateUnread 的整条 promise 链跑完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('fetchConversationUnreadCount · 端点取值', () => {
  test('请求 `GET /conversations/unread-count`，返回端点的 unreadCount', async () => {
    unreadCountResponse = () => Promise.resolve(ok({ unreadCount: 137 }))

    expect(await fetchConversationUnreadCount()).toBe(137)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(UNREAD_COUNT_URL)
    // 病根：不再为了算一个总数去拉会话列表
    expect(listCalls()).toHaveLength(0)
  })

  test('端点失败就抛错，不把「读不到」当成 0', async () => {
    unreadCountResponse = () => Promise.resolve(serverError())

    await expect(fetchConversationUnreadCount()).rejects.toThrow()
    expect(listCalls()).toHaveLength(0)
  })
})

describe('未读快照 · 冷启动走专用端点', () => {
  test('冷启动只发一次 unread-count，且完全不发 `GET /conversations` 列表', async () => {
    unreadCountResponse = () => Promise.resolve(ok({ unreadCount: 137 }))
    notificationCountResponse = ok({ unreadCount: 2 })

    hydrateUnread('u-alan')
    // 底栏实例每个 Tab 页各一份，会并发触发：同账号只该发一次请求
    hydrateUnread('u-alan')
    await flush()

    expect(calls.filter((call) => call.url === UNREAD_COUNT_URL)).toHaveLength(1)
    expect(listCalls()).toHaveLength(0)
    // 冷启动这一轮总共只该打这两个端点
    expect(calls.map((call) => call.url).sort()).toEqual(
      [NOTIFICATION_COUNT_URL, UNREAD_COUNT_URL].sort(),
    )
  })

  test('>50 个会话、更早批次还有未读时，底栏数字等于端点返回值而不是首页求和', async () => {
    // 端点聚合全部会话给出 137；按第一页（50 条 × 1）求和只会得到 50
    unreadCountResponse = () => Promise.resolve(ok({ unreadCount: 137 }))
    notificationCountResponse = ok({ unreadCount: 0 })

    hydrateUnread('u-alan')
    await flush()

    const snapshot = unreadSnapshot()
    expect(snapshot?.conversations).toBe(137)
    expect(snapshot?.conversations).toBeGreaterThan(50)
    // 底栏徽标拿到的也是这个数（#433 起判定换成 `unreadBadgeText`）：137 已超两位 ⇒
    // 必为 `99+`；若退回首页求和（50）则只会显示 `50`，这条断言就会红。
    expect(
      unreadBadgeText({
        conversations: snapshot?.conversations ?? null,
        notifications: snapshot?.notifications ?? null,
        previous: null,
      }),
    ).toBe('99+')
    expect(listCalls()).toHaveLength(0)
  })

  test('unread-count 失败 → 会话分量记「不知道」（null），不拿 0 或 fixture 冒充', async () => {
    unreadCountResponse = () => Promise.resolve(serverError())
    notificationCountResponse = ok({ unreadCount: 2 })

    hydrateUnread('u-alan')
    await flush()

    // 不是 0（「确定没有未读」这个具体结论），也不是 fixture 的数字
    expect(unreadSnapshot()?.conversations).toBeNull()
    // 另一项拿到真值就照常用真值
    expect(unreadSnapshot()?.notifications).toBe(2)
  })

  test('unread-count 网络异常 → 同样是 null', async () => {
    unreadCountResponse = () => Promise.reject(new Error('network down'))

    hydrateUnread('u-alan')
    await flush()

    expect(unreadSnapshot()?.conversations).toBeNull()
  })
})
