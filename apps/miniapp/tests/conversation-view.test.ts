import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import { clockTime, dayLabelOf } from '../src/lib/time'
import {
  beginSend,
  canRetry,
  clearDeferredReload,
  deferReload,
  initialDeferredReload,
  isFlushDue,
  listingStatusText,
  type PendingMessage,
  parseTxEvent,
  resetDeferredReload,
  settleSend,
  shouldFlushDeferredReload,
  shouldReloadOnShow,
  sortMessages,
  systemPillText,
} from '../src/pages/conversation/view'

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
  /** 走一遍：发起 n 次发送、再落定 m 次（都用同一个 epoch） */
  const run = (epoch: number, sends: number, settles: number) => {
    let state = deferReload(initialDeferredReload(epoch))
    const flushes: boolean[] = []
    for (let i = 0; i < sends; i += 1) state = beginSend(state, epoch)
    for (let i = 0; i < settles; i += 1) {
      state = settleSend(state, epoch)
      flushes.push(isFlushDue(state))
    }
    return { state, flushes }
  }

  test('单个发送落定后 → 到点补刷新', () => {
    const { state, flushes } = run(1, 1, 1)
    expect(flushes).toEqual([true])
    expect(state).toEqual({ deferred: true, inflight: 0, epoch: 1 })
  })

  test('多个并发发送：只有最后一次落定才到点，flush 恰好一次', () => {
    const { state, flushes } = run(1, 2, 2)
    expect(flushes).toEqual([false, true])
    expect(state.inflight).toBe(0)
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
