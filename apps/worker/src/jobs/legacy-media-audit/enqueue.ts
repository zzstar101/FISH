import { LEGACY_MEDIA_AUDIT_JOB_TYPE } from '@fish/contracts/legacy-media/jobs'
import type { Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import {
  type LegacyMediaAuditCandidate,
  listLegacyMediaAuditCandidates,
} from '@fish/db/legacy-media-audit'
import { jobs } from '@fish/db/schema/jobs'

/**
 * #694 M8：把 inventory 里到点可补审的对象各投一条 job。
 *
 * 一个对象一条 job，批大小由调用方控制：单个对象的上游失败只影响自己那条 job，
 * 不会让整批一起进入重试。`jobs` 上有一条 (`payload->>'objectKey'`) 的
 * **PENDING 部分唯一索引**，因此并发调度/重复投递不会产生重复待办；已经 DONE 的 job
 * 不阻止下一轮重投（失败重试由 inventory 的 `next_attempt_at` 决定）。
 *
 * `payload` 必须走 `jsonParam`：裸对象经 drizzle + bun-sql 会被二次 stringify，落成
 * **jsonb 字符串**而不是对象，`payload->>'objectKey'` 为 NULL —— 索引对它形同不存在，
 * 去重直接失效（`packages/db/src/json.ts` 有对照说明）。
 */
export async function enqueueLegacyMediaAuditBatch(
  db: Db,
  input: { limit: number; maxAttempts: number },
): Promise<{ enqueued: number; candidates: LegacyMediaAuditCandidate[] }> {
  const candidates = await listLegacyMediaAuditCandidates(db, {
    limit: input.limit,
    maxAttempts: input.maxAttempts,
  })
  let enqueued = 0
  for (const candidate of candidates) {
    const inserted = await db
      .insert(jobs)
      .values({
        type: LEGACY_MEDIA_AUDIT_JOB_TYPE,
        payload: jsonParam({ objectKey: candidate.objectKey }),
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id })
    if (inserted.length > 0) enqueued += 1
  }
  return { enqueued, candidates }
}
