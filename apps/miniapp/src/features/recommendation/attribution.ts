/**
 * 详情页的推荐归因（Issue #323 R1 §3.5）。
 *
 * **为什么用页面参数而不是内存 Map / sessionStorage**：小程序页面参数随页面栈保存 ——
 * 从详情返回列表再进、系统回收页面后重建、分享链接直接打开，参数都还在；而模块级 Map
 * 只活在当前 JS 进程里（小程序进程随时可能被回收），一旦重建归因就静默丢失。
 * 更关键的是：参数是对**这一次导航**的精确归属，不存在「同一件商品从搜索页进来」
 * 被键冲突误判成推荐来源的问题，也就不需要 TTL 兜底。
 */
export type FeedAttribution = {
  requestId: string
  position: number
}

/** 详情页 URL 上的两个参数名；`pages/listing-detail/index.tsx` 按同名字段读取 */
const REQUEST_ID_PARAM = 'rid'
const POSITION_PARAM = 'pos'

/**
 * 拼详情页地址，带上归因参数（没有归因就只带 id）。
 *
 * `position` 为 0 也要带上：0 是合法序号（推荐流第一件），用真值判断会把它丢掉。
 */
export function buildListingDetailUrl(
  listingId: string,
  attribution: FeedAttribution | null,
): string {
  const base = `/pages/listing-detail/index?id=${encodeURIComponent(listingId)}`
  if (!attribution) return base
  const requestId = encodeURIComponent(attribution.requestId)
  return `${base}&${REQUEST_ID_PARAM}=${requestId}&${POSITION_PARAM}=${attribution.position}`
}

/** 从页面参数里读回归因；缺任一项或形状不对都返回 null（宁可没有归因，也不要脏归因） */
export function readFeedAttribution(
  params: Record<string, string | undefined>,
): FeedAttribution | null {
  const requestId = params[REQUEST_ID_PARAM]
  const rawPosition = params[POSITION_PARAM]
  if (!requestId || rawPosition === undefined) return null
  const position = Number.parseInt(rawPosition, 10)
  if (!Number.isInteger(position) || position < 0) return null
  return { requestId, position }
}
