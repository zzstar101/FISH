import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import {
  badgeText,
  chatListState,
  conversationTimeLabel,
  conversationUnreadForBadge,
  EMPTY_PREVIEW,
  isLatestUnreadFetch,
  markAllReadOutcome,
  previewOf,
  refreshConversationWindow,
} from '../src/pages/chat/list-view'

/**
 * 会话列表（#89：Chat 页从 fixture 改为真实 `GET /conversations`）。
 *
 * 这里锁的是「屏幕上显示的东西与事实不符」那一类缺陷：把「没读到」显示成
 * 「你没有会话」、把契约 JSON 原文当消息显示、把时间算成负数天。
 * 组件接线（页面是否调用这些函数、传什么参数）本仓没有组件渲染基建，靠 code review。
 */

function dto(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'c-1',
    listingId: 'l-1',
    role: 'buyer',
    listing: {
      id: 'l-1',
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'u-2', nickname: '卖家', avatarUrl: null },
    unreadCount: 0,
    counterpartLastReadAt: null,
    lastMessage: null,
    lastMessageAt: '2026-09-21T04:00:00.000Z',
    createdAt: '2026-09-21T03:00:00.000Z',
    ...overrides,
  }
}

describe('badgeText —— 角标数字上限', () => {
  test('99 及以下原样显示，超过显示 99+', () => {
    expect(badgeText(0)).toBe('0')
    expect(badgeText(1)).toBe('1')
    expect(badgeText(99)).toBe('99')
    // 1版稿的窄角标装不下三位以上数字
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(1234)).toBe('99+')
  })
})

describe('chatListState —— 列表形态判定', () => {
  test('失败 → 错误态，且优先于加载态与空态', () => {
    // 「加载不出来」不是「恰好没有会话」：即使还没 ready、条数为 0，也必须报错
    expect(chatListState({ ready: false, failed: true, itemCount: 0 })).toBe('error')
    expect(chatListState({ ready: true, failed: true, itemCount: 0 })).toBe('error')
    expect(chatListState({ ready: true, failed: true, itemCount: 5 })).toBe('error')
  })

  test('还没拿到结果 → 加载态，不能先显示空态', () => {
    // 首次进页 / 失败后重试在途：items 还是空数组，此时显示空态等于在说「你没有会话」
    expect(chatListState({ ready: false, failed: false, itemCount: 0 })).toBe('loading')
  })

  test('成功且为空 → 空态；成功且有数据 → 列表', () => {
    expect(chatListState({ ready: true, failed: false, itemCount: 0 })).toBe('empty')
    expect(chatListState({ ready: true, failed: false, itemCount: 1 })).toBe('list')
  })
})

describe('previewOf —— 列表行预览文案', () => {
  test('TEXT 直接显示原文', () => {
    const item = dto({
      lastMessage: {
        type: 'TEXT',
        content: '还在吗',
        senderId: 'u-2',
        createdAt: '2026-09-21T04:00:00.000Z',
      },
    })
    expect(previewOf(item)).toBe('还在吗')
  })

  test('还没有任何消息（lastMessage 为 null）→ 占位文案', () => {
    expect(previewOf(dto())).toBe(EMPTY_PREVIEW)
  })

  test('交易 SYSTEM 事件翻成中文，不把契约 JSON 漏到界面上', () => {
    const sys = (content: string) =>
      dto({
        lastMessage: {
          type: 'SYSTEM',
          content,
          senderId: null,
          createdAt: '2026-09-21T04:00:00.000Z',
        },
      })
    expect(previewOf(sys(JSON.stringify({ type: 'tx.proposal', amountCents: 15000 })))).toBe(
      '买家发起交易确认 · ¥150，待确认',
    )
    // 没有金额字段时不能显示 "¥undefined"
    expect(previewOf(sys(JSON.stringify({ type: 'tx.proposal' })))).toBe('买家发起交易确认，待确认')
    expect(previewOf(sys(JSON.stringify({ type: 'tx.accepted' })))).toBe('交易已确认 · 约定面交中')
    expect(previewOf(sys(JSON.stringify({ type: 'tx.rejected' })))).toBe('卖家已拒绝本次议价')
  })

  test('认不出的 SYSTEM 内容按原文降级（JSON 与普通文本都不吞）', () => {
    const sys = (content: string) =>
      dto({
        lastMessage: {
          type: 'SYSTEM',
          content,
          senderId: null,
          createdAt: '2026-09-21T04:00:00.000Z',
        },
      })
    expect(previewOf(sys(JSON.stringify({ type: 'tx.unknown' })))).toBe('{"type":"tx.unknown"}')
    expect(previewOf(sys('你的学号认证已通过'))).toBe('你的学号认证已通过')
  })
})

describe('conversationTimeLabel —— 会话行时间文案', () => {
  // 固定「现在」为本地 2026-09-21 12:00（周一），避免用例随时钟漂移
  const NOW = new Date(2026, 8, 21, 12, 0, 0).getTime()
  const at = (...args: [number, number, number, number?, number?]) =>
    new Date(...args).toISOString()

  test('一分钟内 → 刚刚；一小时内 → N 分钟前', () => {
    expect(conversationTimeLabel(new Date(NOW - 30_000).toISOString(), NOW)).toBe('刚刚')
    expect(conversationTimeLabel(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12 分钟前')
  })

  test('同一天但超过一小时 → 今天（不是「N 小时前」）', () => {
    expect(conversationTimeLabel(at(2026, 8, 21, 9, 0), NOW)).toBe('今天')
  })

  test('昨天按本地日历日判定，不按「距今 24 小时」', () => {
    // 距今仅 16 小时，但日历上已经是昨天
    expect(conversationTimeLabel(at(2026, 8, 20, 20, 0), NOW)).toBe('昨天')
  })

  test('一周内 → 周X；超过一周 → M 月 D 日', () => {
    expect(conversationTimeLabel(at(2026, 8, 18, 10, 0), NOW)).toBe('周五')
    expect(conversationTimeLabel(at(2026, 8, 15, 10, 0), NOW)).toBe('周二')
    expect(conversationTimeLabel(at(2026, 8, 14, 10, 0), NOW)).toBe('9 月 14 日')
    expect(conversationTimeLabel(at(2026, 8, 1, 10, 0), NOW)).toBe('9 月 1 日')
  })

  test('未来时间戳（时钟偏差）夹到「刚刚」，不出负数', () => {
    expect(conversationTimeLabel(new Date(NOW + 60 * 60_000).toISOString(), NOW)).toBe('刚刚')
  })

  test('解析不了的 ISO → 空串（不显示 NaN）', () => {
    expect(conversationTimeLabel('not-a-date', NOW)).toBe('')
  })
})

/**
 * 从会话页返回时的刷新窗口（#67 第三步）。
 *
 * 锁的是「刷新把用户翻到的位置弄丢」这一类缺陷：只重取第一页（窗口缩水）、
 * 已到底还继续空转、第一页失败与后续页失败被当成同一回事。
 */
describe('refreshConversationWindow', () => {
  /** 造一页 50 条（真实分页大小）；游标就是页码，便于断言请求序列 */
  function page(n: number, nextCursor: string | null) {
    return {
      items: Array.from({ length: 50 }, (_, i) => dto({ id: `p${n}-${i}` })),
      nextCursor,
      failed: false,
    }
  }

  test('只加载了第一页：只重取第一页，不多发请求', async () => {
    const asked: (string | undefined)[] = []
    const result = await refreshConversationWindow(async (cursor) => {
      asked.push(cursor)
      return page(1, 'c1')
    }, 50)
    expect(asked).toEqual([undefined])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(50)
    expect(result.nextCursor).toBe('c1')
  })

  test('翻到第 3 页（120 条）：重取 3 页，窗口不缩水，游标接着第 3 页', async () => {
    const asked: (string | undefined)[] = []
    const result = await refreshConversationWindow(async (cursor) => {
      asked.push(cursor)
      if (!cursor) return page(1, 'c1')
      if (cursor === 'c1') return page(2, 'c2')
      return page(3, 'c3')
    }, 120)
    expect(asked).toEqual([undefined, 'c1', 'c2'])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(150)
    expect(result.items[0]?.id).toBe('p1-0')
    expect(result.items[149]?.id).toBe('p3-49')
    expect(result.nextCursor).toBe('c3')
  })

  test('刚好一页多一点（51 条）也要取第二页，否则返回时少一条', async () => {
    const asked: (string | undefined)[] = []
    await refreshConversationWindow(async (cursor) => {
      asked.push(cursor)
      return cursor ? page(2, 'c2') : page(1, 'c1')
    }, 51)
    expect(asked).toEqual([undefined, 'c1'])
  })

  test('空列表（0 条）仍要拿到最新的第一页', async () => {
    const asked: (string | undefined)[] = []
    const result = await refreshConversationWindow(async (cursor) => {
      asked.push(cursor)
      return page(1, 'c1')
    }, 0)
    expect(asked).toEqual([undefined])
    expect(result.kind).toBe('ok')
  })

  test('服务端已经到底：取完就停，不空转', async () => {
    const asked: (string | undefined)[] = []
    const result = await refreshConversationWindow(async (cursor) => {
      asked.push(cursor)
      return page(1, null)
    }, 500)
    expect(asked).toEqual([undefined])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.nextCursor).toBeNull()
  })

  test('第一页失败 → first-page-failed（调用方清屏进错误态）', async () => {
    const result = await refreshConversationWindow(
      async () => ({ items: [], nextCursor: null, failed: true }),
      50,
    )
    expect(result).toEqual({ kind: 'first-page-failed' })
  })

  test('第二页失败 → tail-failed：保留已刷新的第一页，游标停在失败那一页', async () => {
    const result = await refreshConversationWindow(async (cursor) => {
      if (!cursor) return page(1, 'c1')
      return { items: [], nextCursor: null, failed: true }
    }, 120)
    expect(result.kind).toBe('tail-failed')
    if (result.kind !== 'tail-failed') return
    expect(result.items).toHaveLength(50)
    expect(result.items[0]?.id).toBe('p1-0')
    expect(result.nextCursor).toBe('c1')
  })
})

/**
 * 底栏「会话未读」分量的口径（#67 R5）。
 *
 * 修复前是 `unreadTotal ?? conversationUnread`：聚合请求一失败就退回本页求和，而本页
 * 只加载了第一页 —— 求和恰好是 0 时就会发布 `conversations: 0`，把上一份正确的正数
 * 覆盖掉、熄灭底栏红点。这里锁的就是「未知不等于恰好没有」。
 */
describe('conversationUnreadForBadge', () => {
  test('聚合有值：直接用聚合（它覆盖全部会话，不受本页分页影响）', () => {
    expect(conversationUnreadForBadge({ aggregate: 7, windowSum: 0, windowComplete: true })).toBe(7)
  })

  test('聚合拿不到但本页求和 > 0：下界也足以点亮，照发', () => {
    expect(
      conversationUnreadForBadge({ aggregate: null, windowSum: 2, windowComplete: false }),
    ).toBe(2)
  })

  test('聚合拿不到、窗口已覆盖到服务端末尾、求和 0：0 是确定结论', () => {
    expect(
      conversationUnreadForBadge({ aggregate: null, windowSum: 0, windowComplete: true }),
    ).toBe(0)
  })

  test('聚合拿不到、窗口不完整、求和 0：不得发布确定零（修复前这里发的是 0）', () => {
    expect(
      conversationUnreadForBadge({ aggregate: null, windowSum: 0, windowComplete: false }),
    ).toBeNull()
  })

  test('聚合是 0（服务端确认没有未读）时压过本页求和', () => {
    expect(conversationUnreadForBadge({ aggregate: 0, windowSum: 0, windowComplete: false })).toBe(
      0,
    )
  })
})

/**
 * 「全部已读」的结果归并（#67 R4）。
 *
 * `POST /conversations/:id/read` 是逐条的，部分失败时把整批都清零就是谎报已读。
 */
describe('markAllReadOutcome', () => {
  const ok = { status: 'fulfilled', value: undefined } as PromiseSettledResult<void>
  const bad = {
    status: 'rejected',
    reason: new Error('HTTP 500'),
  } as PromiseSettledResult<void>

  test('全部成功：所有 id 都算已读，missed = 0', () => {
    const { readIds, missed } = markAllReadOutcome({
      unreadIds: ['c-1', 'c-2'],
      results: [ok, ok],
    })
    expect([...readIds]).toEqual(['c-1', 'c-2'])
    expect(missed).toBe(0)
  })

  test('部分成功：只把成功的算已读，失败的如实计入 missed', () => {
    const { readIds, missed } = markAllReadOutcome({
      unreadIds: ['c-1', 'c-2', 'c-3'],
      results: [ok, bad, ok],
    })
    expect([...readIds]).toEqual(['c-1', 'c-3'])
    expect(missed).toBe(1)
  })

  test('全部失败：一个都不清零，missed = 全部', () => {
    const { readIds, missed } = markAllReadOutcome({
      unreadIds: ['c-1', 'c-2'],
      results: [bad, bad],
    })
    expect(readIds.size).toBe(0)
    expect(missed).toBe(2)
  })

  test('响应条数少于请求条数（缺失的按失败计）', () => {
    const { readIds, missed } = markAllReadOutcome({
      unreadIds: ['c-1', 'c-2'],
      results: [ok],
    })
    expect([...readIds]).toEqual(['c-1'])
    expect(missed).toBe(1)
  })
})

/**
 * 聚合取数的代次守卫（#67 R4）。
 *
 * 「已读落定后重取」与「一份标记已读之前发出的旧响应迟到」是同一个场景的两面：
 * 没有代次守卫，旧响应会把刚拿到的 0 盖回旧的正数，底栏红点明明该熄却又亮起来。
 */
describe('isLatestUnreadFetch', () => {
  test('代次相同才允许落地', () => {
    expect(isLatestUnreadFetch(3, 3)).toBe(true)
  })

  test('旧响应（代次落后）一律丢弃', () => {
    expect(isLatestUnreadFetch(3, 4)).toBe(false)
    expect(isLatestUnreadFetch(0, 1)).toBe(false)
  })
})
