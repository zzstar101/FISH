import { describe, expect, test } from 'bun:test'
import {
  VISION_RESULT_PAGE,
  VISUAL_QUERY_LOCAL_PATH_PARAM,
  VISUAL_QUERY_OBJECT_KEY_PARAM,
  visionResultPageUrl,
} from '@/features/visual-search/link'
import { routeParam } from '@/lib/route-param'

/**
 * 识图 → 结果页的页面间契约。
 *
 * 对象键里带 `/`，所以要按仓内惯例编码后再拼 query（`pages/wish` 跳搜索页同一手法），
 * 消费侧必须用 `routeParam` 解一次 —— 微信不会替调用方解码。写错只会表现为
 * 「结果页拿不到图」，所以两侧都钉成字面量。
 *
 * 两个参数：`visualObjectKey` 是检索的输入（必须），`visualQueryPath` 只给查询图卡当
 * 缩略图（可选，查询图存私有前缀、服务端给不出可渲染 URL）。后者缺省时 URL 里**不能**
 * 出现空参数 —— 空值会让消费侧把「没有本地路径」与「路径是空串」混在一起。
 */
describe('visionResultPageUrl', () => {
  test('结果页 + 编码后的对象键', () => {
    expect(visionResultPageUrl('visual-search/a1b2/c3d4.png')).toBe(
      `${VISION_RESULT_PAGE}?visualObjectKey=visual-search%2Fa1b2%2Fc3d4.png`,
    )
  })

  test('带本地路径时追加第二个参数（同样编码）', () => {
    expect(visionResultPageUrl('visual-search/a1b2/c3d4.png', 'http://tmp/xx 1.jpg')).toBe(
      `${VISION_RESULT_PAGE}?visualObjectKey=visual-search%2Fa1b2%2Fc3d4.png&visualQueryPath=http%3A%2F%2Ftmp%2Fxx%201.jpg`,
    )
  })

  test('本地路径为空 / 未给：URL 里不出现空参数', () => {
    const withoutParam = `${VISION_RESULT_PAGE}?visualObjectKey=visual-search%2Fa1b2%2Fc3d4.png`
    expect(visionResultPageUrl('visual-search/a1b2/c3d4.png', '')).toBe(withoutParam)
    expect(visionResultPageUrl('visual-search/a1b2/c3d4.png', undefined)).toBe(withoutParam)
  })

  test('消费侧各解一次能还原成原值', () => {
    const key = 'visual-search/93f1/8c2a.png'
    const path = 'http://tmp/wx 2.png'
    const url = visionResultPageUrl(key, path)
    const query = url.slice(url.indexOf('?') + 1)
    const pairs = Object.fromEntries(query.split('&').map((part) => part.split('=')))
    expect(routeParam(pairs[VISUAL_QUERY_OBJECT_KEY_PARAM])).toBe(key)
    expect(routeParam(pairs[VISUAL_QUERY_LOCAL_PATH_PARAM])).toBe(path)
  })

  test('两个参数名就是结果页读的那两个（改名只会静默拿不到图）', () => {
    expect(VISUAL_QUERY_OBJECT_KEY_PARAM).toBe('visualObjectKey')
    expect(VISUAL_QUERY_LOCAL_PATH_PARAM).toBe('visualQueryPath')
  })

  test('结果页已在 app.config.ts 注册（没注册时 navigateTo 只在运行时失败）', async () => {
    const config = await Bun.file(new URL('../src/app.config.ts', import.meta.url)).text()
    // 配置里写的是不带前导斜杠的页面路径（`'pages/vision-result/index'`）
    expect(config).toContain(`'${VISION_RESULT_PAGE.slice(1)}'`)
  })
})
