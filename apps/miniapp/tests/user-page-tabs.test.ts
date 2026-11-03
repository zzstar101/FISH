/**
 * 他人主页的口径入口（#581）：页头「在售 N / 卖出 N」两格替代了原来的「在售｜已售出」胶囊。
 *
 * 这里钉三层：
 * 1. **纯函数**：`?tab=` 的解析（非法值回落）、页面自己的路由拼接、首屏那一页取自哪、内滚锚点的交替；
 * 2. **接线**：三格统计各自的属性区**按节点切片**断言 —— 谁接了哪个入口、好评率那格什么都不接、
 *    两个入口各自在「已在当前口径」时怎么走、补拉第一页的触发、失败重试调的是什么；
 * 3. **样式**：胶囊删净不留孤儿规则、可点两格的触控高度。
 *
 * 为什么切片而不是全文 `toContain`：全文断言只能证明「字符串在文件里出现过」，
 * 换个位置、接反两格、多挂一个 onClick 都照样通过（#582 复核里 7 个变异全绿就是这么来的）。
 *
 * 端上表现（点击手感、44pt 触控区）只能在微信开发者工具里目视，不在这里断言。
 */
import { describe, expect, test } from 'bun:test'
import { toggleAnchor } from '../src/pkg-browse/pages/user/scroll-anchor'
import { firstPageOf, segmentOfTab, userHomeUrl } from '../src/pkg-browse/pages/user/segment-page'

/**
 * 取 `from` 开头、到其后第一次出现的 `to` 为止的那段源码。
 * 锚点缺失时直接抛错 —— 切片断言必须建立在「这段代码还在」之上，不能让空串蒙混过关。
 */
function slice(code: string, from: string, to: string, nth = 0): string {
  let at = -1
  for (let i = 0; i <= nth; i++) {
    at = code.indexOf(from, at + 1)
    if (at < 0) throw new Error(`切片起点缺失：${from}`)
  }
  const end = code.indexOf(to, at + from.length)
  if (end < 0) throw new Error(`切片终点缺失：${to}`)
  return code.slice(at, end)
}

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

describe('firstPageOf —— 首屏那一页从哪来', () => {
  const home = { listings: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' }

  test('在售口径直接吃本次响应里的列表', () => {
    expect(firstPageOf('ACTIVE', home)).toEqual({
      items: home.listings,
      nextCursor: 'c1',
      loaded: true,
      loading: false,
      failed: false,
    })
  })

  test('已售出口径不拿在售列表充当首屏，交回空页等 effect 另拉', () => {
    // 拿在售列表填「已售出」= 把 TA 正在卖的东西画在「已售出」标题下面
    expect(firstPageOf('SOLD', home)).toEqual({
      items: [],
      nextCursor: null,
      loaded: false,
      loading: false,
      failed: false,
    })
  })
})

describe('toggleAnchor —— 内滚锚点必须交替', () => {
  test('同一个锚点连点两次指向不同 id（scrollIntoView 同值不重滚）', () => {
    const first = toggleAnchor('', 'uhome-body-a', 'uhome-body-b')
    expect(first).toBe('uhome-body-a')
    const second = toggleAnchor(first, 'uhome-body-a', 'uhome-body-b')
    // 第二次还是同一个值的话，原生层不会重滚 —— 用户看到的是「点了没反应」
    expect(second).not.toBe(first)
    expect(second).toBe('uhome-body-b')
    expect(toggleAnchor(second, 'uhome-body-a', 'uhome-body-b')).toBe(first)
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

  test('首屏那一页走 firstPageOf，不在页面里手写「口径是否 ACTIVE」的分支', async () => {
    const code = await page
    expect(code).toContain('firstPageOf(seg, result)')
    expect(code).not.toContain("if (seg === 'ACTIVE') {\n      setPage(")
  })

  test('三格统计：在售 / 卖出各接自己那个入口，好评率那格什么都不接', async () => {
    const code = await page
    // 真实的三格是 <View className="uhome__stat…"；骨架格的 key 在 className 之前，不会混进来
    // 两格可点的属性区（`.uhome__stats` 容器本身也含 'className="uhome__stat' 前缀，别拿它当锚点）
    const active = slice(code, 'uhome__stat uhome__stat--link', '<Text', 0)
    const sold = slice(code, 'uhome__stat uhome__stat--link', '<Text', 1)
    const rate = slice(code, '<View className="uhome__stat">', '<Text')

    // 配对关系：各接各的，接反了两格都会露馅
    expect(active).toContain('onClick={openActiveListings}')
    expect(active).not.toContain('openSoldListings')
    expect(sold).toContain('onClick={openSoldListings}')
    expect(sold).not.toContain('openActiveListings')

    // 两格共用同一个可点样式与按压反馈
    expect(active).toContain('uhome__stat--link')
    expect(sold).toContain('uhome__stat--link')
    expect(active).toContain('hoverClass="uhome__stat--tap"')
    expect(sold).toContain('hoverClass="uhome__stat--tap"')

    // 好评率：没有对应列表可去，不接点击、不给可点样式、不给按压反馈（票面验收）
    expect(rate).not.toContain('onClick')
    expect(rate).not.toContain('hoverClass')
    expect(rate).not.toContain('uhome__stat--link')
  })

  test('两个入口在「已在当前口径」时滚列表，否则才跳转 / 返回', async () => {
    const code = await page
    const soldHandler = slice(
      code,
      'const openSoldListings = useCallback(',
      'const openActiveListings = useCallback(',
    )
    const activeHandler = slice(
      code,
      'const openActiveListings = useCallback(',
      'const IDENTITY_FALLBACK = 320',
    )

    // 卖出格：已在已售出视图 → 滚列表（不叠栈）；否则开一个 ?tab=SOLD 的新实例
    expect(soldHandler).toContain("if (seg === 'SOLD') {")
    const soldBranch = slice(soldHandler, "if (seg === 'SOLD') {", '}')
    expect(soldBranch).toContain('scrollToBody()')
    expect(soldBranch).not.toContain('navigateTo')
    expect(soldHandler).toContain("Taro.navigateTo({ url: userHomeUrl(userId, 'SOLD') })")
    // 卖出格不许出现「返回」：从在售视图点「卖出」是往前开一页，不是退一页
    expect(soldHandler).not.toContain('Taro.navigateBack(')

    // 在售格：已在在售视图 → 滚列表；否则返回上一页（返回失败才原地 redirect，不留白屏）
    expect(activeHandler).toContain("if (seg === 'ACTIVE') {")
    const activeBranch = slice(activeHandler, "if (seg === 'ACTIVE') {", '}')
    expect(activeBranch).toContain('scrollToBody()')
    expect(activeBranch).not.toContain('navigateTo')
    expect(activeHandler).toContain('Taro.navigateBack({')
    // 在售格不许压栈：从已售出视图点「在售」是退回原来的在售实例，压栈会把同一页叠起来
    expect(activeHandler).not.toContain('Taro.navigateTo(')
    expect(activeHandler).toContain('Taro.redirectTo({ url: userHomeUrl(userId) })')
  })

  test('滚列表用交替锚点，不写死单一 id', async () => {
    const code = await page
    expect(code).toContain('id="uhome-body-a"')
    expect(code).toContain('id="uhome-body-b"')
    // 写死一个 id 的话连点第二次没有任何反应（scrollIntoView 同值不重滚）
    expect(code).not.toContain("setTopAnchor('uhome-body')")
    const body = slice(code, 'const scrollToBody = useCallback(', '}, [])')
    expect(body).toContain("toggleAnchor(prev, 'uhome-body-a', 'uhome-body-b')")
    const handlers = slice(
      code,
      'const openSoldListings = useCallback(',
      'const IDENTITY_FALLBACK = 320',
    )
    expect((handlers.match(/scrollToBody\(\)/g) ?? []).length).toBe(2)
  })

  test('没载入就补拉第一页（已售出实例全靠它），失败后不自动重试', async () => {
    const code = await page
    const effect = slice(code, '列表还没拉过时补第一页', '}, [loadSegment, loadState, page])')
    expect(effect).toContain('void loadSegment(null)')
    expect(effect).toContain("if (loadState !== 'ok') return")
  })

  test('列表失败的重试直接再拉这一页，不走整页 load()', async () => {
    const code = await page
    const retry = slice(code, 'actionText="重试"', '/>')
    // 走 load() 会把资料也重拉一遍，且 `loadState` 会先回 loading、页头闪一下
    expect(retry).toContain('onAction={() => void loadSegment(null)}')
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

  test('可点两格的触控高度按 44pt 换算成 88px，且只给可点的那两格', async () => {
    const scss = await style
    expect(scss).toContain('.uhome__stat--link {')
    expect((scss.match(/min-height: 88px;/g) ?? []).length).toBe(1)
    // 逐格拉伸到同高，否则「在售|卖出」与「卖出|好评率」两条分隔线一长一短
    const base = slice(scss, '.uhome__stats {', '}')
    expect(base).toContain('align-items: stretch;')
    const cell = slice(scss, '.uhome__stat {', '}')
    expect(cell).toContain('justify-content: center;')
  })
})
