import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import {
  LISTING_REPORT_REASONS,
  ReportReasonSchema,
  USER_REPORT_REASONS,
} from '@fish/contracts/reports/schema'

/**
 * 用户端举报链路的取数行为（#73 治理半场，小程序接线）。
 *
 * 锁住四件接接口时最容易做错、错了会被用户当成事实的事：
 * 1. **重复举报不是失败**：服务端对「同一举报人 + 同一目标 + 已有未决单」返回 200 +
 *    `created: false` 与**已存在的那条**。客户端若按状态码或异常把它当失败，用户会反复
 *    重试，而单子一直好好躺着（契约 `ReportCreateResponseSchema` 的注释就是这么写的）。
 * 2. **原因子集按对象类型收敛**：`ReportCreateInputSchema` 的 `superRefine` 会拒掉跨子集
 *    组合（422）。所以前端选项必须从契约的 `LISTING_REPORT_REASONS` /
 *    `USER_REPORT_REASONS` 取，不能在本地复制一份 —— 复制的那份一漂移，就是给用户一堆
 *    服务端必拒的选项。
 * 3. **空补充说明不带键**：契约是 `trim().min(1).max(200).optional()`，传空串会被服务端
 *    以 422 拒掉（「填了但等于没填」比「没填」更糟）。
 * 4. **响应用契约 schema 收口**：形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * 替换 `@/lib/request` 的 `apiRequest`（与 `@tarojs/taro` 的原因面板）后**动态 import**
 * 被测模块，与 `wishes-api.test.ts` 同一手法；被测入口是 `features/report/*` 本身，
 * 不经过页面，所以不需要渲染 React。
 */

/** 契约错误信封在客户端侧的形状（`@/lib/request` 的 `isApiError` 按 name+code+status 认） */
class FakeApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type ApiCall = { path: string; method?: string; body?: unknown }

/** 契约里几个必须合法的 id（`ReportCreateInputSchema.targetId` 是 `z.uuid()`） */
const LISTING_ID = '11111111-1111-4111-8111-111111111111'
const REPORT_ID = '99999999-9999-4999-8999-999999999999'

const calls: ApiCall[] = []
/** 假后端要返回什么；默认给一条能过契约解析的 201 结果 */
let respondImpl: (call: ApiCall) => Promise<unknown> = () => Promise.resolve(null)

mock.module('@/lib/request', () => ({
  isApiError: (error: unknown) => error instanceof FakeApiError,
  isUnauthenticatedError: (error: unknown) =>
    error instanceof FakeApiError && error.status === 401 && error.code === 'UNAUTHENTICATED',
  ApiError: FakeApiError,
  apiRequest: (
    path: string,
    options: { method?: string; query?: Record<string, unknown>; body?: unknown } = {},
  ) => {
    const call: ApiCall = { path, method: options.method, body: options.body }
    calls.push(call)
    return respondImpl(call)
  },
}))

/** 原因面板的替身：默认选中第 0 项；`null` = 用户取消 / 面板没出来 */
let actionSheetImpl: (list: string[]) => Promise<{ tapIndex: number }> = () =>
  Promise.resolve({ tapIndex: 0 })
mock.module('@tarojs/taro', () => ({
  default: {
    showActionSheet: (options: { itemList: string[] }) => actionSheetImpl(options.itemList),
  },
}))

const { submitReport } = await import('../src/features/report/api')
const { REPORT_REASON_LABELS, pickReportReason, reportFailureMessage, reportReasonOptions } =
  await import('../src/features/report/reasons')

/** 一条能过 `ReportCreateResponseSchema.parse` 的返回（`createdAt` 必须是合法 ISO 串） */
function createResponse(created: boolean, reason = 'MISLEADING') {
  return {
    report: {
      id: REPORT_ID,
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason,
      detailText: null,
      status: 'PENDING',
      createdAt: '2026-10-01T12:00:00.000Z',
      handledAt: null,
    },
    created,
  }
}

beforeEach(() => {
  calls.length = 0
  respondImpl = () => Promise.resolve(createResponse(true))
  actionSheetImpl = () => Promise.resolve({ tapIndex: 0 })
})

describe('submitReport —— 请求构造', () => {
  test('POST 到契约的 `/reports`，body 只带四个键', async () => {
    await submitReport({ targetType: 'LISTING', targetId: LISTING_ID, reason: 'MISLEADING' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(REPORT_ROUTES.create)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
    })
  })

  test('detailText 填了空白字符 → 整个键不带（空串会被服务端 trim().min(1) 拒掉）', async () => {
    await submitReport({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
      detailText: '   ',
    })

    expect(calls[0]?.body).not.toHaveProperty('detailText')
  })

  test('detailText 有内容 → 去掉首尾空白再发', async () => {
    await submitReport({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
      detailText: '  描述与实物不符  ',
    })

    expect(calls[0]?.body).toEqual({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
      detailText: '描述与实物不符',
    })
  })
})

describe('submitReport —— 受理结果', () => {
  test('重复举报（created:false）正常 resolve，不当失败', async () => {
    respondImpl = () => Promise.resolve(createResponse(false))

    const response = await submitReport({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
    })

    expect(response.created).toBe(false)
    expect(response.report.id).toBe(REPORT_ID)
  })

  test('响应用契约 schema 收口：少了 createdAt 就地抛，不把坏数据交回页面', async () => {
    respondImpl = () =>
      Promise.resolve({
        report: {
          id: REPORT_ID,
          targetType: 'LISTING',
          targetId: LISTING_ID,
          reason: 'MISLEADING',
          detailText: null,
          status: 'PENDING',
          handledAt: null,
        },
        created: true,
      })

    await expect(
      submitReport({ targetType: 'LISTING', targetId: LISTING_ID, reason: 'MISLEADING' }),
    ).rejects.toThrow()
  })

  test('接口失败原样抛出，不退回任何演示数据（举报没有 mock 回退）', async () => {
    respondImpl = () => Promise.reject(new FakeApiError(422, 'REPORT_SELF_TARGET', '不能举报自己'))

    await expect(
      submitReport({ targetType: 'LISTING', targetId: LISTING_ID, reason: 'MISLEADING' }),
    ).rejects.toMatchObject({ code: 'REPORT_SELF_TARGET', status: 422 })
  })
})

describe('举报原因 —— 子集按对象类型收敛', () => {
  test('LISTING 选项正好等于契约子集（不含骚扰 / 冒充 / 滥用）', () => {
    const reasons = reportReasonOptions('LISTING').map((item) => item.reason)

    expect(reasons).toEqual([...LISTING_REPORT_REASONS])
    expect(reasons).not.toContain('HARASSMENT')
    expect(reasons).not.toContain('IMPERSONATION')
    expect(reasons).not.toContain('ABUSE')
  })

  test('USER 选项正好等于契约子集（不含信息不实 / 违规商品 / 垃圾信息）', () => {
    const reasons = reportReasonOptions('USER').map((item) => item.reason)

    expect(reasons).toEqual([...USER_REPORT_REASONS])
    expect(reasons).not.toContain('MISLEADING')
    expect(reasons).not.toContain('PROHIBITED')
    expect(reasons).not.toContain('SPAM')
  })

  test('每个选项都带非空文案（空串会让面板出现一行空白）', () => {
    for (const item of [...reportReasonOptions('LISTING'), ...reportReasonOptions('USER')]) {
      expect(item.label.length).toBeGreaterThan(0)
    }
  })

  test('文案表覆盖契约枚举的每一个值，且不多不少', () => {
    const enumKeys = ReportReasonSchema.options.map(String)
    // 漏键 => 面板该行渲染 undefined；多键 => 契约删了值而文案表留着死条目
    expect(Object.keys(REPORT_REASON_LABELS).sort()).toEqual([...enumKeys].sort())
  })
})

describe('pickReportReason —— 原生面板回映', () => {
  test('tapIndex 映射到对应原因', async () => {
    actionSheetImpl = (list) => Promise.resolve({ tapIndex: list.length - 1 })

    await expect(pickReportReason('LISTING')).resolves.toBe('OTHER')
  })

  test('结果按 targetType 收敛：同一个 tapIndex 在两类对象上含义不同', async () => {
    actionSheetImpl = () => Promise.resolve({ tapIndex: 0 })

    await expect(pickReportReason('LISTING')).resolves.toBe('MISLEADING')
    await expect(pickReportReason('USER')).resolves.toBe('HARASSMENT')
  })

  test('用户取消（面板 reject）→ null，不开浮层', async () => {
    actionSheetImpl = () => Promise.reject(new Error('cancel'))

    await expect(pickReportReason('LISTING')).resolves.toBeNull()
  })

  test('面板 index 越界（理论上不来）→ null 而不是 undefined', async () => {
    actionSheetImpl = () => Promise.resolve({ tapIndex: 99 })

    await expect(pickReportReason('LISTING')).resolves.toBeNull()
  })
})

describe('reportFailureMessage —— 失败文案', () => {
  test('举报自己 → 明确拒绝理由，不是笼统失败', () => {
    expect(reportFailureMessage(new FakeApiError(422, 'REPORT_SELF_TARGET', '不能举报自己'))).toBe(
      '不能举报自己',
    )
  })

  test('目标不存在 / 已删除 → 说明对象怎么了', () => {
    expect(
      reportFailureMessage(new FakeApiError(404, 'REPORT_TARGET_NOT_FOUND', '举报目标不存在')),
    ).toBe('举报对象不存在或已删除')
  })

  test('未登录 → 引导登录，不说「失败」', () => {
    expect(reportFailureMessage(new FakeApiError(401, 'UNAUTHENTICATED', '未登录'))).toBe(
      '请先登录后再举报',
    )
  })

  test('其它 422 → 用服务端文案兜底', () => {
    expect(
      reportFailureMessage(new FakeApiError(422, 'VALIDATION_FAILED', '请求参数校验失败')),
    ).toBe('请求参数校验失败')
  })

  test('非 ApiError（断网等）→ 统一兜底文案', () => {
    expect(reportFailureMessage(new Error('network down'))).toBe('举报提交失败，请重试')
  })
})
