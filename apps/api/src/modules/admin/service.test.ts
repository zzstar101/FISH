import { expect, test } from 'bun:test'
import type { MediaStorage } from '../uploads/storage'
import { AdminError } from './errors'
import { createAdminService } from './service'
import type { AdminStore } from './store'

// #286 复审：图片结算拒绝人工决策时，store 会返回 `media-*` 结果码，service 必须把它翻译成可解释的
// 409（而不是让管理员看到 500）。这里只测「结果码 → AdminError」这一段映射；store 侧的翻译
// （`ModerationSettlementError` → 结果码）由 `store.test.ts` 打真库覆盖。
function serviceWith(result: Awaited<ReturnType<AdminStore['decideModeration']>>) {
  const store = { decideModeration: async () => result } as unknown as AdminStore
  return createAdminService({ store, storage: {} as MediaStorage })
}

function input() {
  return {
    recordId: '00000000-0000-7000-8000-000000000000',
    actorUserId: '00000000-0000-7000-8000-000000000001',
    decision: 'ALLOW' as const,
    reason: '人工复核',
    requestId: 'admin-service-test-1',
  }
}

test('图已被人工阻断 → 409 且提示"不能放行"', async () => {
  const error = await serviceWith('media-blocked')
    .decideModeration(input())
    .catch((thrown: unknown) => thrown)

  expect(error).toBeInstanceOf(AdminError)
  expect(error).toMatchObject({
    status: 409,
    code: 'MODERATION_CONFLICT',
    message: '该商品的图片已被人工阻断，不能放行',
  })
})

test('结算过程失败 → 409 且提示可重试', async () => {
  const error = await serviceWith('media-settlement-failed')
    .decideModeration(input())
    .catch((thrown: unknown) => thrown)

  expect(error).toMatchObject({
    status: 409,
    code: 'MODERATION_CONFLICT',
    message: '图片结算失败，本次决策未生效，请重试',
  })
})

test('台账行 / 对象缺失 → 409 且提示人工核查（与可重试的失败区分）', async () => {
  const error = await serviceWith('media-settlement-data-missing')
    .decideModeration(input())
    .catch((thrown: unknown) => thrown)

  expect(error).toMatchObject({
    status: 409,
    code: 'MODERATION_CONFLICT',
    message: '该商品的审核图片台账或对象缺失，无法放行，请人工核查',
  })
})
