import { describe, expect, test } from 'bun:test'
import { VISUAL_QUERY_OBJECT_KEY_PARAM, visualSearchPageUrl } from '@/features/visual-search/link'
import { routeParam } from '@/lib/route-param'

/**
 * 识图 → 搜索页的页面间契约。
 *
 * 对象键里带 `/`，所以要按仓内惯例编码后再拼 query（`pages/wish` 跳搜索页同一手法），
 * 消费侧必须用 `routeParam` 解一次 —— 微信不会替调用方解码。写错只会表现为
 * 「搜索页拿不到图」，所以两侧都钉成字面量。
 */
describe('visualSearchPageUrl', () => {
  test('搜索页 + 编码后的对象键', () => {
    expect(visualSearchPageUrl('visual-search/a1b2/c3d4.png')).toBe(
      '/pages/search/index?visualObjectKey=visual-search%2Fa1b2%2Fc3d4.png',
    )
  })

  test('消费侧解一次能还原成原对象键', () => {
    const key = 'visual-search/93f1/8c2a.png'
    const url = visualSearchPageUrl(key)
    const query = url.slice(url.indexOf('?') + 1)
    const [name, value] = query.split('=')
    expect(name).toBe('visualObjectKey')
    expect(routeParam(value)).toBe(key)
  })

  test('参数名就是搜索页读的那个（改名只会静默拿不到图）', () => {
    expect(VISUAL_QUERY_OBJECT_KEY_PARAM).toBe('visualObjectKey')
  })
})
