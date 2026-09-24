import { describe, expect, test } from 'bun:test'
import { canLoad, isLatestLoad, ownerChanged, shouldReloadOnShow } from '../src/pages/match/view'

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
