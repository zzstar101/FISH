import { describe, expect, test } from 'bun:test'
import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import { clockTime, dayLabelOf } from '../src/lib/time'
import {
  beginSend,
  canRetry,
  canRetryMedia,
  clearDeferredReload,
  deferReload,
  hasEarlierPage,
  initialDeferredReload,
  isCurrentPlayRequest,
  isFlushDue,
  isStaleMediaTask,
  listingStatusText,
  mergePushedMedia,
  mergeRefreshedMedia,
  mergeTimeline,
  type PendingMedia,
  type PendingMessage,
  parseTxEvent,
  planMediaLoad,
  resetDeferredReload,
  settleSend,
  shouldFlushDeferredReload,
  shouldReloadOnShow,
  sortMessages,
  startMediaRetry,
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

/**
 * #67 第四步：媒体消息进入会话流的两条新路径。
 *
 * 服务端有**两条独立消息流**（文本/系统 + 媒体，各自端点、各自实时事件、没有共同
 * 联合类型），所以这里锁的是客户端把它们并起来的三条判据：按 `(createdAt,id)` 定序、
 * 按服务端 id 去重、后台刷新不抹掉「刷新期间才发出去的那条媒体」。
 */
const mediaText = (id: string, createdAt: string): MessageDto => ({
  id,
  conversationId: 'c-1',
  senderId: 'u-1',
  sender: { id: 'u-1', nickname: '我', avatarUrl: null },
  type: 'TEXT',
  content: id,
  createdAt,
})

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
      [mediaText('t1', '2026-09-21T10:00:00.000Z'), mediaText('t3', '2026-09-21T10:00:02.000Z')],
      [picture('m2', '2026-09-21T10:00:01.000Z')],
    )
    expect(entries.map((entry) => entry.keyId)).toEqual(['t1', 'm2', 't3'])
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'media', 'message'])
  })

  test('同一毫秒用 id 定序（与 sortMessages 同一口径，不引入新的不稳定来源）', () => {
    const entries = mergeTimeline(
      [mediaText('b', '2026-09-21T10:00:00.000Z')],
      [picture('a', '2026-09-21T10:00:00.000Z')],
    )
    expect(entries.map((entry) => entry.keyId)).toEqual(['a', 'b'])
  })

  test('另一条流为空时也保留这一条（不会因为「没有文本」就丢掉媒体）', () => {
    expect(mergeTimeline([], [picture('m1', '2026-09-21T10:00:00.000Z')])).toHaveLength(1)
    expect(mergeTimeline([mediaText('t1', '2026-09-21T10:00:00.000Z')], [])).toHaveLength(1)
  })

  test('不改动入参数组', () => {
    const messages = [
      mediaText('t2', '2026-09-21T10:00:02.000Z'),
      mediaText('t1', '2026-09-21T10:00:00.000Z'),
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
  const task = { epoch: 3, cookie: 'fish_session=aaa' }
  const request = { token: 7, task }

  test('当前有效：还活着、还是同一次点击、还是同一个身份', () => {
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        epoch: 3,
        cookie: 'fish_session=aaa',
        alive: true,
      }),
    ).toBe(true)
  })

  test('点播放 → 下载挂起 → 换了账号：下载回来不许出声、不许回填缓存', () => {
    // 直接换 storage 会话（代次没动）也要拦住：缓存里是上一个身份的私有媒体临时文件
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        epoch: 3,
        cookie: 'fish_session=bbb',
        alive: true,
      }),
    ).toBe(false)
    // 退出登录 / 整页重拉推进代次
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        epoch: 4,
        cookie: 'fish_session=aaa',
        alive: true,
      }),
    ).toBe(false)
  })

  test('点播放 → 下载挂起 → 离开会话页：下载回来不许出声', () => {
    expect(
      isCurrentPlayRequest(request, {
        token: 7,
        epoch: 3,
        cookie: 'fish_session=aaa',
        alive: false,
      }),
    ).toBe(false)
  })

  test('下载期间用户又点了别的语音：旧的那次不再抢当前播放', () => {
    expect(
      isCurrentPlayRequest(request, {
        token: 8,
        epoch: 3,
        cookie: 'fish_session=aaa',
        alive: true,
      }),
    ).toBe(false)
  })

  test('只看 playingId 不够：令牌不同就必须判旧（迟到的回调读到的是别人的答案）', () => {
    // 这条断言的含义是：即使身份没变（epoch / cookie 都一样），
    // 只要播放请求序号被后来的点击推进过，旧回调就不能落地。
    expect(
      isCurrentPlayRequest(
        { token: 1, task },
        { token: 2, epoch: task.epoch, cookie: task.cookie, alive: true },
      ),
    ).toBe(false)
  })
})
