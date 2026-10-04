import { describe, expect, test } from 'bun:test'

/**
 * 瀑布流卡片长按菜单（收藏 / 不感兴趣）在**源码层**的接线。
 *
 * 为什么要有这个文件：需求是「卡片新增菜单，复用这张卡的页面全部生效」——这句话的保证方式只有
 * 一种，就是菜单长在卡片自己身上、任何页面都不必接东西。谁把菜单挪回某个页面、把 JSX 上那条
 * `onLongPress` 绑定删掉、把两个菜单项的序号写反、或不再把本机名单传下来，**编译器和端上点击
 * 都不会报错**（只是功能少了一块或整个不弹），所以这里把最容易静默坏掉的那几条钉在源码上。
 *
 * 断言跑在 `code()` **去掉注释之后**的源码上：卡片源码里正逐条解释着这些机制，只在原文上
 * `toContain`，把某一行注释掉也能过。
 */

async function cardSource(): Promise<string> {
  return await Bun.file(new URL('../src/components/product-card/index.tsx', import.meta.url)).text()
}

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
}

async function searchSource(): Promise<string> {
  return await Bun.file(new URL('../src/pkg-browse/pages/search/index.tsx', import.meta.url)).text()
}

async function detailSource(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url),
  ).text()
}

async function favoritesListSource(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-browse/pages/favorites/list.ts', import.meta.url),
  ).text()
}

/** 去掉注释后的源码：断言必须看**代码** */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 压掉空白：biome 会把单行 `if` 折成两行，按原样匹配就把格式当成了语义 */
function flat(source: string): string {
  return source.replace(/\s+/g, ' ')
}

/** 取 `from` 到其后第一个 `to` 之间的**代码**（两端都不含） */
async function cardSlice(from: string, to: string): Promise<string> {
  const text = code(await cardSource())
  const start = text.indexOf(from)
  expect(start, `卡片源码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `卡片源码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

/** 卡片「已隐藏就不渲染」那一行的标记；既是断言对象，也是下面几个切片的结束位 */
const HIDDEN_GATE = 'if (hidden || ownHidden) return null'

/** 取任意源码里 `from` 到其后第一个 `to` 之间的**代码**（两端都不含） */
function sliceOf(source: string, from: string, to: string): string {
  const text = code(source)
  const start = text.indexOf(from)
  expect(start, `源码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `源码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

describe('菜单属于卡片：任何页面都不需要接长按回调', () => {
  test('长按真的绑到了卡片的菜单上（少这一行等于功能全灭，编译器不报错）', async () => {
    const source = flat(code(await cardSource()))
    expect(source).toContain('onLongPress={() => void handleLongPress()}')
  })

  test('卡片自己弹原生菜单，两个选项就是收藏与不感兴趣', async () => {
    const menu = flat(await cardSlice('const handleLongPress =', HIDDEN_GATE))
    expect(menu).toContain('Taro.showActionSheet({')
    // 菜单文案按**问到的真实收藏态**说，不是按本地名单说
    expect(menu).toContain("current ? '取消收藏' : '收藏'")
    expect(menu).toContain("'不感兴趣'")
  })

  test('两个菜单项的序号常量没被写反（写反了「收藏」会隐藏卡片、不感兴趣会收藏）', async () => {
    const source = code(await cardSource())
    expect(source).toMatch(/const MENU_FAVORITE = 0/)
    expect(source).toMatch(/const MENU_DISLIKE = 1/)
    const menu = flat(await cardSlice('const handleLongPress =', HIDDEN_GATE))
    expect(menu).toContain('tapIndex === MENU_FAVORITE')
    expect(menu).toContain('tapIndex === MENU_DISLIKE')
  })

  test('菜单不靠 props 门禁：卡片上没有 onLongPress 这个入参了', async () => {
    const source = code(await cardSource())
    // 旧的入参形态（页面传回调、不传就没长按行为）必须已经收掉
    expect(source).not.toContain('onLongPress?:')
    // 长按直接进卡片自己的菜单，中间没有「调用方没给回调就 return」
    const menu = flat(await cardSlice('const handleLongPress =', HIDDEN_GATE))
    expect(menu).not.toMatch(/if\s*\(\s*!\s*on[A-Z]/)
  })

  test('先合上「吃掉下一次 tap」的开关，再去 await 菜单', async () => {
    const menu = await cardSlice('const handleLongPress =', HIDDEN_GATE)
    const swallowed = menu.indexOf('swallowNextTapRef.current = true')
    const awaited = menu.indexOf('await Taro.showActionSheet(')
    expect(swallowed).toBeGreaterThanOrEqual(0)
    expect(awaited).toBeGreaterThanOrEqual(0)
    // 反了就等于没拦：菜单弹出与关闭之间隔着好几帧
    expect(swallowed).toBeLessThan(awaited)
  })
})

describe('「不感兴趣」的通用几步留在卡片里（三页共用同一套）', () => {
  test('发 HIDE + 记本地隐藏名单 + 把自己摘掉 + 叫页面补它自己的账', async () => {
    const dislike = flat(await cardSlice('const handleDislike =', 'const handleLongPress ='))
    expect(dislike).toContain("eventType: 'HIDE'")
    expect(dislike).toContain('hideListing(listing.id)')
    expect(dislike).toContain('setOwnHidden(true)')
    expect(dislike).toContain('onDislike?.()')
    /*
      这几步不接受**任何**门禁：搜索页与相似推荐位不传 `onDislike`，也必须真的发 HIDE、
      记名单、摘卡。断言写成「函数体里一个 if 都没有」，而不是匹配某一种写法 ——
      `if (!onDislike) return` 这种反向门禁同样是需求要防的回归，子串匹配抓不到它。
    */
    expect(dislike).not.toMatch(/\bif\s*\(/)
  })

  test('隐藏后整张卡不渲染（页面传下来的判定与卡片自己那份任一为真）', async () => {
    const source = code(await cardSource())
    expect(source).toContain(HIDDEN_GATE)
    /*
      hooks 必须在条件返回之前：隐藏态与收藏态两个 useState 都要先跑。
      先断言「找到了」再比大小 —— `indexOf` 找不到时是 -1，那个负数恰好也「小于」闸门位置，
      只写 toBeLessThan 的话，把 state 改成普通常量（= 摘卡机制没了）测试照样全绿。
    */
    const gate = source.indexOf(HIDDEN_GATE)
    expect(gate).toBeGreaterThanOrEqual(0)
    const ownHidden = source.indexOf(
      'const [ownHidden, setOwnHidden] = useState(() => readHiddenListingIds().includes(listing.id))',
    )
    expect(
      ownHidden,
      '卡片自己那份隐藏态必须是 state（否则长按当场摘不掉卡）',
    ).toBeGreaterThanOrEqual(0)
    expect(ownHidden).toBeLessThan(gate)
    const faved = source.indexOf('const [faved, setFaved] = useState(false)')
    expect(faved, '收藏态必须是 state（否则菜单与心形读不到写回的值）').toBeGreaterThanOrEqual(0)
    expect(faved).toBeLessThan(gate)
  })
})

describe('「收藏」走真实服务端接口（#397 范围 A：不留第二份收藏真值）', () => {
  test('长按先问一次真实收藏态；问不到也要把菜单弹出来', async () => {
    const menu = flat(await cardSlice('const handleLongPress =', HIDDEN_GATE))
    expect(menu).toContain('fetchFavoriteState(listing.id)')
    /*
      读失败（断网 / 会话过期）不能让整个菜单哑掉 —— 那会把同一张表里的「不感兴趣」
      一起废掉。所以 catch 里必须落回一个**可用**的 `current`，再照常弹菜单。
    */
    expect(menu).toContain('current = false')
    expect(menu).toContain('Taro.showActionSheet({')
  })

  test('写入用幂等的 setFavorite，并以服务端返回为准回写 state', async () => {
    const favorite = flat(await cardSlice('const handleFavorite =', 'const handleDislike ='))
    expect(favorite).toContain('setFavorite(listing.id, !current)')
    expect(favorite).toContain('setFaved(state.favorited)')
    expect(favorite).toContain("state.favorited ? 'FAVORITE' : 'UNFAVORITE'")
    /*
      三条顺序都要钉住：
      1) `setFavorite(` 在 `setFaved(` 之前 —— 反了就是「本地先翻转」，写失败时心形已经变过了
      2) 埋点在写成功之后 —— 失败也报 FAVORITE / UNFAVORITE 就是与事实不符
      3) 失败文案走 `favoriteFailureText` —— 它把 LISTING_NOT_FOUND 翻成人话
    */
    const written = favorite.indexOf('setFavorite(')
    expect(written).toBeGreaterThanOrEqual(0)
    expect(written).toBeLessThan(favorite.indexOf('setFaved(state.favorited)'))
    expect(written).toBeLessThan(favorite.indexOf('trackRecommendationEvent('))
    expect(favorite).toContain('favoriteFailureText(caught)')
  })

  test('卡片与详情页都不再读本机收藏名单（收藏真值只剩服务端一份）', async () => {
    for (const source of [code(await cardSource()), code(await detailSource())]) {
      expect(source).not.toContain('isListingFaved')
      expect(source).not.toContain('setListingFavorite')
      expect(source).not.toContain('favorites/local')
    }
  })

  test('初始收藏态是「还没问过」，不是「从本机名单读的结果」', async () => {
    const source = code(await cardSource())
    /*
      `faved === false` 有两种含义（没收藏 / 还没问过），所以必须多一个 `favoriteKnown`：
      没有它，第一次长按会跳过询问、直接把「收藏」当成事实。
    */
    expect(source).toContain('const [faved, setFaved] = useState(false)')
    expect(source).toContain('const [favoriteKnown, setFavoriteKnown] = useState(false)')
  })
})

describe('三个复用页面都按本机名单隐藏，且都不靠删列表项来隐藏', () => {
  test('首页：两处卡片都拿到名单，菜单动作后结算曝光并记 id（不删 items，避免整片换列）', async () => {
    const source = flat(code(await homeSource()))
    expect((source.match(/hidden=\{hiddenIds\.includes\(item\.id\)\}/g) ?? []).length).toBe(2)
    expect((source.match(/onDislike=\{\(\) => onDislikeListing\(item\)\}/g) ?? []).length).toBe(2)
    expect(source).toContain("impressions.settleListing(item.id, 'dismissed')")
    // 反面：不许再用「从 items 里删掉」来隐藏 —— 那会让后面的卡重新分列并重挂载
    expect(source).not.toContain('setItems((prev) => prev.filter((row) => row.id !== item.id))')
  })

  test('搜索页：卡片拿名单、计数分开说「找到 N 件 / 已隐藏 M 件」，且不删 results', async () => {
    const source = flat(code(await searchSource()))
    expect((source.match(/hidden=\{hiddenIds\.includes\(item\.id\)\}/g) ?? []).length).toBe(2)
    expect(
      (
        source.match(
          /onDislike=\{\(\) => setHiddenIds\(\(prev\) => \[\.\.\.prev, item\.id\]\)\}/g,
        ) ?? []
      ).length,
    ).toBe(2)
    expect(source).toContain('results.filter((item) => !hiddenIds.includes(item.id)).length')
    // 计数报服务端给的条数，隐藏另说一句：把两件事混成一个数（报 shownCount）就是自相矛盾
    // 断言到**渲染出来的那个数**，不只看旁边那几个常量 —— 数字换成 shownCount 也要能抓住
    expect(source).toContain('<Text className="search__meta-num num">{results.length}</Text>')
    expect(source).toContain('const hiddenCount = results.length - shownCount')
    expect(source).toMatch(/已隐藏 \$\{hiddenCount\} 件/)
    // 空态读的是「屏幕上还剩几件」：全隐藏时要给出口，不能说成「没找到」
    expect(source).toContain('!loading && shownCount === 0')
    expect(source).not.toContain('setResults((prev) => prev.filter((row) => row.id !== item.id))')
  })

  test('首页：全隐藏后要给空态出口（不能只留一块没文案的白板）', async () => {
    const source = flat(code(await homeSource()))
    // 空态判定必须按「屏幕上真能看到的件数」，不能按 items.length（隐藏不从 items 里删）
    expect(source).toContain('itemCount: visibleCount')
    expect(source).toContain('items.filter((item) => !hiddenIds.includes(item.id)).length')
    expect(source).toContain('这些商品都不感兴趣了')
  })

  test('详情页「同类推荐」：分列按原列表、隐藏只让那张卡自己不渲染', async () => {
    const source = flat(code(await detailSource()))
    expect(source).toContain('splitColumns(similarAll)')
    expect((source.match(/hidden=\{hiddenSimilar\.includes\(item\.id\)\}/g) ?? []).length).toBe(2)
    expect(
      (
        source.match(
          /onDislike=\{\(\) => setHiddenSimilar\(\(prev\) => \[\.\.\.prev, item\.id\]\)\}/g,
        ) ?? []
      ).length,
    ).toBe(2)
    // 空块判定用的是「过滤后还剩几件」，不是「原列表长度为 0」
    expect(source).toContain('visibleSimilarCount === 0 ? null : (')
  })

  test('三个页面都在 useDidShow 的回调体里重读名单（否则在别处隐藏的商品回到这页仍在）', async () => {
    /*
      必须切到 `useDidShow` 的**回调体**里断言：只查「文件里同时存在 useDidShow 与重读语句」
      的话，把重读挪进 `useLoad`（回到本页不再重读）照样全绿 —— 而那正是这条用例要拦的回归。
    */
    for (const source of [
      flat(code(await homeSource())),
      flat(code(await searchSource())),
      flat(code(await detailSource())),
    ]) {
      const body = sliceOf(source, 'useDidShow(() => {', '})')
      // 读名单 + 写进 state 两步都必须在回调体里（首页中间还夹了一次曝光结算与一个 for）
      expect(body).toContain('readHiddenListingIds()')
      expect(body).toMatch(/setHidden(Ids|Similar)\(/)
    }
  })

  test('首页跨页隐藏时先结算曝光（新武装的计时器不能给一张已卸载的卡补发曝光）', async () => {
    const source = flat(code(await homeSource()))
    const body = sliceOf(source, 'useDidShow(() => {', '})')
    expect(body).toContain("impressions.settleListing(id, 'dismissed')")
    // 判定要在 setState 之外：state updater 必须是纯函数
    expect(body).not.toContain('setHiddenIds((prev) =>')
  })
})

describe('「我的收藏」页不再自称「还没接后端」（#394 端点已上线）', () => {
  test('空态说的是「你还没有收藏」，而不是「服务端还没有接口」', async () => {
    const source = flat(code(await favoritesListSource()))
    /*
      端点上线后这两句都成了假话，而且方向最坏：用户明明收藏过，页面却告诉他
      「只记在这台设备上 / 服务端还没有接口」，等于把服务端那份收藏说成不存在。
    */
    expect(source).not.toContain('还没接后端')
    expect(source).not.toContain('这台设备')
    expect(source).not.toContain('没有收藏接口')
    expect(source).toContain('还没有收藏的宝贝')
  })
})
