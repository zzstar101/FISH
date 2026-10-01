import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/**
 * 行为事件 → 长期画像重算的解耦层（#323 R2）。
 *
 * 与 `apps/api/src/modules/wishes/match-queue.ts` 同形：api 只负责"这个用户的行为变了，投一条 job"，
 * 聚合与写库全在 worker（长期画像 = 近 180 天行为的全量重算，是一次后台计算，不能挂在
 * `POST /recommendations/events` 的请求线程上）。
 *
 * **画像只能由这条链产出**：session 画像（api，请求时实时算）不落库，所以"行为写入"是长期画像
 * 唯一的失效来源；漏投一次，这个用户的长期画像就会停在旧数据上，直到下一次行为到来。
 */
export interface InterestRefreshQueue {
  /**
   * 投递该用户的长期画像重算。幂等：同一用户至多一条**待跑**的 job
   * （`jobs_refresh_user_interest_user_id_pending_uidx`），重复调用不会堆任务。
   */
  enqueue(userId: string): Promise<void>
}

/**
 * 真实投递：往 `jobs` 表插一条 PENDING 的 `REFRESH_USER_INTEREST`（消费方见
 * `apps/worker/src/jobs/interest/handlers.ts`）。
 *
 * ⚠️ payload 必须写成 `${...}::text::jsonb` 两段转型（同 `match-queue.ts` 的注释）：本仓的
 * drizzle + bun-sql 组合下直接 `::jsonb` 会把已序列化的字符串再编码一次，落成 jsonb **字符串标量**
 * （`jsonb_typeof='string'`），消费方 `payload->>'userId'` 恒为 NULL，而部分唯一索引的表达式
 * 也就跟着失效——两件事会一起坏掉。
 *
 * 幂等键的谓词必须带 `status='PENDING'`：只锁 type 的话，先跑完的那条（DONE）会永久占位，
 * 之后所有投递都被 `ON CONFLICT DO NOTHING` 静默吃掉，"行为变了就重算"从此不再发生
 * （#322 M2 修过同一个坑）。
 */
export function createDbInterestRefreshQueue(db: Db): InterestRefreshQueue {
  return {
    async enqueue(userId: string) {
      await db.execute(sql`
        INSERT INTO jobs (id, type, payload)
        VALUES (${newId()}, 'REFRESH_USER_INTEREST', ${JSON.stringify({ userId })}::text::jsonb)
        ON CONFLICT DO NOTHING
      `)
    },
  }
}
