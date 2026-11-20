import type { Db } from '@fish/db/client'
import { type SQL, sql } from 'drizzle-orm'

/** 一次限流检查：全部条目都通过才一起记一次事件，任一不过则整体拒绝且不写任何行。 */
export type RateLimitEntry = {
  bucket: string
  subject: string
  limit: number
  windowSeconds: number
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; bucket: string }

export interface RateLimitStore {
  takeAll(entries: readonly RateLimitEntry[]): Promise<RateLimitDecision>
}

type CountRow = { count: number | string; oldest: Date | string | null }

/**
 * 读取某主体在当前窗口内的事件数；顺带删除窗口外的旧行（同一语句里的 DELETE 有界）。
 * 调用方必须在事务里、且已对 `(bucket, subject)` 取 advisory lock，保证「查 + 写」原子。
 */
type Executor = { execute(query: SQL): Promise<unknown> }

async function windowCount(
  tx: Executor,
  entry: RateLimitEntry,
): Promise<{ count: number; oldest: Date | string | null }> {
  await tx.execute(sql`
    DELETE FROM rate_limit_events
    WHERE bucket = ${entry.bucket}
      AND subject = ${entry.subject}
      AND created_at <= now() - (${entry.windowSeconds} * interval '1 second')
  `)
  const result = await tx.execute(sql`
    SELECT count(*)::int AS count, min(created_at) AS oldest
    FROM rate_limit_events
    WHERE bucket = ${entry.bucket}
      AND subject = ${entry.subject}
      AND created_at > now() - (${entry.windowSeconds} * interval '1 second')
  `)
  const row = (result as unknown as CountRow[])[0]
  return { count: Number(row?.count ?? 0), oldest: row?.oldest ?? null }
}

function retryAfterSeconds(oldest: Date | string | null, windowSeconds: number): number {
  if (oldest === null) return windowSeconds
  const oldestMs = new Date(oldest).getTime()
  const waitMs = oldestMs + windowSeconds * 1000 - Date.now()
  return Math.max(1, Math.ceil(waitMs / 1000))
}

export function createSqlRateLimitStore(db: Db): RateLimitStore {
  return {
    async takeAll(entries) {
      if (entries.length === 0) return { allowed: true }
      return db.transaction(async (tx) => {
        // 同一 (bucket, subject) 的并发请求在这里串行化：先查后写必须原子，否则两个并发
        // 请求会同时看到「还差一条」并一起写入，突破配额。
        for (const entry of [...entries].sort((a, b) =>
          `${a.bucket}:${a.subject}`.localeCompare(`${b.bucket}:${b.subject}`),
        )) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`rate:${entry.bucket}:${entry.subject}`}, 0))`,
          )
        }
        let rejected: (RateLimitDecision & { allowed: false }) | null = null
        for (const entry of entries) {
          const { count, oldest } = await windowCount(tx, entry)
          if (count >= entry.limit) {
            const wait = retryAfterSeconds(oldest, entry.windowSeconds)
            // 多个桶同时命中时取最长等待：客户端一次倒计时就能覆盖所有拒绝。
            if (!rejected || wait > rejected.retryAfterSeconds) {
              rejected = { allowed: false, retryAfterSeconds: wait, bucket: entry.bucket }
            }
          }
        }
        if (rejected) return rejected
        for (const entry of entries) {
          await tx.execute(sql`
            INSERT INTO rate_limit_events (bucket, subject)
            VALUES (${entry.bucket}, ${entry.subject})
          `)
        }
        // 访问路径之外没有人清理：每次成功计数顺手删掉远超最长窗口（10 分钟）的旧行，
        // 由 created_at 索引兜住，避免这张表无限增长。
        await tx.execute(sql`
          DELETE FROM rate_limit_events WHERE created_at <= now() - interval '1 hour'
        `)
        return { allowed: true as const }
      })
    },
  }
}
