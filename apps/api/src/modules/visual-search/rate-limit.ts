import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/**
 * 拍照识图搜索的滚动窗口限流（#324 M2 / Q6=B：**允许匿名，但必须限流**）。
 *
 * 与 `apps/api/src/modules/listings/number-lookup.ts` 同一形态（那张表就是先例）：
 * 匿名身份先 HMAC 成 subject key 再落库，原始 IP 从不进入数据库；
 * 配额判定在**一条事务**里做「清过期 → 计数 → 插入」并用 advisory lock 串行化，
 * 所以并发请求不可能一起挤过窗口。
 *
 * 为什么不用进程内计数（`auth/scan-rate-limit.ts` 那种）：多实例部署下每台各算一份，
 * 实际额度会被实例数放大——那张表的注释自己就写了"多实例下不准"。
 * 拍照搜图的每次调用都要花钱（多模态向量化按图计费），额度必须是全局真值。
 *
 * ## 为什么一次请求要同时过多个主体
 *
 * 匿名请求同时按 `session`（换会话就换主体）与 `ip`（同一出口 IP 换会话）计数：
 * - 只按 IP：一个校园/运营商出口后面的所有正常用户共享额度，很快被无关的人耗光；
 * - 只按 session：清一下本地存储就重置，等于没有限制。
 *
 * 两条都要过，缺一不可；登录用户只按 `user` 计。任一主体超额即拒绝，
 * 剩余等待时间取**最晚**释放的那个（否则客户端按最短的等，重试必然再次被拒）。
 */
export const VISUAL_SEARCH_WINDOW_SECONDS = 60

/**
 * 窗口内允许的「上传 + 搜索」次数之和。
 *
 * 20 的依据：一次拍照搜图 = 1 次 presign + 1 次 search，正常用户一分钟内做十次已经远超需要；
 * 而每次 search 都会产生一次真实的多模态向量化调用，额度必须能挡住脚本刷量。
 */
export const VISUAL_SEARCH_MAX_ATTEMPTS = 20

export type VisualSearchAttemptSubject = {
  /** `user`（登录）/ `ip`（匿名按出口 IP）/ `session`（匿名按会话）。 */
  subjectType: 'user' | 'ip' | 'session'
  /** HMAC 后的主体标识（`user` 时就是 userId）。 */
  subjectKey: string
}

export class VisualSearchRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    message = '拍照搜图过于频繁，请稍后再试',
  ) {
    super(message)
    this.name = 'VisualSearchRateLimitError'
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

/**
 * 有界的机会式清理，配额事务之外执行。
 *
 * `SKIP LOCKED` 避免与并发主体的配额事务互相等待，`created_at` 索引把扫描限制在窗口边界附近。
 * 不清也不会错（配额判定自己会删本主体的过期行），只是表会慢慢变大。
 */
export async function pruneExpiredVisualSearchAttempts(db: Db): Promise<void> {
  await db.execute(sql`
    DELETE FROM visual_search_attempts WHERE id IN (
      SELECT id FROM visual_search_attempts
      WHERE created_at <= clock_timestamp() - make_interval(secs => ${VISUAL_SEARCH_WINDOW_SECONDS})
      ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED
    )
  `)
}

export type VisualSearchRateLimiter = {
  /** 消耗一次配额；超额抛 `VisualSearchRateLimitError`。`subjects` 为空表示无限流主体（不该发生）。 */
  consume(subjects: VisualSearchAttemptSubject[]): Promise<void>
}

/**
 * 上一次全局清理的进程内时刻（毫秒）。
 *
 * 清理是**尽力而为**的：配额判定自己会删本主体的过期行，不清也不会算错，只是"被放弃"的会话桶
 * 与兜底桶会慢慢积累。所以门控的是频率，不是正确性。
 *
 * 为什么不用概率（本文件原先的 `Math.random() < 0.02`）：期望值要 50 次请求才清理一次，而这条路
 * 每次调用都要花钱，低流量时等于永不清理；改成"每个窗口最多一次"后，清理频率与流量解耦。
 */
let lastPrunedAtMs = 0

export function createVisualSearchRateLimiter(db: Db): VisualSearchRateLimiter {
  return {
    async consume(subjects) {
      if (subjects.length === 0) return

      // advisory lock 按稳定顺序逐个获取：固定顺序 = 不会出现 A 等 B、B 等 A 的死锁。
      const ordered = [...subjects].sort((left, right) =>
        `${left.subjectType}:${left.subjectKey}`.localeCompare(
          `${right.subjectType}:${right.subjectKey}`,
        ),
      )

      const deniedAfterSeconds = await db.transaction(async (tx) => {
        for (const subject of ordered) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('visual-search'), hashtext(${`${subject.subjectType}:${subject.subjectKey}`}))`,
          )
        }

        let worstRetryAfterSeconds: number | null = null
        for (const subject of ordered) {
          await tx.execute(sql`DELETE FROM visual_search_attempts
            WHERE subject_type = ${subject.subjectType} AND subject_key = ${subject.subjectKey}
              AND created_at <= clock_timestamp() - make_interval(secs => ${VISUAL_SEARCH_WINDOW_SECONDS})`)
          const [row] = rowsOf(
            await tx.execute(sql`SELECT count(*)::int AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at))), 0)::float8 AS oldest_age
            FROM visual_search_attempts
            WHERE subject_type = ${subject.subjectType} AND subject_key = ${subject.subjectKey}`),
          )
          if (Number(row?.count ?? 0) >= VISUAL_SEARCH_MAX_ATTEMPTS) {
            // 滚动窗口：名额要等**最早**那次尝试滑出窗口才释放。
            // `Math.max(1, …)` 是因为契约要求 `retryAfterSeconds` 是正整数。
            const oldestAgeSeconds = Number(row?.oldest_age ?? 0)
            const retryAfterSeconds = Math.max(
              1,
              Math.ceil(VISUAL_SEARCH_WINDOW_SECONDS - oldestAgeSeconds),
            )
            worstRetryAfterSeconds =
              worstRetryAfterSeconds === null
                ? retryAfterSeconds
                : Math.max(worstRetryAfterSeconds, retryAfterSeconds)
          }
        }

        if (worstRetryAfterSeconds !== null) return worstRetryAfterSeconds

        for (const subject of ordered) {
          await tx.execute(sql`INSERT INTO visual_search_attempts (id, subject_type, subject_key, created_at)
            VALUES (${newId()}::uuid, ${subject.subjectType}, ${subject.subjectKey}, clock_timestamp())`)
        }
        return null
      })

      if (deniedAfterSeconds !== null) {
        throw new VisualSearchRateLimitError(deniedAfterSeconds)
      }

      const nowMs = Date.now()
      if (nowMs - lastPrunedAtMs >= VISUAL_SEARCH_WINDOW_SECONDS * 1000) {
        lastPrunedAtMs = nowMs
        await pruneExpiredVisualSearchAttempts(db)
      }
    },
  }
}
