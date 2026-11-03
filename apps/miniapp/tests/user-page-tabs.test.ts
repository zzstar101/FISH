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
import type { Segment, SegmentRequest } from '../src/pkg-browse/pages/user/segment-page'
import {
  applySegmentPage,
  firstPageOf,
  isCurrentRequest,
  makeSegmentLoader,
  segmentOfTab,
  segTitleOf,
  shouldRefetch,
  totalOf,
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

/**
 * 「在途请求不污染新段」是页内切段唯一的正确性卖点，而它只靠两行代码撑着：
 * `live()` 实时读当前口径与代号、`finally` 只由自己那一份归还闩。这两处删掉都不会让
 * 任何 `toContain` 变红 —— 所以逻辑抽成了 `makeSegmentLoader`，这里用挂起的 promise
 * 把时序真的跑一遍（#582 审查中-1）。
 */
describe('makeSegmentLoader —— 切段瞬间回来的旧段响应', () => {
  type Item = { id: string }
  type Fetched = { listings: Item[]; nextCursor: string | null }

  /** 一条挂起的请求：什么时候回来、回来是成功还是失败，都由用例自己决定。 */
  const pending = () => {
    let settle!: {
      resolve: (page: Fetched | null) => void
      reject: (error: unknown) => void
    }
    const promise = new Promise<Fetched | null>((resolve, reject) => {
      settle = { resolve, reject }
    })
    return { promise, settle }
  }

  /** 加载器 + 它的取数记录；`gates` 按段号存着那一条还没回来的请求。 */
  const setup = () => {
    const view: { seg: Segment; epoch: number } = { seg: 'ACTIVE', epoch: 0 }
    const calls: Array<{ seg: Segment; cursor: string | null }> = []
    const gates = new Map<Segment, ReturnType<typeof pending>>()
    const loader = makeSegmentLoader<Item>({
      getSeg: () => view.seg,
      getEpoch: () => view.epoch,
      fetch: (seg, cursor) => {
        calls.push({ seg, cursor })
        const gate = pending()
        gates.set(seg, gate)
        return gate.promise
      },
    })
    return { view, calls, gates, loader }
  }

  /** 页面 `switchSegment` 干的三件事：换口径、作废代号、放开闩。 */
  const switchTo = (h: ReturnType<typeof setup>, next: Segment) => {
    h.view.epoch += 1
    h.view.seg = next
    h.loader.release()
  }

  const handlers = (seen: string[]) => ({
    onPage: () => {
      seen.push('page')
    },
    onMissing: () => {
      seen.push('missing')
    },
    onFailed: () => {
      seen.push('failed')
    },
  })

  test('旧段成功响应回来：一个回调都不调，也不替新段归还闩', async () => {
    const h = setup()
    const seen: string[] = []
    const old = h.loader.load(null, handlers(seen))
    expect(h.calls).toEqual([{ seg: 'ACTIVE', cursor: null }])

    switchTo(h, 'SOLD')
    const fresh = h.loader.load(null, handlers(seen))
    // 旧段的闩已被切段放开：新段这一份真的发出去了（两道请求同时在飞）
    expect(h.calls.map((call) => call.seg)).toEqual(['ACTIVE', 'SOLD'])

    h.gates.get('ACTIVE')?.settle.resolve({ listings: [{ id: 'active-1' }], nextCursor: 'a-next' })
    expect(await old).toBe('stale')
    // 「不污染新段」的实义：列表、游标、三态一个都没被旧响应写过
    expect(seen).toEqual([])
    // 闩仍由新段那一份持有：`finally` 无条件归还的话，第三次调用会真的发出请求
    void h.loader.load(null, handlers(seen))
    expect(h.calls.length).toBe(2)

    h.gates.get('SOLD')?.settle.resolve({ listings: [{ id: 'sold-1' }], nextCursor: null })
    expect(await fresh).toBe('applied')
    expect(seen).toEqual(['page'])
  })

  test('旧段失败响应回来：不置 failed，也不归还新段的闩', async () => {
    const h = setup()
    const seen: string[] = []
    const old = h.loader.load(null, handlers(seen))
    switchTo(h, 'SOLD')
    const fresh = h.loader.load(null, handlers(seen))

    h.gates.get('ACTIVE')?.settle.reject(new Error('旧段的网络错误'))
    expect(await old).toBe('stale')
    expect(seen).toEqual([])
    // 同上：旧段的失败不许替新段解锁
    void h.loader.load(null, handlers(seen))
    expect(h.calls.length).toBe(2)

    h.gates.get('SOLD')?.settle.resolve(null)
    expect(await fresh).toBe('missing')
    expect(seen).toEqual(['missing'])
  })

  test('同一段但代号变了（重载）：响应同样作废，不许写进视图', async () => {
    const h = setup()
    const seen: string[] = []
    const old = h.loader.load(null, handlers(seen))
    // 页面 `load()` 只换代、不换段：判定必须「段 + 代号」一起看，缺一就漏
    h.view.epoch += 1
    h.loader.release()

    h.gates.get('ACTIVE')?.settle.resolve({ listings: [{ id: 'active-1' }], nextCursor: null })
    expect(await old).toBe('stale')
    expect(seen).toEqual([])
  })

  test('没切段的正常路径：先 onStart，再按结局回调，结束后把闩还回来', async () => {
    const h = setup()
    const seen: string[] = []
    const running = h.loader.load(null, {
      onStart: () => {
        seen.push('start')
      },
      ...handlers(seen),
    })
    expect(seen).toEqual(['start'])

    h.gates.get('ACTIVE')?.settle.resolve({ listings: [{ id: 'active-1' }], nextCursor: 'a-next' })
    expect(await running).toBe('applied')
    expect(seen).toEqual(['start', 'page'])

    // 闩已归还：下一份能进（发不发得出去，看 `calls` 就知道）
    void h.loader.load(null, handlers(seen))
    expect(h.calls.length).toBe(2)
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
    // 取数读的是同步镜像 `segRef`（`state` 要等下一次渲染），判定与重入都在加载器里
    const loader = slice(code, 'const loader = useMemo(', '[userId],')
    expect(loader).toContain('getSeg: () => segRef.current')
    expect(loader).toContain('loadPublicUserListingsPage(userId, status, cursor)')
  })

  test('首屏那一页走 firstPageOf，不在页面里手写「口径是否 ACTIVE」的分支', async () => {
    const code = await page
    expect(code).toContain('firstPageOf(segRef.current, result)')
    // 页面里不再有「按口径分支」的写法（口径的判定全在 `firstPageOf` / `totalOf` / `segTitleOf` 里）
    expect(code).not.toContain('if (seg ===')
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
      'loader.release()',
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

  test('整页重载也作废在途请求：重置数据之外还要换代 + 放开闩（#582 审查低-1）', async () => {
    const code = await page
    // `load()` 会把分段数据整份重置、闩也放开。不换代的话，上一轮还在飞的响应回来时
    // 身份仍然有效，会写进这一轮刚清空的视图（切段那条路已由上面那条用例钉住）
    const body = slice(code, 'const load = useCallback(async () => {', '}, [loader, userId])')
    expect(body).toContain('setPage(emptyPage())')
    expect(body).toContain('epoch.current += 1')
    expect(body).toContain('loader.release()')
  })

  test('在途请求的段 / 代号校验交给加载器，页面只注入同步镜像与取数（#582）', async () => {
    const code = await page
    // 身份与闩的**判断**搬进了 `makeSegmentLoader`（行为级用例见上面那一组）：
    // 页面这边只负责把「当前口径 / 代号」的同步读法与真实取数交进去。
    const loader = slice(code, 'const loader = useMemo(', '[userId],')
    expect(loader).toContain('getSeg: () => segRef.current')
    expect(loader).toContain('getEpoch: () => epoch.current')
    expect(loader).toContain('loadPublicUserListingsPage(userId, status, cursor)')

    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    // 页面不再自己判身份 / 自己管闩：重入、过期、用户消失全由加载器分档
    expect(body).toContain('await loader.load(cursor, {')
    expect(body).not.toContain('isCurrentRequest')
    expect(body).not.toContain('inFlight')
    // 写回时仍带当前身份（写 state 的那一刻可能又切过段），交给 `applySegmentPage` 兜底
    expect(body).toContain('applySegmentPage(prev, sent, liveRequest(), next, at)')
    // 用户在这一步消失 → 整页 notFound；列表失败只降级列表
    expect(body).toContain("onMissing: () => setLoadState('notFound')")
    expect(body).toContain('failed: true')
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

  test('空页就补拉第一页（切段后 / 深链进已售出都靠它），失败后不自动重试', async () => {
    const code = await page
    const effect = slice(code, '列表还没拉过时补第一页', '}, [loadSegment, loadState, page])')
    // 守卫搬进纯函数 `shouldRefetch`（三态与加载态的样本在下面那组），页面只留一句判定：
    // 只剩 `page.loaded` 的话，`failed` 之后每次渲染都会再打一次接口。
    expect(effect).toContain('if (!shouldRefetch(loadState, page)) return')
    expect(effect).toContain('void loadSegment(null)')
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

describe('shouldRefetch / totalOf / segTitleOf —— 口径的单一来源（#582 首轮审查 M1 / M4 / 低-3）', () => {
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

describe('他人主页口径接线（#582 首轮审查 M1–M6 / 低）', () => {
  const page = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()
  const style = Bun.file(new URL('../src/pkg-browse/pages/user/index.scss', import.meta.url)).text()

  test('补拉 effect 不看口径：判定交给 shouldRefetch，不是「只有 SOLD 才补」', async () => {
    const code = await page
    const effect = slice(
      code,
      '// 「该不该补拉」由纯函数决定',
      '}, [loadSegment, loadState, page])',
    )
    expect(effect).toContain('if (!shouldRefetch(loadState, page)) return')
    expect(effect).toContain('void loadSegment(null)')
    // 写成「只有 SOLD 才补」会让切回在售的分段永远空着；拿渲染快照 `segRef` 会更糟
    expect(effect).not.toContain("'SOLD'")
    expect(effect).not.toContain('segRef')
  })

  test('下一页信号与列表终点都取游标 / 服务端总数，不拿条数猜', async () => {
    const code = await page
    expect(code).toContain('const hasMore = page.nextCursor !== null')
    expect(code).toContain('const segTotal = totalOf(seg, profile)')
    expect(code).toContain('userListEnd(items.length, segTotal, hasMore)')
  })

  test('整页重载的换代紧跟数据重置：清除、换代、放开闩是同一步', async () => {
    const code = await page
    const load = slice(code, 'const load = useCallback(async () => {', '}, [loader, userId])')
    // 把换代挪到 `await loadPublicUserHome(...)` 之后，这一轮的首屏响应就会被自己作废
    const order = ['setPage(emptyPage())', 'epoch.current += 1', 'loader.release()']
    let at = -1
    for (const step of order) {
      const found = load.indexOf(step, at + 1)
      expect(found).toBeGreaterThan(at)
      at = found
    }
  })

  test('起始 / 失败两条回调都把三态写全，不留旧值（loading 永真的话列表卡在「加载中」）', async () => {
    const code = await page
    // 整块 handlers 一起取，再按回调名切：`setPage` 那只调用会被 Biome 折成多行，
    // 所以不能拿它的完整字面量当锚点。
    const handlers = slice(code, 'await loader.load(cursor, {', 'const items = page.items')
    const start = handlers.slice(0, handlers.indexOf('onPage:'))
    const failed = handlers.slice(handlers.indexOf('onFailed: (_sent, error) =>'))
    // 开拉：把上一轮的失败态清掉，否则失败后重试会一直停在错误提示上
    expect(start).toContain('loading: true')
    expect(start).toContain('failed: false')
    // 失败：把 loading 落回 false，否则续页失败后列表永远卡在「加载中」
    expect(failed).toContain('loading: false')
    expect(failed).toContain('failed: true')
  })

  test('页头两格与分段标题的样式都在：可点态有按压反馈，标题规则没被连着胶囊一起删掉', async () => {
    const scss = await style
    expect(scss).toContain('.uhome__stat--tap {')
    expect(scss).toContain('.uhome__sect-title {')
  })
})
