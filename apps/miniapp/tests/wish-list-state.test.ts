import { describe, expect, test } from 'bun:test'
import { wishHitLink } from '../src/pages/wish/list-state'

/**
 * 许愿卡「命中入口」门禁（三轮独立审查反复抓到的同一族问题）。
 *
 * 规则：终态愿望不给死链接；许愿中只在**拿到权威命中列表**时才跳转；
 * 确定 0 命中时仍要能点出提示（基线行为，不能被接真接口改没）；
 * 命中请求失败时既不跳转也不误报「没命中」。
 */
describe('wishHitLink —— 命中入口形态', () => {
  test('许愿中 + 拿到列表且 total > 0 → linked（可跳转）', () => {
    expect(wishHitLink({ status: 'ACTIVE', matchCount: 3 }, { total: 3, items: [] })).toBe('linked')
  })

  test('许愿中 + 拿到列表但 total = 0 → empty（可点出「还没命中」）', () => {
    expect(wishHitLink({ status: 'ACTIVE', matchCount: 5 }, { total: 0, items: [] })).toBe('empty')
  })

  test('许愿中 + 契约 matchCount = 0（没发命中请求）→ empty，提示不能丢', () => {
    expect(wishHitLink({ status: 'ACTIVE', matchCount: 0 }, undefined)).toBe('empty')
  })

  test('许愿中 + 命中请求失败（matchCount > 0）→ unavailable：不跳转、不误报', () => {
    expect(wishHitLink({ status: 'ACTIVE', matchCount: 4 }, undefined)).toBe('unavailable')
  })

  test('终态愿望 → none：`/matches` 对非 ACTIVE 恒为空，不给入口', () => {
    expect(wishHitLink({ status: 'CLOSED', matchCount: 3 }, undefined)).toBe('none')
    expect(wishHitLink({ status: 'FULFILLED', matchCount: 3 }, { total: 3, items: [] })).toBe(
      'none',
    )
  })
})
