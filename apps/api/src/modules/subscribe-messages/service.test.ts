import { describe, expect, test } from 'bun:test'
import type { SubscribeMessageGrantReport } from '@fish/contracts/subscribe-messages/schema'
import { createSubscribeMessageService, resolveCapability, SubscribeMessageError } from './service'
import type { SubscribeMessageStore, SubscribeRemaining } from './store'

/**
 * 授权记账（#462）的业务口径：只认 `accept`、未开通时 503、始终返回当前剩余次数。
 *
 * 用假 store 而不是真库：这里要钉的是"哪些上报该被记账"，SQL 层的封顶与并发在
 * `store.test.ts`（真库用例）里。
 */

const NO_TEMPLATES = { chat: null, tx: null, review: null }
const ALL_TEMPLATES = { chat: 'tmpl_chat', tx: 'tmpl_tx', review: 'tmpl_review' }

function fakeStore(initial: Partial<SubscribeRemaining> = {}) {
  const remaining: SubscribeRemaining = { CHAT: 0, TX: 0, REVIEW: 0, ...initial }
  const calls: { userId: string; kinds: string[]; limit: number }[] = []
  const store: SubscribeMessageStore = {
    async readRemaining() {
      return { ...remaining }
    },
    async addAcceptedGrants(userId, kinds, limit) {
      calls.push({ userId, kinds: [...kinds], limit })
    },
    // 下面这些本域用例用不到：给了就抛，避免"测的是别的方法"。
    async insertDeliveries() {
      throw new Error('不该被调用')
    },
    async insertChatDeliveries() {
      throw new Error('不该被调用')
    },
    async listNotificationSources() {
      throw new Error('不该被调用')
    },
    async findListingTitles() {
      throw new Error('不该被调用')
    },
    async findTransactionListingTitles() {
      throw new Error('不该被调用')
    },
    async listChatSources() {
      throw new Error('不该被调用')
    },
    async listPendingDeliveryIds() {
      throw new Error('不该被调用')
    },
    async attemptDelivery() {
      throw new Error('不该被调用')
    },
    async abandonStaleSending() {
      throw new Error('不该被调用')
    },
    async findOpenid() {
      throw new Error('不该被调用')
    },
  }
  return { store, calls }
}

const report = (...grants: SubscribeMessageGrantReport['grants']): SubscribeMessageGrantReport => ({
  grants,
})

describe('resolveCapability', () => {
  test('WECHAT_TRANSPORT 不是 live 时整个能力关闭（没令牌就发不出去）', () => {
    for (const transport of ['off', 'stub'] as const) {
      const capability = resolveCapability({ transport, templates: ALL_TEMPLATES })
      expect(capability.enabled).toBe(false)
      // 模板 ID 即使配了也不下发：端上不该为一个发不出去的 kind 弹授权
      expect(capability.templateIds).toEqual({ CHAT: null, TX: null, REVIEW: null })
    }
  })

  test('live 但一个模板都没配：能力关闭，三个 kind 都是 null', () => {
    const capability = resolveCapability({ transport: 'live', templates: NO_TEMPLATES })
    expect(capability.enabled).toBe(false)
    expect(capability.templateIds).toEqual({ CHAT: null, TX: null, REVIEW: null })
  })

  test('live + 部分模板：只有配了的 kind 下发，能力即开启', () => {
    const capability = resolveCapability({
      transport: 'live',
      templates: { chat: 'tmpl_chat', tx: null, review: 'tmpl_review' },
    })
    expect(capability.enabled).toBe(true)
    expect(capability.templateIds).toEqual({
      CHAT: 'tmpl_chat',
      TX: null,
      REVIEW: 'tmpl_review',
    })
  })
})

describe('reportGrants', () => {
  test('能力关闭 → 503 SUBSCRIBE_MESSAGES_DISABLED，且不写任何记账', async () => {
    const { store, calls } = fakeStore()
    const service = createSubscribeMessageService({
      store,
      capability: resolveCapability({ transport: 'live', templates: NO_TEMPLATES }),
    })

    await expect(
      service.reportGrants('u1', report({ kind: 'CHAT', status: 'accept' })),
    ).rejects.toBeInstanceOf(SubscribeMessageError)
    expect(calls).toHaveLength(0)
  })

  test('只认 accept：reject / ban / filter 一次都不加', async () => {
    const { store, calls } = fakeStore()
    const service = createSubscribeMessageService({
      store,
      capability: resolveCapability({ transport: 'live', templates: ALL_TEMPLATES }),
    })

    const result = await service.reportGrants(
      'u1',
      report(
        { kind: 'CHAT', status: 'reject' },
        { kind: 'TX', status: 'ban' },
        { kind: 'REVIEW', status: 'filter' },
      ),
    )

    expect(calls).toHaveLength(0)
    // 仍然返回当前剩余次数（端上要靠它显示额度）
    expect(result.remaining).toEqual({ CHAT: 0, TX: 0, REVIEW: 0 })
  })

  test('多个 accept 一次记账，上限由 store 的 SQL 保证（这里只传契约常量）', async () => {
    const { store, calls } = fakeStore({ CHAT: 3 })
    const service = createSubscribeMessageService({
      store,
      capability: resolveCapability({ transport: 'live', templates: ALL_TEMPLATES }),
    })

    const result = await service.reportGrants(
      'u1',
      report(
        { kind: 'CHAT', status: 'accept' },
        { kind: 'TX', status: 'reject' },
        {
          kind: 'REVIEW',
          status: 'accept',
        },
      ),
    )

    expect(calls).toEqual([{ userId: 'u1', kinds: ['CHAT', 'REVIEW'], limit: 50 }])
    expect(result.remaining).toEqual({ CHAT: 3, TX: 0, REVIEW: 0 })
  })

  test('同一个 kind 重复上报按最后一次算（端上原样摊平上报，不该记两次）', async () => {
    const { store, calls } = fakeStore()
    const service = createSubscribeMessageService({
      store,
      capability: resolveCapability({ transport: 'live', templates: ALL_TEMPLATES }),
    })

    await service.reportGrants(
      'u1',
      report({ kind: 'CHAT', status: 'accept' }, { kind: 'CHAT', status: 'reject' }),
    )

    // 契约注释：重复键只可能是端上 bug，按最后一次算 —— 最后一次是 reject，不加
    expect(calls).toHaveLength(0)
  })

  test('未配置模板的 kind 即使上报 accept 也不记（端上旧缓存的产物）', async () => {
    const { store, calls } = fakeStore()
    const service = createSubscribeMessageService({
      store,
      capability: resolveCapability({
        transport: 'live',
        templates: { chat: null, tx: 'tmpl_tx', review: null },
      }),
    })

    await service.reportGrants(
      'u1',
      report({ kind: 'CHAT', status: 'accept' }, { kind: 'TX', status: 'accept' }),
    )

    expect(calls).toEqual([{ userId: 'u1', kinds: ['TX'], limit: 50 }])
  })
})

describe('config', () => {
  test('原样下发三个 kind 的模板 ID（含 null）', () => {
    const { store } = fakeStore()
    const service = createSubscribeMessageService({
      store,
      capability: resolveCapability({
        transport: 'live',
        templates: { chat: 'tmpl_chat', tx: null, review: 'tmpl_review' },
      }),
    })

    expect(service.config()).toEqual({
      templates: { CHAT: 'tmpl_chat', TX: null, REVIEW: 'tmpl_review' },
    })
  })
})
