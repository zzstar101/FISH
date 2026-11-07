/**
 * 「这一次识图的原图」从入口页交给结果页的**一次性交接位**。
 *
 * Owner 2026-09-30：结果页是**共享元素式**切换 —— 背后保留那张拍照原图，主内容从底部
 * 弹上来。#583 起拍图搜**整图上传**、不再取框，结果页也不再画取框（交接位随之去掉 `crop`）。
 *
 * 与 `features/listing/edit-target.ts`（我的发布 → 出物页）同一手法。
 *
 * ## 两段式：先 stash 原图，上传拿到 objectKey 后再 bind
 *
 * 原图要在**上传之前**就记下来（页面跳走之后本页的 state 就没人读了），而「这是哪一次搜索」
 * 只有上传成功、拿到 `objectKey` 才知道。所以分两步：`stashVisualShot` → `bindVisualShot`。
 * 结果页按 `objectKey` 读（`readVisualShot`），于是：
 * - 重复渲染拿到同一份（不会「背景时有时无」）；
 * - 换了图（键对不上）拿到 `null`，**不会把上一张照片当背景**——那比没有背景更糟。
 */
export type VisualShot = {
  /** 这张原图对应的查询图对象键（与结果页 URL 里的 `visualObjectKey` 同一个值） */
  objectKey: string
  /** 拍照原图的本地临时路径（结果页的背景图） */
  path: string
}

/** 未绑定 objectKey 的暂存态（上传还没回来） */
type PendingShot = Omit<VisualShot, 'objectKey'> & { objectKey: string | null }

let pending: PendingShot | null = null

/** 入口页调用（**上传之前**）：记下这次的原图 */
export function stashVisualShot(shot: Omit<VisualShot, 'objectKey'>): void {
  pending = { ...shot, objectKey: null }
}

/** 入口页调用（上传成功、跳转之前）：把「这是哪一次搜索」补上 */
export function bindVisualShot(objectKey: string): void {
  if (pending === null) return
  pending = { ...pending, objectKey }
}

/**
 * 结果页调用：取与 `objectKey` 对应的那一份；对不上就清掉并返回 `null`。
 *
 * **不清空匹配成功的那一份**：同一次页面进入里的重复渲染要拿到同一个结果，
 * 而换了一张图时键不同、自然读不到旧的（并且顺手清掉，避免它继续赖着）。
 */
export function readVisualShot(objectKey: string): VisualShot | null {
  const shot = pending
  if (shot === null || objectKey === '' || shot.objectKey === null) return null
  if (shot.objectKey !== objectKey) {
    // 键对不上 = 这是一张**新的**查询图（或上一次的残留）：丢掉，别把旧照片当背景
    pending = null
    return null
  }
  return { ...shot, objectKey: shot.objectKey }
}
