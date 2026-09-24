import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  isLatestPageLoad,
  mergePushedMessage,
  mergeRefreshedMessages,
} from '../src/pages/conversation/view'

/**
 * 会话页两处竞态的回归（#186 审查要求：修复前必须失败、修复后必须通过）。
 *
 * - P2-1：silent 后台刷新落地时无条件 `setMessages(page.items)`，把刷新期间发送
 *   成功的消息抹掉；
 * - P2-2：旧分页任务的 `.finally(() => setLoadingEarlier(false))` 无条件还锁，
 *   会把新账号在途分页的锁放掉。
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

describe('mergePushedMessage —— 实时推送按服务端 id 去重（#67 第三步）', () => {
  test('推送顺序与服务端落库顺序不一致时按 (createdAt, id) 排回去', () => {
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z')]
    // 后到的推送 createdAt 更早（两个连接 / 乱序到达）
    const pushed = msg('m0', '2026-09-23T23:59:00.000Z')

    expect(ids(mergePushedMessage(previous, pushed))).toEqual(['m0', 'm1'])
  })

  test('同一条消息被推第二次时不产生重复气泡（发送响应 + 推送）', () => {
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z')]

    expect(ids(mergePushedMessage(previous, msg('m1', '2026-09-24T00:00:00.000Z')))).toEqual(['m1'])
  })

  test('重复时返回原数组本身，避免同一条推送让消息流白重渲染', () => {
    const previous = [msg('m1', '2026-09-24T00:00:00.000Z')]

    expect(mergePushedMessage(previous, msg('m1', '2026-09-24T00:00:00.000Z'))).toBe(previous)
  })
})
