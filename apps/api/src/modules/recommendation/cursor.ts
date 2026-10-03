/**
 * 推荐 Feed 游标编解码（#323 §M7）。
 *
 * 契约规定 cursor 对前端是**不透明字符串**。R4 起有两种游标，编码上靠"第二个键是谁"区分：
 *
 * - **snapshot**（排序 Feed 的常态）：`{ requestId, offset }`。排序结果已经按 position 冻结在
 *   `recommendation_request_items` 里，翻页只是按 offset 切片，因此不需要也不应该重跑召回与排序
 *   （重跑会让同一批候选在两次请求里得到不同分数与顺序，用户会看到商品重复或漏掉）；
 * - **passthrough**（R1 的旧形态，也是排序失败降级回 `newest` 时的形态）：
 *   `{ requestId, listingCursor }`。内层游标原样嵌套给商品层，语义与校验都留在
 *   `listings/cursor.ts`，这里不重新实现一遍排序键解析。
 *
 * **两种形状都是恰好两个键**，所以 R1/R2/R3 期间发出的旧游标天然解码成 passthrough，部署瞬间
 * 在途的会话不会突然 422（N4）：那些请求行的版本恒为 `rec-v1-none`（R1 起只写过这一个值）。
 *
 * 形状只是**一半**的校验：`service.startFeed` 还要求游标形状与请求行实际走的策略一致
 * （passthrough 只对 `rec-v1-none` 有效，snapshot 只对排序请求有效）。否则客户端自造一个
 * `{listingCursor, requestId}` 就能把排序请求带去 newest 透传：那一页发出去的卡片没有快照行，
 * 它们随后的曝光会被归因层按 `attribution_not_found` 逐条拒收 —— 用户侧表现为曝光数据丢失。
 *
 * 外层都要带 `requestId`：翻页若拿不回同一个请求，同一次滚动就会被拆成两次推荐请求 —— 客户端
 * 算出的 `position` 会从 0 重新开始，曝光序号在服务端看起来"第 3 位出现了两次"。
 *
 * 解码失败一律返回 `null`（路由层报 422），不做宽容解析：一个伪造或截断的游标如果被当成合法
 * 起点，用户会看到静默错乱的推荐流，比直接报错难查得多。
 */
import { RECOMMENDATION_SNAPSHOT_MAX_ITEMS } from '@fish/contracts/recommendation/rank'
import { isUuidShape } from './uuid'

export interface RecommendationSnapshotCursor {
  kind: 'snapshot'
  requestId: string
  /** 下一页在快照中的起始下标（0-based）。 */
  offset: number
}

export interface RecommendationPassthroughCursor {
  kind: 'passthrough'
  requestId: string
  /** 商品 Feed 的不透明游标，原样交给 `listings` 层。 */
  listingCursor: string
}

export type RecommendationCursor = RecommendationSnapshotCursor | RecommendationPassthroughCursor

export function encodeRecommendationCursor(cursor: RecommendationCursor): string {
  const payload =
    cursor.kind === 'snapshot'
      ? { requestId: cursor.requestId, offset: cursor.offset }
      : { requestId: cursor.requestId, listingCursor: cursor.listingCursor }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeRecommendationCursor(raw: string): RecommendationCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  // 多余的键直接拒：游标是服务端自己编的，出现第三个键说明它被伪造或来自另一个版本的编码。
  if (Object.keys(record).length !== 2) return null

  const { requestId } = record
  if (typeof requestId !== 'string' || !isUuidShape(requestId)) return null

  const { offset } = record
  if (typeof offset === 'number' && Number.isInteger(offset)) {
    // 快照最多 `RECOMMENDATION_SNAPSHOT_MAX_ITEMS` 条，越界的 offset 只可能来自伪造或旧版本。
    if (offset < 0 || offset > RECOMMENDATION_SNAPSHOT_MAX_ITEMS) return null
    return { kind: 'snapshot', requestId, offset }
  }

  const { listingCursor } = record
  if (typeof listingCursor !== 'string' || listingCursor.length === 0) return null

  return { kind: 'passthrough', requestId, listingCursor }
}
