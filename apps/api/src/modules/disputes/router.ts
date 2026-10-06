import {
  DisputeAttachmentConfirmRequestSchema,
  DisputeAttachmentPresignRequestSchema,
  DisputeCreateInputSchema,
  DisputeEvidenceInputSchema,
  DisputeMineQuerySchema,
} from '@fish/contracts/disputes/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { decodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { RestrictionGuard } from '../governance/guard'
import type { DisputeService } from './service'
import { DisputeServiceError } from './service'

type DisputesVariables = { userId: string }
type DisputesContext = Context<{ Variables: DisputesVariables }>

/**
 * Disputes 路由（#465）：只做「解析 + 校验 + 调 service + 映射错误」，业务判断全在 service。
 *
 * 管理端的三条路径不在这里，在 `apps/api/src/modules/admin/router.ts`（`/admin/disputes*`，
 * 与其它管理端点共用 `requireAdmin` 守卫），共享同一个 `DisputeService` 实例。
 */
export type DisputesRouterOptions = {
  service: DisputeService
  /** 写接口先过治理守卫（封禁用户不能发起争议 / 传附件），读接口不挂。 */
  guard: RestrictionGuard
  /** 已登录用户 id（由挂载点的 requireAuth 保证存在）。 */
  getUserId: (context: DisputesContext) => string
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function fail(error: unknown, c: Context): Response | undefined {
  if (error instanceof DisputeServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  return undefined
}

/**
 * 路径里的争议 id 必须是规范 `dsp_` 公开 ID；否则与"不存在"同码 404。
 * 用同一句话、同一状态码，避免外人用错误码枚举争议是否存在。
 */
function requireDisputeId(c: Context): string {
  const raw = c.req.param('disputeId')
  if (!raw || !isPublicId(PUBLIC_ID_PREFIX.dispute, raw)) {
    throw new DisputeServiceError('DISPUTE_NOT_FOUND', 404, '争议不存在')
  }
  return decodePublicId(PUBLIC_ID_PREFIX.dispute, raw)
}

function validationFailure(
  c: Context,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(issues)), 422)
}

export function createDisputesRouter(options: DisputesRouterOptions) {
  const { service } = options
  const router = new Hono<{ Variables: DisputesVariables }>()

  router.post('/', options.guard.write, async (c) => {
    const parsed = DisputeCreateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return validationFailure(c, parsed.error.issues)

    try {
      const response = await service.createDispute(options.getUserId(c), {
        // 公开 ID → 裸 UUID 的边界：契约已保证前缀正确，这里只做解码。
        transactionId: decodePublicId(PUBLIC_ID_PREFIX.transaction, parsed.data.transactionId),
        type: parsed.data.type,
        detailText: parsed.data.detailText ?? null,
      })
      // 重复提交同一方向同一交易返回 200 + `created: false`（不是 409）：超时重试对客户端无感。
      return c.json(response, response.created ? 201 : 200)
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  // `mine` 必须注册在 `/:disputeId` 之前：否则会被当成 `dsp_` id 解析而 404。
  router.get('/mine', async (c) => {
    const parsed = DisputeMineQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return validationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listMine(options.getUserId(c), parsed.data), 200)
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  router.get('/:disputeId', async (c) => {
    try {
      return c.json(await service.getDispute(options.getUserId(c), requireDisputeId(c)), 200)
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  router.post('/:disputeId/withdraw', options.guard.write, async (c) => {
    try {
      return c.json(await service.withdrawDispute(options.getUserId(c), requireDisputeId(c)), 200)
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  router.post('/:disputeId/attachments/presign', options.guard.write, async (c) => {
    const parsed = DisputeAttachmentPresignRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return validationFailure(c, parsed.error.issues)

    try {
      return c.json(
        await service.presignAttachment(options.getUserId(c), requireDisputeId(c), parsed.data),
        200,
      )
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  router.post('/:disputeId/attachments', options.guard.write, async (c) => {
    const parsed = DisputeAttachmentConfirmRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return validationFailure(c, parsed.error.issues)

    try {
      const response = await service.confirmAttachment(
        options.getUserId(c),
        requireDisputeId(c),
        parsed.data,
      )
      return c.json(response, response.created ? 201 : 200)
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  router.post('/:disputeId/evidence-messages', options.guard.write, async (c) => {
    const parsed = DisputeEvidenceInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return validationFailure(c, parsed.error.issues)

    try {
      const response = await service.addEvidence(options.getUserId(c), requireDisputeId(c), {
        // 同 createDispute：公开 ID 在协议层解码，service 只认裸 UUID。
        messageId: decodePublicId(PUBLIC_ID_PREFIX.message, parsed.data.messageId),
      })
      return c.json(response, response.created ? 201 : 200)
    } catch (error) {
      return fail(error, c) ?? Promise.reject(error)
    }
  })

  return router
}

export type DisputesRouter = ReturnType<typeof createDisputesRouter>
