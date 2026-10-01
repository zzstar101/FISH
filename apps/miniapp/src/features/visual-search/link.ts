/**
 * 识图 → 结果页的**页面间契约**（Taro-free，可单测）。
 *
 * 查询图对象键走 URL query：`pages/vision-result/index` 是普通页（不在 tabBar 的 list 里），
 * 所以 `navigateTo` 可达且能带参数 —— 与 `pages/wish` 跳搜索页是同一手法
 * （`apps/miniapp/src/pages/wish/index.tsx` 的 `/pages/search/index?q=…`）。
 *
 * 参数值用 `encodeURIComponent` 拼，消费侧必须用 `routeParam` 解一次：微信不会替调用方解码
 * （见 `apps/miniapp/src/lib/route-param.ts` 的说明）。对象键里带 `/`，漏了编码会把它拆成
 * 路径分隔符。
 *
 * **为什么另开一页而不是复用搜索结果页**：识图结果有搜索页没有的四块内容 —— 查询图与识别
 * 结论、价格区间、「重拍」回退、以及一套独立的失败态（设计稿 `设计稿_V1-vision-result.html`）。
 */

/** 查询图对象键的 query 参数名（写错只会表现为结果页拿不到图，静默失败） */
export const VISUAL_QUERY_OBJECT_KEY_PARAM = 'visualObjectKey'

/**
 * 查询图**本地临时路径**的 query 参数名。
 *
 * 只用于结果页查询图卡里的缩略图：查询图存在私有前缀（`visual-search/`），
 * `publicUrl()` 对非 `listings/*` 的键 fail-closed，服务端给不出可渲染的 URL ——
 * 所以拿本地这一份来显示。取不到就不显示（结果页有占位），不影响检索。
 */
export const VISUAL_QUERY_LOCAL_PATH_PARAM = 'visualQueryPath'

/** 识图结果页路由 */
export const VISION_RESULT_PAGE = '/pages/vision-result/index'

/** 带着查询图跳结果页的 URL */
export function visionResultPageUrl(objectKey: string, localPath?: string): string {
  const base = `${VISION_RESULT_PAGE}?${VISUAL_QUERY_OBJECT_KEY_PARAM}=${encodeURIComponent(objectKey)}`
  if (localPath === undefined || localPath === '') return base
  return `${base}&${VISUAL_QUERY_LOCAL_PATH_PARAM}=${encodeURIComponent(localPath)}`
}
