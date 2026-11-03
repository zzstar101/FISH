import { describe, expect, test } from 'bun:test'
import {
  firstPageOf,
  segmentOfTab,
  segTitleOf,
  shouldRefetch,
  totalOf,
} from '../src/pkg-browse/pages/user/segment-page'

/**
 * 他人主页的口径入口（#581）：页头「在售 N / 卖出 N」两格替代原来的「在售｜已售出」胶囊，
 * 点哪格就在本页换成哪一段列表。
 *
 * 纯函数用例钉口径解析与首屏来源；接线用例读源码（本仓 `tests/` 没有 Taro 渲染基建，
 * 先例 `tests/history-wiring.test.ts`），只钉「字符串换个位置就会红」的那几处：
 * 两格接反、切段改成跳转、在途请求的闩与代号被删。
 * 端上表现（触控手感、88px 够不够大）只能按 `docs/miniapp-dev-workflow.md` 在开发者工具里看。
 */

describe('segmentOfTab —— 深链参数决定首屏看哪一段', () => {
  test('只认字面量 SOLD，其余一律回落在售', () => {
    expect(segmentOfTab('SOLD')).toBe('SOLD')
    // 显式 ACTIVE、缺省、空串、大小写不符、任意垃圾值都不该白屏，最差就是看到默认那段
    for (const tab of ['ACTIVE', undefined, '', 'sold', 'FOO']) {
      expect(segmentOfTab(tab)).toBe('ACTIVE')
    }
  })
})

describe('firstPageOf —— 首屏那一页从哪来', () => {
  const home = { listings: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' }

  test('在售段直接吃本次响应里的列表', () => {
    expect(firstPageOf('ACTIVE', home)).toEqual({
      items: home.listings,
      nextCursor: 'c1',
      loaded: true,
      loading: false,
      failed: false,
    })
  })

  test('已售出段不拿在售列表充当首屏，交回空页等 effect 另拉', () => {
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

/** 取 `from` 开头、到其后第一次出现的 `to` 为止的那段源码；锚点缺失直接抛错 */
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

describe('他人主页接线（#581）', () => {
  const page = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()
  const style = Bun.file(new URL('../src/pkg-browse/pages/user/index.scss', import.meta.url)).text()

  test('胶囊整套删净，不留孤儿样式', async () => {
    expect(await page).not.toContain('uhome__seg')
    expect(await style).not.toContain('uhome__seg')
  })

  test('三格统计：在售 / 卖出各接自己那格入口，好评率那格什么都不接', async () => {
    const code = await page
    // 按「整格」切片（容器 `.uhome__stats` 也含 'uhome__stat' 前缀，别拿它当锚点）
    const active = slice(code, 'uhome__stat uhome__stat--link', '</View>', 0)
    const sold = slice(code, 'uhome__stat uhome__stat--link', '</View>', 1)
    const rate = slice(code, '<View className="uhome__stat">', '</View>')

    // 接反就红 —— 这是本票的核心接线，属性名对了还不够，入口带的段参数也要对
    expect(active).toContain('onClick={openActiveListings}')
    expect(sold).toContain('onClick={openSoldListings}')
    expect(code).toContain(
      "const openActiveListings = useCallback(() => switchSegment('ACTIVE'), [switchSegment])",
    )
    expect(code).toContain(
      "const openSoldListings = useCallback(() => switchSegment('SOLD'), [switchSegment])",
    )
    expect(active).toContain('hoverClass="uhome__stat--tap"')
    expect(sold).toContain('hoverClass="uhome__stat--tap"')

    // 每一格显示的是自己那份计数与自己那个标签
    expect(active).toContain('{profile.activeCount}')
    expect(active).toContain('>在售<')
    expect(sold).toContain('{profile.soldCount}')
    expect(sold).toContain('>卖出<')

    // 好评率没有对应列表可去（票面验收：不可点、无点击反馈）
    expect(rate).not.toContain('onClick')
    expect(rate).not.toContain('hoverClass')
    expect(rate).not.toContain('uhome__stat--link')
  })

  test('深链与整页重载共用一份口径解析（`?tab=` 只决定首屏看哪段）', async () => {
    const code = await page
    expect(code).toContain('const tabParam = router.params.tab')
    expect(code).toContain('useState<Segment>(() => segmentOfTab(tabParam))')
    // 整页重载也从 `?tab=` 重算，不留「沿用当前段」的镜像
    const reload = slice(code, 'const load = useCallback(', 'if (userId ===')
    expect(reload).toContain('const initial = segmentOfTab(tabParam)')
    // 算出来的口径要真的被用上：换段与首屏都不许绕过它写死 ACTIVE
    expect(reload).toContain('setSeg(initial)')
    expect(code).toContain('setPage(firstPageOf(initial, result))')
  })

  test('切段只改本页状态：不压栈、不跳转、不写 URL 参数，同段只滚不动数据', async () => {
    const code = await page
    const body = slice(code, 'const switchSegment = useCallback(', 'const openSoldListings')
    expect(body).not.toContain('navigate')
    expect(body).not.toContain('redirectTo')
    expect(body).not.toContain('tab=')
    // 已在当前段必须提前返回，否则会白把数据重置、再拉一遍同一段
    const same = slice(body, 'if (next === seg) {', '}')
    expect(same.replace(/\s+/g, ' ')).toContain('scrollToBody() return')
    // 换段：先作废在途请求，再换口径、重置数据、滚列表
    const order = ['generation.current += 1', 'inFlight.current = false', 'setSeg(next)']
    let at = -1
    for (const step of order) {
      const found = body.indexOf(step, at + 1)
      expect(found).toBeGreaterThan(at)
      at = found
    }
    expect(body).toContain('setPage(emptyPage())')
  })

  test('在途请求：一把同步闩 + 代号校验，旧段的响应不写进新段、也不替新段放闩', async () => {
    const code = await page
    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    // 重入靠同步 ref 闩：`page.loading` 是渲染快照，同一帧两次调用读到的都是旧值
    expect(body).toContain('if (inFlight.current) return')
    expect(body).toContain('inFlight.current = true')
    // 成功与失败两条路都要判代号；`finally` 只在代号仍有效时归还闩
    expect((body.match(/if \(sent !== generation\.current\) return/g) ?? []).length).toBe(2)
    expect(body).toContain('if (sent === generation.current) inFlight.current = false')
    // 合并（覆盖 / 追尾 / 按 id 去重）交给纯函数，页面不手抄字段
    expect(body).toContain('...mergeSegmentPage(prev, next, cursor)')

    // 整页重载也要作废在途请求（#582 审查中-1 那个竞态的同构问题）：换代与放手都在重置数据之前
    const reload = slice(code, 'const load = useCallback(', 'if (userId ===')
    expect(reload.replace(/\s+/g, ' ')).toContain(
      'generation.current += 1 inFlight.current = false',
    )
    expect(reload.indexOf('generation.current += 1')).toBeLessThan(
      reload.indexOf('setPage(emptyPage())'),
    )
    // 两个 callback 都必须把 `seg` 放进依赖：少了它，切段后闭包仍是旧段的快照
    expect(code).toContain('    [seg, userId],')
    expect(code).toContain('    [scrollToBody, seg],')
  })

  test('空页就补拉第一页（切段后 / 深链进已售出都靠它），失败后不自动重试', async () => {
    const code = await page
    const effect = slice(code, '列表还没拉过时补第一页', '}, [loadSegment, loadState, page])')
    // 守卫搬进纯函数 `shouldRefetch`（三态与加载态的样本见下面那组），页面只留一句判定：
    // 只剩 `page.loaded` 的话，`failed` 之后每次渲染都会再打一次接口
    expect(effect).toContain('if (!shouldRefetch(loadState, page)) return')
    expect(effect).toContain('void loadSegment(null)')
    // 写成「只有 SOLD 才补」会让切回在售的分段永远空着
    expect(effect).not.toContain("'SOLD'")
  })

  test('列表失败的重试直接再拉这一页，不走整页 load()', async () => {
    const code = await page
    // 走 load() 会把资料也重拉一遍，页头先闪一下
    expect(slice(code, 'actionText="重试"', '/>')).toContain(
      'onAction={() => void loadSegment(null)}',
    )
    // 这条分支的条件写活：恒假的话错误态就成了死代码，失败时只剩骨架屏
    expect(code).toContain('page.failed && items.length === 0')
  })

  test('滚列表用交替锚点，不写死单一 id，并让出导航条高度', async () => {
    const code = await page
    const flat = code.replace(/\s+/g, ' ')
    expect(code).toContain('id="uhome-body-a"')
    expect(code).toContain('id="uhome-body-b"')
    // 锚点必须贴在列表上沿：搬到页顶也「两个 id 都在」，落点却跑到页头去了
    expect(flat).toContain('<View id="uhome-body-b" /> </View> <View className="uhome__body">')
    // 落点顶到滚区 y=0 后，列表标题还要落在绝对定位的导航条下方，所以整块向上让出导航条高度
    expect(flat).toMatch(/style=\{\{ marginTop: `-\$\{navTotalHeight\}px` \}\}/)
    // 写死一个 id 的话连点第二次没有任何反应（scrollIntoView 同值不重滚）
    const body = slice(code, 'const scrollToBody = useCallback(', '}, [])')
    expect(body).toContain("'uhome-body-a'")
    expect(body).toContain("'uhome-body-b'")
  })

  test('可点两格的触控高度按 44pt 换算成 88px，且只给可点的那两格', async () => {
    const scss = await style
    expect(scss).toContain('.uhome__stat--link {')
    expect((scss.match(/min-height: 88px;/g) ?? []).length).toBe(1)
    // 逐格拉伸到同高，否则「在售|卖出」与「卖出|好评率」两条分隔线一长一短
    expect(slice(scss, '.uhome__stats {', '}')).toContain('align-items: stretch;')
    expect(slice(scss, '.uhome__stat {', '}')).toContain('justify-content: center;')
    // 按压反馈那条规则与分段标题都得在（删了规则，端上就只剩抖动没有反馈）
    expect(scss).toContain('.uhome__stat--tap {')
    expect(scss).toContain('.uhome__sect-title {')
  })

  test('开拉与失败都把三态写全，不留旧值', async () => {
    const code = await page
    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    // 开拉：清掉上一轮的失败态，否则失败后重试会一直停在错误提示上
    expect(body).toContain('setPage((prev) => ({ ...prev, loading: true, failed: false }))')
    // 失败：把 loading 落回 false，否则续页失败后列表永远卡在「加载中」
    expect(body.replace(/\s+/g, ' ')).toContain(
      'setPage((prev) => ({ ...prev, loading: false, failed: true }))',
    )
  })

  test('计数与终点判定都取服务端总数，不拿已加载条数猜', async () => {
    const code = await page
    expect(code).toContain('const segTotal = totalOf(seg, profile)')
    expect(code).toContain('const segTitle = segTitleOf(seg)')
    expect(code).toContain('userListEnd(items.length, segTotal, hasMore)')
  })

  test('空态文案跟着当前口径走（已售出也有一句自己的说明）', async () => {
    const code = await page
    expect(code).toMatch(/`TA 暂无\$\{segTitle\}商品`/)
    // 两段的补充说明各自一句话，别共用一句「没有商品」了事
    expect(code).toContain("'TA 的东西都被抢光啦，有新上架会出现在这里'")
    expect(code).toContain("'TA 成交的商品会出现在这里'")
  })
})

describe('shouldRefetch / totalOf / segTitleOf —— 口径的单一来源（#582 首轮审查 M1 / M4）', () => {
  const idle = { loaded: false, loading: false, failed: false }

  test('补拉只看加载态与三态：不看口径，失败后不自动重试', () => {
    expect(shouldRefetch('ok', idle)).toBe(true)
    expect(shouldRefetch('loading', idle)).toBe(false)
    expect(shouldRefetch('notFound', idle)).toBe(false)
    expect(shouldRefetch('failed', idle)).toBe(false)
    // 三态里任一为真都不该再打接口：已加载过、正在拉、刚失败
    expect(shouldRefetch('ok', { ...idle, loaded: true })).toBe(false)
    expect(shouldRefetch('ok', { ...idle, loading: true })).toBe(false)
    expect(shouldRefetch('ok', { ...idle, failed: true })).toBe(false)
  })

  test('分段总数取服务端那个数：两段不许互换，也不拿已加载条数冒充', () => {
    const profile = { activeCount: 7, soldCount: 3 }
    expect(totalOf('ACTIVE', profile)).toBe(7)
    expect(totalOf('SOLD', profile)).toBe(3)
    // profile 还没到（加载中）：先报 0，列表尾注按 `userListEnd` 的 `none` 分支不提前下结论
    expect(totalOf('ACTIVE', null)).toBe(0)
    expect(totalOf('SOLD', null)).toBe(0)
  })

  test('分段名两段不许互换', () => {
    expect(segTitleOf('ACTIVE')).toBe('在售')
    expect(segTitleOf('SOLD')).toBe('已售出')
  })
})
