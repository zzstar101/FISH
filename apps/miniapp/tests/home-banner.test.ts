import { describe, expect, test } from 'bun:test'
import { BANNERS, canAutoPlayBanner } from '../src/pages/home/banners'

describe('首页轮播', () => {
  test('三张独立插画按约定排列', () => {
    expect(BANNERS.map((banner) => banner.title)).toEqual([
      '校园闲置交换站',
      '教材交换',
      '宿舍好物',
    ])
    expect(new Set(BANNERS.map((banner) => banner.image)).size).toBe(3)
  })

  test('只在首页与轮播都可见，且用户未手动切换时自动播放', () => {
    expect(canAutoPlayBanner(true, true, false)).toBe(true)
    expect(canAutoPlayBanner(false, true, false)).toBe(false)
    expect(canAutoPlayBanner(true, false, false)).toBe(false)
    expect(canAutoPlayBanner(true, true, true)).toBe(false)
  })
})
