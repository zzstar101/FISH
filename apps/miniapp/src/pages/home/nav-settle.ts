/**
 * 分类切换的**落点**、**是否真的会滚动**，以及归位期间的吸顶判定锁时长。
 *
 * 落点是闲鱼口径：已滚过吸顶点 → 归位到「文字导航刚好吸顶」的位置；还没滚到 →
 * 原地不动（不把用户往下拽）。`+1` 让落点仍满足 `scrollTop >= pinAt`，判定不会在
 * 落点上自己翻面。
 *
 * 「是否真的会滚动」与落点是同一件事的两面：**落点等于当前位置时这一跳不带位移**，
 * 此时若照样锁住吸顶判定，用户点完分类立刻下滑的那 260ms 里吸顶条出不来（判定被钉在
 * 旧值上）—— 锁只能跟着**真的会发生滚动**的那一跳走（审查 P2：原来无条件上锁）。
 *
 * 抽成纯函数是因为这条判据的反例（「点完立刻下滑」）在组件里看不见：`pinAt` 由
 * `useReady` 量一次、量不到时是 `Infinity`，`scrollTopRef` 又是滚动中随时在变的
 * 设备 px。四种组合都在 `tests/home-category-settle.test.ts` 里锁住。
 */

/** 归位滚动时长（ms）。`Taro.pageScrollTo` 的 duration。 */
export const CATEGORY_SCROLL_DURATION = 200

/**
 * 归位期间的锁时长（ms）：必须**大于**滚动时长，否则动画还在跑锁就松了，
 * 判定会在动画末尾翻面（吸顶条滑出一半被拽回 = 抖动）。留 60ms 余量。
 */
export const NAV_SETTLE_MS = 260

/**
 * 落点相对吸顶点的偏移。`+1` 而不是 `+0`：落点若正好等于 `pinAt`，浮点/取整误差
 * 会让 `scrollTop >= pinAt` 在落点上自己翻 false，吸顶条刚到位置就被判定为该收起来。
 */
export const SETTLE_OVERSHOOT = 1

export type CategorySettle = {
  /** `Taro.pageScrollTo` 的目标位置（设备 px） */
  target: number
  /** 这一跳是否真的会移动（true 才需要 `pageScrollTo` + 锁吸顶判定） */
  repositions: boolean
}

export function resolveCategorySettle(current: number, pinAt: number): CategorySettle {
  // `pinAt` 还没量到（`Infinity`）时 `Math.min` 会给出 `current` —— 顺带成为
  // 「未量到就不动」的兜底，不需要额外的分支
  const target = Math.min(current, pinAt + SETTLE_OVERSHOOT)
  return { target, repositions: target < current }
}
