/**
 * 推荐 Feed 游标编解码（#323 §M7）。
 *
 * 契约规定 cursor 对前端是**不透明字符串**。这里用 base64url(JSON) 承载
 * `(listingCursor, requestId)`，而不是直接复用商品 Feed 的 `(created_at, id)` 游标：
 *
 * - **不能直接复用**：商品游标只说明"下一页从哪件商品开始"，它不带推荐上下文。
 *   翻页若拿不回同一个 `requestId`，同一次滚动就会被拆成两次推荐请求 —— 客户端算出的
 *   `position` 会从 0 重新开始，曝光序号在服务端看起来"第 3 位出现了两次"；
 * - **内层游标原样嵌套**：商品侧游标（`(排序键, id)`，见 listings/cursor.ts）的语义与
 *   校验都留在原处，这里不重新实现一遍排序键解析。伪造/截断的内层游标会被商品层拒绝 → 422；
 * - **外层只加 requestId**，并且路由层会验证它的归属（存在、属于当前身份）：
 *   游标可以伪造，但伪造的 requestId 不能冒充别人的推荐请求。
 *
 * 解码失败一律返回 `null`（路由层报 422），不做宽容解析：一个伪造或截断的游标如果被
 * 当成合法起点，用户会看到静默错乱的推荐流，比直接报错难查得多。
 */
import { isUuidShape } from './uuid'

export interface RecommendationCursor {
  listingCursor: string
  requestId: string
}

export function encodeRecommendationCursor(cursor: RecommendationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeRecommendationCursor(raw: string): RecommendationCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { listingCursor, requestId } = parsed as Record<string, unknown>
  // 多余的键直接拒：游标是服务端自己编的，出现第三个键说明它被伪造或来自另一个版本的编码。
  if (Object.keys(parsed).length !== 2) return null
  if (typeof listingCursor !== 'string' || listingCursor.length === 0) return null
  if (typeof requestId !== 'string' || !isUuidShape(requestId)) return null

  return { listingCursor, requestId }
}
