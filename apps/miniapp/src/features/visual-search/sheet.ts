/**
 * 识图结果页底部弹窗的几何与手势判据（纯逻辑，可单测）。
 *
 * Owner 2026-09-30 按参考图定版：结果页是**整张查询图打底 + 从底部升起的面板**，
 * 面板可以往下拖收起、再拉起来（不是页面级滚动）。
 *
 * 这里只回答三件事：
 * 1. **两个停靠位**（`sheetHeight`）：打开时占屏高的多少、收起时留多高；
 * 2. **拖动中的高度**（`dragSheet`）：夹在两个停靠位之间，且**不能越过收起位**（越过了面板
 *    就整块滑出屏幕，用户再也拉不回来）；
 * 3. **松手后停哪**（`settleSheet`）：先看甩动速度 —— 快速上甩/下甩直接按方向定；慢速松手
 *    才按「离哪个停靠位近」判断。速度优先是必须的：手指快速上甩时往往只拖过屏高的一小段，
 *    只看距离会把一次明确的「打开」判成「收起」。
 *
 * 收起位**不是 0**：留一条把手 + 一句提示，用户才有地方把它重新拉起来（参考图里那也是
 * 一个可点的把手条）。
 */

export type SheetStop = 'closed' | 'open'

/** 打开时面板高度占屏高的比例（参考图里面板约到屏幕 3/5 处） */
export const SHEET_OPEN_RATIO = 0.62

/**
 * 收起时留下的高度（设备 px）。
 *
 * 96 ≈ 把手 + 一行提示，刚好够手指按住往下/往上拖；比这更矮就没法稳定命中，
 * 而 0 会让面板彻底消失、无法再打开。
 */
export const SHEET_CLOSED_HEIGHT = 96

/** 判定「甩动」的速度阈值（px/ms）。慢于此按距离判断，快于此按方向判断。 */
export const SHEET_FLING_VELOCITY = 0.5

/** 某个停靠位对应的高度（设备 px）。 */
export function sheetHeight(stop: SheetStop, viewHeight: number): number {
  if (stop === 'closed') return SHEET_CLOSED_HEIGHT
  return Math.max(SHEET_CLOSED_HEIGHT, Math.round(viewHeight * SHEET_OPEN_RATIO))
}

/**
 * 拖动中的高度：`deltaY` 是**本次触摸相对上一次**的位移（向下为正 = 收起）。
 *
 * 夹在 `[SHEET_CLOSED_HEIGHT, openHeight]` 之间，两个方向都不越界。
 */
export function dragSheet(currentHeight: number, deltaY: number, viewHeight: number): number {
  const open = sheetHeight('open', viewHeight)
  const next = currentHeight - deltaY
  return Math.round(Math.min(open, Math.max(SHEET_CLOSED_HEIGHT, next)))
}

/**
 * 松手后停在哪个停靠位。
 *
 * - `velocity` 单位 px/ms（向下为正 = 收起方向）。**速度优先**：快速下甩直接收起、
 *   快速上甩直接打开，不管当时拖到哪 —— 只看距离会把明确的甩动手势判反。
 * - 慢速松手按「离哪个停靠位近」判断（中点是两个停靠位的算术平均）。
 */
export function settleSheet(height: number, velocity: number, viewHeight: number): SheetStop {
  if (velocity >= SHEET_FLING_VELOCITY) return 'closed'
  if (velocity <= -SHEET_FLING_VELOCITY) return 'open'

  const open = sheetHeight('open', viewHeight)
  const middle = (open + SHEET_CLOSED_HEIGHT) / 2
  return height >= middle ? 'open' : 'closed'
}

/**
 * 面板的 `translateY`（相对「完全展开」的位置）。
 *
 * 面板在 CSS 里按**打开高度**铺满、再整体下移；收起时下移 `open - closed`。
 * 用「铺满 + 下移」而不是「改高度」：改高度会让内部列表每帧重新布局（拖动时明显掉帧），
 * 而 transform 只走合成层。
 */
export function sheetTranslate(height: number, viewHeight: number): number {
  const open = sheetHeight('open', viewHeight)
  return Math.max(0, Math.round(open - height))
}
