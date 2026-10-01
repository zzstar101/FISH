import { describe, expect, test } from 'bun:test'
import {
  centeredBox,
  clampBox,
  cropHandleAt,
  cropOutputSize,
  dragCropBox,
  fillFit,
  HANDLE_TOLERANCE,
  MAX_CROP_OUTPUT,
  MIN_CROP_SIZE,
  toImageRect,
} from '@/features/visual-search/crop'

/**
 * 识图取框的几何（Owner 2026-09-29 按两张参考图定版）。
 *
 * 这一组判据全都「写错了也能跑」—— 框会照样渲染、手指照样拖得动，只是：
 * - 初始框与取景框不一致 → 用户按快门后框会跳一下；
 * - 拖角时对边跟着动 → 变成平移而不是缩放；
 * - 不夹紧 → 框被拖出图片，裁出来是空白；
 * - 不设最小边长 → 框缩成一个点，手柄再也抓不住；
 * - 显示坐标到图片像素不反算 `aspectFill` 的缩放/偏移 → 裁出来的位置与用户看到的完全对不上。
 *
 * 所以每一条都在这里钉住。
 */
describe('centeredBox —— 初始框与取景框同尺寸同中心', () => {
  test('取景框比屏小：原样居中（就是用户按快门之前对准的那个框）', () => {
    const view = { width: 390, height: 844 }
    const frame = { width: 260, height: 270 }
    expect(centeredBox(view, frame)).toEqual({ x: 65, y: 287, w: 260, h: 270 })
  })

  test('取景框比屏大：按屏收口（否则一开始就有部分框在屏幕外、手柄抓不到）', () => {
    const view = { width: 200, height: 200 }
    expect(centeredBox(view, { width: 260, height: 270 })).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
  })

  test('取景框比最小边长还小：抬到最小边长', () => {
    const box = centeredBox({ width: 390, height: 844 }, { width: 10, height: 10 })
    expect(box.w).toBe(MIN_CROP_SIZE)
    expect(box.h).toBe(MIN_CROP_SIZE)
  })
})

describe('clampBox —— 换屏 / 换图后把框夹回显示区', () => {
  test('越界与超尺寸都被夹回', () => {
    const bounds = { width: 390, height: 844 }
    expect(clampBox({ x: -50, y: -50, w: 500, h: 900 }, bounds)).toEqual({
      x: 0,
      y: 0,
      w: 390,
      h: 844,
    })
  })

  test('右下越界：整体回推，尺寸不变', () => {
    const bounds = { width: 390, height: 844 }
    expect(clampBox({ x: 300, y: 800, w: 100, h: 100 }, bounds)).toEqual({
      x: 290,
      y: 744,
      w: 100,
      h: 100,
    })
  })
})

describe('cropHandleAt —— 触点落在哪个手柄上', () => {
  const box = { x: 100, y: 200, w: 200, h: 200 }

  test('四角优先于四边（角上同时靠近两条边，先判边会变成只放大一个方向）', () => {
    expect(cropHandleAt(box, { x: 102, y: 202 })).toBe('tl')
    expect(cropHandleAt(box, { x: 298, y: 202 })).toBe('tr')
    expect(cropHandleAt(box, { x: 102, y: 398 })).toBe('bl')
    expect(cropHandleAt(box, { x: 298, y: 398 })).toBe('br')
  })

  test('四边中点', () => {
    expect(cropHandleAt(box, { x: 200, y: 201 })).toBe('t')
    expect(cropHandleAt(box, { x: 200, y: 399 })).toBe('b')
    expect(cropHandleAt(box, { x: 101, y: 300 })).toBe('l')
    expect(cropHandleAt(box, { x: 299, y: 300 })).toBe('r')
  })

  test('框内是移动', () => {
    expect(cropHandleAt(box, { x: 200, y: 300 })).toBe('move')
  })

  test('离框太远：不响应（返回 null）', () => {
    expect(cropHandleAt(box, { x: 200, y: 300 - box.h })).toBeNull()
    expect(cropHandleAt(box, { x: 200, y: 500 })).toBeNull()
    expect(cropHandleAt(box, { x: 50, y: 300 })).toBeNull()
  })

  test('容差边界：贴边外扩 HANDLE_TOLERANCE 内仍命中，超出即不命中', () => {
    expect(cropHandleAt(box, { x: 100 - HANDLE_TOLERANCE, y: 300 })).toBe('l')
    expect(cropHandleAt(box, { x: 100 - HANDLE_TOLERANCE - 1, y: 300 })).toBeNull()
  })
})

describe('dragCropBox —— 拖拽后的框', () => {
  const bounds = { width: 390, height: 844 }
  const box = { x: 100, y: 200, w: 200, h: 200 }

  test('move：整体平移，对边同步', () => {
    expect(dragCropBox(box, 'move', { x: 10, y: -20 }, bounds)).toEqual({
      x: 110,
      y: 180,
      w: 200,
      h: 200,
    })
  })

  test('拖左上角：右下角不动（这是缩放而不是平移）', () => {
    expect(dragCropBox(box, 'tl', { x: -20, y: -30 }, bounds)).toEqual({
      x: 80,
      y: 170,
      w: 220,
      h: 230,
    })
  })

  test('拖右下角：左上角不动', () => {
    expect(dragCropBox(box, 'br', { x: 30, y: 40 }, bounds)).toEqual({
      x: 100,
      y: 200,
      w: 230,
      h: 240,
    })
  })

  test('拖上边：只有上边动，左右不动', () => {
    expect(dragCropBox(box, 't', { x: 25, y: -30 }, bounds)).toEqual({
      x: 100,
      y: 170,
      w: 200,
      h: 230,
    })
  })

  test('最小边长：拖到负尺寸也停在 MIN_CROP_SIZE', () => {
    const tiny = dragCropBox(box, 'tl', { x: 9999, y: 9999 }, bounds)
    expect(tiny.w).toBe(MIN_CROP_SIZE)
    expect(tiny.h).toBe(MIN_CROP_SIZE)
  })

  test('边界夹紧：拖出显示区也被挡住（裁不出空白）', () => {
    expect(dragCropBox(box, 'tl', { x: -9999, y: -9999 }, bounds)).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 400,
    })
    expect(dragCropBox(box, 'br', { x: 9999, y: 9999 }, bounds)).toEqual({
      x: 100,
      y: 200,
      w: 290,
      h: 644,
    })
  })

  test('move 也夹紧在显示区内', () => {
    expect(dragCropBox(box, 'move', { x: 9999, y: 9999 }, bounds)).toEqual({
      x: 190,
      y: 644,
      w: 200,
      h: 200,
    })
  })
})

describe('fillFit / toImageRect —— 显示坐标 ↔ 图片像素', () => {
  test('aspectFill：取较大的缩放，居中留偏移（横图在竖屏上左右裁掉）', () => {
    // 竖屏 390×844 显示一张 4000×3000 的横图：scale = max(0.0975, 0.2813) = 0.2813
    const fit = fillFit({ width: 390, height: 844 }, { width: 4000, height: 3000 })
    expect(fit.scale).toBeCloseTo(844 / 3000, 6)
    expect(fit.offsetX).toBeCloseTo((390 - 4000 * (844 / 3000)) / 2, 6)
    expect(fit.offsetY).toBeCloseTo(0, 6)
  })

  test('取框 → 图片像素矩形：夹紧、取整、不越界', () => {
    const view = { width: 390, height: 844 }
    const image = { width: 4000, height: 3000 }
    const rect = toImageRect({ x: 65, y: 287, w: 260, h: 270 }, view, image)
    // 反算：x = (65 - offsetX) / scale
    const fit = fillFit(view, image)
    expect(rect.x).toBe(Math.round((65 - fit.offsetX) / fit.scale))
    expect(rect.y).toBe(Math.round((287 - fit.offsetY) / fit.scale))
    expect(rect.w).toBeGreaterThan(0)
    expect(rect.h).toBeGreaterThan(0)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.w).toBeLessThanOrEqual(image.width)
    expect(rect.y + rect.h).toBeLessThanOrEqual(image.height)
  })

  test('框超出图片范围时裁剪矩形被夹到图片内（不产生越界源矩形）', () => {
    const view = { width: 390, height: 844 }
    const image = { width: 400, height: 400 }
    const rect = toImageRect({ x: -100, y: -100, w: 900, h: 900 }, view, image)
    // 不写死具体数值：`aspectFill` 的偏移会让「框的左上角」映射到图片内部的某个点，
    // 这里要钉的是**四条边都落在图片内**且尺寸非零（越界的源矩形会让宿主补黑边）
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.w).toBeGreaterThan(0)
    expect(rect.h).toBeGreaterThan(0)
    expect(rect.x + rect.w).toBeLessThanOrEqual(image.width)
    expect(rect.y + rect.h).toBeLessThanOrEqual(image.height)
  })

  test('尺寸信息缺失（0 宽/0 高）时不除零', () => {
    const fit = fillFit({ width: 0, height: 0 }, { width: 100, height: 100 })
    expect(fit).toEqual({ scale: 1, offsetX: 0, offsetY: 0 })
    expect(() =>
      toImageRect({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 }, { width: 1, height: 1 }),
    ).not.toThrow()
  })
})

describe('cropOutputSize —— 裁剪输出尺寸', () => {
  test('小图不放大', () => {
    expect(cropOutputSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
  })

  test('大图按长边收到 MAX_CROP_OUTPUT 并保持比例', () => {
    const out = cropOutputSize({ width: 4000, height: 3000 })
    expect(out.width).toBe(MAX_CROP_OUTPUT)
    expect(out.height).toBe(Math.round((3000 * MAX_CROP_OUTPUT) / 4000))
  })

  test('竖图同样按长边收', () => {
    const out = cropOutputSize({ width: 3000, height: 4000 })
    expect(out.height).toBe(MAX_CROP_OUTPUT)
    expect(out.width).toBe(Math.round((3000 * MAX_CROP_OUTPUT) / 4000))
  })
})
