import { describe, expect, test } from 'bun:test'
import { isListingNumberQuery } from '../src/features/listing/number'

/**
 * 搜索页的分流判据（#217 / #252 第 ⑤ 项）：
 * 12 位、首位非 0 的纯数字才是商品编号 `listingNo`，走 `GET /listings/by-number/:listingNo`；
 * 其余一律走关键词搜索。判据只有一处来源（契约 `ListingNoSchema`），不在这里另写正则。
 *
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建），
 * 所以「编号 → 精确查询、404 → 没找到、429 → 限流」这三条分支靠本文件 + 开发者工具演示。
 */

describe('商品编号判据', () => {
  test('12 位、首位非 0 才算编号；前后空白忽略', () => {
    expect(isListingNumberQuery('348572910465')).toBe(true)
    expect(isListingNumberQuery(' 348572910465 ')).toBe(true)
    expect(isListingNumberQuery('999999999999')).toBe(true)
  })

  test('长度不对 / 首位为 0 / 含非数字都不算编号，照旧走关键词', () => {
    for (const keyword of [
      '',
      '   ',
      '12345678901', // 11 位
      '1234567890123', // 13 位
      '034857291046', // 首位 0
      '12345678901a',
      'lst_01jc000000e00800000000000k', // 公开 ID 不是编号
      '显示器',
      '-3485729104', // 负数 / 少一位
    ]) {
      expect(isListingNumberQuery(keyword)).toBe(false)
    }
  })

  test('编号与公开 ID 是两套东西：公开 ID 不能当编号查', () => {
    // 误把 `lst_…` 当编号发给 /listings/by-number/:listingNo 会直接 404，
    // 判据必须在这里就把两件事分开
    expect(isListingNumberQuery('lst_01jc000000e00800000000000k')).toBe(false)
    expect(isListingNumberQuery('usr_01jc000000e00800000000000a')).toBe(false)
  })
})
