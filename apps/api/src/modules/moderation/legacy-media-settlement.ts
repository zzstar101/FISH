import { sql } from 'drizzle-orm'
import type { SettleLegacyMediaAuditHook } from './store'

/**
 * 存量图片补审结算（#694 审查 P1-3）。
 *
 * 管理端对 REVIEW 商品放行 / 拒绝后，只改 `listings.moderation_status` 是不够的：读侧
 * （详情、封面、legacy 代理）读的是 `legacy_media_audit_items.decision`，不同步就会留下
 * 「商品已批准、图仍 404」的死结。这里在同一事务里把该商品引用、且仍是机器 `REVIEW` 的
 * 补审记录改判成人工结论。
 *
 * 只改 `AUDITED + REVIEW`：
 * - `AUDITED + BLOCK` 是上游明确拒绝，商品放行不能替它翻案（要恢复走补审队列的
 *   `BLOCK → ALLOW`，那里的审计日志留痕）；
 * - `PENDING` / `FAILED` 还没有人工可依据的结论，等补审跑完再说。
 */
export function createLegacyMediaAuditSettlement(): SettleLegacyMediaAuditHook {
  return async (tx, { listingId, decision }) => {
    await tx.execute(sql`
      UPDATE legacy_media_audit_items AS item
      SET decision = ${decision}::moderation_decision,
          version = item.version + 1,
          updated_at = now()
      FROM listing_images AS li
      WHERE li.listing_id = ${listingId}::uuid
        AND li.object_key = item.object_key
        AND item.audit_status = 'AUDITED'
        AND item.decision = 'REVIEW'
    `)
  }
}
