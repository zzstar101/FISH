import { describe, expect, test } from 'bun:test'
import {
  CATEGORY_SCROLL_DURATION,
  NAV_SETTLE_MS,
  resolveCategorySettle,
  SETTLE_OVERSHOOT,
} from '../src/pages/home/nav-settle'

/**
 * 首页分类切换的落点与「要不要锁吸顶判定」（#320 审查 P1/P2）。
 *
 * 三条被独立审查抓到的事实：
 * 1. 落点是闲鱼口径 —— 已滚过吸顶点归位到「刚好吸顶」，还没滚到就**原地不动**；
 * 2. `pageScrollTo` 只在**真的会发生移动**时才该发（落点 = 当前位置时那一跳不带位移）；
 * 3. 吸顶判定的锁只跟着**真的会发生移动**的那一跳走。原来无条件上锁，于是「页面还没过
 *    吸顶点时点分类 + 立刻下滑」这 260ms 里吸顶条被钉在旧值上出不来 —— 而此刻它本该
 *    跟手出现。同一处还有第二个竞态：连点 A→B→C 时 A 的定时器先解锁，C 的动画还没跑完。
 *
 * 这一层是纯判据；定时器的清旧 / 卸载清理属于**接线**，由
 * `tests/home-sticky-nav-wiring.test.ts` 读源码钉住（本仓 tests/ 没有 Taro 渲染基建）。
 */

describe('resolveCategorySettle —— 落点', () => {
  test('已滚过吸顶点：归位到刚好吸顶（+1px 留余量）', () => {
    // 真实形状：pinAt 由 useReady 量出来的设备 px，scrollTop 在它之上
    expect(resolveCategorySettle(600, 95)).toEqual({
      target: 95 + SETTLE_OVERSHOOT,
      repositions: true,
    })
  })

  test('还没滚到吸顶点：原地不动，不把用户往下拽', () => {
    // scrollTop(40) < pinAt(95)：min 取 40，落点就是当前位置
    expect(resolveCategorySettle(40, 95)).toEqual({ target: 40, repositions: false })
  })

  test('正好压在吸顶点上：已在吸顶位，不动（多推 1px 是没必要的位移）', () => {
    // `min(95, 95 + 1) = 95` —— 落点等于当前位置，`scrollTop >= pinAt` 此刻已成立，
    // 不需要再挪那 1px，也就没有「真位移」可锁
    expect(resolveCategorySettle(95, 95)).toEqual({ target: 95, repositions: false })
  })

  test('刚过吸顶点（96 > 95）：落点 96（= pinAt + 1）—— 往回退 0px 也算位移', () => {
    // pinAt + 1 = 96 与当前位置相等 → 不动；这是「恰好 1px 之外」的边界
    expect(resolveCategorySettle(96, 95)).toEqual({ target: 96, repositions: false })
    // 再往上一点就真的要回退了
    expect(resolveCategorySettle(200, 95)).toEqual({ target: 96, repositions: true })
  })

  test('pinAt 还没量到（Infinity）：落点即当前位置、不动 —— 兜底不需要额外分支', () => {
    expect(resolveCategorySettle(0, Number.POSITIVE_INFINITY)).toEqual({
      target: 0,
      repositions: false,
    })
    expect(resolveCategorySettle(320, Number.POSITIVE_INFINITY)).toEqual({
      target: 320,
      repositions: false,
    })
  })

  test('落点永远不大于当前位置（只会往上归位，不会把页面往下推）', () => {
    for (const current of [0, 1, 94, 95, 96, 600, 5000]) {
      for (const pinAt of [0, 95, 400, Number.POSITIVE_INFINITY]) {
        const { target } = resolveCategorySettle(current, pinAt)
        expect(target, `current=${current} pinAt=${pinAt}`).toBeLessThanOrEqual(current)
      }
    }
  })

  test('repositions 与「落点 ≠ 当前位置」严格同义（锁只跟真位移走）', () => {
    for (const current of [0, 1, 94, 95, 96, 600, 5000]) {
      for (const pinAt of [0, 95, 400, Number.POSITIVE_INFINITY]) {
        const { target, repositions } = resolveCategorySettle(current, pinAt)
        expect(repositions, `current=${current} pinAt=${pinAt}`).toBe(target !== current)
      }
    }
  })
})

describe('归位时序常量', () => {
  test('锁时长大于滚动时长 —— 动画没跑完不能松锁（松早了判定在动画末尾翻面 = 抖动）', () => {
    expect(NAV_SETTLE_MS).toBeGreaterThan(CATEGORY_SCROLL_DURATION)
  })

  test('落点偏移是 1px（0 会让判定在落点上自己翻 false）', () => {
    expect(SETTLE_OVERSHOOT).toBe(1)
  })
})
