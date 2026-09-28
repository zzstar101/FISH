/**
 * 愿望 → 匹配的解耦层（Issue #7 设计方案 §5）。
 * matching 模块与 worker 归 Dev A；本模块只投递事件。
 *
 * #322 M1 起 `enqueue` 投**两条** job：`MATCH_WISH`（v1 重算）与 `EMBED_WISH`（语义向量刷新）。
 * 两者成对投递的理由与商品侧一致：愿望的 keyword/description/category 同时是打分输入与向量输入，
 * 分两处投递迟早会漏掉一边。
 */
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

export interface WishMatchQueue {
  /** 投递该愿望的匹配重算 + 向量刷新（各自幂等，重复调用不会产生重复待跑任务）。 */
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
      // 幂等：jobs_match_wish_wish_id_uidx（payload->>'wishId' 的 partial unique index）保证
      // 同一个愿望最多一条 MATCH_WISH job；重复请求/重放被 DB 原子地忽略，
      // 而前一次投递真正失败（没插进去）时这里会补上一条。
      await db.execute(sql`
        INSERT INTO jobs (id, type, payload)
        VALUES (${newId()}, 'MATCH_WISH', ${JSON.stringify({ wishId })}::text::jsonb)
        ON CONFLICT DO NOTHING
      `)

      // #322 M1：同一入口投 EMBED_WISH，同样用 `::text::jsonb` 两段转型（理由见上面的 ⚠️）。
      // 它的唯一键是 (payload->>'wishId') WHERE type='EMBED_WISH' AND status='PENDING'——
      // 与 MATCH_WISH 那条"终身一条"刻意不同：已有待跑任务时 DO NOTHING 即可，而任务跑完
      // （DONE/FAILED）后再次编辑会真正插进一条新的，向量因此不会永久停在旧内容上。
      await db.execute(sql`
        INSERT INTO jobs (id, type, payload)
        VALUES (${newId()}, 'EMBED_WISH', ${JSON.stringify({ wishId })}::text::jsonb)
        ON CONFLICT DO NOTHING
      `)
    },
  }
}
