import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  isLatestPageLoad,
  mergeEarlierMessages,
  mergeRefreshedMessages,
  resolveConvState,
  resolveMsgState,
} from '../src/pkg-social/pages/conversation/view'

/**
 * 会话页竞态的回归（#186 审查要求：修复前必须失败、修复后必须通过）。
 *
 * - P2-1：silent 后台刷新落地时无条件 `setMessages(page.items)`，把刷新期间发送
 *   成功的消息抹掉；
 * - P2-2：旧分页任务的 `.finally(() => setLoadingEarlier(false))` 无条件还锁，
 *   会把新账号在途分页的锁放掉。
 *
 * #608（返回本页改后台刷新）之后新增的三条，都是「silent 期间落地的判据」：
 * - 第 1 条：silent 拉到的 `missing` 是服务端权威结论（404），不能当成「没读到」保留旧态，
 *   否则已被删除的会话在屏幕上一直可用；
 * - 第 3 条：首屏请求在途时再起一次 silent 刷新，首屏响应被判过期，silent 又失败 ——
 *   消息区不能停在 `loading`（那个分支没有重试入口）；
 * - 第 4 条：分页与 silent 刷新共用同一代次，刷新把游标重置回首屏时同一页会被再取一次，
 *   分页的追加必须按 id 去重。
 *
 * 边界：本文件只跑判据与状态机，不跑组件接线（`load` 里怎么取 `baseIds`、
 * `loadEarlier` 是否真的调了守卫）—— 那部分按端上时序在微信开发者工具里验收。
 */

const msg = (id: string, createdAt: string): MessageDto => ({
  id,
  conversationId: 'c-1',
  senderId: 'u-1',
  sender: { id: 'u-1', nickname: '我', avatarUrl: null },
  type: 'TEXT',
  content: id,
  createdAt,
})

const ids = (items: MessageDto[]) => items.map((item) => item.id)

describe('mergeRefreshedMessages —— silent 刷新不得覆盖刷新期间确认的消息（P2-1）', () => {
  test('刷新发起后发送成功的消息必须留下（修复前这里只剩 m1）', () => {
    // 刷新发起时消息流里只有 m1；m2 是刷新在途期间才被服务端确认落地的
    const baseIds = new Set(['m1'])
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z'), msg('m2', '2026-09-24T00:01:00.000Z')]
    // 快照取自发送之前，看不到 m2
    const incoming = [msg('m1', '2026-09-24T00:00:00.000Z')]

    expect(ids(mergeRefreshedMessages(previous, incoming, baseIds))).toEqual(['m1', 'm2'])
  })

  test('刷新期间对方发来的消息照样从快照进来，且按时间排在后面', () => {
    const baseIds = new Set(['m1'])
    const previous = [
      msg('m1', '2026-09-24T00:00:00.000Z'),
      msg('mine', '2026-09-24T00:01:00.000Z'),
    ]
    const incoming = [
      msg('m1', '2026-09-24T00:00:00.000Z'),
      msg('theirs', '2026-09-24T00:02:00.000Z'),
    ]

    expect(ids(mergeRefreshedMessages(previous, incoming, baseIds))).toEqual([
      'm1',
      'mine',
      'theirs',
    ])
  })

  test('同一条既在快照里又在本地流里时不重复（按 id 去重）', () => {
    const baseIds = new Set<string>()
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z')]
    const incoming = [msg('m1', '2026-09-24T00:00:00.000Z')]

    expect(ids(mergeRefreshedMessages(previous, incoming, baseIds))).toEqual(['m1'])
  })

  test('刷新发起时就已在流里、但快照里没有的，以服务端为准丢弃', () => {
    const baseIds = new Set(['m1', 'gone'])
    const previous = [
      msg('m1', '2026-09-24T00:00:00.000Z'),
      msg('gone', '2026-09-24T00:00:30.000Z'),
    ]
    const incoming = [msg('m1', '2026-09-24T00:00:00.000Z')]

    expect(ids(mergeRefreshedMessages(previous, incoming, baseIds))).toEqual(['m1'])
  })

  test('空快照不会清空刷新期间确认的消息', () => {
    const baseIds = new Set(['m1'])
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z'), msg('m2', '2026-09-24T00:01:00.000Z')]

    expect(ids(mergeRefreshedMessages(previous, [], baseIds))).toEqual(['m2'])
  })
})

describe('mergeEarlierMessages —— 分页追加按 id 去重（#608 审查第 4 条）', () => {
  test('刷新把游标重置回首屏后再翻一次同一页，不产生重复气泡', () => {
    // loadEarlier 先落地（游标推到更早一页）→ silent 刷新随后把 nextCursor 写回首屏游标
    // → 用户再翻，取回的正是刚落过的那一页
    const previous = [msg('m2', '2026-09-24T00:01:00.000Z'), msg('m3', '2026-09-24T00:02:00.000Z')]
    const incoming = [msg('m1', '2026-09-24T00:00:00.000Z'), msg('m2', '2026-09-24T00:01:00.000Z')]

    expect(ids(mergeEarlierMessages(previous, incoming))).toEqual(['m1', 'm2', 'm3'])
  })

  test('全新一页照常拼在已有消息之前，并按 (createdAt, id) 定序', () => {
    const previous = [msg('m3', '2026-09-24T00:02:00.000Z')]
    const incoming = [msg('m1', '2026-09-24T00:00:00.000Z'), msg('m2', '2026-09-24T00:01:00.000Z')]

    expect(ids(mergeEarlierMessages(previous, incoming))).toEqual(['m1', 'm2', 'm3'])
  })

  test('同一条重复出现时只留一份', () => {
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z')]
    const incoming = [msg('m1', '2026-09-24T00:00:00.000Z')]

    expect(ids(mergeEarlierMessages(previous, incoming))).toEqual(['m1'])
  })
})

describe('resolveConvState —— silent 拉到的 missing 是权威结论（#608 审查第 1 条）', () => {
  test('后台刷新拉到 missing 必须如实降级：会话已删不能再显示旧内容', () => {
    expect(resolveConvState('ok', 'missing', true)).toBe('missing')
  })

  test('后台刷新拉到 failed 仍不降级（弱网补刷新失败不能盖掉屏幕上的内容）', () => {
    expect(resolveConvState('ok', 'failed', true)).toBe('ok')
  })

  test('还没正常显示过时 silent 也如实落地（不能停在没有重试入口的态）', () => {
    expect(resolveConvState('loading', 'failed', true)).toBe('failed')
    expect(resolveConvState('failed', 'missing', true)).toBe('missing')
  })

  test('非 silent 一切如实落地', () => {
    expect(resolveConvState('ok', 'missing', false)).toBe('missing')
    expect(resolveConvState('ok', 'failed', false)).toBe('failed')
    expect(resolveConvState('ok', 'ok', false)).toBe('ok')
  })
})

describe('resolveMsgState —— silent 失败不得把消息区留在 loading（#608 审查第 3 条）', () => {
  test('首屏请求在途时被 silent 刷新判过期，随后失败 → 必须落 failed 给重试', () => {
    expect(resolveMsgState('loading', true, true)).toBe('failed')
  })

  test('屏幕上已有消息时 silent 失败保持 ok（不换成错误卡）', () => {
    expect(resolveMsgState('ok', true, true)).toBe('ok')
  })

  test('silent 成功照常写 ok（首屏在途也一样）', () => {
    expect(resolveMsgState('loading', false, true)).toBe('ok')
  })

  test('非 silent 一律如实落地', () => {
    expect(resolveMsgState('ok', true, false)).toBe('failed')
    expect(resolveMsgState('loading', false, false)).toBe('ok')
  })
})

describe('isLatestPageLoad —— 旧分页任务不得释放新账号的分页锁（P2-2）', () => {
  test('代次相等才落定', () => {
    expect(isLatestPageLoad(3, 3)).toBe(true)
    expect(isLatestPageLoad(3, 4)).toBe(false)
  })

  test('A 账号在途分页落定时不释放 B 账号刚拿起的锁', () => {
    // 页面级模型：epoch 是加载代次，loading 是「更早一页」这把锁
    const page = { epoch: 0, loading: false }

    // A 发起分页，拿到 ticket 1 并持锁
    page.epoch += 1
    const ticketA = page.epoch
    page.loading = true

    // 换账号：身份清场把锁收回（页面渲染期的 setLoadingEarlier(false)），epoch 前进
    page.epoch += 1
    page.loading = false

    // B 发起分页，拿到 ticket 2 并持锁
    page.epoch += 1
    const ticketB = page.epoch
    page.loading = true

    // A 迟到落定：守卫必须挡住，不能把 B 的锁放掉
    if (isLatestPageLoad(ticketA, page.epoch)) page.loading = false
    expect(page.loading).toBe(true)

    // B 正常落定才还锁
    if (isLatestPageLoad(ticketB, page.epoch)) page.loading = false
    expect(page.loading).toBe(false)
  })

  test('整页重拉判过期后主动还锁，不会永久锁死分页', () => {
    const page = { epoch: 0, loading: false }

    page.epoch += 1
    const ticket = page.epoch
    page.loading = true

    // 整页重拉：epoch 前进，并在 `load` 里主动 setLoadingEarlier(false)
    page.epoch += 1
    page.loading = false

    // 旧分页迟到落定被守卫挡住（它自己不会还锁），锁由重拉方收回 —— 仍可再次分页
    if (isLatestPageLoad(ticket, page.epoch)) page.loading = false
    expect(page.loading).toBe(false)
  })
})
