import type { Db } from '@fish/db/client'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { and, eq, ne } from 'drizzle-orm'
import type { ImageModerationResult } from '../moderation/providers/types'
import type { ModerationDecision } from '../moderation/types'

export type ListingMediaObjectRow = typeof listingMediaObjects.$inferSelect

/** 引用校验需要的切片：这是谁的图、固化到哪、结论是什么。 */
export type ConfirmedListingMediaObject = {
  userId: string
  finalKey: string
  moderationDecision: ModerationDecision
}

/**
 * Listing 引用校验的最小端口（#286）。`listings` 只需要回答「这个 final 键是否已经是一个
 * 审核过的图片对象」，不需要知道 staging / 摘要 / provider 这些上传域细节。
 */
export interface ConfirmedImageLookup {
  findConfirmedFinalKey(finalKey: string): Promise<ConfirmedListingMediaObject | null>
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
            // BLOCK 行本来就写不进去 final 键（DB CHECK），这里再挡一次：判定结论是安全关键，
            // 不依赖「上游写库时没写错」这一个前提。
            ne(listingMediaObjects.moderationDecision, 'BLOCK'),
          ),
        )
        .limit(1)
      if (!row || row.finalKey === null) return null
      return {
        userId: row.userId,
        finalKey: row.finalKey,
        moderationDecision: row.moderationDecision,
      }
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
