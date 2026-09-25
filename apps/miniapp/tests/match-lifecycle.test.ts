import { describe, expect, test } from 'bun:test'
import {
  type ChatTask,
  canLoad,
  isCurrentChatTask,
  isLatestLoad,
  ownerChanged,
  shouldReleaseChatTask,
  shouldReloadOnShow,
} from '../src/pages/match/view'

/**
 * match 页 owner/epoch 交错的回归（#170 A/B/C/D 的判据层）。
 *
 * 锁的是三类曾经出错、且只看单帧状态看不出来的时序：
 * - 冷启动 `authStatus === 'unknown'` 阶段不得发受限请求（旧实现挂在 `useLoad` 上抢跑，
 *   两个端点必然 401）；
 * - A 的在途响应不得写进 B 的页面（旧实现只在组件内自增序号，没有用例守着这条）；
 * - 首次 show 与登录态 effect 不能对首屏双发。
 *
 * 边界：本文件只跑判据，不跑组件接线（effect 顺序、渲染期 setState、`useDidShow`
 * 注册时机）—— 那部分按 A/B/C/D 时序在微信开发者工具里实测，不拿本文件当端上证明。
 */

/** 一个最小的「页面 + 序号」模型：只保留跨账号交错需要的两个字段 */
function screen() {
  return { ownerId: null as string | null, seq: 0 }
}

/** 换账号：渲染期同步清场 + 序号前进（对应 index.tsx 的 prevUserId 分支） */
function switchOwner(s: ReturnType<typeof screen>, next: string | null) {
  if (ownerChanged(s.ownerId, next)) {
    s.ownerId = next
    s.seq += 1
  }
}

/** 发起一次加载：序号前进并返回这次的 ticket */
function beginLoad(s: ReturnType<typeof screen>) {
  s.seq += 1
  return { seq: s.seq, ownerId: s.ownerId }
}

/** 响应落地：只有 ticket 仍是最新一次才允许写入 */
function applyResponse(s: ReturnType<typeof screen>, ticket: { seq: number }) {
  return isLatestLoad(ticket.seq, s.seq)
}

describe('match 页加载门禁', () => {
  test('冷启动 unknown 阶段不发受限请求', () => {
    expect(canLoad(false, null)).toBe(false)
  })

  test('已登录但没有 userId 时仍不发（身份未就绪）', () => {
    expect(canLoad(true, null)).toBe(false)
  })

  test('恢复到 authed 且拿到 userId 后才加载', () => {
    expect(canLoad(true, 'user-a')).toBe(true)
  })
})

describe('match 页 owner/epoch 交错', () => {
  test('A 的在途响应不得写进 B（成功与失败两种结果都作废）', () => {
    const s = screen()
    switchOwner(s, 'user-a')
    const ticketA = beginLoad(s)

    switchOwner(s, 'user-b')
    expect(ownerChanged('user-a', 'user-b')).toBe(true)
    switchOwner(s, 'user-b')
    const ticketB = beginLoad(s)

    // A 迟到：无论是 ok 还是 failed，写入判据都必须是 false
    expect(applyResponse(s, ticketA)).toBe(false)
    expect(applyResponse(s, ticketB)).toBe(true)
  })

  test('退出登录到 null 也算换 owner，在途响应同样作废', () => {
    const s = screen()
    switchOwner(s, 'user-a')
    const ticketA = beginLoad(s)

    switchOwner(s, null)
    expect(applyResponse(s, ticketA)).toBe(false)
  })

  test('同一账号内连点重试：先发的响应后到不得覆盖后发的', () => {
    const s = screen()
    switchOwner(s, 'user-a')
    const first = beginLoad(s)
    const second = beginLoad(s)

    expect(applyResponse(s, first)).toBe(false)
    expect(applyResponse(s, second)).toBe(true)
  })

  test('账号没变时不重复清场，序号不无故前进', () => {
    const s = screen()
    switchOwner(s, 'user-a')
    const seqAfterLogin = s.seq
    switchOwner(s, 'user-a')
    expect(s.seq).toBe(seqAfterLogin)
  })
})

/**
 * 「聊一聊」任务令牌的模型（#67 R3）。
 *
 * 与页面同构：`inFlight` 是 `listingId -> token` 的 Map（不是 Set），`epoch` 只在换账号
 * 与卸载时前进。`beginChat` 对应 `chat()` 入口，`release` 对应它的 `finally`。
 */
function chatPage() {
  return {
    ownerId: null as string | null,
    epoch: 0,
    inFlight: new Map<string, number>(),
    taskSeq: 0,
  }
}

function switchChatOwner(p: ReturnType<typeof chatPage>, next: string | null) {
  if (ownerChanged(p.ownerId, next)) {
    p.ownerId = next
    // 换账号同时作废建会话任务（index.tsx 的 ownerChanged 分支：chatEpoch += 1、
    // inFlight.clear()）—— 清掉旧账号的锁，新账号才能立刻对同一商品重新发起。
    p.epoch += 1
    p.inFlight.clear()
  }
}

/** 对应 `chat()` 入口：在途闸门 + 捕获令牌 + 占锁。被闸门拦住时返回 null。 */
function beginChat(p: ReturnType<typeof chatPage>, listingId: string): ChatTask | null {
  if (p.inFlight.has(listingId)) return null
  p.taskSeq += 1
  const task: ChatTask = {
    listingId,
    ownerId: p.ownerId,
    epoch: p.epoch,
    token: p.taskSeq,
  }
  p.inFlight.set(listingId, task.token)
  return task
}

/** 对应 `chat()` 里的 `isCurrentTask()` */
function stillCurrent(p: ReturnType<typeof chatPage>, task: ChatTask): boolean {
  return isCurrentChatTask(task, {
    ownerId: p.ownerId,
    epoch: p.epoch,
    inFlightToken: p.inFlight.get(task.listingId),
  })
}

/** 对应 `chat()` 的 `release()`：只释放自己的锁（判据本身取自页面同一个纯函数） */
function releaseChat(p: ReturnType<typeof chatPage>, task: ChatTask) {
  if (!shouldReleaseChatTask(task, p.inFlight.get(task.listingId))) return
  p.inFlight.delete(task.listingId)
}

describe('match 页「聊一聊」任务令牌（#67 R3）', () => {
  test('任务仍在当前账号且未被顶替时有效（不能把所有请求都判旧）', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')
    const task = beginChat(p, 'listing-1')
    expect(task).not.toBeNull()
    expect(stillCurrent(p, task as ChatTask)).toBe(true)

    // 同一账号内从会话页返回触发重拉：只推进加载序号，不推进 chatEpoch，
    // 否则一次仍然有效的建会话请求会被丢掉。
    expect(p.epoch).toBe(1)
    expect(stillCurrent(p, task as ChatTask)).toBe(true)
  })

  test('A 发起的建会话，切到 B 之后迟到返回也不得写缓存/导航', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')
    const taskA = beginChat(p, 'listing-1') as ChatTask

    switchChatOwner(p, 'user-b')
    expect(p.ownerId).toBe('user-b')
    expect(stillCurrent(p, taskA)).toBe(false)
  })

  test('A→B→A 之后 owner 又相等，仍必须判旧（靠代次而不是 owner）', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')
    const taskA = beginChat(p, 'listing-1') as ChatTask

    switchChatOwner(p, 'user-b')
    switchChatOwner(p, 'user-a')

    // 只看 ownerId 会误判为有效，于是迟到的缓存写入与导航会落到 B 已经离开的账号上。
    expect(p.ownerId).toBe(taskA.ownerId)
    expect(stillCurrent(p, taskA)).toBe(false)
  })

  test('卸载（代次前进）后返回的响应判旧', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')
    const task = beginChat(p, 'listing-1') as ChatTask

    // index.tsx 卸载 effect：`chatEpoch.current += 1`
    p.epoch += 1
    expect(stillCurrent(p, task)).toBe(false)
  })

  test('B 持锁时结束 A 的请求：A 的收尾不得释放 B 的在途标记', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')
    const taskA = beginChat(p, 'listing-1') as ChatTask

    switchChatOwner(p, 'user-b')
    const taskB = beginChat(p, 'listing-1') as ChatTask

    // A 的迟到 finally 在 B 已经取得锁之后才跑
    releaseChat(p, taskA)
    expect(p.inFlight.get('listing-1')).toBe(taskB.token)
    expect(stillCurrent(p, taskB)).toBe(true)

    // B 自己的收尾正常释放
    releaseChat(p, taskB)
    expect(p.inFlight.has('listing-1')).toBe(false)
  })

  test('缓存命中路径连点只跳一次（在途闸门对缓存分支同样生效）', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')

    const first = beginChat(p, 'listing-1')
    const second = beginChat(p, 'listing-1')
    expect(first).not.toBeNull()
    expect(second).toBeNull()

    // 释放后允许再次发起（例如用户返回后又点了一次）
    releaseChat(p, first as ChatTask)
    expect(beginChat(p, 'listing-1')).not.toBeNull()
  })

  test('不同商品的在途互不干扰：一个商品的收尾不影响另一个', () => {
    const p = chatPage()
    switchChatOwner(p, 'user-a')
    const task1 = beginChat(p, 'listing-1') as ChatTask
    const task2 = beginChat(p, 'listing-2') as ChatTask

    releaseChat(p, task1)
    expect(stillCurrent(p, task2)).toBe(true)
  })
})

describe('match 页子页返回重拉', () => {
  test('首次 show 让渡给登录态 effect（不双发）', () => {
    expect(shouldReloadOnShow({ firstShow: true, authed: true, userId: 'user-a' })).toBe(false)
  })

  test('非首次 show 且身份有效时重拉', () => {
    expect(shouldReloadOnShow({ firstShow: false, authed: true, userId: 'user-a' })).toBe(true)
  })

  test('退出登录后返回不发受限请求', () => {
    expect(shouldReloadOnShow({ firstShow: false, authed: false, userId: null })).toBe(false)
  })

  test('身份未就绪（authed 但无 userId）时返回也不发', () => {
    expect(shouldReloadOnShow({ firstShow: false, authed: true, userId: null })).toBe(false)
  })
})
