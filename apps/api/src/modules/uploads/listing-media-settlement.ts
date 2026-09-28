import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import { newId } from '@fish/db/ids'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { listingImages } from '@fish/db/schema/listings'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type ModerationDbTransaction, ModerationSettlementError } from '../moderation/store'
import { effectiveModerationDecision } from './media-objects'
import { isListingReviewMediaKey } from './review-media'
import type { MediaStorage } from './storage'

/**
 * #286 复审 blocker 1：人工审核结论对**图片**的 durable 结算。
 *
 * 背景：`REVIEW` 图片在 confirm 时只固化到私有的 `listing-review-media/…`（blocker 2），商品因此进人工
 * 队列。管理员做出 ALLOW / BLOCK 之后，如果这张图还留着原始的机器 `REVIEW` 结论，卖家下一次不改图的
 * 文本编辑（编辑请求省略 `objectKeys`，服务端沿用 `listing_images` 里的老键）会重新读到 `REVIEW`，
 * 把已经放行的商品**再次**压回 `REVIEW` + `OFFLINE` —— 人工结论被编辑洗掉。所以人工决策必须与图片
 * 结论一起落库，且是同一个事务：
 *
 * - `ALLOW`：把私有对象**搬到**公开的 `listings/…` 前缀（`readMediaBytes` → `writeMediaBytes`），
 *   改写媒体行（`final_key` = 新公开键、`settled_decision='ALLOW'`）与 `listing_images.object_key`，
 *   于是「放行」与「可匿名读」同时生效；改写 `listing_images` 时**不限定当前商品**：同一个 final 键
 *   允许被同一卖家的多条商品引用（引用校验只按归属前缀 + 台账行），只改被决策的那条会让另一条继续
 *   指向私有键、并在它自己的人工放行时既搬不动（台账行已改名）又留下"已放行但图是私有键"的状态。
 * - `BLOCK`：只结算结论（`settled_decision='BLOCK'`，不固化、不搬对象），媒体行随即不可引用；
 *   之后任何仍引用该键的商品被人工放行时**必须失败**（见下），否则被阻断的字节会随那次放行进公开前缀。
 *
 * 事务边界：调用方（`moderation/store.ts` 的 `decideWithin`）已经对 listings 行 `FOR UPDATE`，
 * 而卖家改图走 `listings/store.ts` 的 `updateListingAtomic`，也在锁内读 `listing_images` —— 两者
 * 互斥，因此把 S3 拷贝放在决策事务里不会与卖家编辑并发改写同一批键。代价是决策事务内做 ≤9 次
 * 对象拷贝（管理员低频操作），换来「翻转结论」与「切换可引用键」原子。
 *
 * 并发：管理端的互斥锁是 `hashtext(recordId:requestId)`，**同一张图被两条商品引用时两条决策不互斥**，
 * 所以本模块自己按 `final_key` 排序后对台账行 `SELECT … FOR UPDATE`（ALLOW / BLOCK 两支同一顺序取锁，
 * 避免死锁），并在放行的条件 UPDATE 上校验 `settled_decision IS NULL` 与 rowcount：并发下不会出现
 * 「BLOCK 已判、ALLOW 照样搬字节进公开前缀」或「后写的把先写的结论覆盖掉」。
 *
 * 两阶段：第一遍只加锁、校验、读字节；全部合法后才在第二遍写公开对象并改台账 —— 对象写入不随事务
 * 回滚，先写后校验会在「一张图合法、另一张已被 BLOCK」时留下无人引用的匿名可读孤儿对象。
 *
 * 失败即回滚（抛 `ModerationSettlementError`）：拷贝失败、对象缺失、台账行缺失时宁可整个人工决策
 * 不生效（商品留在 REVIEW 队列），也不能出现「已放行但图片仍是私有键 / 键指向不存在对象」的半截状态。
 */
export type SettleListingMedia = (
  tx: ModerationDbTransaction,
  input: { listingId: string; decision: 'ALLOW' | 'BLOCK' },
) => Promise<void>

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** 私有审核键与公开固化键同构，扩展名就是对象内容类型。 */
function extensionOf(key: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(key)
  return (match?.[1] ?? 'jpg').toLowerCase()
}

export function createListingMediaSettlement(deps: { storage: MediaStorage }): SettleListingMedia {
  const { storage } = deps
  return async function settleListingMediaWithin(tx, { listingId, decision }) {
    const storedRows = await tx
      .select({ objectKey: listingImages.objectKey })
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
    // 去重 + 排序：去重是脏数据防御（正常路径下契约层已拦住「同一张图重复」），排序让并发事务按同一
    // 顺序去锁台账行，避免两条共享多张审核图的商品互相等待成死锁。
    const reviewKeys = [
      ...new Set(storedRows.map((row) => row.objectKey).filter(isListingReviewMediaKey)),
    ].sort()
    // 没有审核中的图（全机器 ALLOW 或纯 legacy 键）：人工结论对图片没有可结算的内容。
    if (reviewKeys.length === 0) return

    if (decision === 'BLOCK') {
      // 先 `FOR UPDATE` 锁住这些台账行再落结论：否则可能与并发的 ALLOW（另一条引用同一键的商品，
      // 其管理端互斥锁只按 recordId 取，与本商品不互斥）交错，出现「BLOCK 已判、ALLOW 照样把字节
      // 搬进匿名可读前缀」的窗口。`orderBy` 让本分支与 ALLOW 分支按同一顺序取锁，避免死锁。
      const blockedRows = await tx
        .select({ id: listingMediaObjects.id })
        .from(listingMediaObjects)
        .where(
          and(
            inArray(listingMediaObjects.finalKey, reviewKeys),
            eq(listingMediaObjects.moderationDecision, 'REVIEW'),
          ),
        )
        .orderBy(listingMediaObjects.finalKey)
        .for('update')
      if (blockedRows.length > 0) {
        await tx
          .update(listingMediaObjects)
          .set({ settledDecision: 'BLOCK', settledAt: sql`now()` })
          .where(
            inArray(
              listingMediaObjects.id,
              blockedRows.map((row) => row.id),
            ),
          )
      }
      return
    }

    if (!storage.readMediaBytes || !storage.writeMediaBytes) {
      throw new ModerationSettlementError(
        'SETTLEMENT_FAILED',
        '媒体存储不支持读写字节，无法结算人工放行的审核图片',
      )
    }
    // 第一遍：加行锁、校验、读字节，**不写任何对象**。事务回滚撤不掉对象存储里的写入，所以「某一张
    // 图不合法」（台账缺失、已被人工阻断、对象缺失）必须在写第一张之前就全部发现，否则会留下没有任何
    // 台账行引用的匿名可读孤儿对象。
    const promotions: {
      reviewKey: string
      mediaId: string
      userId: string
      publicKey: string
      bytes: Uint8Array
      contentType: string
    }[] = []
    // 已被别的商品人工放行结算过的键：不重复搬运，只把本条商品的引用改到已有的公开键。
    const rewrites: { from: string; to: string }[] = []

    for (const reviewKey of reviewKeys) {
      const [media] = await tx
        .select()
        .from(listingMediaObjects)
        .where(eq(listingMediaObjects.finalKey, reviewKey))
        .limit(1)
        .for('update')
      // 台账行缺失只可能来自脏数据：放行会把 `final_key` 改写成公开键，并在同一事务里把所有引用该键的
      // `listing_images` 一起改写；因此"引用着私有键、却没有对应台账行"没有任何正常来源。宁可拒绝这次
      // 人工放行（商品留在队列，卖家换图后重试），也不能放行一张结论不明的图。
      if (!media) {
        throw new ModerationSettlementError(
          'SETTLEMENT_DATA_MISSING',
          `审核图片台账缺失，无法结算人工放行：${reviewKey}`,
        )
      }
      // 同一个键被另一条商品引用、且那张图已经被人工 BLOCK：绝不能借这次 ALLOW 把阻断过的字节放出去
      // （放出去就是匿名可读的公开对象）。拒绝整个决策，商品留在人工队列由人再看。
      if (effectiveModerationDecision(media) === 'BLOCK') {
        throw new ModerationSettlementError(
          'IMAGE_BLOCKED',
          `审核图片已被人工阻断，不能放行引用它的商品：${reviewKey}`,
        )
      }
      // 已经被并发/重试结算过：行锁保证这里读到的是已提交的最终状态，不重复搬运，只复用公开键。
      if (media.settledDecision !== null) {
        if (media.finalKey === null) {
          throw new ModerationSettlementError(
            'SETTLEMENT_DATA_MISSING',
            `审核图片台账缺少可引用键，无法结算人工放行：${reviewKey}`,
          )
        }
        rewrites.push({ from: reviewKey, to: media.finalKey })
        continue
      }
      // 未结算却不是 REVIEW：台账与商品图片键已经不一致，拒绝而不是猜一个公开键。
      if (media.moderationDecision !== 'REVIEW') {
        throw new ModerationSettlementError(
          'SETTLEMENT_DATA_MISSING',
          `审核图片台账状态异常，无法结算人工放行：${reviewKey}`,
        )
      }

      const bytes = await storage.readMediaBytes(reviewKey, MAX_IMAGE_BYTES)
      if (!bytes || bytes.length === 0) {
        throw new ModerationSettlementError(
          'SETTLEMENT_DATA_MISSING',
          `审核图片对象缺失，无法结算人工放行：${reviewKey}`,
        )
      }
      const extension = extensionOf(reviewKey)
      promotions.push({
        reviewKey,
        mediaId: media.id,
        userId: media.userId,
        publicKey: `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, media.userId)}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.${extension}`,
        bytes,
        contentType: CONTENT_TYPE_BY_EXTENSION[extension] ?? 'image/jpeg',
      })
    }

    // 第二遍：所有图都校验通过后才写公开对象、改台账。条件 UPDATE 带 `settled_decision IS NULL` 并校验
    // rowcount：并发下另一个事务抢先结算时这里改不到行，整个决策回滚，绝不会覆盖对方的结论。
    for (const promotion of promotions) {
      await storage.writeMediaBytes(promotion.publicKey, promotion.bytes, promotion.contentType)
      const updated = await tx
        .update(listingMediaObjects)
        .set({
          finalKey: promotion.publicKey,
          settledDecision: 'ALLOW',
          settledAt: sql`now()`,
        })
        .where(
          and(
            eq(listingMediaObjects.id, promotion.mediaId),
            isNull(listingMediaObjects.settledDecision),
            eq(listingMediaObjects.moderationDecision, 'REVIEW'),
          ),
        )
        .returning({ id: listingMediaObjects.id })
      if (updated.length !== 1) {
        throw new ModerationSettlementError(
          'SETTLEMENT_FAILED',
          `审核图片台账已被并发结算，本次人工放行未生效：${promotion.reviewKey}`,
        )
      }
      rewrites.push({ from: promotion.reviewKey, to: promotion.publicKey })
    }

    // 引用改写放在最后：同一卖家**所有**引用过该私有键的商品一起改到公开键（键由上传者私有，引用校验
    // 保证只有归属前缀匹配的卖家能用它），共享同一张审核图的商品因此不会留下指向私有键的悬空引用。
    for (const { from, to } of rewrites) {
      await tx.update(listingImages).set({ objectKey: to }).where(eq(listingImages.objectKey, from))
    }
  }
}
