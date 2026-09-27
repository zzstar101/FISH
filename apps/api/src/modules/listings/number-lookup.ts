import { ListingNumberLookupResponseSchema } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { sql } from 'drizzle-orm'
import type { ListingService } from './service'
import { normalizeIp } from './trusted-ip'

type LookupCode =
  | 'LISTING_NOT_FOUND'
  | 'LISTING_LOOKUP_RATE_LIMITED'
  | 'LISTING_LOOKUP_IP_UNAVAILABLE'

/** 滚动窗口与上限：SQL 里两处 `interval '60 seconds'` 必须与窗口常量保持一致。 */
const NUMBER_LOOKUP_WINDOW_SECONDS = 60
const NUMBER_LOOKUP_MAX_ATTEMPTS = 50

export class ListingNumberLookupError extends Error {
  constructor(
    readonly status: 404 | 429 | 503,
    readonly code: LookupCode,
    message: string,
    /** 仅 429 携带：还要等多少秒才有名额（契约 §4.2，客户端不必解析 message）。 */
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ListingNumberLookupError'
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

export async function pruneExpiredNumberLookups(db: Db): Promise<void> {
  // Bounded opportunistic cleanup outside the quota transaction; SKIP LOCKED avoids
  // waiting on concurrent subjects, and the created_at index bounds the scan.
  await db.execute(sql`
    DELETE FROM listing_lookup_attempts WHERE id IN (
      SELECT id FROM listing_lookup_attempts
      WHERE created_at <= clock_timestamp() - interval '60 seconds'
      ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED
    )
  `)
}

export type ListingNumberLookup = {
  lookup(
    number: string,
    viewerId: string | null,
    trustedIp: string | null,
  ): Promise<{ id: `lst_${string}` }>
}

/** The HMAC key is API-only; domain separation prevents collision with meetup-token signatures. */
export function createListingNumberLookup(
  db: Db,
  listings: Pick<ListingService, 'getDetail'>,
  secret: string,
): ListingNumberLookup {
  const encoder = new TextEncoder()
  const key = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return {
    async lookup(number, viewerId, trustedIp) {
      const ip = viewerId ? null : normalizeIp(trustedIp)
      if (!viewerId && !ip) {
        throw new ListingNumberLookupError(
          503,
          'LISTING_LOOKUP_IP_UNAVAILABLE',
          '无法确认匿名请求来源',
        )
      }
      const type = viewerId ? 'user' : 'ip'
      let subject = viewerId
      if (!subject) {
        const digest = await crypto.subtle.sign(
          'HMAC',
          await key,
          encoder.encode(`listing-number-ip:${ip}`),
        )
        subject = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
      }
      const subjectKey = subject
      const quota: { allowed: true } | { allowed: false; retryAfterSeconds: number } =
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('listing-no-lookup'), hashtext(${`${type}:${subjectKey}`}))`,
          )
          await tx.execute(sql`DELETE FROM listing_lookup_attempts
          WHERE subject_type = ${type} AND subject_key = ${subjectKey}
            AND created_at <= clock_timestamp() - interval '60 seconds'`)
          const [row] = rowsOf(
            await tx.execute(sql`SELECT count(*)::int AS count,
            COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at))), 0)::float8 AS oldest_age
          FROM listing_lookup_attempts
          WHERE subject_type = ${type} AND subject_key = ${subjectKey}`),
          )
          if (Number(row?.count ?? 0) >= NUMBER_LOOKUP_MAX_ATTEMPTS) {
            // 滚动窗口：名额要等**最早**那次尝试滑出窗口才释放，所以剩余秒数由最老一条的年龄决定。
            // 取 `Math.max(1, …)` 是因为契约要求 `retryAfterSeconds` 是正整数。
            const oldestAgeSeconds = Number(row?.oldest_age ?? 0)
            return {
              allowed: false,
              retryAfterSeconds: Math.max(
                1,
                Math.ceil(NUMBER_LOOKUP_WINDOW_SECONDS - oldestAgeSeconds),
              ),
            }
          }
          await tx.execute(sql`INSERT INTO listing_lookup_attempts (id, subject_type, subject_key, created_at)
          VALUES (${newId()}::uuid, ${type}, ${subjectKey}, clock_timestamp())`)
          return { allowed: true }
        })
      if (!quota.allowed) {
        throw new ListingNumberLookupError(
          429,
          'LISTING_LOOKUP_RATE_LIMITED',
          '编号查询过于频繁',
          quota.retryAfterSeconds,
        )
      }
      if (Math.random() < 0.02) await pruneExpiredNumberLookups(db)
      const [found] = rowsOf(
        await db.execute(sql`
        SELECT id FROM listings WHERE listing_no = ${number}::bigint LIMIT 1
      `),
      )
      if (!found) throw new ListingNumberLookupError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')
      const id = String(found.id)
      // Reuse detail visibility, including seller-only OFFLINE/REVIEW access. A hidden hit and
      // a miss both consume the quota and return the same 404; no existence oracle is created.
      await listings.getDetail(viewerId, id)
      return ListingNumberLookupResponseSchema.parse({
        id: encodePublicId(PUBLIC_ID_PREFIX.listing, id),
      })
    },
  }
}
