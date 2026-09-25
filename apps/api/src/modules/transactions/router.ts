import { errorBody, validationDetails } from '@fish/contracts/system/error'
import {
  meetupTokenRedeemInputSchema,
  meetupTokenVerifyCodeInputSchema,
  transactionAcceptInputSchema,
  transactionListQuerySchema,
  transactionProposalInputSchema,
  transactionRejectInputSchema,
} from '@fish/contracts/transactions/schema'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { isTransactionId, type TransactionService, TransactionServiceError } from './service'

export type TransactionsRouterOptions = {
  service: TransactionService
  /** 交易没有匿名路径（一切操作都以参与者身份为前提），整条路由挂 requireAuth。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：提案 / 接受 / 拒绝前检查封禁（交易推进属 `write` 作用域）。 */
  guard: RestrictionGuard
}

/** 畸形 :id 不进 store（uuid 列会 500）：与 listings 的 router 级 id 校验同一惯例。 */
function txNotFound(c: Context) {
  return c.json(errorBody('TRANSACTION_NOT_FOUND', '交易不存在'), 404)
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof TransactionServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/**
 * 挂载点是 /transactions（app.ts），router 内部用 /；路径常量见契约
 * TRANSACTION_ROUTES（响应体与状态码的口径也在那里冻结）。
 */
export function createTransactionsRouter({
  service,
  requireAuth,
  guard,
}: TransactionsRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post('/proposals', requireAuth, guard.write, async (c) => {
    const parsed = transactionProposalInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.propose(c.get('userId'), parsed.data), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/proposals/reject', requireAuth, guard.write, async (c) => {
    const parsed = transactionRejectInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.reject(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.get('/', requireAuth, async (c) => {
    const parsed = transactionListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.listTransactions(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 注意顺序：/proposals、/proposals/reject 已在上面注册，:id 不会吞掉它们；
  // 但 :id 段必须放在它们之后（Hono 按注册顺序匹配）。
  app.get('/:id', requireAuth, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    try {
      return c.json(await service.getTransaction(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 卖家接受并创建交易（唯一建行端点）。
  app.post('/', requireAuth, guard.write, async (c) => {
    const parsed = transactionAcceptInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.accept(c.get('userId'), parsed.data), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/:id/confirm', requireAuth, guard.write, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    try {
      return c.json(await service.confirm(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/:id/cancel', requireAuth, guard.write, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    try {
      return c.json(await service.cancel(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // ---- 面交交易码（#70；路径常量与响应口径冻结在 TRANSACTION_ROUTES / contracts）----

  // 卖家取本单面交码（201；#175 幂等：重复调用返回同一枚；明文码与 qrPayload 只在此响应出现）。
  app.post('/:id/meetup-token', requireAuth, guard.write, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    try {
      return c.json(await service.issueMeetupToken(c.get('userId'), c.req.param('id')), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 当前凭证状态（无明文）。
  app.get('/:id/meetup-token', requireAuth, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    try {
      return c.json(await service.getMeetupTokenStatus(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 买家核销二维码（200 MeetupVerificationResponse；nextAction 驱动 confirm）。
  app.post('/:id/meetup-token/redeem', requireAuth, guard.write, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    const parsed = meetupTokenRedeemInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        await service.redeemMeetupToken(c.get('userId'), c.req.param('id'), parsed.data),
        200,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 买家核销 6 位手动码。
  app.post('/:id/meetup-token/verify-code', requireAuth, guard.write, async (c) => {
    if (!isTransactionId(c.req.param('id'))) return txNotFound(c)
    const parsed = meetupTokenVerifyCodeInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        await service.verifyMeetupCode(c.get('userId'), c.req.param('id'), parsed.data),
        200,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return app
}
