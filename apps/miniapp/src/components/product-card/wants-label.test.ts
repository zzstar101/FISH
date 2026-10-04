/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { wantsLabel } from './wants-label'

/**
 * #406 第 5 项：识图结果页在 `favoriteCount` 缺失（`undefined`）时会渲染「undefined人想要」。
 * 判据从卡片里抽成这个纯函数，就是为了让它能被钉住——卡片本身依赖 Taro 运行时，
 * 小程序目录里没有渲染测试的基建（全仓 `apps/miniapp/src` 下此前 0 个测试文件）。
 *
 * 这条用例组编码的正是**改动前**的判据：`listing.wants === null ? 不画 : `${wants}人想要``——
 * 把 `wantsLabel` 里的条件换回 `wants !== null` 就会在这里变红（见 PR 描述里的红→绿回执）。
 */
describe('wantsLabel（「N 人想要」的渲染判据）', () => {
  test('拿到真数就画', () => {
    expect(wantsLabel(7)).toBe('7人想要')
  })

  test('0 是真数：0 表示"没人收藏"，不是"没有这个数"', () => {
    expect(wantsLabel(0)).toBe('0人想要')
  })

  test('null（契约里"没有这个计数"的表示法）不画', () => {
    expect(wantsLabel(null)).toBeNull()
  })

  test('undefined 不画，绝不能漏成「undefined人想要」', () => {
    expect(wantsLabel(undefined)).toBeNull()
  })

  test('NaN / Infinity 同样不画，而不是漏成「NaN人想要」', () => {
    expect(wantsLabel(Number.NaN)).toBeNull()
    expect(wantsLabel(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
