import type { Db } from '@fish/db/client'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { and, eq, sql } from 'drizzle-orm'
import type { ImageModerationResult } from '../moderation/providers/types'
import type { ModerationDecision } from '../moderation/types'

export type ListingMediaObjectRow = typeof listingMediaObjects.$inferSelect

/**
 * #286 复审 blocker 1：**有效结论** = 人工结算优先。
 *
 * `moderation_decision` 是机器原始结论，不可变；管理员对商品做出 ALLOW/BLOCK 时，这张 REVIEW 图
 * 在同事务里被结算（`settled_decision` / `settled_at`）。所有"这张图现在算不算过审"的判定都必须
 * 走这里 —— 否则人工放行过的图会被原始 REVIEW 重新压回人工队列。
 */
export function effectiveModerationDecision(
  row: Pick<ListingMediaObjectRow, 'moderationDecision' | 'settledDecision'>,
): ModerationDecision {
  return row.settledDecision ?? row.moderationDecision
}

/** 引用校验需要的切片：这是谁的图、固化到哪、结论是什么。 */
export type ConfirmedListingMediaObject = {
  userId: string
  finalKey: string
  moderationDecision: ModerationDecision
}

/** `findByFinalKey` 的切片：原始结论 + 人工结算结论（调用方自行取有效值）。 */
export type StoredListingMediaObject = {
  userId: string
  finalKey: string
  moderationDecision: ModerationDecision
  settledDecision: ModerationDecision | null
}

/**
 * Listing 引用校验的最小端口（#286）。`listings` 只需要回答「这个键是否已经是一个审核过的图片对象，
 * 以及它现在的**有效**结论是什么」，不需要知道 staging / 摘要 / provider 这些上传域细节。
 */
export interface ConfirmedImageLookup {
  /**
   * 可引用的确认记录：有效结论为 BLOCK 的行**不返回**（`null`），调用方据此拒绝引用。
   * 幂等快速路径与引用校验都用它。
   */
  findConfirmedFinalKey(finalKey: string): Promise<ConfirmedListingMediaObject | null>
  /**
   * 按键取原始记录，**包含**有效结论为 BLOCK 的行。人工结算成 BLOCK 的审核图仍然躺在
   * `listing_images` 里（商品被下架但图片键没变），编辑链路必须能看出它已被阻断并继续拦下，
   * 而不是把它当成"没有记录"而豁免（那会让一次纯文本编辑洗掉人工 BLOCK）。
   */
  findByFinalKey(finalKey: string): Promise<StoredListingMediaObject | null>
}

export type ListingMediaObjectInsert = {
  userId: string
  stagingKey: string
  /** BLOCK 不固化，写 null；ALLOW / REVIEW 写服务端生成的 final 键。 */
  finalKey: string | null
  contentDigest: string
  providerMd5: string | null
  moderationDecision: ModerationDecision
  provider: ImageModerationResult['provider']
  providerRequestId: string | null
}

export interface ListingMediaObjectStore extends ConfirmedImageLookup {
  /** 幂等查找：同一 `(userId, stagingKey, 当前字节内容)` 的既有结论。 */
  findByDigest(input: {
    userId: string
    stagingKey: string
    contentDigest: string
  }): Promise<ListingMediaObjectRow | null>
  /**
   * 落库。并发 confirm 撞上唯一索引时返回 null（不是抛错）——调用方据此改用先落库那一行的
   * final 键，保证同一个对象只产生一个可引用键。
   */
  insert(input: ListingMediaObjectInsert): Promise<ListingMediaObjectRow | null>
}

export function createSqlListingMediaObjectStore(db: Db): ListingMediaObjectStore {
  return {
    async findByDigest({ userId, stagingKey, contentDigest }) {
      const [row] = await db
        .select()
        .from(listingMediaObjects)
        .where(
          and(
            eq(listingMediaObjects.userId, userId),
            eq(listingMediaObjects.stagingKey, stagingKey),
            eq(listingMediaObjects.contentDigest, contentDigest),
          ),
        )
        .limit(1)
      return row ?? null
    },

    async findConfirmedFinalKey(finalKey) {
      const [row] = await db
        .select()
        .from(listingMediaObjects)
        .where(
          and(
            eq(listingMediaObjects.finalKey, finalKey),
            // 有效结论为 BLOCK 的行不可引用：机器 BLOCK 行本来就写不进可引用键（DB CHECK），
            // 但人工结算成 BLOCK 的 REVIEW 行是有的。判定结论是安全关键，不依赖"上游写库时没写错"。
            sql`COALESCE(${listingMediaObjects.settledDecision}, ${listingMediaObjects.moderationDecision}) <> 'BLOCK'`,
          ),
        )
        .limit(1)
      if (!row || row.finalKey === null) return null
      return {
        userId: row.userId,
        finalKey: row.finalKey,
        moderationDecision: effectiveModerationDecision(row),
      }
    },

    async findByFinalKey(finalKey) {
      const [row] = await db
        .select({
          userId: listingMediaObjects.userId,
          finalKey: listingMediaObjects.finalKey,
          moderationDecision: listingMediaObjects.moderationDecision,
          settledDecision: listingMediaObjects.settledDecision,
        })
        .from(listingMediaObjects)
        .where(eq(listingMediaObjects.finalKey, finalKey))
        .limit(1)
      return row && row.finalKey !== null ? { ...row, finalKey: row.finalKey } : null
    },

    async insert(input) {
      const [row] = await db
        .insert(listingMediaObjects)
        .values(input)
        .onConflictDoNothing()
        .returning()
      return row ?? null
    },
  }
}
