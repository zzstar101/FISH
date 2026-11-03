/**
 * 他人主页的口径入口（#581）：页头「在售 N / 卖出 N」两格替代了原来的「在售｜已售出」胶囊。
 *
 * 这里钉三层：
 * 1. **纯函数**：`?tab=` 的解析（非法值回落）、首屏那一页取自哪、切段瞬间的过期响应怎么处理、
 *    内滚锚点的交替；
 * 2. **接线**：三格统计各自的属性区**按节点切片**断言 —— 谁接了哪个入口、好评率那格什么都不接、
 *    切段只改本页状态（不压栈 / 不跳转）、在途请求的身份校验、补拉第一页的触发、失败重试调的是什么；
 * 3. **样式**：胶囊删净不留孤儿规则、可点两格的触控高度。
 *
 * 为什么切片而不是全文 `toContain`：全文断言只能证明「字符串在文件里出现过」，
 * 换个位置、接反两格、多挂一个 onClick 都照样通过（#582 复核里 7 个变异全绿就是这么来的）。
 *
 * 端上表现（点击手感、44pt 触控区）只能在微信开发者工具里目视，不在这里断言。
 */
import { describe, expect, test } from 'bun:test'
import { toggleAnchor } from '../src/pkg-browse/pages/user/scroll-anchor'
import type { SegmentRequest } from '../src/pkg-browse/pages/user/segment-page'
import {
  applySegmentPage,
  firstPageOf,
  isCurrentRequest,
  segmentOfTab,
} from '../src/pkg-browse/pages/user/segment-page'

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

describe('isCurrentRequest —— 回来的响应还算不算数', () => {
  test('段与代号都对才算当前请求，任一不符即过期', () => {
    expect(isCurrentRequest({ seg: 'SOLD', epoch: 3 }, { seg: 'SOLD', epoch: 3 })).toBe(true)
    // 段变了：切段了，这是上一段的响应
    expect(isCurrentRequest({ seg: 'ACTIVE', epoch: 3 }, { seg: 'SOLD', epoch: 3 })).toBe(false)
    // 段又切回来了，但中间切过（代号变了）：仍是上一次的响应
    expect(isCurrentRequest({ seg: 'SOLD', epoch: 3 }, { seg: 'SOLD', epoch: 4 })).toBe(false)
  })
})

describe('applySegmentPage —— 切段瞬间回来的旧段数据不许落进新段', () => {
  // 已售出视图：一条数据、没有下一页、已加载完成
  const soldPage = {
    items: [{ id: 'sold-1' }],
    nextCursor: null,
    loaded: true,
    loading: false,
    failed: false,
  }

  test('过期响应原样返回，列表 / 游标 / 三态一个字段都不动', () => {
    const stale: SegmentRequest = { seg: 'ACTIVE', epoch: 1 }
    const live: SegmentRequest = { seg: 'SOLD', epoch: 2 }
    const applied = applySegmentPage(
      soldPage,
      stale,
      live,
      { listings: [{ id: 'active-1' }, { id: 'active-2' }], nextCursor: 'n1' },
      null,
    )
    // 引用相等：不是「值相同」，是压根没重建 —— 旧段的列表没混进来，
    // `loading` 没被改回 false（新段自己的请求还在飞），`nextCursor` 也没被旧游标顶掉
    expect(applied).toBe(soldPage)
  })

  test('当前响应照常合并：续页追尾、换游标、三态收敛', () => {
    const live: SegmentRequest = { seg: 'SOLD', epoch: 1 }
    const applied = applySegmentPage(
      { items: [{ id: 'sold-1' }], nextCursor: 'c1', loaded: false, loading: true, failed: false },
      live,
      live,
      { listings: [{ id: 'sold-2' }], nextCursor: 'c2' },
      'c1',
    )
    expect(applied).toEqual({
      items: [{ id: 'sold-1' }, { id: 'sold-2' }],
      nextCursor: 'c2',
      loaded: true,
      loading: false,
      failed: false,
    })
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

  test('口径初值来自 ?tab=，之后由页内 state 驱动，页面不再拼自己的路由', async () => {
    const code = await page
    expect(code).toContain('useState<Segment>(() => segmentOfTab(router.params.tab))')
    // 页内切换后没人再拼「回自己」的地址，深链只由外部带进来
    expect(code).not.toContain('userHomeUrl')
    // 请求发的是「发起时的段」（`sent.seg`），不是可能已经过期的 state
    expect(code).toContain('loadPublicUserListingsPage(userId, sent.seg, cursor)')
  })

  test('首屏那一页走 firstPageOf，不在页面里手写「口径是否 ACTIVE」的分支', async () => {
    const code = await page
    expect(code).toContain('firstPageOf(segRef.current, result)')
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

  test('页头两格只改本页状态：不压栈、不跳转、不写 URL 参数（#582 交互改动）', async () => {
    const code = await page
    const section = slice(
      code,
      'const switchSegment = useCallback(',
      'const IDENTITY_FALLBACK = 320',
    )

    // 页内切换：整块里不许出现任何路由跳转，也不许回写 ?tab=
    expect(section).not.toContain('navigate')
    expect(section).not.toContain('redirectTo')
    expect(section).not.toContain('tab=')

    // 已经在当前段：只滚列表，且必须**提前返回** —— 少了 return 会接着把数据重置、白拉一遍
    const same = slice(section, 'if (segRef.current === next) {', '}')
    expect(same.replace(/\s+/g, ' ')).toContain('scrollToBody() return')

    // 换段的顺序是有讲究的：先作废在途请求，再改同步镜像、state、数据、滚动
    const order = [
      'epoch.current += 1',
      'inFlight.current = false',
      'segRef.current = next',
      'setSeg(next)',
      'setPage(emptyPage())',
      'scrollToBody()',
    ]
    let at = -1
    for (const step of order) {
      const found = section.indexOf(step, at + 1)
      expect(found).toBeGreaterThan(at)
      at = found
    }

    // 两个入口各自只调自己那一档
    const sold = slice(
      code,
      'const openSoldListings = useCallback(',
      'const openActiveListings = useCallback(',
    )
    expect(sold).toContain("switchSegment('SOLD')")
    const active = slice(
      code,
      'const openActiveListings = useCallback(',
      'const IDENTITY_FALLBACK = 320',
    )
    expect(active).toContain("switchSegment('ACTIVE')")
  })

  test('在途请求带段 + 代号：切段后回来的旧响应整包丢弃（#582）', async () => {
    const code = await page
    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    // 发起时记下身份，请求用的也是它（不是渲染快照里的 seg）
    expect(body).toContain(
      'const sent: SegmentRequest = { seg: segRef.current, epoch: epoch.current }',
    )
    expect(body).toContain('loadPublicUserListingsPage(userId, sent.seg, cursor)')
    expect(body).toContain('applySegmentPage(prev, sent, live(), next, cursor)')
    // 成功分支：拿到数据之后、写状态之前必须再判一次身份（写状态时可能已经切过段）
    const tryBody = slice(body, 'const next = await', 'catch (error)')
    expect(tryBody).toContain('if (!isCurrentRequest(sent, live())) return')
    // 闩只由「自己这一份」归还：切段时闩已被新段接管，旧响应不许替新段解锁
    expect(body).toContain('if (isCurrentRequest(sent, live())) inFlight.current = false')
    // 失败分支同样先判身份：旧段的失败不能把新段打成 failed
    const catchAt = body.indexOf('catch (error)')
    expect(catchAt).toBeGreaterThan(-1)
    expect(body.slice(catchAt)).toContain('if (!isCurrentRequest(sent, live())) return')
  })

  test('滚列表用交替锚点，不写死单一 id', async () => {
    const code = await page
    expect(code).toContain('id="uhome-body-a"')
    expect(code).toContain('id="uhome-body-b"')
    // 写死一个 id 的话连点第二次没有任何反应（scrollIntoView 同值不重滚）
    expect(code).not.toContain("setTopAnchor('uhome-body')")
    // 锚点必须贴在列表上沿：搬到页顶也「两个 id 都在」，但落点就跑到页头去了
    expect(code.replace(/\s+/g, ' ')).toContain(
      '<View id="uhome-body-b" /> <View className="uhome__body">',
    )
    const body = slice(code, 'const scrollToBody = useCallback(', '}, [])')
    // 只钉「两个 id 都在、且交给交替函数」，不钉参数顺序 —— 两个 id 互换行为完全等价
    expect(body).toContain("'uhome-body-a'")
    expect(body).toContain("'uhome-body-b'")
    expect(body).toContain('toggleAnchor(prev,')
    // 滚动只发生在 `switchSegment` 里：同段连点一次、换段一次，都靠它把列表滚进视野
    const switcher = slice(
      code,
      'const switchSegment = useCallback(',
      'const openSoldListings = useCallback(',
    )
    expect((switcher.match(/scrollToBody\(\)/g) ?? []).length).toBe(2)
  })

  test('没载入就补拉第一页（已售出实例全靠它），失败后不自动重试', async () => {
    const code = await page
    const effect = slice(code, '列表还没拉过时补第一页', '}, [loadSegment, loadState, page])')
    expect(effect).toContain('void loadSegment(null)')
    expect(effect).toContain("if (loadState !== 'ok') return")
    // 三态守卫缺一不可：只剩 `page.loaded` 的话，`failed` 之后每次渲染都会再打一次接口
    expect(effect.replace(/\s+/g, ' ')).toContain(
      'if (page.loaded || page.loading || page.failed) return',
    )
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
