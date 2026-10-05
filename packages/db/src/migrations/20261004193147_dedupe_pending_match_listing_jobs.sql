-- #322 M4 §12.1「工程缺口一」的前置数据清理。
--
-- `MATCH_LISTING` 此前没有 partial unique index，投递侧是**裸 INSERT**
-- （`apps/api/src/modules/listings/store.ts`、`governance/service.ts`、`moderation/store.ts`），
-- 所以"同一个 listing 有多条 PENDING `MATCH_LISTING`"是**常态而非异常**：商品创建后、worker
-- 领走之前再编辑一次，就多出一条（本地开发库实测 3 组重复）。下一条 migration 要建
-- `jobs_match_listing_listing_id_pending_uidx`，而库里有重复行时 `CREATE UNIQUE INDEX` 会直接
-- 失败（`Key ((payload ->> 'listingId'::text))=(…) is duplicated`），因此必须**先**清理。
--
-- 只删"同一 `payload->>'listingId'` 分组里按 `(run_at, id)` 排序后第 2 条起的 PENDING 行"：
-- 保留下来的那条与其它条 payload 完全相同，且匹配 job 运行时重读实体现状（重算幂等），
-- 留最早的那条可以顺带保住队列领取顺序。RUNNING / DONE / FAILED 的历史行一律不动；
-- `payload->>'listingId' IS NULL` 的行（没有 listingId 的脏 payload）不参与分组——唯一索引对
-- NULL 不设约束，它们不需要清理。
DELETE FROM "jobs"
WHERE "type" = 'MATCH_LISTING'
  AND "status" = 'PENDING'
  AND "id" IN (
    SELECT "id"
    FROM (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY "payload"->>'listingId'
          ORDER BY "run_at", "id"
        ) AS "rn"
      FROM "jobs"
      WHERE "type" = 'MATCH_LISTING'
        AND "status" = 'PENDING'
        AND "payload"->>'listingId' IS NOT NULL
    ) AS "ranked"
    WHERE "rn" > 1
  );
