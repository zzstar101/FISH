import { describe, expect, test } from 'bun:test'
import type { ConversationDto, MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import { clockTime, dayLabelOf } from '../src/lib/time'
import {
  applyPresenceEvent,
  applyPresencePoll,
  applyReadEvent,
  applyRecalled,
  beginSend,
  canRecallMessage,
  canRetry,
  canRetryMedia,
  clearDeferredReload,
  deferReload,
  hasEarlierPage,
  initialDeferredReload,
  isCurrentPlayRequest,
  isFlushDue,
  isLatestPresencePoll,
  isStaleMediaIdentity,
  isStaleMediaTask,
  keepRecalledTombstones,
  listingStatusText,
  localReplyExcerpt,
  MESSAGE_ACTION_LABEL,
  mergePushedMedia,
  mergePushedMessage,
  mergeRefreshedMedia,
  mergeTimeline,
  messageActions,
  messageReadLabel,
  type PendingMedia,
  type PendingMessage,
  parseTxEvent,
  planMediaLoad,
  REPLY_DROPPED_TIP,
  recallFailureText,
  resetDeferredReload,
  settleSend,
  shouldDropReplyOnSendFailure,
  shouldFlushDeferredReload,
  shouldReloadOnShow,
  sortMessages,
  startMediaRetry,
  systemPillText,
} from '../src/pkg-social/pages/conversation/view'

/**
 * 会话页（#89：历史 / 发送 / 已读接真实接口）的展示逻辑。
 *
 * 这里锁的是三类「界面上写什么」的判定：交易 SYSTEM 事件的中文化、时间文案、
 * 发送失败态能否重试。组件接线（页面是否调用、传什么参数）靠 code review。
 */

describe('parseTxEvent —— 交易 SYSTEM 事件解析', () => {
  test('认得出契约里的 tx.* JSON', () => {
    expect(parseTxEvent(JSON.stringify({ type: 'tx.proposal', amountCents: 15000 }))).toEqual({
      type: 'tx.proposal',
    })
  })

  test('普通文本系统消息、缺 type、type 非字符串都返回 null（按原文渲染）', () => {
    expect(parseTxEvent('你的学号认证已通过')).toBeNull()
    expect(parseTxEvent(JSON.stringify({ amountCents: 1 }))).toBeNull()
    expect(parseTxEvent(JSON.stringify({ type: 42 }))).toBeNull()
    expect(parseTxEvent('{"type":')).toBeNull()
  })
})

describe('systemPillText —— 灰胶囊文案', () => {
  test('proposal / rejected 翻成中文', () => {
    expect(systemPillText(JSON.stringify({ type: 'tx.proposal' }))).toBe('待对方同意')
    expect(systemPillText(JSON.stringify({ type: 'tx.rejected' }))).toBe('卖家已拒绝这次交易')
  })

  test('认不出的内容按原文降级，不吞消息', () => {
    expect(systemPillText(JSON.stringify({ type: 'tx.unknown' }))).toBe('{"type":"tx.unknown"}')
    expect(systemPillText('买家发起了交易确认。')).toBe('买家发起了交易确认。')
  })
})

describe('listingStatusText —— 商品摘要条状态', () => {
  test('契约的四种状态各有中文；缺字段说明商品已下架', () => {
    expect(listingStatusText('ACTIVE')).toBe('在售')
    expect(listingStatusText('RESERVED')).toBe('已预订')
    expect(listingStatusText('SOLD')).toBe('已售出')
    expect(listingStatusText('OFFLINE')).toBe('已下架')
    expect(listingStatusText(undefined)).toBe('商品已下架')
  })

  test('未来新增的状态原样透出，不假装成「在售」', () => {
    expect(listingStatusText('ARCHIVED')).toBe('ARCHIVED')
  })
})

describe('canRetry —— 发送失败才可重试', () => {
  test('failed 可以重试，sending 不能（避免重复投递）', () => {
    const failed: PendingMessage = { id: 'local-1', content: 'hi', status: 'failed' }
    const sending: PendingMessage = { id: 'local-2', content: 'hi', status: 'sending' }
    expect(canRetry(failed)).toBe(true)
    expect(canRetry(sending)).toBe(false)
  })
})

describe('sortMessages —— 回到契约的 (createdAt, id) 升序', () => {
  const msg = (id: string, createdAt: string): MessageDto => ({
    id,
    conversationId: 'c-1',
    senderId: 'u-1',
    sender: { id: 'u-1', nickname: '我', avatarUrl: null },
    type: 'TEXT',
    content: id,
    createdAt,
  })

  test('响应乱序到达时按时间重排（服务端的顺序才是事实）', () => {
    // 连发两条：B 的响应先回来、A 的后回来 —— 追加顺序是 B, A
    const sorted = sortMessages([
      msg('b', '2026-09-21T10:00:01.000Z'),
      msg('a', '2026-09-21T10:00:00.000Z'),
    ])
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b'])
  })

  test('同一毫秒用 id 决出稳定顺序，且不改动入参数组', () => {
    const input = [msg('b', '2026-09-21T10:00:00.000Z'), msg('a', '2026-09-21T10:00:00.000Z')]
    expect(sortMessages(input).map((item) => item.id)).toEqual(['a', 'b'])
    expect(input.map((item) => item.id)).toEqual(['b', 'a'])
  })
})

describe('applyPresencePoll —— 在线态轮询只写在线态（#359 第五点）', () => {
  const dto = (overrides: Partial<ConversationDto> = {}): ConversationDto => ({
    id: 'cnv_01jc000000e00800000000001a',
    listingId: 'lst_01jc000000e00800000000000t',
    role: 'buyer',
    listing: {
      id: 'lst_01jc000000e00800000000000t',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    counterpartPresence: { online: false, lastActiveAt: '2026-09-30T11:00:00.000Z' },
    unreadCount: 1,
    counterpartLastReadAt: null,
    lastMessage: {
      type: 'TEXT',
      content: '在吗',
      senderId: 'usr_01jc000000e00800000000000b',
      createdAt: '2026-09-30T10:59:00.000Z',
    },
    lastMessageAt: '2026-09-30T10:59:00.000Z',
    createdAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  })

  test('把新拿到的在线态写回', () => {
    const merged = applyPresencePoll(
      dto(),
      dto({ counterpartPresence: { online: true, lastActiveAt: '2026-09-30T12:00:00.000Z' } }),
    )
    expect(merged.counterpartPresence).toEqual({
      online: true,
      lastActiveAt: '2026-09-30T12:00:00.000Z',
    })
  })

  test('轮询响应即使更旧，也不回退消息 / 未读 / 商品等字段', () => {
    const current = dto({
      unreadCount: 3,
      lastMessage: {
        type: 'TEXT',
        content: '我刚发出去的',
        senderId: 'usr_01jc000000e00800000000000a',
        createdAt: '2026-09-30T12:00:00.000Z',
      },
      lastMessageAt: '2026-09-30T12:00:00.000Z',
      listing: {
        id: 'lst_01jc000000e00800000000000t',
        title: '九成新自行车',
        priceCents: 12000,
        status: 'RESERVED',
        coverUrl: null,
      },
    })
    // 这次轮询的响应是「刚发出消息之前」的快照
    const stale = dto()

    const merged = applyPresencePoll(current, stale)
    expect(merged.unreadCount).toBe(3)
    expect(merged.lastMessage?.content).toBe('我刚发出去的')
    expect(merged.lastMessageAt).toBe('2026-09-30T12:00:00.000Z')
    expect(merged.listing.status).toBe('RESERVED')
    // 只有在线态取新值（这里恰好是同一份，重点是其余字段一个都没动）
    expect(merged.counterpartPresence).toEqual(stale.counterpartPresence)
  })
})

describe('applyReadEvent —— 实时推送的 conversation.read 落地', () => {
  const dto = (counterpartLastReadAt: string | null): ConversationDto => ({
    id: 'cnv_01jc000000e00800000000001a',
    listingId: 'lst_01jc000000e00800000000000t',
    role: 'buyer',
    listing: {
      id: 'lst_01jc000000e00800000000000t',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    counterpartPresence: { online: false, lastActiveAt: null },
    unreadCount: 0,
    counterpartLastReadAt,
    lastMessage: null,
    lastMessageAt: '2026-09-30T10:59:00.000Z',
    createdAt: '2026-09-30T10:00:00.000Z',
  })

  test('推送推进对方的读位（「已读」标签翻绿）', () => {
    const merged = applyReadEvent(dto(null), '2026-09-30T11:00:00.000Z')
    expect(merged.counterpartLastReadAt).toBe('2026-09-30T11:00:00.000Z')
  })

  test('乱序的旧推送不把读位打回去（读位单调只前进）', () => {
    const previous = dto('2026-09-30T12:00:00.000Z')
    expect(applyReadEvent(previous, '2026-09-30T11:00:00.000Z')).toBe(previous)
  })
})

describe('applyPresenceEvent —— 实时推送的 presence.changed 落地', () => {
  const dto = (overrides: Partial<ConversationDto> = {}): ConversationDto => ({
    id: 'cnv_01jc000000e00800000000001a',
    listingId: 'lst_01jc000000e00800000000000t',
    role: 'buyer',
    listing: {
      id: 'lst_01jc000000e00800000000000t',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    counterpartPresence: { online: false, lastActiveAt: '2026-09-30T11:00:00.000Z' },
    unreadCount: 0,
    counterpartLastReadAt: null,
    lastMessage: null,
    lastMessageAt: '2026-09-30T10:59:00.000Z',
    createdAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  })

  test('对方上线：只写 counterpartPresence，其余字段不动', () => {
    const presence = { online: true, lastActiveAt: '2026-09-30T12:00:00.000Z' }
    const merged = applyPresenceEvent(dto(), 'usr_01jc000000e00800000000000b', presence)
    expect(merged.counterpartPresence).toEqual(presence)
    expect(merged.unreadCount).toBe(0)
    expect(merged.listing.status).toBe('ACTIVE')
  })

  test('别的用户上线（不是本会话对方）：原样返回，不白重渲染', () => {
    const previous = dto()
    expect(
      applyPresenceEvent(previous, 'usr_01jc000000e00800000000009z', {
        online: true,
        lastActiveAt: '2026-09-30T12:00:00.000Z',
      }),
    ).toBe(previous)
  })
})

/**
 * #376 审查回合：同一代次内两跳轮询的响应可能乱序回来，而 `applyPresencePoll` 是
 * last-write-wins —— 守卫必须只让**最新一次发起**的那跳落地，否则刚点亮的绿点会被
 * 先发后至的旧快照灭回去。
 */
describe('isLatestPresencePoll —— 在线态轮询乱序落地守卫（#359 第五点）', () => {
  test('同一代次：只有序号最新的一跳落地（先发后至的旧快照被丢掉）', () => {
    // 第 1 跳在第 2 跳之后才 resolve
    expect(isLatestPresencePoll({ seq: 1, epoch: 7, latestSeq: 2, latestEpoch: 7 })).toBe(false)
    expect(isLatestPresencePoll({ seq: 2, epoch: 7, latestSeq: 2, latestEpoch: 7 })).toBe(true)
  })

  test('代次变了（换账号 / 换会话 / 整页重拉）→ 一律不落地，即使序号恰好最新', () => {
    expect(isLatestPresencePoll({ seq: 2, epoch: 6, latestSeq: 2, latestEpoch: 7 })).toBe(false)
  })

  test('序号与代次同时过期 → 不落地', () => {
    expect(isLatestPresencePoll({ seq: 1, epoch: 6, latestSeq: 2, latestEpoch: 7 })).toBe(false)
  })
})

describe('clockTime —— 气泡时间戳', () => {
  test('本地时间 HH:mm，补零', () => {
    expect(clockTime(new Date(2026, 8, 21, 9, 5).toISOString())).toBe('09:05')
    expect(clockTime(new Date(2026, 8, 21, 23, 59).toISOString())).toBe('23:59')
  })

  test('解析不了 → 空串，不显示 NaN', () => {
    expect(clockTime('not-a-date')).toBe('')
  })
})

describe('dayLabelOf —— 日期分隔条', () => {
  // 固定「现在」为本地 2026-09-21 12:00（周一）
  const NOW = new Date(2026, 8, 21, 12, 0, 0).getTime()

  test('今天 / 昨天按本地日历日判定', () => {
    expect(dayLabelOf(new Date(2026, 8, 21, 9, 0).toISOString(), NOW)).toBe('今天 09:00')
    // 距今仅 16 小时，但日历上已经是昨天
    expect(dayLabelOf(new Date(2026, 8, 20, 20, 0).toISOString(), NOW)).toBe('昨天 20:00')
  })

  test('更早显示月日', () => {
    expect(dayLabelOf(new Date(2026, 8, 14, 10, 30).toISOString(), NOW)).toBe('9 月 14 日 10:30')
  })

  test('解析不了 → 空串', () => {
    expect(dayLabelOf('not-a-date', NOW)).toBe('')
  })
})

describe('messageReadLabel —— 我发出的消息按对方读位标已读 / 未读（#359 四）', () => {
  const SENT = '2026-09-21T10:00:00.000Z'
  const mine = (createdAt: string, counterpartLastReadAt: string | null) =>
    messageReadLabel({ mine: true, createdAt, counterpartLastReadAt })

  test('对方读位 >= 这条的发出时刻 → 已读（含恰好相等）', () => {
    expect(mine(SENT, SENT)).toBe('已读')
    expect(mine(SENT, '2026-09-21T10:00:01.000Z')).toBe('已读')
  })

  test('对方读位停在这条之前 → 未读', () => {
    expect(mine(SENT, '2026-09-21T09:59:59.000Z')).toBe('未读')
  })

  test('对方从未读过（null）→ 未读', () => {
    expect(mine(SENT, null)).toBe('未读')
  })

  test('对方发来的消息不标（我自己的读位不在契约里，Owner 拍板只标我发出的）', () => {
    expect(
      messageReadLabel({ mine: false, createdAt: SENT, counterpartLastReadAt: SENT }),
    ).toBeNull()
    expect(
      messageReadLabel({ mine: false, createdAt: SENT, counterpartLastReadAt: null }),
    ).toBeNull()
  })

  test('时间戳解析不了 → 未读：不把没把握的读回执说成已读', () => {
    expect(mine('not-a-date', SENT)).toBe('未读')
    expect(mine(SENT, 'not-a-date')).toBe('未读')
  })
})

/**
 * #170 D（返回同步）的接线判据。
 *
 * 这些是「组件接线」里唯一能脱离渲染单独锁住的部分 —— 页面组件本身没有渲染
 * 测试基建（见文件头），所以把「什么时候重拉 / 什么时候补刷新」抽成纯函数与
 * 状态机锁在这里；至于页面是否真的在 didShow 里调用、ref 是否真的同步，
 * 仍靠 code review + 端上验收。
 */
describe('shouldReloadOnShow —— 返回本页时是否立刻重拉（#170 D）', () => {
  const base = { loadedOnce: true, authed: true, hasUserId: true, sending: false }

  test('登录态就绪、已加载过、无在途发送 → 重拉', () => {
    expect(shouldReloadOnShow(base)).toBe(true)
  })

  test('首次显示（还没加载过）→ 不重拉：让渡给登录态 effect，冷启动不双发', () => {
    expect(shouldReloadOnShow({ ...base, loadedOnce: false })).toBe(false)
  })

  test('未登录 / 登录态未就绪 → 不发受限请求', () => {
    expect(shouldReloadOnShow({ ...base, authed: false })).toBe(false)
    expect(shouldReloadOnShow({ ...base, hasUserId: false })).toBe(false)
  })

  test('有在途发送 → 不立刻重拉（否则 epoch+1 把乐观气泡卡在「发送中」）', () => {
    expect(shouldReloadOnShow({ ...base, sending: true })).toBe(false)
  })
})

describe('DeferredReload 状态机 —— 「发送中返回」延后到发送落定再补刷新（#170 D）', () => {
  /**
   * 走一遍完整回路：发起 n 次发送、再落定 m 次（同一 epoch）。
   *
   * 落定时模拟组件的做法：**到点就先 `clearDeferredReload` 再补刷新**
   * （`index.tsx` 的 finally）。带上这一步，`flushes` 才等于「真的补了几次」，
   * 而不是「有几次满足到点条件」—— 「多个并发只补一次」靠的是这两半合起来。
   */
  const run = (epoch: number, sends: number, settles: number) => {
    let state = deferReload(initialDeferredReload(epoch))
    const flushes: boolean[] = []
    for (let i = 0; i < sends; i += 1) state = beginSend(state, epoch)
    for (let i = 0; i < settles; i += 1) {
      state = settleSend(state, epoch)
      if (isFlushDue(state)) {
        flushes.push(true)
        state = clearDeferredReload(state)
      } else {
        flushes.push(false)
      }
    }
    return { state, flushes }
  }

  test('单个发送落定后 → 到点补刷新', () => {
    const { state, flushes } = run(1, 1, 1)
    expect(flushes).toEqual([true])
    expect(state).toEqual({ deferred: false, inflight: 0, epoch: 1 })
  })

  test('多个并发发送：只有最后一次落定才补，且只补一次', () => {
    const { state, flushes } = run(1, 2, 2)
    expect(flushes).toEqual([false, true])
    expect(state.inflight).toBe(0)
  })

  test('补过一次之后，同一轮再落定不再补（「只补一次」的另一半）', () => {
    let state = deferReload(initialDeferredReload(1))
    state = beginSend(state, 1)
    state = beginSend(state, 1)
    state = settleSend(state, 1)
    expect(isFlushDue(state)).toBe(false)
    state = settleSend(state, 1)
    expect(isFlushDue(state)).toBe(true)
    state = clearDeferredReload(state)
    // 补刷新之后又发了一条并落定：没有新的「欠刷新」，不该再补
    state = beginSend(state, 1)
    state = settleSend(state, 1)
    expect(isFlushDue(state)).toBe(false)
  })

  test('没被延后（正常 didShow 已重拉）→ 落定后不到点，避免多打一次', () => {
    let state = initialDeferredReload(1)
    state = beginSend(state, 1)
    state = settleSend(state, 1)
    expect(isFlushDue(state)).toBe(false)
  })

  test('陈旧 epoch 的落定原样返回：不污染当前 epoch 的计数、也不触发刷新', () => {
    // A(epoch 1) 的发送在飞 → 换账号到 epoch 2
    let state = beginSend(initialDeferredReload(1), 1)
    // B 发起发送并延后刷新
    state = beginSend(state, 2)
    state = deferReload(state)
    expect(state).toEqual({ deferred: true, inflight: 1, epoch: 2 })

    // A 的迟到落定：完全无副作用
    const afterStale = settleSend(state, 1)
    expect(afterStale).toEqual(state)
    expect(isFlushDue(afterStale)).toBe(false)

    // B 的落定才归零并到点 —— 这是「A 的 finally 不能压制 / 触发 B 的刷新」的回归点
    const afterB = settleSend(afterStale, 2)
    expect(afterB.inflight).toBe(0)
    expect(isFlushDue(afterB)).toBe(true)
  })

  test('陈旧落定不得把计数减成负数（换账号后计数被 beginSend 重置）', () => {
    let state = beginSend(initialDeferredReload(1), 1)
    state = beginSend(state, 1)
    // 换账号：组件在渲染期 reset，再发起 B 的第一次发送
    state = resetDeferredReload(2)
    state = beginSend(state, 2)
    expect(state.inflight).toBe(1)
    // 两条陈旧落定 + 一条当前落定
    state = settleSend(state, 1)
    state = settleSend(state, 1)
    expect(state.inflight).toBe(1)
    state = settleSend(state, 2)
    expect(state.inflight).toBe(0)
  })

  test('同一 epoch 多减一次也不下溢（0 → 0）', () => {
    const state = settleSend(initialDeferredReload(1), 1)
    expect(state.inflight).toBe(0)
  })

  test('epoch 被 load 抬高（未换账号）时标记故意保留：代价是多一次 silent load', () => {
    // 钉住 beginSend 跨 epoch 分支里 deferred 的存活语义：不 reset 的 epoch 抬升
    // （当前只有登录态 effect 会这样）不该把「欠刷新」丢掉，宁可多补一次。
    let state = deferReload(initialDeferredReload(1))
    state = beginSend(state, 1)
    state = beginSend(state, 2)
    expect(state).toEqual({ deferred: true, inflight: 1, epoch: 2 })
    state = settleSend(state, 2)
    expect(isFlushDue(state)).toBe(true)
  })

  test('身份清场（reset）丢掉标记与计数：陈旧标记不会被新账号的落定消费', () => {
    let state = deferReload(beginSend(initialDeferredReload(1), 1))
    state = resetDeferredReload(2)
    expect(state).toEqual({ deferred: false, inflight: 0, epoch: 2 })
    // 新账号发一条并落定：没有欠刷新，不该补
    state = beginSend(state, 2)
    state = settleSend(state, 2)
    expect(isFlushDue(state)).toBe(false)
  })

  test('clear 只清标记、不动计数', () => {
    const state = beginSend(deferReload(initialDeferredReload(1)), 1)
    expect(clearDeferredReload(state)).toEqual({ deferred: false, inflight: 1, epoch: 1 })
  })
})

describe('shouldFlushDeferredReload —— 到点之后「真的能发」才补（#170 D）', () => {
  const due = deferReload(initialDeferredReload(1))
  const base = { state: due, authed: true, hasUserId: true, visible: true }

  test('到点 + 身份有效 + 页面可见 → 补刷新', () => {
    expect(shouldFlushDeferredReload(base)).toBe(true)
  })

  test('没到点（还欠着在途发送）→ 不补：等最后一次落定', () => {
    const sending = beginSend(due, 1)
    expect(shouldFlushDeferredReload({ ...base, state: sending })).toBe(false)
  })

  test('没欠刷新（正常 didShow 已重拉 / 已被清场）→ 不补', () => {
    expect(shouldFlushDeferredReload({ ...base, state: initialDeferredReload(1) })).toBe(false)
  })

  test('身份失效 / 页面不可见 → 不补（不可见时不丢，回到本页 didShow 会正常重拉）', () => {
    expect(shouldFlushDeferredReload({ ...base, authed: false })).toBe(false)
    expect(shouldFlushDeferredReload({ ...base, hasUserId: false })).toBe(false)
    expect(shouldFlushDeferredReload({ ...base, visible: false })).toBe(false)
  })
})

/* ------------------------------------------------------------------ 媒体（#359 3b） */

/** 一条文本消息的最小合法形状（本文件的用例只关心 id / createdAt 与渲染判定） */
const text = (id: string, createdAt: string): MessageDto => ({
  id,
  conversationId: 'c-1',
  senderId: 'u-1',
  sender: { id: 'u-1', nickname: '我', avatarUrl: null },
  type: 'TEXT',
  content: id,
  createdAt,
})

/** 一张图片媒体（`MediaMessageDto` 是独立 DTO，不与 `MessageDto` 共用形状） */
const picture = (id: string, createdAt: string): MediaMessageDto => ({
  id,
  conversationId: 'c-1',
  senderId: 'u-1',
  kind: 'IMAGE',
  mediaId: `media-${id}`,
  url: `/api/conversations/c-1/media/media-${id}`,
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
  width: 800,
  height: 600,
  durationMs: null,
  createdAt,
})

describe('mergeTimeline —— 文本与媒体合成一条升序时间线', () => {
  test('两条流交错时按时间排回去，而不是「先文本后媒体」', () => {
    const entries = mergeTimeline(
      [text('t1', '2026-09-21T10:00:00.000Z'), text('t3', '2026-09-21T10:00:02.000Z')],
      [picture('m2', '2026-09-21T10:00:01.000Z')],
    )
    expect(entries.map((entry) => entry.keyId)).toEqual(['t1', 'm2', 't3'])
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'media', 'message'])
  })

  test('同一毫秒用 id 定序（与 sortMessages 同一口径，不引入新的不稳定来源）', () => {
    const entries = mergeTimeline(
      [text('b', '2026-09-21T10:00:00.000Z')],
      [picture('a', '2026-09-21T10:00:00.000Z')],
    )
    expect(entries.map((entry) => entry.keyId)).toEqual(['a', 'b'])
  })

  test('另一条流为空时也保留这一条（不会因为「没有文本」就丢掉媒体）', () => {
    expect(mergeTimeline([], [picture('m1', '2026-09-21T10:00:00.000Z')])).toHaveLength(1)
    expect(mergeTimeline([text('t1', '2026-09-21T10:00:00.000Z')], [])).toHaveLength(1)
  })

  test('不改动入参数组', () => {
    const messages = [
      text('t2', '2026-09-21T10:00:02.000Z'),
      text('t1', '2026-09-21T10:00:00.000Z'),
    ]
    mergeTimeline(messages, [])
    expect(messages.map((item) => item.id)).toEqual(['t2', 't1'])
  })
})

describe('mergePushedMedia —— 实时推送的媒体并入媒体流（#67 第四步）', () => {
  test('推送乱序到达时按 (createdAt, id) 排回去', () => {
    const merged = mergePushedMedia(
      [picture('m3', '2026-09-21T10:00:02.000Z')],
      picture('m1', '2026-09-21T10:00:00.000Z'),
    )
    expect(merged.map((item) => item.id)).toEqual(['m1', 'm3'])
  })

  test('重复推送同一条（推送不保证不重）不产生第二条，且返回原数组本身', () => {
    const previous = [picture('m1', '2026-09-21T10:00:00.000Z')]
    expect(mergePushedMedia(previous, picture('m1', '2026-09-21T10:00:00.000Z'))).toBe(previous)
  })

  test('同一毫秒用 id 定序', () => {
    const merged = mergePushedMedia(
      [picture('b', '2026-09-21T10:00:00.000Z')],
      picture('a', '2026-09-21T10:00:00.000Z'),
    )
    expect(merged.map((item) => item.id)).toEqual(['a', 'b'])
  })
})

describe('mergePushedMessage —— 实时推送的消息并入消息流', () => {
  const text = (id: string, createdAt: string): MessageDto => ({
    id,
    conversationId: 'c-1',
    senderId: 'u-2',
    sender: { id: 'u-2', nickname: '小林', avatarUrl: null },
    type: 'TEXT',
    content: id,
    recalledAt: null,
    replyTo: null,
    createdAt,
  })

  test('推送先于自己发送的 HTTP 响应到达时落一次，响应到了不再重复', () => {
    // 服务端「先落库、再推送、再回 HTTP」：推送可能先到
    const previous = [text('b', '2026-09-21T10:00:01.000Z')]
    expect(
      mergePushedMessage(previous, text('a', '2026-09-21T10:00:00.000Z')).map((i) => i.id),
    ).toEqual(['a', 'b'])
  })

  test('重复推送 / 与已落库消息同 id 时返回原数组本身（碑优先于迟到的正文）', () => {
    const previous = [text('a', '2026-09-21T10:00:00.000Z')]
    expect(mergePushedMessage(previous, text('a', '2026-09-21T10:00:00.000Z'))).toBe(previous)
  })
})

describe('mergeRefreshedMedia —— 后台刷新落地时不抹掉刷新期间发出的媒体', () => {
  test('baseIds 之外、incoming 里也没有的本地新增被保留（与 mergeRefreshedMessages 对称）', () => {
    const merged = mergeRefreshedMedia(
      [picture('m1', '2026-09-21T10:00:00.000Z'), picture('m2', '2026-09-21T10:00:05.000Z')],
      [picture('m1', '2026-09-21T10:00:00.000Z')],
      new Set(['m1']),
    )
    expect(merged.map((item) => item.id)).toEqual(['m1', 'm2'])
  })

  test('incoming 已经有的 id 不重复（服务端回包与本地乐观条目会撞上）', () => {
    const merged = mergeRefreshedMedia(
      [picture('m1', '2026-09-21T10:00:00.000Z')],
      [picture('m1', '2026-09-21T10:00:00.000Z')],
      new Set(),
    )
    expect(merged.map((item) => item.id)).toEqual(['m1'])
  })

  test('baseIds 之内的旧条目以服务端快照为准（本地那份不再保留）', () => {
    const merged = mergeRefreshedMedia(
      [picture('m1', '2026-09-21T10:00:00.000Z')],
      [],
      new Set(['m1']),
    )
    expect(merged).toEqual([])
  })
})

describe('canRetryMedia —— 上传失败才可重试', () => {
  const pendingImage = (status: 'uploading' | 'failed'): PendingMedia => ({
    kind: 'IMAGE',
    clientRequestId: 'req-1',
    path: 'wxfile://tmp/photo.jpg',
    image: { mime: 'image/jpeg', width: 800, height: 600, sizeBytes: 1024 },
    id: 'local-1',
    uploaded: null,
    status,
  })

  test('failed 可以重试；uploading 不能（否则同一条媒体会被投两次）', () => {
    expect(canRetryMedia(pendingImage('failed'))).toBe(true)
    expect(canRetryMedia(pendingImage('uploading'))).toBe(false)
  })
})

describe('hasEarlierPage —— 文本游标到底不再挡住媒体历史（#67 N3）', () => {
  test('两条流都到底才没有更早的了', () => {
    expect(hasEarlierPage(null, null)).toBe(false)
  })

  test('文本还有更早的一页：要翻', () => {
    expect(hasEarlierPage('c-text', null)).toBe(true)
  })

  test('文本到底、媒体还有历史：仍然要翻（修复前按钮会消失）', () => {
    expect(hasEarlierPage(null, 'c-media')).toBe(true)
  })

  test('两条都还有：照常翻', () => {
    expect(hasEarlierPage('c-text', 'c-media')).toBe(true)
  })
})

describe('startMediaRetry —— 重试期间切回上传中（#67 N4）', () => {
  const uploadedImage = {
    kind: 'IMAGE' as const,
    objectKey: 'chat-media/c/u/p.png',
    contentType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
  }
  const pendingImage = (status: 'uploading' | 'failed'): PendingMedia => ({
    kind: 'IMAGE',
    clientRequestId: 'req-1',
    path: 'wxfile://tmp/photo.jpg',
    image: { mime: 'image/jpeg', width: 800, height: 600, sizeBytes: 1024 },
    id: 'local-1',
    uploaded: uploadedImage,
    status,
  })

  test('失败态重试后不再是失败态，重试按钮随之消失', () => {
    const retried = startMediaRetry(pendingImage('failed'))
    expect(retried.status).toBe('uploading')
    expect(canRetryMedia(retried)).toBe(false)
    // 只改状态：重试只重发 create，`uploaded` 必须原样带着（否则指纹变化 → 409）
    expect(retried.uploaded).toEqual(uploadedImage)
  })
})

describe('isStaleMediaTask —— 媒体发送任务绑定发起时的会话（#67 N2）', () => {
  const binding = { epoch: 3, cookie: 'fish_session=aaa' }

  test('代次与 cookie 都没变：还是这份任务的', () => {
    expect(isStaleMediaTask(binding, { epoch: 3, cookie: 'fish_session=aaa' })).toBe(false)
  })

  test('整页重拉 / 身份清场推进了代次：判旧', () => {
    expect(isStaleMediaTask(binding, { epoch: 4, cookie: 'fish_session=aaa' })).toBe(true)
  })

  test('只换了账号、代次没动（直接换 storage 会话）：也必须判旧', () => {
    expect(isStaleMediaTask(binding, { epoch: 3, cookie: 'fish_session=bbb' })).toBe(true)
  })

  test('退出登录（cookie 变空）：判旧', () => {
    expect(isStaleMediaTask(binding, { epoch: 3, cookie: '' })).toBe(true)
  })
})

describe('isStaleMediaIdentity —— 选图 / 录音 / 点开媒体的身份判据（#364 审查）', () => {
  const identity = { cookie: 'fish_session=aaa', userId: 'user-a' }

  test('身份没变就不判旧：整页重拉推进的只是 epoch，不是换人', () => {
    // 修复前这几处用的是 `isStaleMediaTask(task, { epoch, cookie })`：用户选图 / 录音
    // 期间任何一次 `load()`（切后台回来、发送落定后的补刷新）都会把 epoch 推走，
    // 于是「选了图 / 录了音，什么都没发生」——素材被静默丢掉。
    expect(isStaleMediaIdentity(identity, { cookie: 'fish_session=aaa', userId: 'user-a' })).toBe(
      false,
    )
  })

  test('与新判据的差别就是修复点：同一个身份下 epoch 被推进，旧的 isStaleMediaTask 会判旧', () => {
    // 左边这条正是修复前的行为（发送链仍在用 `isStaleMediaTask`，那里 epoch 有意义）；
    // 选图 / 录音 / 点开媒体换成右边这条判据后，整页重拉不再丢掉用户已经拿到的东西。
    expect(
      isStaleMediaTask(
        { epoch: 3, cookie: 'fish_session=aaa' },
        {
          epoch: 4,
          cookie: 'fish_session=aaa',
        },
      ),
    ).toBe(true)
    expect(isStaleMediaIdentity(identity, { cookie: 'fish_session=aaa', userId: 'user-a' })).toBe(
      false,
    )
  })

  test('换了账号（userId 变了）：判旧', () => {
    expect(isStaleMediaIdentity(identity, { cookie: 'fish_session=aaa', userId: 'user-b' })).toBe(
      true,
    )
  })

  test('直接换 storage 会话（userId 没变、cookie 变了）：也要判旧', () => {
    expect(isStaleMediaIdentity(identity, { cookie: 'fish_session=bbb', userId: 'user-a' })).toBe(
      true,
    )
  })

  test('退出登录（userId 变 null / cookie 变空）：判旧', () => {
    expect(isStaleMediaIdentity(identity, { cookie: 'fish_session=aaa', userId: null })).toBe(true)
    expect(isStaleMediaIdentity(identity, { cookie: '', userId: 'user-a' })).toBe(true)
    // 反向同理：未登录时起的任务遇上登录，也不是同一个身份
    expect(
      isStaleMediaIdentity(
        { cookie: 'fish_session=aaa', userId: null },
        { cookie: 'fish_session=aaa', userId: 'user-a' },
      ),
    ).toBe(true)
  })
})

describe('planMediaLoad —— 缓存命中要回填本页路径（#67 复查 #222）', () => {
  test('第一次进会话：模块缓存还空 → 去下载', () => {
    expect(planMediaLoad({ cached: null, downloading: false })).toEqual({ kind: 'download' })
  })

  test('第一次成功显示 → 退出 → 重新进入：命中缓存必须 reuse 并把路径带回来', () => {
    // 第一次进：走下载，成功后写进模块缓存 + 本页 localPaths
    expect(planMediaLoad({ cached: null, downloading: false })).toEqual({ kind: 'download' })
    // 退出会话：页面级 localPaths 随组件一起被重建为空，模块级缓存还在。
    // 修复前这里直接 `continue`，渲染只读 localPaths → 图片退化成占位块，
    // 而且缓存命中把下载也挡住了，永远不会自愈。
    expect(planMediaLoad({ cached: 'wxfile://tmp/a.png', downloading: false })).toEqual({
      kind: 'reuse',
      path: 'wxfile://tmp/a.png',
    })
  })

  test('同一条媒体正在下载：跳过，不并发重复下载', () => {
    expect(planMediaLoad({ cached: null, downloading: true })).toEqual({ kind: 'skip' })
  })

  test('缓存命中优先于「下载中」：已经有路径就不必等那次下载', () => {
    expect(planMediaLoad({ cached: 'wxfile://tmp/a.png', downloading: true })).toEqual({
      kind: 'reuse',
      path: 'wxfile://tmp/a.png',
    })
  })
})

describe('isCurrentPlayRequest —— 迟到的语音下载不许落地（#67 复查 #222）', () => {
  const task = { cookie: 'fish_session=aaa', userId: 'user-a' }
  const request = { token: 7, task }

  test('当前有效：还活着、还是同一次点击、还是同一个身份（整页重拉不算换人）', () => {
    // #364 审查：`epoch` 会被任何一次整页重拉推进（切后台回来、发送落定后的补刷新），
    // 但它**不代表换人** —— 用户点开一段语音、下载还没回来时正好赶上一次重拉，旧实现
    // 把 epoch 也当身份，于是既不预览也不提示（点了没反应）。判据里没有 epoch 这一项。
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        cookie: 'fish_session=aaa',
        userId: 'user-a',
        alive: true,
      }),
    ).toBe(true)
  })

  test('点播放 → 下载挂起 → 换了账号：下载回来不许出声、不许回填缓存', () => {
    // 直接换 storage 会话（userId 没动）也要拦住：缓存里是上一个身份的私有媒体临时文件
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        cookie: 'fish_session=bbb',
        userId: 'user-a',
        alive: true,
      }),
    ).toBe(false)
    // 退出登录（cookie 与 userId 一起没了）
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        cookie: '',
        userId: null,
        alive: true,
      }),
    ).toBe(false)
  })

  test('点播放 → 下载挂起 → 离开会话页：下载回来不许出声', () => {
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        cookie: 'fish_session=aaa',
        userId: 'user-a',
        alive: false,
      }),
    ).toBe(false)
  })

  test('下载期间用户又点了别的语音：旧的那次不再抢当前播放', () => {
    expect(
      isCurrentPlayRequest(request, {
        token: 8,
        cookie: 'fish_session=aaa',
        userId: 'user-a',
        alive: true,
      }),
    ).toBe(false)
  })

  test('只看 playingId 不够：令牌不同就必须判旧（迟到的回调读到的是别人的答案）', () => {
    // 这条断言的含义是：即使身份没变（cookie / userId 都一样），
    // 只要播放请求序号被后来的点击推进过，旧回调就不能落地。
    expect(
      isCurrentPlayRequest(
        { token: 1, task },
        { token: 2, cookie: task.cookie, userId: task.userId, alive: true },
      ),
    ).toBe(false)
  })
})

/**
 * 长按菜单 / 引用 / 撤回（#359 3c）。
 *
 * 锁的是「哪些动作该出现、哪些不该」这条判据 —— 它是页面里唯一决定「用户能不能撤回
 * 别人的消息」的地方，写错会直接变成越权入口（服务端仍会拦，但界面不该给）。
 */
describe('messageActions / canRecallMessage —— 长按菜单能做什么（#359 3c）', () => {
  const WINDOW = 120_000
  const NOW = Date.parse('2026-09-21T10:00:00.000Z')
  const ME = 'usr_01jc000000e0080000000000a1'

  const text = (over: Partial<MessageDto> = {}): MessageDto => ({
    id: 'msg_01jc000000e0080000000000d1',
    conversationId: 'cnv_01jc000000e0080000000000c1',
    senderId: ME,
    sender: { id: ME, nickname: '我', avatarUrl: null },
    type: 'TEXT',
    content: '在的',
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-09-21T09:59:30.000Z',
    ...over,
  })

  test('自己的未撤回 TEXT：复制 / 引用 / 撤回三项齐全', () => {
    expect(messageActions(text(), ME, NOW, WINDOW)).toEqual(['copy', 'reply', 'recall'])
  })

  test('对方发的：没有撤回项（界面不给越权入口）', () => {
    expect(messageActions(text({ senderId: 'usr_x' }), ME, NOW, WINDOW)).toEqual(['copy', 'reply'])
  })

  test('超出 2 分钟窗口：撤回项消失，复制与引用仍在', () => {
    const old = text({ createdAt: '2026-09-21T09:57:00.000Z' })
    expect(canRecallMessage(old, ME, NOW, WINDOW)).toBe(false)
    expect(messageActions(old, ME, NOW, WINDOW)).toEqual(['copy', 'reply'])
  })

  test('窗口边界（恰好 120s）仍可撤回，多 1ms 即不可', () => {
    expect(canRecallMessage(text({ createdAt: '2026-09-21T09:58:00.000Z' }), ME, NOW, WINDOW)).toBe(
      true,
    )
    expect(canRecallMessage(text({ createdAt: '2026-09-21T09:57:59.999Z' }), ME, NOW, WINDOW)).toBe(
      false,
    )
  })

  test('已撤回的：只剩撤回碑，没有复制 / 引用 / 撤回任何一项', () => {
    const recalled = text({ content: '', recalledAt: '2026-09-21T09:59:40.000Z' })
    expect(messageActions(recalled, ME, NOW, WINDOW)).toEqual([])
  })

  test('SYSTEM 消息不给任何动作（交易事实不是用户消息）', () => {
    const system = text({ type: 'SYSTEM', senderId: null, sender: null })
    expect(messageActions(system, ME, NOW, WINDOW)).toEqual([])
  })

  /*
    商品卡（LISTING）与媒体（MEDIA）的菜单口径不在这里测：本分支的契约里
    `messageTypeSchema` 只有 TEXT / SYSTEM（LISTING 在 #366/#363、媒体在 #364 上，
    都还没合入），构造那种 DTO 会是类型错误。等它们合入后按同一组断言补
    「无正文可复制 → 只给引用与撤回」—— 已记在 #359 的合流清单里。
  */

  test('未登录（meId 为 null）：撤回入口消失，本地动作仍在', () => {
    // 复制 / 引用不依赖身份（纯本地动作），撤回必须依赖「是不是我发的」——
    // 身份缺失时不能凭空给出撤回入口。
    expect(messageActions(text(), null, NOW, WINDOW)).toEqual(['copy', 'reply'])
    expect(canRecallMessage(text(), null, NOW, WINDOW)).toBe(false)
  })

  test('时间戳解析不了：不误判成「在窗口内」', () => {
    expect(canRecallMessage(text({ createdAt: 'not-a-date' }), ME, NOW, WINDOW)).toBe(false)
  })

  test('每个动作都有中文文案（菜单不会出现空行）', () => {
    for (const action of ['copy', 'reply', 'recall'] as const) {
      expect(MESSAGE_ACTION_LABEL[action].length).toBeGreaterThan(0)
    }
  })
})

describe('localReplyExcerpt —— 本地摘引文案（与服务端 replyExcerpt 同口径）', () => {
  const base = {
    id: 'msg_01jc000000e0080000000000d1',
    conversationId: 'cnv_01jc000000e0080000000000c1',
    senderId: 'usr_x',
    sender: { id: 'usr_x', nickname: 'A', avatarUrl: null },
    type: 'TEXT' as const,
    content: '在的',
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-09-21T10:00:00.000Z',
  }

  test('普通文本原样；首尾空白先 trim', () => {
    expect(localReplyExcerpt({ ...base, content: '  在的  ' })).toBe('在的')
  })

  test('超长截断到 120 字含省略号（契约 excerpt 的 max）', () => {
    const long = 'a'.repeat(200)
    expect(localReplyExcerpt({ ...base, content: long })).toBe(`${'a'.repeat(119)}…`)
    expect(localReplyExcerpt({ ...base, content: long }).length).toBe(120)
  })

  test('空正文与已撤回各给占位，不画空引用条', () => {
    expect(localReplyExcerpt({ ...base, content: '   ' })).toBe('[消息]')
    expect(
      localReplyExcerpt({ ...base, content: '', recalledAt: '2026-09-21T10:00:00.000Z' }),
    ).toBe('[消息已撤回]')
  })
})

describe('applyRecalled —— 撤回落地（#359 3c）', () => {
  const make = (id: string): MessageDto => ({
    id,
    conversationId: 'cnv_01jc000000e0080000000000c1',
    senderId: 'usr_01jc000000e0080000000000a1',
    sender: { id: 'usr_01jc000000e0080000000000a1', nickname: '我', avatarUrl: null },
    type: 'TEXT',
    content: '发错了',
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-09-21T10:00:00.000Z',
  })

  test('目标那条正文清空并落 recalledAt，其余不动', () => {
    const items = [make('m1'), make('m2')]
    const out = applyRecalled(items, 'm1', '2026-09-21T10:00:05.000Z')
    expect(out[0]).toMatchObject({ id: 'm1', content: '', recalledAt: '2026-09-21T10:00:05.000Z' })
    expect(out[1]).toEqual(items[1])
  })

  test('不改动入参数组（避免原地改 state 里那份）', () => {
    const items = [make('m1')]
    applyRecalled(items, 'm1', '2026-09-21T10:00:05.000Z')
    expect(items[0]?.content).toBe('发错了')
    expect(items[0]?.recalledAt).toBeNull()
  })

  test('id 不存在时原样返回，不误伤别的消息', () => {
    const items = [make('m1')]
    expect(applyRecalled(items, 'nope', '2026-09-21T10:00:05.000Z')).toEqual(items)
  })
})

describe('recallFailureText —— 撤回失败的三档文案', () => {
  test('超窗 / 越权 / 不存在各有说法', () => {
    expect(recallFailureText('MESSAGE_RECALL_WINDOW_EXCEEDED')).toBe('超过 2 分钟，不能撤回了')
    expect(recallFailureText('MESSAGE_RECALL_FORBIDDEN')).toBe('只能撤回自己发的消息')
    expect(recallFailureText('MESSAGE_NOT_FOUND')).toBe('消息已不存在')
  })

  test('其它错误码与缺省走通用文案（不泄漏服务端原文）', () => {
    expect(recallFailureText('INTERNAL_ERROR')).toBe('撤回失败，请重试')
    expect(recallFailureText(undefined)).toBe('撤回失败，请重试')
  })
})

/**
 * `doRecall` 的 epoch 契约（#365 审查 P1）。
 *
 * 组件里的 `doRecall` 刻意**不设** epoch 守卫，原因写在 `index.tsx` 的注释里：撤回在途
 * 最长 15s，期间任何一次 `load()` 都会 `epoch + 1`，按 epoch 判过期会让「撤回成功后本地
 * 不落碑」+「`recallingId` 永久锁死」同时发生。页面组件没有渲染测试基建，所以把这条
 * 不变式锚在 `applyRecalled` 上：它**只按 id 命中**，换账号后 `messages` 已清空，
 * 陈旧响应改不到任何行 —— 这正是「不设守卫也安全」的依据。
 */
describe('applyRecalled 的跨账号安全性（doRecall 不设 epoch 守卫的依据）', () => {
  const msg = (id: string, senderId: string): MessageDto => ({
    id,
    conversationId: 'cnv_01jc000000e0080000000000c1',
    senderId,
    sender: { id: senderId, nickname: 'A', avatarUrl: null },
    type: 'TEXT',
    content: 'x',
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-09-21T10:00:00.000Z',
  })

  test('id 不在流里时逐条原样返回（换账号后清空 → 陈旧撤回改不到新账号的消息）', () => {
    const other = [msg('m-b', 'usr_b'), msg('m-c', 'usr_b')]
    const out = applyRecalled(other, 'm-a', '2026-09-21T10:00:05.000Z')
    expect(out).toEqual(other)
  })

  test('只改命中 id 的那一条，同会话其它消息（含同发送者）不动', () => {
    const items = [msg('m-a', 'usr_a'), msg('m-b', 'usr_a')]
    const out = applyRecalled(items, 'm-a', '2026-09-21T10:00:05.000Z')
    expect(out[0]?.recalledAt).toBe('2026-09-21T10:00:05.000Z')
    expect(out[1]).toEqual(items[1])
  })
})

/**
 * 撤回不可回退（#359 3c 审查回合）。
 *
 * 服务端的 `recalled_at` 是单调的，所以「本地已落碑、刚回来的快照却没撤回」只可能是快照更早
 * —— 而撤回在途 15s 内任何一次 `load()` 都可能带回这种快照（整页重拉与 silent 补刷都算）。
 */
describe('keepRecalledTombstones —— 旧快照不能把撤回碑写回正文', () => {
  const msg = (over: Partial<MessageDto> = {}): MessageDto => ({
    id: 'msg_01jc000000e0080000000000e1',
    conversationId: 'cnv_01jc000000e0080000000000c1',
    senderId: 'usr_01jc000000e0080000000000a1',
    sender: { id: 'usr_01jc000000e0080000000000a1', nickname: '我', avatarUrl: null },
    type: 'TEXT',
    content: '撤回前的正文',
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-09-21T10:00:00.000Z',
    ...over,
  })
  const RECALLED_AT = '2026-09-21T10:00:05.000Z'

  test('本地已落碑 + 快照说没撤回 → 保住撤回碑（正文清空、撤回时刻保留）', () => {
    const local = [msg({ content: '', recalledAt: RECALLED_AT })]
    const stale = [msg({ content: '撤回前的正文', recalledAt: null })]

    const out = keepRecalledTombstones(local, stale)

    expect(out).toHaveLength(1)
    expect(out[0]?.recalledAt).toBe(RECALLED_AT)
    expect(out[0]?.content).toBe('')
  })

  test('快照自己也带撤回时原样采信（权威值可由它推进）', () => {
    const local = [msg({ content: '', recalledAt: RECALLED_AT })]
    const fresh = [msg({ content: '', recalledAt: '2026-09-21T10:00:09.000Z' })]
    expect(keepRecalledTombstones(local, fresh)[0]?.recalledAt).toBe('2026-09-21T10:00:09.000Z')
  })

  test('没有本地撤回记录时不改任何一条（新消息、顺序修正照常生效）', () => {
    const incoming = [msg(), msg({ id: 'msg_01jc000000e0080000000000e2', content: '对方刚发的' })]
    expect(keepRecalledTombstones([], incoming)).toEqual(incoming)
  })

  test('快照里的别条消息不受影响', () => {
    const local = [msg({ content: '', recalledAt: RECALLED_AT })]
    const other = msg({ id: 'msg_01jc000000e0080000000000e3', content: '别的' })
    const out = keepRecalledTombstones(local, [msg(), other])
    expect(out[1]).toEqual(other)
  })
})

/**
 * 引用失效的善后（#359 3c 审查回合）：422 `MESSAGE_REPLY_INVALID` 时若不摘掉引用，
 * `retry` 会原样把同一个 `replyTo` 再发一次 —— 每次重试必然 422，成为死循环气泡。
 */
describe('shouldDropReplyOnSendFailure —— 引用失效必须摘掉引用再重试', () => {
  test('只有 MESSAGE_REPLY_INVALID 摘引用', () => {
    expect(shouldDropReplyOnSendFailure('MESSAGE_REPLY_INVALID')).toBe(true)
    expect(shouldDropReplyOnSendFailure('IDEMPOTENCY_KEY_REUSED')).toBe(false)
    expect(shouldDropReplyOnSendFailure(undefined)).toBe(false)
  })

  test('提示文案非空（用户得知道引用为什么没了）', () => {
    expect(REPLY_DROPPED_TIP.length).toBeGreaterThan(0)
  })
})
