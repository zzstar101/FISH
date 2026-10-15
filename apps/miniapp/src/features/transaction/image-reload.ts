/**
 * 评价配图签名 URL 失效后的**自动补读闸门**（#485 审查回修）。
 *
 * 评价图是服务端签发的 900 秒 capability URL（`REVIEW_MEDIA_URL_TTL_SECONDS`），
 * 页面挂后台超过 15 分钟再回来看就全是裂图 —— 契约不带 `expiresAt`，端上只能按 `onError` 兜底：
 * 补读一次列表 / 对账块，拿到**重新签发**的 URL。
 *
 * 为什么不能只按 URL 去重：每次补读都会换一批签名（token 对 `(key, 过期秒)` 确定性、
 * 过期秒每次都不同），所以「这个 URL 补读过了」在下一轮不成立 —— 一张**永久**失败的图
 * （对象被外部删掉）会 onError(旧) → 补读 → 新 URL → onError(新) → 补读 …… 无界。
 *
 * 所以判据是**三道**：
 * 1. **一批只跑一个补读周期**（`inFlightUrl`）：一批同时过期的图（整屏缩略图一起裂是常态）
 *    只会并入**一个**在跑 / 在飞的补读周期。不合并的话三张图并发三次重读，既浪费请求，
 *    又会互相顶掉对方的落地（调用方按代次丢弃迟到响应）；
 * 2. 同一 URL 不重复补读（`attempted` 只记**真正发起过补读**的地址）；
 * 3. 组件存活期内补读**批次**数有硬上限（按批次计数，不是按张 —— 三张图一起过期是
 *    一批，不该一次吃掉三份预算）。
 *
 * **失败不留后患**（审查第三轮 P3）：调用方在补读落地后**必须** `finishImageReload`
 * 释放闸门，并如实传 `succeeded` —— 失败 / 中止时把这一批的触发地址从 `attempted`
 * 里撤掉，否则「一次失败 = 这些图在本页实例里永远不再自动补」。没被记进 `attempted`
 * 的地址（并入在飞那一批的其余图）本来就不受限制，可以各自触发后续批次；
 * 无界重读仍由**单调递增的批次计数**挡住。
 *
 * 纯函数、不 import 任何 Taro 模块，`bun test` 直接加载（同 `review-form.ts` 的手法）。
 */

/** 组件存活期内允许的自动补读**批次**上限（正常过期补 1 批就够；余量留给长挂起反复过期） */
export const IMAGE_RELOAD_MAX = 3

export type ImageReloadState = {
  /** 已真正发起过补读的图片地址（成功批次留下；失败 / 中止会在 `finishImageReload` 里撤掉） */
  attempted: Set<string>
  /** 已发起的补读批次（单调递增，失败不回收 —— 它是无界重读的最后一道闸） */
  count: number
  /** 在飞的那一批由哪个地址触发；`null` = 没有在飞（新失败可以另起一批） */
  inFlightUrl: string | null
}

export function createImageReloadState(): ImageReloadState {
  return { attempted: new Set(), count: 0, inFlightUrl: null }
}

/**
 * 记一次图片加载失败，返回**是否应该发起补读**。返回 `true` 时状态已就地推进
 * （调用方只需 `setRefreshTick(+1)` / 发起重读，并在落地后 `finishImageReload(state, ok)`）。
 *
 * 返回 `false` 的三种情形都是「什么都不做」：
 * - 这个地址已经触发过一次补读（同一签名不必再读一遍 —— 令牌对 `(key, 过期秒)`
 *   确定性，同一秒重签出的是同一个地址）；
 * - 已有补读周期在跑：**并入它**。并入的地址**不记入** `attempted`：那一批若失败，
 *   它们还要能各自再触发后续批次（记下就会把它们永久挡在门外）；
 * - 批次预算用完。
 */
export function noteImageFailure(
  state: ImageReloadState,
  url: string,
  max: number = IMAGE_RELOAD_MAX,
): boolean {
  if (state.attempted.has(url)) return false
  if (state.inFlightUrl !== null) return false
  if (state.count >= max) return false
  state.attempted.add(url)
  state.count += 1
  state.inFlightUrl = url
  return true
}

/**
 * 补读落地后释放闸门，让下一批过期图还能补。
 *
 * `succeeded = false`（请求失败 / 中止）时把本批触发地址从 `attempted` 里撤掉：
 * 补读没换来新地址，这些图不该被记成「补过了」。批次计数不回退 ——
 * 单调计数才是「永久失败的图不会无界重读」的那道闸。
 */
export function finishImageReload(state: ImageReloadState, succeeded: boolean): void {
  if (!succeeded && state.inFlightUrl !== null) state.attempted.delete(state.inFlightUrl)
  state.inFlightUrl = null
}
