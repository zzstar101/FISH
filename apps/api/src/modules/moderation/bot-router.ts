import type { AdminModerationQueueItem } from '@fish/contracts/admin/schema'
import {
  ModerationBotDecisionInputSchema,
  ModerationBotQueueSchema,
} from '@fish/contracts/moderation/bot'
import type { Db } from '@fish/db/client'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { Hono } from 'hono'
import type { MediaStorage } from '../uploads/storage'
import { loadBotListingFacts } from './bot-store'

/**
 * 飞书审核台的内部接口（`/internal/moderation/*`）。
 *
 * 认证是**静态 token**（`Authorization: Bearer …`），不是会话：机器人没有用户身份，也不该为了
 * 点按钮去模拟一个管理员登录。能力边界刻意只有两条：
 *
 * - `GET /pending`：最近待人工处理的 REVIEW 商品（卡片内容）；
 * - `POST /:recordId/decision`：通过 / 拒绝。
 *
 * 判定本身仍由 admin 域的 `decideModeration` 执行——图片结算、通知、幂等、审计全都在那条
 * 事务里，机器人只是换了个触发入口，不复制任何判定逻辑。
 */

/** 一次最多给几张卡：再多会刷屏，剩下的等下一轮轮询。 */
const MAX_PENDING = 10
const DEFAULT_PENDING = 5
const DEFAULT_REASON = '飞书审核台人工复核'
/** 更高强度会误伤正常枚举；卡片动作的 requestId 只是幂等键，不承担防暴力猜解职责。 */
const MAX_REQUEST_ID_LENGTH = 128

export interface BotModerationService {
  listModerationQueue(input: { limit: number }): Promise<{ items: AdminModerationQueueItem[] }>
  decideModeration(input: {
    recordId: string
    actorUserId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    requestId: string
  }): Promise<unknown>
}

export function createModerationBotRouter(options: {
  service: BotModerationService
  db: Db
  storage: MediaStorage
  /** 空串由 `loadModerationBotEnv` 拦掉，这里只做等长比较。 */
  token: string
  /** 决策写入审计的 actor：Owner 本人的用户 ID（卡片只允许 Owner 点）。 */
  actorUserId: string
}) {
  const router = new Hono()

  router.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!tokenMatches(presented, options.token)) {
      return jsonResponse({ error: 'UNAUTHORIZED' }, 401)
    }
    await next()
  })

  router.get('/pending', async (c) => {
    const limit = pendingLimit(c.req.query('limit'))
    let page: { items: AdminModerationQueueItem[] }
    try {
      page = await options.service.listModerationQueue({ limit })
    } catch (error) {
      return failureResponse(error)
    }

    const facts = await loadBotListingFacts(options.db, options.storage, page.items)
    const items = page.items.flatMap((item) => {
      const fact = facts.get(item.listing.id)
      // 商品刚好被删/类目脏数据：这一条跳过，不让整页卡片 500。
      if (!fact) return []
      return [
        {
          recordId: item.record.id,
          listingId: item.listing.id,
          title: item.listing.title,
          description: item.listing.description,
          priceCents: fact.priceCents,
          category: fact.category,
          sellerId: item.seller.id,
          sellerNickname: item.seller.nickname,
          machineDecision: item.record.decision,
          provider: item.record.provider,
          label: item.record.label,
          subLabel: item.record.subLabel,
          score: item.record.score,
          images: fact.images,
          imageCount: fact.imageCount,
          modelReview: fact.modelReview,
          createdAt: item.listing.createdAt,
        },
      ]
    })
    return Response.json(ModerationBotQueueSchema.parse({ items }), { status: 200 })
  })

  router.post('/:recordId/decision', async (c) => {
    const rawRecordId = c.req.param('recordId')
    let recordId: string
    try {
      recordId = decodePublicId(PUBLIC_ID_PREFIX.moderationRecord, rawRecordId)
    } catch {
      return jsonResponse({ error: 'VALIDATION_FAILED', message: '审核记录 ID 不合法' }, 422)
    }

    const input = ModerationBotDecisionInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) {
      return jsonResponse(
        { error: 'VALIDATION_FAILED', message: 'decision 只能是 ALLOW / BLOCK' },
        422,
      )
    }
    const requestId = c.req.header('Idempotency-Key')?.trim()
    if (!requestId || requestId.length > MAX_REQUEST_ID_LENGTH) {
      return jsonResponse(
        { error: 'VALIDATION_FAILED', message: '缺少有效的 Idempotency-Key' },
        422,
      )
    }

    try {
      await options.service.decideModeration({
        recordId,
        actorUserId: options.actorUserId,
        decision: input.data.decision,
        reason: input.data.reason ?? DEFAULT_REASON,
        requestId,
      })
    } catch (error) {
      return failureResponse(error)
    }
    return Response.json({ recordId: rawRecordId, decision: input.data.decision }, { status: 200 })
  })

  return router
}

function pendingLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_PENDING
  return Math.min(Math.max(parsed, 1), MAX_PENDING)
}

/**
 * 定长比较：先各自哈希再逐字节异或，长度不同也不会提前返回——
 * 静态 token 的唯一入口，不值得为省几行留下按字节计时猜测前缀的余地。
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = new Bun.CryptoHasher('sha256').update(presented).digest()
  const b = new Bun.CryptoHasher('sha256').update(expected).digest()
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return diff === 0
}

/** admin 域抛的是 `AdminError`（带 code/status）；这里只按鸭子类型翻译，不 import 它的类。 */
function failureResponse(error: unknown): Response {
  const status = statusOf(error)
  const code =
    typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : 'INTERNAL_ERROR'
  const message = error instanceof Error ? error.message : '审核操作失败'
  return jsonResponse({ error: code, message }, status)
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status })
}
