import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'

export const jobStatusEnum = pgEnum('job_status', ['PENDING', 'RUNNING', 'DONE', 'FAILED'])

/** job 类型跨 Owner 增长，用 text + TS 收窄，避免每加一类都要改 migration。 */
export type JobType =
  | 'MATCH_LISTING'
  | 'MATCH_WISH'
  | 'EMBED_LISTING'
  | 'EMBED_WISH'
  /** #323 R2：从 0 重算某个用户的长期兴趣画像（payload `{userId}`）。 */
  | 'REFRESH_USER_INTEREST'
  /** #324 M8：为 Listing 封面生成视觉向量（回填与"换图后重算"共用同一种 job）。 */
  | 'VISUAL_EMBED_LISTING'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 异步任务队列（PostgreSQL 表 + Worker 轮询）。
 *
 * 领取：`WHERE status='PENDING' AND run_at <= now() ORDER BY run_at, id FOR UPDATE SKIP LOCKED`
 * 之后置 `status='RUNNING', locked_at=now(), attempts=attempts+1`。
 * worker 崩溃后那行会停在 RUNNING，由 worker 启动时的回收处理：`status='RUNNING'` 且未达重试上限的
 * 回 `PENDING`，已达上限的直接 `FAILED`（不判 `locked_at` 时限——当前是单 worker 拓扑，
 * 启动时看到的 RUNNING 必属于已死进程；见 `apps/worker/src/jobs/queue.ts` 的 `recoverStaleClaims`）。
 */
export const jobs = pgTable(
  'jobs',
  {
    ...primaryKey(),
    type: text('type').$type<JobType>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    /** 支持退避重试：到点之前不领取。 */
    runAt: timestamptz('run_at').notNull().defaultNow(),
    lockedAt: timestamptz('locked_at'),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (table) => [
    check('jobs_attempts_non_negative', sql`${table.attempts} >= 0`),
    index('jobs_status_run_at_id_idx').on(table.status, table.runAt, table.id),
    index('jobs_running_locked_at_idx').on(table.lockedAt).where(sql`${table.status} = 'RUNNING'`),
    /*
     * 幂等键（#7 的重复请求/重放不得刷出重复任务；#322 M2 修正谓词）：
     * 同一个愿望最多一条**待执行**（`status = 'PENDING'`）的 MATCH_WISH job。
     *
     * 原谓词只有 `type = 'MATCH_WISH'`（实体终身一条），后果是 `DONE` 行永久占位：
     * 愿望被编辑后 `updateWish` 投的新 job 会被 `ON CONFLICT DO NOTHING` 静默吃掉，
     * 于是"编辑愿望 → 重算匹配"从不发生。加上 `status = 'PENDING'` 后，投递幂等性
     * （同一时刻只排一条）不变，但终态行不再阻塞后续重投——与下面的 EMBED_* 同一形状。
     * 索引名一并改掉：旧名 `..._wish_id_uidx` 描述的是错误语义，留着会误导。
     */
    uniqueIndex('jobs_match_wish_wish_id_pending_uidx')
      .on(sql`(${table.payload}->>'wishId')`)
      .where(sql`${table.type} = 'MATCH_WISH' AND ${table.status} = 'PENDING'`),
    /*
     * #322 M4 §12.1 遗留缺口：`MATCH_LISTING` 此前**没有** partial unique index，投递侧只能靠
     * `NOT EXISTS (… status = 'PENDING')` 去重（`apps/worker/src/jobs/matching/enqueue.ts`），
     * 而 `NOT EXISTS` 在并发下不是原子的——两个插入者可能同时通过它，最坏多出一条**幂等**重算。
     * 与 `MATCH_WISH` 同形（谓词必须带 `status = 'PENDING'`：`DONE` 行不能永久占位，否则
     * "编辑商品 → 重算匹配"在第一次跑完之后就再也不触发）。
     */
    uniqueIndex('jobs_match_listing_listing_id_pending_uidx')
      .on(sql`(${table.payload}->>'listingId')`)
      .where(sql`${table.type} = 'MATCH_LISTING' AND ${table.status} = 'PENDING'`),
    // #322 M1：EMBED_* 的幂等键**只锁"待执行"那一行**（`status = 'PENDING'`），
    // 与上面 MATCH_WISH 的"实体终身一条"刻意不同：内容改动后必须能重新投递
    // （否则编辑永远不触发重新生成），而仍在队列里的那一条本来就会在运行时重读实体
    // （见 `apps/worker/src/jobs/embedding/handlers.ts`），重复投递没有意义。
    uniqueIndex('jobs_embed_listing_listing_id_uidx')
      .on(sql`(${table.payload}->>'listingId')`)
      .where(sql`${table.type} = 'EMBED_LISTING' AND ${table.status} = 'PENDING'`),
    uniqueIndex('jobs_embed_wish_wish_id_uidx')
      .on(sql`(${table.payload}->>'wishId')`)
      .where(sql`${table.type} = 'EMBED_WISH' AND ${table.status} = 'PENDING'`),
    /*
     * #323 R2：同一个用户最多一条**待执行**的画像重算 job。
     *
     * 与 EMBED_* 同形（`status = 'PENDING'` 谓词不能省）：画像重算是"按当前数据从 0 全量重算"，
     * 重复投递没有意义，所以"待执行去重"就够；但 RUNNING 期间到达的新行为必须能再排一条，
     * 否则那批行为要等下一次有人动这个用户才会进画像（`docs/design/issue-322-matching-v2-m1.md`
     * 记过同一个坑）。
     */
    uniqueIndex('jobs_refresh_user_interest_user_id_pending_uidx')
      .on(sql`(${table.payload}->>'userId')`)
      .where(sql`${table.type} = 'REFRESH_USER_INTEREST' AND ${table.status} = 'PENDING'`),
    // #324 M8：视觉回填的幂等键，形状与 EMBED_LISTING 完全一致（只锁待执行那一条）。
    // 封面被换掉时"再投一条"是必须能成功的——所以不能把 DONE 行也纳入唯一键。
    uniqueIndex('jobs_visual_embed_listing_listing_id_pending_uidx')
      .on(sql`(${table.payload}->>'listingId')`)
      .where(sql`${table.type} = 'VISUAL_EMBED_LISTING' AND ${table.status} = 'PENDING'`),
  ],
)
