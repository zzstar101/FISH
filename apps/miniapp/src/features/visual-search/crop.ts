/**
 * 识图取框的几何（纯逻辑，可单测）。
 *
 * 交互取自 Owner 2026-09-29 给的两张参考图：拍照后**图片固定**，程序先按页面里那个取景框
 * 的位置放一个初始框，用户可拖四角 / 四边放大、拖框内移动，确认后再用这个框去搜。
 * 所以这里要回答三件事：
 *
 * 1. **初始框放哪**（`centeredBox`）：与拍照前那个取景框**同一位置同一尺寸** —— 用户在取景
 *    时对准的范围，就是他按下快门后看到的框，不该跳一下。
 * 2. **触点落在哪个手柄上**（`cropHandleAt`）：四角优先于四边（角上两个方向都能拖，是更常用
 *    的意图）；都不命中才是「移动」。
 * 3. **拖完框在哪**（`dragCropBox`）：带最小边长与边界夹紧 —— 不夹紧的话框能被拖出图片，
 *    裁出来就是空白；不设最小边长则框会缩成一个点，用户再也抓不住手柄。
 *
 * 另外几个映射函数解决「显示坐标 ↔ 图片像素」：全屏显示用的是 `aspectFill`（铺满、裁掉
 * 溢出），所以显示坐标到原图像素之间有一次缩放加一次居中偏移，裁剪时必须反算，否则取框
 * 位置与用户看到的完全对不上。
 *
 * 坐标一律用**设备 px**（触摸事件的 `clientX/clientY` 与 `boundingClientRect` 都是它），
 * 不掺 rpx：rpx 只存在于样式表，换算放在调用方（`centeredBox` 的 `frame` 参数就是换算后的 px）。
 */

export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { width: number; height: number }
export type Point = { x: number; y: number }

/** 手柄：四角（`tl`/`tr`/`bl`/`br`）、四边中点（`t`/`b`/`l`/`r`）、框内（`move`）。 */
export type CropHandle = 'move' | 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r'

/**
 * 框的最小边长（设备 px）。
 *
 * 为什么是 48：手指的触点半径大约 20px，框再小两个相邻手柄的命中区就会重叠，用户拖哪边
 * 都变成拖另一边；同时 48px 在 390pt 屏上约 12pt，再小裁出来的图也没有检索价值。
 */
export const MIN_CROP_SIZE = 48

/** 手柄命中容差（设备 px）：比 `MIN_CROP_SIZE` 的一半略小，保证相邻手柄的命中区不重叠。 */
export const HANDLE_TOLERANCE = 22

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 初始框：与取景框同尺寸、同中心。
 *
 * `frame` 是取景框的**设备 px** 尺寸（设计稿的 500×520rpx 由调用方按 `windowWidth / 750`
 * 换算后传进来 —— rpx 只按屏宽缩放，不按屏高）。框比显示区还大时按显示区收口，
 * 否则一开始就有部分框在屏幕外、手柄抓不到。
 */
export function centeredBox(view: Size, frame: Size): Rect {
  const w = Math.round(clamp(frame.width, MIN_CROP_SIZE, view.width))
  const h = Math.round(clamp(frame.height, MIN_CROP_SIZE, view.height))
  return {
    x: Math.round((view.width - w) / 2),
    y: Math.round((view.height - h) / 2),
    w,
    h,
  }
}

/** 把任意框夹回显示区（横竖屏切换 / 图片换掉之后要重算一次）。 */
export function clampBox(box: Rect, bounds: Size): Rect {
  const w = Math.round(clamp(box.w, MIN_CROP_SIZE, bounds.width))
  const h = Math.round(clamp(box.h, MIN_CROP_SIZE, bounds.height))
  return {
    w,
    h,
    x: Math.round(clamp(box.x, 0, bounds.width - w)),
    y: Math.round(clamp(box.y, 0, bounds.height - h)),
  }
}

/** 触点是否在矩形内（含容差外扩） */
function within(rect: Rect, point: Point, pad: number): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.w + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.h + pad
  )
}

/**
 * 触点落在哪个手柄上；都不命中返回 `null`（页面据此不响应这次拖动）。
 *
 * 顺序是**四角 → 四边 → 框内**：角上同时靠近两条边，如果先判边，用户在角上想放大就会
 * 变成「只放大一个方向」，框会越拖越不像自己想要的形状。
 */
export function cropHandleAt(
  box: Rect,
  point: Point,
  tolerance = HANDLE_TOLERANCE,
): CropHandle | null {
  if (!within(box, point, tolerance)) return null

  const nearLeft = Math.abs(point.x - box.x) <= tolerance
  const nearRight = Math.abs(point.x - (box.x + box.w)) <= tolerance
  const nearTop = Math.abs(point.y - box.y) <= tolerance
  const nearBottom = Math.abs(point.y - (box.y + box.h)) <= tolerance

  if (nearLeft && nearTop) return 'tl'
  if (nearRight && nearTop) return 'tr'
  if (nearLeft && nearBottom) return 'bl'
  if (nearRight && nearBottom) return 'br'
  if (nearTop) return 't'
  if (nearBottom) return 'b'
  if (nearLeft) return 'l'
  if (nearRight) return 'r'
  return 'move'
}

/**
 * 按手柄把框拖到新位置（`delta` 是本次触摸相对上一次的位移）。
 *
 * 三条不变量（都由单测钉住）：
 * - **最小边长**：拖到小于 `MIN_CROP_SIZE` 就停住，用户不会把框拖成一个抓不住的点；
 * - **不越界**：框始终完整落在 `bounds`（显示区）内，裁不出空白；
 * - **对边不动**：拖左上角时右下角固定 —— 这是「拖角放大」的直觉，若改成整体平移
 *   就变成了移动而不是缩放。
 */
export function dragCropBox(box: Rect, handle: CropHandle, delta: Point, bounds: Size): Rect {
  if (handle === 'move') {
    return {
      ...box,
      x: Math.round(clamp(box.x + delta.x, 0, bounds.width - box.w)),
      y: Math.round(clamp(box.y + delta.y, 0, bounds.height - box.h)),
    }
  }

  // 先算出四条边的目标位置，再按最小边长收口；最后统一夹紧到显示区
  let left = box.x
  let top = box.y
  let right = box.x + box.w
  let bottom = box.y + box.h

  if (handle === 'tl' || handle === 'l' || handle === 'bl') {
    left = clamp(box.x + delta.x, 0, right - MIN_CROP_SIZE)
  }
  if (handle === 'tr' || handle === 'r' || handle === 'br') {
    right = clamp(right + delta.x, left + MIN_CROP_SIZE, bounds.width)
  }
  if (handle === 'tl' || handle === 't' || handle === 'tr') {
    top = clamp(box.y + delta.y, 0, bottom - MIN_CROP_SIZE)
  }
  if (handle === 'bl' || handle === 'b' || handle === 'br') {
    bottom = clamp(bottom + delta.y, top + MIN_CROP_SIZE, bounds.height)
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  }
}

/** `aspectFill` 的缩放与居中偏移：显示区被图片铺满，多出来的部分被裁掉。 */
export type FillFit = { scale: number; offsetX: number; offsetY: number }

export function fillFit(view: Size, image: Size): FillFit {
  if (image.width <= 0 || image.height <= 0 || view.width <= 0 || view.height <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 }
  }
  const scale = Math.max(view.width / image.width, view.height / image.height)
  return {
    scale,
    offsetX: (view.width - image.width * scale) / 2,
    offsetY: (view.height - image.height * scale) / 2,
  }
}

/** 显示坐标 → 图片像素坐标（裁剪前必须反算，否则取框位置与用户看到的对不上）。 */
export function toImagePoint(point: Point, view: Size, image: Size): Point {
  const fit = fillFit(view, image)
  return { x: (point.x - fit.offsetX) / fit.scale, y: (point.y - fit.offsetY) / fit.scale }
}

/**
 * 图片像素矩形 → 显示坐标矩形（`toImageRect` 的**逆**）。
 *
 * 结果页要把「用户取框的那一块」画回背景图上（参考图②就是「整张照片 + 框住主体」），
 * 而取框是在**入口页**用显示坐标定的、上传时换算成了图片像素。所以结果页要再换回来 ——
 * 两个页面的显示区尺寸可能不同（状态栏 / 安全区），用图片像素做中转才不会错位。
 */
export function toViewRect(rect: Rect, view: Size, image: Size): Rect {
  const fit = fillFit(view, image)
  return {
    x: Math.round(rect.x * fit.scale + fit.offsetX),
    y: Math.round(rect.y * fit.scale + fit.offsetY),
    w: Math.max(1, Math.round(rect.w * fit.scale)),
    h: Math.max(1, Math.round(rect.h * fit.scale)),
  }
}

/**
 * 显示坐标下的取框 → 图片像素下的裁剪矩形。
 *
 * 结果**夹紧到图片范围并取整**：`drawImage` 的源矩形越界时行为由宿主决定（可能补黑边），
 * 而取整是必须的 —— 非整数源矩形在部分机型上会被截断成一个像素偏差的区域。
 */
export function toImageRect(box: Rect, view: Size, image: Size): Rect {
  const topLeft = toImagePoint({ x: box.x, y: box.y }, view, image)
  const bottomRight = toImagePoint({ x: box.x + box.w, y: box.y + box.h }, view, image)

  const x = clamp(Math.round(topLeft.x), 0, image.width)
  const y = clamp(Math.round(topLeft.y), 0, image.height)
  const right = clamp(Math.round(bottomRight.x), x, image.width)
  const bottom = clamp(Math.round(bottomRight.y), y, image.height)

  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) }
}

/**
 * 裁剪输出的长边上限（图片像素）。
 *
 * 取框通常只占原图的一小块，但「框满屏」时裁剪结果可能仍是 3000+ px 的长边 —— 那既超过
 * 查询图的 5MB 上限（PNG），也没有任何检索收益（上游按图 token 计费，像素越多越贵）。
 *
 * 取 1024 还有一条实现约束：裁剪用**旧版画布**（`canvasId` + `createCanvasContext`），
 * 它的绘制坐标系就是画布元素的 CSS px 尺寸（`type="2d"` 那套才能自己设 `canvas.width`），
 * 所以画布元素必须真按输出像素尺寸铺开（见 `pages/scan-vision` 的行内 style）。
 * 1024×1024 的离屏画布约 4MB 显存，再大就有机型风险，而 1024px 对「找同款」足够。
 */
export const MAX_CROP_OUTPUT = 1024

/** 裁剪输出尺寸：按长边上限等比缩小，不放大（小图裁完仍是原尺寸）。 */
export function cropOutputSize(rect: Size, max = MAX_CROP_OUTPUT): Size {
  const longest = Math.max(rect.width, rect.height)
  if (longest <= max) return { width: rect.width, height: rect.height }
  const ratio = max / longest
  return {
    width: Math.max(1, Math.round(rect.width * ratio)),
    height: Math.max(1, Math.round(rect.height * ratio)),
  }
}
