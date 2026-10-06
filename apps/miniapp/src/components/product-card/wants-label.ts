/**
 * 「N 人想要」的渲染判据（#406 第 5 项）。
 *
 * 为什么不能写成 `wants === null`：这个计数的来源是**卡片外层**的
 * `VisualSearchResultItemSchema.favoriteCount`，而它的真实值由调用方透传
 * （`toMockListing(card, now, card.favoriteCount)`）。契约目前把它列为必填，所以
 * `undefined` 还进不来；一旦契约放宽（或上游/缓存的响应缺这个键），严格 `=== null`
 * 会让 `undefined` 一路漏进模板串，页面上就出现「undefined人想要」——
 * 那不是市场信号，是开发期的脏字，而且看起来像真的计数。
 *
 * 所以判据按**有没有拿到真数**写：`typeof wants === 'number'` 且是有限数。`null`、
 * `undefined`、`NaN` / `Infinity`、以及任何非数字（老 mock 里的字符串计数之类）一律不渲染，
 * 而不是编成 0。
 */
export function wantsLabel(wants: number | null | undefined): string | null {
  return typeof wants === 'number' && Number.isFinite(wants) ? `${wants}人想要` : null
}
