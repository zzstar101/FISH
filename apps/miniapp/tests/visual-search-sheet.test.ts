import { describe, expect, test } from 'bun:test'
import {
  dragSheet,
  SHEET_CLOSED_HEIGHT,
  SHEET_FLING_VELOCITY,
  SHEET_OPEN_RATIO,
  settleSheet,
  sheetHeight,
  sheetTranslate,
} from '@/features/visual-search/sheet'

/**
 * 识图结果页底部面板的几何与手势判据（Owner 2026-09-30 按参考图定版）。
 *
 * 这组判据全是「写错了也能跑」的：面板照样升起、手指照样拖得动，只是
 * - 收起位取 0 → 面板整块滑出屏幕，用户再也拉不回来；
 * - 拖动不夹紧 → 能拖到比展开位还高（露出下面的空白）；
 * - 甩动只看距离 → 手指快速上甩时（往往只拖过一小段）被误判成收起。
 */
const VIEW = 844

describe('sheetHeight —— 两个停靠位', () => {
  test('打开位 = 屏高 × 比例', () => {
    expect(sheetHeight('open', VIEW)).toBe(Math.round(VIEW * SHEET_OPEN_RATIO))
  })

  test('收起位不是 0（留一条把手 + 一句提示，否则面板消失、再也拉不回来）', () => {
    expect(sheetHeight('closed', VIEW)).toBe(SHEET_CLOSED_HEIGHT)
    expect(SHEET_CLOSED_HEIGHT).toBeGreaterThan(0)
  })

  test('屏很矮时打开位也不低于收起位（否则「打开」反而比「收起」还矮）', () => {
    expect(sheetHeight('open', 100)).toBe(SHEET_CLOSED_HEIGHT)
  })
})

describe('dragSheet —— 拖动中的高度', () => {
  const open = sheetHeight('open', VIEW)

  test('向下拖 = 收起（高度变小）', () => {
    expect(dragSheet(open, 100, VIEW)).toBe(open - 100)
  })

  test('向上拖 = 展开（高度变大）', () => {
    expect(dragSheet(400, -100, VIEW)).toBe(500)
  })

  test('不越过打开位（否则面板顶出去、露出下面的空白）', () => {
    expect(dragSheet(open, -9999, VIEW)).toBe(open)
  })

  test('不越过收起位（否则整块滑出屏幕）', () => {
    expect(dragSheet(open, 9999, VIEW)).toBe(SHEET_CLOSED_HEIGHT)
  })
})

describe('settleSheet —— 松手后停哪', () => {
  const open = sheetHeight('open', VIEW)
  const middle = (open + SHEET_CLOSED_HEIGHT) / 2

  test('慢速松手：按离哪个停靠位近判断', () => {
    expect(settleSheet(middle + 1, 0, VIEW)).toBe('open')
    expect(settleSheet(middle - 1, 0, VIEW)).toBe('closed')
  })

  test('快速下甩：直接收起（哪怕当时还拖在很靠上的位置）', () => {
    expect(settleSheet(open - 10, SHEET_FLING_VELOCITY, VIEW)).toBe('closed')
  })

  test('快速上甩：直接打开（哪怕当时只拖过一小段）', () => {
    expect(settleSheet(SHEET_CLOSED_HEIGHT + 10, -SHEET_FLING_VELOCITY, VIEW)).toBe('open')
  })

  test('速度刚好在阈值内仍按距离判断（边界不抖）', () => {
    const justUnder = SHEET_FLING_VELOCITY - 0.01
    expect(settleSheet(middle + 1, justUnder, VIEW)).toBe('open')
    expect(settleSheet(middle - 1, -justUnder, VIEW)).toBe('closed')
  })
})

describe('sheetTranslate —— 面板的下移量', () => {
  test('展开位不下移', () => {
    expect(sheetTranslate(sheetHeight('open', VIEW), VIEW)).toBe(0)
  })

  test('收起位下移「打开高度 − 收起高度」', () => {
    expect(sheetTranslate(SHEET_CLOSED_HEIGHT, VIEW)).toBe(
      sheetHeight('open', VIEW) - SHEET_CLOSED_HEIGHT,
    )
  })

  test('超出展开位时夹到 0（不产生负下移）', () => {
    expect(sheetTranslate(sheetHeight('open', VIEW) + 100, VIEW)).toBe(0)
  })
})
