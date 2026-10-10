/**
 * 评价配图签名 URL 失效后的**自动补读判据**（#485 审查回修）。
 *
 * 评价图是服务端签发的 900 秒 capability URL（`REVIEW_MEDIA_URL_TTL_SECONDS`），
 * 页面挂后台超过 15 分钟再回来看就全是裂图 —— 契约不带 `expiresAt`，端上只能按 `onError` 兜底：
 * 补读一次列表 / 对账块，拿到**重新签发**的 URL。
 *
 * 为什么不能只按 URL 去重：每次补读都会换一批签名（token 对 `(key, 过期秒)` 确定性、
 * 过期秒每次都不同），所以「这个 URL 补读过了」在下一轮不成立 —— 一张**永久**失败的图
 * （对象被外部删掉）会 onError(旧) → 补读 → 新 URL → onError(新) → 补读 …… 无界。
 *
 * 所以判据是两道的：同一 URL 不重复补读 **且** 组件存活期内补读次数有硬上限。
 * 纯函数、不 import 任何 Taro 模块，`bun test` 直接加载（同 `review-form.ts` 的手法）。
 */

/** 组件存活期内允许的自动补读次数上限（正常过期补 1 次就够；余量留给长挂起反复过期） */
export const IMAGE_RELOAD_MAX = 3

export type ImageReloadState = {
  /** 已补读过的图片地址 */
  attempted: Set<string>
  /** 已补读次数 */
  count: number
}

export function createImageReloadState(): ImageReloadState {
  return { attempted: new Set(), count: 0 }
}

/**
 * 记一次图片加载失败，返回**是否应该发起补读**。返回 `true` 时状态已就地推进
 * （调用方只需 `setRefreshTick(+1)` / `read(...)`）。
 */
export function noteImageFailure(
  state: ImageReloadState,
  url: string,
  max: number = IMAGE_RELOAD_MAX,
): boolean {
  if (state.count >= max) return false
  if (state.attempted.has(url)) return false
  state.attempted.add(url)
  state.count += 1
  return true
}
