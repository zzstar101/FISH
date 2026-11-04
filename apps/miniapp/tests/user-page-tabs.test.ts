import { describe, expect, test } from 'bun:test'
import {
  emptyPage,
  firstPageOf,
  segmentErrorInfo,
  segmentErrorSuffix,
  segmentOfTab,
  segTitleOf,
  shouldRefetch,
  totalOf,
  UNKNOWN_SEGMENT_ERROR,
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
      error: null,
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
      error: null,
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
  if (end < 0) throw new Error(`切片终点缺失：${to}（起点：${from}）`)
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
    // 整页重载也从 `?tab=` 重算，不留「沿用当前段」的镜像；切段自愈时由调用方指名目标段
    const reload = slice(code, 'const load = useCallback(', 'if (userId ===')
    expect(reload).toContain('const initial = target ?? segmentOfTab(tabParam)')
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
    // 代号要在**发请求之前**抓：抓在 await 之后等于永远「对得上」，旧段的响应照样写进新段
    expect(body.indexOf('const sent = generation.current')).toBeLessThan(
      body.indexOf('await loadPublicUserListingsPage'),
    )
    // 过期判定要在**写回之前**：挪到 `setPage(merge…)` 之后就拦不住旧段的响应了
    expect(body.indexOf('if (sent !== generation.current) return')).toBeLessThan(
      body.indexOf('mergeSegmentPage(prev, next, cursor)'),
    )
    // 段级 404（读取层把 404 折成 null）**只降级这一段**：整页 notFound 会把 ScrollView
    // 连页头两格一起卸载，切一次段就丢掉整页（#598）
    expect(body).not.toContain("setLoadState('notFound')")
    expect(slice(body, 'if (next === null) {', 'return')).toContain('failed: true, error: gone')

    // 整页重载也要作废在途请求（#582 审查中-1 那个竞态的同构问题）：换代与放手都在重置数据
    // 之前；#598 复审 F1 起代号顺带留在 `sent` 里，供 await 之后比对（见「切段自愈」那组）
    const reload = slice(code, 'const load = useCallback(', 'if (userId ===')
    expect(reload.replace(/\s+/g, ' ')).toContain(
      'const sent = ++generation.current inFlight.current = false',
    )
    expect(reload.indexOf('const sent = ++generation.current')).toBeLessThan(
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
    // 负 margin 必须有等高的 `height` 兜住（净位移 0）：只有负 margin 的话，这块高度为 0 的
    // 锚点区会把后面整个列表区永久上移一整个导航条，列表标题会压到统计卡上
    expect(flat).toMatch(
      /style=\{\{ marginTop: `-\$\{navTotalHeight\}px`, height: `\$\{navTotalHeight\}px` \}\}/,
    )
    // 写死一个 id、或三元两支指同一个 id，连点第二次都没有任何反应（scrollIntoView 同值不重滚）
    const body = slice(code, 'const scrollToBody = useCallback(', '}, [])').replace(/\s+/g, ' ')
    expect(body).toContain("prev === 'uhome-body-a' ? 'uhome-body-b' : 'uhome-body-a'")
    const top = slice(code, 'const backToTop = () => {', '}').replace(/\s+/g, ' ')
    expect(top).toContain("prev === 'uhome-top-a' ? 'uhome-top-b' : 'uhome-top-a'")
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

  test('请求带的是当前段：段参数写死的话「已售出」永远显示在售商品', async () => {
    const code = await page
    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    expect(body).toContain('loadPublicUserListingsPage(userId, seg, cursor)')
  })

  test('骨架分支要认失败态，否则首屏失败会永远停在骨架屏', async () => {
    const flat = (await page).replace(/\s+/g, ' ')
    expect(flat).toContain("loadState === 'loading' || (!page.loaded && !page.failed) ?")
  })

  test('开拉与失败都把三态写全，不留旧值', async () => {
    const code = await page
    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    // 开拉：清掉上一轮的失败态与错误码，否则失败后重试会一直停在错误提示上
    expect(body).toContain(
      'setPage((prev) => ({ ...prev, loading: true, failed: false, error: null }))',
    )
    // 失败：把 loading 落回 false，否则续页失败后列表永远卡在「加载中」
    expect(body.replace(/\s+/g, ' ')).toContain(
      'setPage((prev) => ({ ...prev, loading: false, failed: true, error: info }))',
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

/**
 * #598：切段失败后「怎么切都出不来」。
 *
 * 根因是 `loadState` 成了终态而 `shouldRefetch` 硬要求 `'ok'` —— 补拉 effect 恒假，
 * 一次 404 / 一次失败之后切段连请求都不发；段级 404 还会把整页打成 notFound，
 * 连 `ScrollView` 和页头那两格一起卸载。这三处修复各自都会让下面的用例变红。
 */
describe('切段自愈与段级失败（#598）', () => {
  const page = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()

  test('切段后一定重新发请求：switchSegment 整份换成 emptyPage()，补拉 effect 由假转真', async () => {
    // 行为（#582 既有口径）：`shouldRefetch` 只在 `!loaded && !loading && !failed` 时放行，
    // `failed` 一律不自动重试 —— 所以「切段能不能重新拉」全看这一段有没有被整份重置。
    expect(shouldRefetch('ok', emptyPage())).toBe(true)
    expect(shouldRefetch('failed', emptyPage())).toBe(false)
    expect(shouldRefetch('notFound', emptyPage())).toBe(false)
    // 接线：`failed: true` 的页面只有被整份换成 `emptyPage()` 才会重新为真。
    // 删掉这一句 ⇒ 段失败后切段静默、连请求都不发（本用例变红）。
    const body = slice(await page, 'const switchSegment = useCallback(', 'const openSoldListings')
    expect(body).toContain('setPage(emptyPage())')
    // 同时作废在途的旧段响应并放开闩，否则新段第一次补拉会被 `inFlight` 挡回
    expect(body).toContain('generation.current += 1')
    expect(body).toContain('inFlight.current = false')
  })

  test('接线：整页重载要领本轮代号，await 之后比对，晚到的响应不许回填', async () => {
    // 失败条件（复审 F1）：`load` 只写 `generation.current += 1`、不把代号留在 `sent` 里，
    // await 之后也没有比对 ⇒ 整页 failed 态的页头两格连点（在售→卖出，两格相邻、现实可达）
    // 时 SOLD 的响应先回、ACTIVE 的后回，结果是 `seg === 'SOLD'` 却摆着一份在售首屏，
    // 而 `loaded: true` 让 `shouldRefetch` 恒假，没有任何一条路会再修它。
    const body = slice(await page, 'const load = useCallback(', 'const loadSegment = useCallback(')
    expect(body).toContain('const sent = ++generation.current')
    const awaitAt = body.indexOf('await loadPublicUserHome(userId)')
    const guardAt = body.indexOf('if (sent !== generation.current) return')
    expect(awaitAt).toBeGreaterThan(-1)
    // 比对必须在 await **之后**：写在前面等于没写
    expect(guardAt).toBeGreaterThan(awaitAt)
    // 目标段仍随参数带过去，否则整页重来后被 `?tab=` 拽回在售
    expect(await page).toContain('const initial = target ?? segmentOfTab(tabParam)')
  })

  test('错误标识从 ApiError 的形状里取，取不到就记 UNKNOWN（不伪装成某个码）', () => {
    expect(segmentErrorInfo({ name: 'ApiError', code: 'VALIDATION_FAILED', status: 422 })).toEqual({
      code: 'VALIDATION_FAILED',
      status: 422,
    })
    // 超时 / 断网抛的不是 `ApiError`（`lib/request` 只在非 2xx 时抛它）
    expect(segmentErrorInfo(new TypeError('request:fail timeout'))).toEqual(UNKNOWN_SEGMENT_ERROR)
    expect(segmentErrorInfo(null)).toEqual(UNKNOWN_SEGMENT_ERROR)
    // 三特征缺一个就不认，否则文案里会冒出 `undefined`
    expect(segmentErrorInfo({ name: 'ApiError', code: 'VALIDATION_FAILED' })).toEqual(
      UNKNOWN_SEGMENT_ERROR,
    )
  })

  test('失败文案把错误码写在脸上：422 / 401 / 5xx 不能长得一样', () => {
    const err422 = segmentErrorSuffix({ code: 'VALIDATION_FAILED', status: 422 })
    expect(err422).toContain('VALIDATION_FAILED')
    expect(err422).toContain('422')
    expect(segmentErrorSuffix({ code: 'UNAUTHENTICATED', status: 401 })).toContain('401')
    expect(segmentErrorSuffix({ code: 'INTERNAL_ERROR', status: 503 })).toContain('503')
    // 没有失败态就不留一个空括号
    expect(segmentErrorSuffix(null)).toBe('')
    // 压根没走到响应（status 0）时说人话，不摆一个「错误码 … 0」出来
    expect(segmentErrorSuffix(UNKNOWN_SEGMENT_ERROR)).not.toContain('错误码')
  })

  test('接线：列表失败文案与 Console 都带上码', async () => {
    const code = await page
    expect(code).toContain(`${'${'}segmentErrorSuffix(page.error)}`)
    const body = slice(code, 'const loadSegment = useCallback(', 'const items = page.items')
    expect(body).toContain('const info = segmentErrorInfo(error)')
    expect(body).toContain('console.error(')
    // 只 `console.warn(error)` 一句、不带码，真机验收（拿不到 Console）就没法区分 422 与 5xx
    expect(body).not.toContain('console.warn(')
  })

  test('段级 404 用端上自造的码，不借服务端的 USER_NOT_FOUND', async () => {
    // `features/user/api.ts` 已把 404 折成 `null`，服务端的码到不了这一层：借服务端那个码会
    // 把「页主注销」和「这段列表不可见」混成一句误导诊断（复审 F6）
    const body = slice(await page, 'const loadSegment = useCallback(', 'const items = page.items')
    expect(body).toContain("code: 'LISTING_NOT_FOUND'")
    expect(body).not.toContain("'USER_NOT_FOUND'")
    // 只钉常量名是假绿：把这一支整个退回 `setLoadState('notFound')` 时上面两条仍会绿。
    // 真正的验收③是「404 只降级这一段列表」，所以必须钉住它写的是段内 `failed` + 码。
    expect(slice(body, 'if (next === null) {', 'return')).toContain('failed: true, error: gone')
  })

  test('续页失败留一个可点的出口：列表尾部换成带码的重试行（复审 M1）', async () => {
    // 修复前：`items.length > 0` 时只走 `list-end` 的「仅显示最近 N 件」—— 一句正常文案、
    // 零诊断、没出口；失败空态的门是 `page.failed && items.length === 0`，够不着；
    // 而滚底闸门又挡着 `page.failed` ⇒ 续页失败是死端，网络恢复也不会自愈。
    const retry = slice(await page, 'page.failed && items.length > 0 ? (', "end === 'end'")
    expect(retry).toContain('void loadSegment(page.nextCursor)')
    expect(retry).toContain(`${'${'}segmentErrorSuffix(page.error)}`)
    expect(retry).toContain('没拉到更多')
  })

  test('接线：段失败后滚底不再重打同一个游标', async () => {
    // 段级失败（含续页 404 降级）后 `nextCursor` 还留着：不挡 `page.failed`，
    // 用户每上滑一次就重打同一游标、再失败一次
    const body = slice(
      await page,
      'const onScrollToLower = useCallback(',
      'const [left, right] = useMemo(',
    )
    expect(body).toContain('page.loading || page.failed || page.nextCursor === null')
  })
})

describe('整页终态也留得住页头两格（#598 验收②）', () => {
  const page = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()

  test('报错块落在滚区之内：ScrollView 不再被整页终态整块换掉', async () => {
    const code = await page
    const scrollAt = code.indexOf('<ScrollView')
    const loadErrorAt = code.indexOf('title="主页加载失败"')
    expect(scrollAt).toBeGreaterThan(-1)
    // 修复前是 `{loadState === 'failed' ? <LoadError …/> : … : (<ScrollView>`：报错块在滚区
    // **外面**、两者互斥 ⇒ 页头（含在售 / 卖出两格）跟着 ScrollView 一起被卸载，
    // 整页终态下用户连「切段重试」都点不到
    expect(loadErrorAt).toBeGreaterThan(scrollAt)
  })

  test('整页 failed 时降级页头只留两格，各自点了就按该段整页重拉', async () => {
    const head = slice(
      await page,
      ") : loadState === 'failed' ? (",
      ") : loadState === 'notFound' ? null : (",
    )
    expect(head).toContain('className="uhome__stats"')
    // 复审 F2：`NavBar` 是透明覆盖层，降级页头也得有 `.uhome__identity` 那层让位
    // （`identityTopGap` = 导航条总高 + 16），否则两格画进状态栏 / 返回钮那一带
    expect(head).toContain('className="uhome__identity"')
    expect(head).toContain(`${'${'}identityTopGap}px`)
    expect(head).toContain("onClick={() => void load('ACTIVE')}")
    expect(head).toContain("onClick={() => void load('SOLD')}")
    // 终态下点两格若走 `switchSegment`，会被「同段早退」吃掉（`next === seg` 直接返回），
    // 页面看着有按钮、点了没反应 —— 所以这两格直接 `load(next)`
    expect(head).not.toContain('openActiveListings')
    // 资料压根没到：不编一个假人，昵称 / 头像 / 关注钮一概不画
    expect(head).not.toContain('uhome__pname')
    expect(head).not.toContain('uhome__avatar')
  })

  test('整页失败的重试钮：保住当前段、给一句人话、并把滚动挪回顶部', async () => {
    const err = slice(await page, 'title="主页加载失败"', 'onAction')
    // 复审 F8：`load()` 无参会被 `?tab=` 拽回初值，用户已经切到的段就丢了
    expect(err).toContain('void load(seg)')
    expect(err).not.toContain('void load()')
    // 复审 F7：整页路径上也得有可读的失败说明，不能只剩一个标题
    expect(err).toContain('text="网络异常，请重试"')
    // 复审 F10：`ScrollView` 自本单起常驻，`scrollTop` 会留着而顶栏两态已复位 ——
    // 不归位就是「导航条透明、居中标题不出现」直到用户再滚一次
    expect(err).toContain('backToTop()')
  })

  test('notFound 不画两格（页主不存在，没有可切的段）', async () => {
    expect(await page).toContain(") : loadState === 'notFound' ? null : (")
  })

  test('标题行在整页终态下不再谎称「加载中」', async () => {
    const cnt = slice(await page, 'className="uhome__sect-cnt num"', '</Text>')
    expect(cnt).toContain("loadState === 'failed' || loadState === 'notFound'")
  })
})
