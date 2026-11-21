import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { jobs } from '@fish/db/schema/jobs'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords, moderationModelReviews } from '@fish/db/schema/moderation'
import { notifications } from '@fish/db/schema/notifications'
import type { ModerationReviewEnv } from '@fish/shared/env'
import { sniffImageMime } from '@fish/shared/image-mime'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { WorkerMediaStorage } from '../../media-storage'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import { parseJobPayload } from '../queue'
import type { ModerationModelClient } from './model-client'
import { ModerationModelError } from './model-client'
import { buildModerationReviewPrompt, MODERATION_REVIEW_PROMPT_VERSION } from './prompt'
import {
  errorReview,
  type ModerationReview,
  ModerationReviewParseError,
  parseModerationReview,
} from './review'

/**
 * 模型复核 job：把「腾讯判 REVIEW」的商品交给多模态模型再判一次。
 *
 * 四路径（Owner 2026-11-21 口径）：
 * - 腾讯严重标签（色情/违禁/暴恐/辱骂，见 `SEVERE_LABELS`）→ **不调模型**，直接留给人工；
 * - 模型 PASS → 自动上架（`AUTO_PASSED`）；
 * - 模型 BLOCK → 自动拒绝 + 固定话术 + 申诉指引（`AUTO_REJECTED`）；
 * - 模型没把握/超时/出错 → 人工（`PENDING`）。
 *
 * 两条不可越过的红线：
 * 1. **模型失败绝不放行**：任何异常都收敛成 `ERROR`，落到 `PENDING`；
 * 2. **模型只能处理 REVIEW**：进事务后先 `for('update')` 复检状态，人工已经改判就不再动。
 *
 * `shadow` 模式下只落记录、不改任何状态，卡片与后台都标注「模型认为」——上线第一周用它量准确率。
 */

/**
 * 即使腾讯只给了 REVIEW，也必须人工复核的标签。
 *
 * 与 `apps/api/src/modules/moderation/providers/tencent.ts` 的 `AUTO_BLOCK_LABELS` 取同一个
 * 集合（那里是"自动拦截"，这里是"不允许模型放行"），刻意**不含 `polity`**：教材封面的
 * "教育部规划教材"正是要由模型结合上下文放行的典型误杀，把它排除在模型权限之外等于没修。
 */
const SEVERE_LABELS = new Set(['porn', 'sexy', 'illegal', 'abuse', 'terror'])

/**
 * 送审图片上限：一张商品最多 9 图，全送会把延迟与成本放大到不可控。
 *
 * 这个上限不只是"省成本"，还是**安全边界**：只要有一张 REVIEW 图没被模型看到，自动放行就
 * 等于把没审过的图放上公网。所以超过上限的商品**不调模型**，直接留给人工（见 handler 的
 * `too-many-review-images`）。
 */
const MAX_REVIEW_IMAGES = 6

/** 整包图片的字节预算：base64 后还要 ×4/3，一次请求体别无限长。 */
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * 自动结论的最低置信度。
 *
 * 模型被要求给 `confidence`；低于这条线（或没给）就当"没把握"，一律转人工 —— 正是需求里
 * "模型没有把握就不要自动处置"的那条。两个方向对称：低置信度的 BLOCK 也不自动拒绝。
 */
const MIN_AUTO_CONFIDENCE = 0.8

/** 自动拒绝时给用户看的话（固定话术，不含模型理由；30 字以内，端上一行能放下）。 */
export const AUTO_REJECT_REASON = '商品信息涉嫌违反平台发布规范，如有异议请通过意见反馈申诉'

const PROMPT_VERSION = MODERATION_REVIEW_PROMPT_VERSION

export type ModerationOutcome = 'SHADOW' | 'AUTO_PASSED' | 'AUTO_REJECTED' | 'PENDING'

/**
 * 结论 × 模式 → 实际动作（纯函数）。
 *
 * 严重标签在**调用模型之前**就被拦掉（见 handler 里的 `SEVERE_LABELS`），所以这里没有
 * "severe" 分支：影子期也不给模型"放行一条色情内容"的记录，那会污染准确率统计。
 */
export function decideOutcome(input: {
  mode: 'shadow' | 'enforce'
  review: ModerationReview
}): ModerationOutcome {
  // 影子期只记录：连"模型没把握"也要落成 SHADOW，否则量出来的放行率会偏低。
  if (input.mode === 'shadow') return 'SHADOW'
  // ERROR 是"没跑完"，UNSURE 是"跑完了但没把握"，都不许自动动状态。
  if (input.review.decision === 'UNSURE' || input.review.decision === 'ERROR') return 'PENDING'
  // 没给 confidence 或低于阈值 = 没把握：两个方向都转人工，不拿不确定的结论去动状态。
  if (input.review.confidence === null || input.review.confidence < MIN_AUTO_CONFIDENCE) {
    return 'PENDING'
  }
  return input.review.decision === 'PASS' ? 'AUTO_PASSED' : 'AUTO_REJECTED'
}

export type ModerationJobDeps = {
  /** `off` 时 handler 只记一条日志 —— 保留 job 消费，避免队列里堆一条永远没人领的任务。 */
  env: ModerationReviewEnv
  storage: WorkerMediaStorage
  client: ModerationModelClient | null
}

export function createModerationJobHandlers(db: Db, deps: ModerationJobDeps) {
  return {
    async LISTING_MODERATION(raw: unknown): Promise<Record<string, unknown>> {
      const listingId = readListingId(raw)

      if (deps.env.mode === 'off' || deps.client === null) {
        return { status: 'skipped', reason: 'model-review-off' }
      }

      const client = deps.client
      const initial = await readReviewTarget(db, listingId)
      if (initial === null) return { status: 'skipped', reason: 'missing' }
      if (initial.moderationStatus !== 'REVIEW') {
        return { status: 'skipped', reason: 'not-review' }
      }
      if (initial.label !== null && SEVERE_LABELS.has(initial.label.toLowerCase())) {
        // 不落记录：这不是"模型复核过"，是"根本不归模型管"。
        return { status: 'skipped', reason: 'severe-label', label: initial.label }
      }
      // 腾讯记录却没有 label（旧数据/上游没回标签）：无法判断是否属于五类严重标签，
      // 不能把"不知道"当成"不严重"——这正是红线被绕过的典型形状。local 记录不在此列。
      if (initial.label === null && initial.provider === 'TENCENT_TMS') {
        return { status: 'skipped', reason: 'unlabeled-text' }
      }

      // 有引用但台账里没有行的图（#286 之前的老键）：模型压根看不到它，
      // 自动放行就等于让它随商品上架。整条转人工。
      if (initial.unaccountedKeys.length > 0) {
        return { status: 'skipped', reason: 'unaccounted-image' }
      }

      // 图片的严重标签同样不归模型管。文本记录只反映标题/描述，图片标签在
      // `listing_media_objects.provider_label` 里；只看文本会漏掉"文字干净、图被标 Porn"的商品。
      // 腾讯 IMS 的图却没有 label（多为新列上线前的存量行）：同样无法判断严重类别。
      if (
        initial.reviewImages.some(
          (image) => image.label === null && image.provider === 'TENCENT_IMS',
        )
      ) {
        return { status: 'skipped', reason: 'unlabeled-image' }
      }
      const severeImage = initial.reviewImages.find(
        (image) => image.label !== null && SEVERE_LABELS.has(image.label.toLowerCase()),
      )
      if (severeImage) {
        return { status: 'skipped', reason: 'severe-image-label', label: severeImage.label }
      }

      // 自动放行的前提是"每一张 REVIEW 图都被模型看过"：只要有一张超出上限，放行就等于
      // 把没审过的图放上公网。这类商品直接留给人工，不调模型。
      if (initial.reviewImages.length > MAX_REVIEW_IMAGES) {
        return { status: 'skipped', reason: 'too-many-review-images' }
      }

      const images = await readReviewImages(
        deps.storage,
        initial.reviewImages.map((image) => image.key),
      )
      // 读失败/超限/不是图片：少看一张就不能自动放行，整条转人工（不落模型记录）。
      if (images === null) return { status: 'skipped', reason: 'image-unreadable' }
      const prompt = buildModerationReviewPrompt({
        title: initial.title,
        description: initial.description,
        category: initial.category,
        priceCents: initial.priceCents,
        providerLabel: initial.label,
        providerSubLabel: initial.subLabel,
        imageCount: images.length,
      })

      const startedAt = performance.now()
      let review: ModerationReview
      let promptTokens: number | null = null
      let completionTokens: number | null = null
      try {
        const response = await client.review({
          system: prompt.system,
          text: prompt.text,
          images,
        })
        promptTokens = response.promptTokens
        completionTokens = response.completionTokens
        review = parseModerationReview(response.content)
      } catch (error) {
        // 不重试的失败也只有一条：超时/网络/HTTP/解析。统一收敛成 ERROR（→ 人工），
        // 错误里只有分类码，没有上游原文（可能回显用户内容）。
        const reason =
          error instanceof ModerationModelError
            ? error.reason
            : error instanceof ModerationReviewParseError
              ? 'parse'
              : 'unknown'
        review = errorReview(`模型复核未完成（${reason}）`)
      }
      const latencyMs = Math.round(performance.now() - startedAt)

      const outcome = decideOutcome({ mode: deps.env.mode, review })

      const action = await db.transaction(async (tx) => {
        // 复检：人工可能已经改判，或卖家在模型跑的时候编辑过（内容变了这次结论就不作数）。
        const current = await tx
          .select({
            moderationStatus: listings.moderationStatus,
            updatedAt: sql<string>`${listings.updatedAt}::text`,
          })
          .from(listings)
          .where(eq(listings.id, listingId))
          .for('update')
          .limit(1)
        const row = current[0]
        if (!row) return 'missing' as const
        if (row.moderationStatus !== 'REVIEW') return 'raced' as const
        if (row.updatedAt !== initial.updatedAt) return 'stale' as const

        const values = {
          listingId,
          moderationRecordId: initial.recordId,
          model: client.model,
          promptVersion: PROMPT_VERSION,
          inputDigest: initial.inputDigest,
          decision: review.decision,
          category: review.category,
          reason: review.reason,
          evidence: jsonParam(review.evidence),
          confidence: review.confidence,
          latencyMs,
          promptTokens,
          completionTokens,
          outcome,
        }
        const inserted = await tx
          .insert(moderationModelReviews)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: moderationModelReviews.id })

        if (inserted.length === 0) {
          // 同内容已经审过。影子期（SHADOW）与"没把握"（PENDING）的行是**没有生效**的记录：
          // 切 enforce 或重新投递时要用这次的结论覆盖它，否则这些商品永远停在"已审过"的
          // 假象里（唯一键把它们挡在门外）。已有自动结论才算真的重复投递。
          const prior = (
            await tx
              .select({ id: moderationModelReviews.id, outcome: moderationModelReviews.outcome })
              .from(moderationModelReviews)
              .where(
                and(
                  eq(moderationModelReviews.listingId, listingId),
                  eq(moderationModelReviews.promptVersion, PROMPT_VERSION),
                  eq(moderationModelReviews.model, client.model),
                  eq(moderationModelReviews.inputDigest, initial.inputDigest),
                ),
              )
              .for('update')
              .limit(1)
          )[0]
          if (prior === undefined || (prior.outcome !== 'SHADOW' && prior.outcome !== 'PENDING')) {
            return 'duplicate' as const
          }
          await tx
            .update(moderationModelReviews)
            .set({
              moderationRecordId: values.moderationRecordId,
              decision: values.decision,
              category: values.category,
              reason: values.reason,
              evidence: values.evidence,
              confidence: values.confidence,
              latencyMs: values.latencyMs,
              promptTokens: values.promptTokens,
              completionTokens: values.completionTokens,
              outcome: values.outcome,
            })
            .where(eq(moderationModelReviews.id, prior.id))
        }

        if (outcome === 'AUTO_PASSED') {
          await tx
            .update(listings)
            .set({
              moderationStatus: 'APPROVED',
              status: 'ACTIVE',
              moderationReason: null,
              moderatedAt: sql`now()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(listings.id, listingId))
          // 与人工放行同语义地结算图片（#286 复审 blocker 1）：不翻这一行，卖家下一次
          // 不改图的文本编辑会从 `listing_images` 重新读到机器 REVIEW，把已上架商品压回
          // 人工队列。**只翻结论、不搬字节**：worker 没有公开前缀的写能力（见
          // apps/worker/src/media-storage.ts 的取舍），图片继续留私有前缀走签名代理读；
          // 这与人工放行"搬到 listings/"的差别是 CDN 路径，不影响可引用性。
          // 只结算这次真正送审的图（`initial.reviewImages`）——不是商品的全部图片。
          if (initial.reviewImages.length > 0) {
            await tx
              .update(listingMediaObjects)
              .set({ settledDecision: 'ALLOW', settledAt: sql`now()` })
              .where(
                and(
                  inArray(
                    listingMediaObjects.finalKey,
                    initial.reviewImages.map((image) => image.key),
                  ),
                  eq(listingMediaObjects.moderationDecision, 'REVIEW'),
                  isNull(listingMediaObjects.settledDecision),
                ),
              )
          }
          await enqueueIndexJobs(tx, listingId)
        } else if (outcome === 'AUTO_REJECTED') {
          await tx
            .update(listings)
            .set({
              moderationStatus: 'BLOCKED',
              status: 'OFFLINE',
              moderationReason: AUTO_REJECT_REASON,
              moderatedAt: sql`now()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(listings.id, listingId))
          // 模型拒绝可以被申诉推翻，所以**不**把图片钉成 BLOCK：留原始 REVIEW，
          // 卖家重发同一张图时仍会进人工，而不是被一次模型判断永久拉黑。
        }

        // 卖家侧的通知与人工决策同形（`moderation/store.ts` 的 decideWithin）：商品从
        // 「审核中」变成有结论，客户端据此刷新「我的发布」并弹结果。
        //
        // **只为自动结论发**：影子期不改状态、PENDING 是"转人工"而不是"被拒"，这两种情况给卖家
        // 发「商品未通过审核」是错误结论（还会在人工改判后再发一次"通过"，自相矛盾）。
        if (outcome !== 'AUTO_PASSED' && outcome !== 'AUTO_REJECTED') return 'recorded' as const
        await tx.insert(notifications).values({
          id: newId(),
          userId: initial.sellerId,
          type: 'MODERATION',
          payload: jsonParam({
            listingId,
            outcome: outcome === 'AUTO_PASSED' ? 'APPROVED' : 'REJECTED',
          }),
        })

        return 'recorded' as const
      })

      return {
        status: action,
        outcome,
        decision: review.decision,
        latencyMs,
        images: images.length,
      }
    },
  }
}

function readListingId(raw: unknown): string {
  const payload = parseJobPayload(raw)
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidJobPayloadError('LISTING_MODERATION', 'payload 必须是对象')
  }
  const listingId = (payload as { listingId?: unknown }).listingId
  if (typeof listingId !== 'string' || listingId.length === 0) {
    throw new InvalidJobPayloadError('LISTING_MODERATION', '缺少 listingId')
  }
  return listingId
}

type ReviewTarget = {
  title: string
  description: string
  category: string
  priceCents: number
  sellerId: string
  moderationStatus: string
  objectKeys: string[]
  /**
   * 待复核（有效结论仍是 `REVIEW`）的图片：键 + 腾讯给这张图的标签。
   *
   * 有效结论 = `settled_decision ?? moderation_decision`（人工放行过的 REVIEW 图不再重复复核）。
   * 模型只看这些图，自动放行也只结算这些图。
   */
  reviewImages: {
    key: string
    label: string | null
    subLabel: string | null
    provider: string
  }[]
  /** 有引用、但台账里没有对应行的键（#286 之前的老键）：这些图模型看不到，不能自动放行。 */
  unaccountedKeys: string[]
  recordId: string | null
  label: string | null
  subLabel: string | null
  provider: string | null
  /** 微秒精度的文本形式：`timestamptz` 落成 Date 只有毫秒，同一毫秒内的编辑会被误判"没变"。 */
  updatedAt: string
  inputDigest: string
}

async function readReviewTarget(db: Db, listingId: string): Promise<ReviewTarget | null> {
  const rows = await db
    .select({
      title: listings.title,
      description: listings.description,
      category: listings.category,
      priceCents: listings.priceCents,
      sellerId: listings.sellerId,
      moderationStatus: listings.moderationStatus,
      updatedAt: sql<string>`${listings.updatedAt}::text`,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)
  const listing = rows[0]
  if (!listing) return null

  const images = await db
    .select({ objectKey: listingImages.objectKey })
    .from(listingImages)
    .where(eq(listingImages.listingId, listingId))
    .orderBy(listingImages.sortOrder)

  // 最近一条机器结论：它是这次复核的"上游标签"，也让后台能点回腾讯那次请求（RequestId）。
  const records = await db
    .select({
      id: listingModerationRecords.id,
      label: listingModerationRecords.label,
      subLabel: listingModerationRecords.subLabel,
      provider: listingModerationRecords.provider,
      providerRequestId: listingModerationRecords.providerRequestId,
    })
    .from(listingModerationRecords)
    .where(eq(listingModerationRecords.listingId, listingId))
    // 同一毫秒可能落两条（标题/描述各一次），按 id 兜底排序，别让"最近一条标签"随机。
    .orderBy(desc(listingModerationRecords.createdAt), desc(listingModerationRecords.id))
    .limit(1)
  const record = records[0] ?? null

  const objectKeys = images.map((image) => image.objectKey)

  // 每张图的有效结论与标签：决定"哪些图要模型看""哪些标签属于严重类别"。
  const mediaRows =
    objectKeys.length === 0
      ? []
      : await db
          .select({
            finalKey: listingMediaObjects.finalKey,
            moderationDecision: listingMediaObjects.moderationDecision,
            settledDecision: listingMediaObjects.settledDecision,
            label: listingMediaObjects.providerLabel,
            subLabel: listingMediaObjects.providerSubLabel,
            provider: listingMediaObjects.provider,
          })
          .from(listingMediaObjects)
          .where(inArray(listingMediaObjects.finalKey, objectKeys))
  const accountedKeys = new Set(
    mediaRows.flatMap((row) => (row.finalKey === null ? [] : [row.finalKey])),
  )
  const reviewImages = mediaRows.flatMap((row) => {
    if (row.finalKey === null) return []
    const effective = row.settledDecision ?? row.moderationDecision
    return effective === 'REVIEW'
      ? [
          {
            key: row.finalKey,
            label: row.label,
            subLabel: row.subLabel,
            provider: row.provider,
          },
        ]
      : []
  })
  // `listing_images` 里有、台账里没有的键（#286 之前的老图，或调用方绕过 confirm 写入）。
  // 这些图既不是 ALLOW 也不在 reviewImages 里，模型根本没看过 —— 一旦自动放行就等于
  // 把一张没审过的图放上公网，所以整条转人工（见 handler 的 `unaccounted-image`）。
  const unaccountedKeys = objectKeys.filter((key) => !accountedKeys.has(key))
  const digest = new Bun.CryptoHasher('sha256')
  digest.update(
    JSON.stringify({
      title: listing.title,
      description: listing.description,
      category: listing.category,
      label: record?.label ?? null,
      subLabel: record?.subLabel ?? null,
      objectKeys,
      imageLabels: reviewImages.map((image) => image.label),
    }),
  )

  return {
    title: listing.title,
    description: listing.description,
    category: listing.category,
    priceCents: listing.priceCents,
    sellerId: listing.sellerId,
    moderationStatus: listing.moderationStatus,
    updatedAt: listing.updatedAt,
    objectKeys,
    reviewImages,
    unaccountedKeys,
    recordId: record?.id ?? null,
    label: record?.label ?? null,
    subLabel: record?.subLabel ?? null,
    provider: record?.provider ?? null,
    inputDigest: digest.digest('hex'),
  }
}

/**
 * 把待复核的图读成 data URL。
 *
 * **一张都不能少**：只要有一张读不到/超限/不是图片/整包超预算，就返回 `null`，调用方据此
 * 转人工。跳过一张图的代价不是"少看一点"，而是"自动放行后把没审过的图放上公网"。
 */
async function readReviewImages(
  storage: WorkerMediaStorage,
  objectKeys: string[],
): Promise<string[] | null> {
  const images: string[] = []
  let totalBytes = 0
  for (const key of objectKeys) {
    const bytes = await storage.readBytes(key, MAX_IMAGE_BYTES)
    // 任何一张读不到/超限/不是图片都返回 null：少看一张就不能自动放行（见调用点）。
    if (bytes === null || bytes.length > MAX_IMAGE_BYTES) return null
    const mime = sniffImageMime(bytes)
    if (mime === null) return null
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return null
    images.push(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`)
  }
  return images
}

/**
 * 放行后补投 `EMBED_LISTING` + `MATCH_LISTING`。
 *
 * 与 `apps/api/src/modules/listings/store.ts` 的 `enqueueListingJobsWith` 是同一组语句（顺序、
 * `DO UPDATE` 的取舍、`payload->>'listingId'` 的部分唯一索引都一致）。worker 侧**不做**
 * 那里的"失效旧向量"（`pruneStaleEmbeddings`）：这条商品在审核期间从未以 APPROVED 落库，
 * 也就从未生成过向量，没有旧行需要失效。
 */
async function enqueueIndexJobs(
  tx: Pick<Db, 'insert' | 'execute'>,
  listingId: string,
): Promise<void> {
  await tx.insert(jobs).values({
    id: newId(),
    type: 'EMBED_LISTING',
    payload: jsonParam({ listingId }),
  })
  await tx.execute(sql`
    INSERT INTO jobs (id, type, payload)
    VALUES (${newId()}, 'MATCH_LISTING', ${JSON.stringify({ listingId })}::text::jsonb)
    ON CONFLICT ((payload->>'listingId'))
      WHERE type = 'MATCH_LISTING' AND status = 'PENDING'
    DO UPDATE SET run_at = now()
  `)
}
