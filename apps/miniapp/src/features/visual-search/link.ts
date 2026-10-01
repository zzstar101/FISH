/**
 * 识图 → 搜索页的**页面间契约**（Taro-free，可单测）。
 *
 * 查询图对象键走 URL query：`pages/search/index` 不在 tabBar 里（`app.config.ts` 的 list 只有
 * 首页/许愿/出物/消息/我的），所以 `navigateTo` 可达且能带参数 —— 与 `pages/wish` 跳搜索页
 * 是同一手法（`apps/miniapp/src/pages/wish/index.tsx:200` 的 `/pages/search/index?q=…`）。
 * 如果是 tabBar 页就只能 `switchTab`（带不了参数），得另做一次跨页暂存 —— 这里靠它是普通页。
 *
 * 参数值用 `encodeURIComponent` 拼，消费侧必须用 `routeParam` 解一次：微信不会替调用方解码
 * （见 `apps/miniapp/src/lib/route-param.ts` 的说明）。
 */

/** 查询图对象键的 query 参数名（写错只会表现为搜索页拿不到图，静默失败） */
export const VISUAL_QUERY_OBJECT_KEY_PARAM = 'visualObjectKey'

/** 搜索页路由 */
export const SEARCH_PAGE = '/pages/search/index'

/** 带着查询图跳搜索页的 URL（分支 2 的搜索页消费这个参数） */
export function visualSearchPageUrl(objectKey: string): string {
  return `${SEARCH_PAGE}?${VISUAL_QUERY_OBJECT_KEY_PARAM}=${encodeURIComponent(objectKey)}`
}
