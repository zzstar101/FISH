/**
 * 愿望 → 匹配的解耦层（Issue #7 设计方案 §5）。
 * matching 模块与 worker 归 Dev A；本模块只投递事件。
 */
import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'

export interface WishMatchQueue {
  enqueue(wishId: string): Promise<void>
}

export function createNoopWishMatchQueue(): WishMatchQueue {
  return {
    async enqueue(wishId: string) {
      console.log(`[wishes] match job not enqueued (noop queue): ${wishId}`)
    },
  }
}

/**
 * 真实投递：往 jobs 表插一条 PENDING 的 MATCH_WISH job，由 worker 轮询消费（#2/#13）。
 * #2 的 jobs schema 已把 MATCH_WISH 收进 JobType，payload 只放 wishId，
 * 匹配参数由消费方按 wishId 现查，避免 payload 与 wishes 行漂移。
 *
 * ⚠️ payload 必须写成 `${...}::text::jsonb` 两段转型。本仓的 drizzle(0.45) + bun-sql 组合下，
 * 直接 `${...}::jsonb` 或 drizzle 的 jsonb insert 都会把已序列化的字符串再编码一次，
 * 落库为 jsonb **字符串标量**（jsonb_typeof='string'），消费方 `payload->>'wishId'` 恒为 NULL。
 * 走 text 转型可让驱动按文本绑定，再由 PG 解析成 jsonb 对象（store.test.ts 有集成用例守着）。
 */
export function createDbWishMatchQueue(db: Db): WishMatchQueue {
  return {
    async enqueue(wishId: string) {
      await db.execute(sql`
        INSERT INTO jobs (id, type, payload)
        VALUES (${crypto.randomUUID()}, 'MATCH_WISH', ${JSON.stringify({ wishId })}::text::jsonb)
      `)
    },
  }
}
