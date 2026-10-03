/**
 * 愿望 → 匹配的解耦层（Issue #7 设计方案 §5）。
 * matching 模块与 worker 归 Dev A；本模块只投递事件。
 *
 * #322 M1 起 `enqueue` 投**两条** job：`EMBED_WISH`（语义向量刷新）与 `MATCH_WISH`（重算）。
 * 两者成对投递的理由与商品侧一致：愿望的 keyword/description/category 同时是打分输入与向量输入，
 * 分两处投递迟早会漏掉一边。
 *
 * **顺序即语义（#322 M4）**：`EMBED_WISH` 必须排在 `MATCH_WISH` **前面**。队列按 `(run_at, id)`
 * 领取，同一事务（这里两条 INSERT 在同一连接上顺序执行、`run_at` 都取事务时间）里
 * `id = newId() = Bun.randomUUIDv7()` 同毫秒单调递增 ⇒「插入序 = id 序 = 领取序」是确定的。
 * 反序就等于：第一轮 MATCH 跑在向量落库之前，引擎按 M2 降级契约落 `ranking_version = 1` 的行，
 * 而 `EMBED_WISH` 跑完不会回头重投 MATCH ⇒ 该愿望**永久**停在 v1，直到下一次编辑。
 */
import { buildWishEmbeddingText, contentHashOf } from '@fish/contracts/embedding/text'
import type { Db } from '@fish/db/client'
import { pruneStaleEmbeddings } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { wishes } from '@fish/db/schema/wishes'
import { eq, sql } from 'drizzle-orm'

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
 * 内容一变就让该愿望已有的向量行当场失效（#322 M2 复审 blocker）。
 *
 * 为什么不能只靠时间戳：实体 `updated_at` 是毫秒分辨率（数据库 `now()`，见
 * `packages/db/src/schema/common.ts`），同一毫秒内的两次编辑内容不同却版本相同——时间戳相等
 * 推不出内容相同（#328 的并发用例已确立）。所以判据
 * 必须是**内容**：用当前字段重算指纹，删掉指纹不符的向量行（`pruneStaleEmbeddings`）。
 *
 * 位置说明：愿望的写路径本身**不是事务化的**（`apps/api/src/modules/wishes/store.ts` 的 `update`
 * 先提交，`enqueue()` 随后执行；见 `service.ts` 里"不假装它原子"的注释）。这里不新造事务语义，
 * 而是把失效放在**投递这一步、且在 HTTP 响应返回之前**：一次成功的 PATCH 在返回客户端时，旧内容
 * 的向量已经不可召回。指纹一致（只改了预算/状态这类不进 embedding 文本的字段）时一行都不删，
 * 重跑的 `EMBED_WISH` 会走 `unchanged` 分支，不重复调用 provider。
 */
async function invalidateStaleEmbedding(db: Db, wishId: string): Promise<void> {
  const rows = await db
    .select({
      keyword: wishes.keyword,
      description: wishes.description,
      category: wishes.category,
    })
    .from(wishes)
    .where(eq(wishes.id, wishId))
    .limit(1)

  const row = rows[0]
  if (!row) return

  await pruneStaleEmbeddings(db, {
    entity: { kind: 'wish', id: wishId },
    contentHash: contentHashOf(buildWishEmbeddingText(row)),
  })
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
      // #322 M2 复审：先失效旧内容向量，再投递（理由见 invalidateStaleEmbedding）。
      await invalidateStaleEmbedding(db, wishId)

      // #322 M1：先投 EMBED_WISH（顺序理由见文件头注释），同样用 `::text::jsonb` 两段转型
      //（理由见下面的 ⚠️）。它的唯一键是 (payload->>'wishId') WHERE type='EMBED_WISH'
      // AND status='PENDING'——与 MATCH_WISH 那条"终身一条"刻意不同：已有待跑任务时 DO NOTHING
      // 即可，而任务跑完（DONE/FAILED）后再次编辑会真正插进一条新的，向量因此不会永久停在旧内容上。
      await db.execute(sql`
        INSERT INTO jobs (id, type, payload)
        VALUES (${newId()}, 'EMBED_WISH', ${JSON.stringify({ wishId })}::text::jsonb)
        ON CONFLICT DO NOTHING
      `)

      // 幂等：jobs_match_wish_wish_id_pending_uidx（(payload->>'wishId') 的 partial unique index，
      // 谓词是 type='MATCH_WISH' AND status='PENDING'）保证同一愿望至多一条**待跑**的 MATCH_WISH job；
      // 重复请求/重放被 DB 原子地忽略，而前一次投递真正失败（没插进去）时这里会补上一条。
      //
      // 谓词里的 status='PENDING' 是 #322 M2 修的（原先只有 type）：旧谓词下 DONE 的行会永久占位，
      // 编辑愿望后投的 job 被 ON CONFLICT DO NOTHING 静默吃掉，"改了就重算"从不发生。
      await db.execute(sql`
        INSERT INTO jobs (id, type, payload)
        VALUES (${newId()}, 'MATCH_WISH', ${JSON.stringify({ wishId })}::text::jsonb)
        ON CONFLICT DO NOTHING
      `)
    },
  }
}
