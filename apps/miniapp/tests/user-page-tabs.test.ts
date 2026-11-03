/**
 * 他人主页的口径入口（#581）：页头「在售 N / 卖出 N」两格替代了原来的「在售｜已售出」胶囊。
 *
 * 这里钉两层：
 * 1. **纯函数**：`?tab=` 的解析（非法值回落）与页面自己的路由拼接；
 * 2. **接线**：页面确实删掉了胶囊、两格确实可点、计数确实取服务端总数而不是 `items.length`、
 *    scss 里确实没有留下孤儿规则。
 *
 * 端上表现（点击手感、44pt 触控区）只能在微信开发者工具里目视，不在这里断言。
 */
import { describe, expect, test } from 'bun:test'
import { segmentOfTab, userHomeUrl } from '../src/pkg-browse/pages/user/segment-page'

describe('segmentOfTab —— 路由参数决定看哪一段', () => {
  test('只认字面量 SOLD，其余一律回落「在售」', () => {
    expect(segmentOfTab('SOLD')).toBe('SOLD')
    // 显式写 ACTIVE、缺省、空串、大小写不符、任意垃圾值：都不该白屏或报错，
    // 最差就是看到默认那段（票面验收：`?tab=FOO` 回落为在售）
    expect(segmentOfTab('ACTIVE')).toBe('ACTIVE')
    expect(segmentOfTab(undefined)).toBe('ACTIVE')
    expect(segmentOfTab('')).toBe('ACTIVE')
    expect(segmentOfTab('sold')).toBe('ACTIVE')
    expect(segmentOfTab('FOO')).toBe('ACTIVE')
  })
})

describe('userHomeUrl —— 页头「卖出 N」要跳的那个地址', () => {
  test('不带 tab 就是在售视图，带 tab 就指到对应段', () => {
    expect(userHomeUrl('u-1')).toBe('/pkg-browse/pages/user/index?id=u-1')
    expect(userHomeUrl('u-1', 'SOLD')).toBe('/pkg-browse/pages/user/index?id=u-1&tab=SOLD')
  })

  test('publicId 是用户可控的路径参数，必须转义', () => {
    expect(userHomeUrl('a&tab=SOLD')).toBe('/pkg-browse/pages/user/index?id=a%26tab%3DSOLD')
  })
})

describe('他人主页接线（#581）', () => {
  const page = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()
  const style = Bun.file(new URL('../src/pkg-browse/pages/user/index.scss', import.meta.url)).text()

  test('胶囊整套删净，不留孤儿样式', async () => {
    const [code, scss] = [await page, await style]
    expect(code).not.toContain('uhome__seg')
    expect(scss).not.toContain('uhome__seg')
  })

  test('口径由 tab 参数派生，页面自己的路由由 userHomeUrl 拼', async () => {
    const code = await page
    expect(code).toContain('segmentOfTab(router.params.tab)')
    expect(code).toContain("userHomeUrl(userId, 'SOLD')")
    // 跳转后新实例只按这个口径取数（不再有 pages[seg] 那种双段状态机）
    expect(code).toContain('loadPublicUserListingsPage(userId, seg, cursor)')
  })

  test('两格可点、各接一个入口，第三格（好评率）不接点击', async () => {
    const code = await page
    expect(code).toContain('onClick={openActiveListings}')
    expect(code).toContain('onClick={openSoldListings}')
    // 可点样式只给两格：三格统计里第三格（好评率）没有列表可去，不该有入口
    expect((code.match(/uhome__stat--link/g) ?? []).length).toBe(2)
    const scss = await style
    expect(scss).toContain('.uhome__stat--link {')
    // 触控区口径：≥ 44pt，按仓库换算写成设计值 88px
    expect(scss).toContain('min-height: 88px;')
  })

  test('件数取服务端总数，不拿已加载条数冒充（分页会低报）', async () => {
    const code = await page
    expect(code).toContain('{profile.activeCount}')
    expect(code).toContain('{profile.soldCount}')
    // 空态那一行是「TA 暂无 + 当前口径 + 商品」，口径取自 segTitle（在售 / 已售出各一句）。
    // 按节点切片断言，不用拼 `${...}` 字面量 —— 那会被 lint 的 noTemplateCurlyInString 拦下
    const emptyAt = code.indexOf('uhome__empty-title')
    expect(emptyAt).toBeGreaterThan(-1)
    const emptyTitle = code.slice(emptyAt, emptyAt + 120)
    expect(emptyTitle).toContain('TA 暂无')
    expect(emptyTitle).toContain('segTitle')
  })
})
