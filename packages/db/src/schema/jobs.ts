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
export type JobType = 'MATCH_LISTING' | 'MATCH_WISH' | 'EMBED_LISTING' | 'EMBED_WISH'

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
  ],
)
