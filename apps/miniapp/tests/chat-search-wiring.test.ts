/**
 * 消息页搜索（#669）的**接线层**回归。
 *
 * 本仓 `apps/miniapp/tests/` 没有 Taro 组件渲染基建（页面用真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-count.test.ts` 文件头），
 * 页面接线只能读源码文本钉住 —— 手法同 `tests/conversation-unread-wiring.test.ts`、
 * `tests/following-wiring.test.ts`。
 *
 * 判据层（匹配 / 去重 / 截断 / 范围文案）由 `tests/chat-search.test.ts` 覆盖，
 * 本文件钉的是**页面有没有把判据接对**。这里每一条都对应一次独立审查抓到过的缺陷，
 * 而且都是「实现看着没问题、改一行就静默复发」的地方：
 *
 * 1. 搜索读的是**会话快照**，不是 `items` 本身（否则从会话页返回就闪一次「正在搜索…」）；
 * 2. 进搜索模式时刷新快照（否则「退出 → 再进」拿着一副空列表搜，什么都搜不出来）；
 * 3. 逐会话失败数进了结果状态（否则「没连上」被说成「没命中」）；
 * 4. 消息缓存随列表刷新失效，且**推进缓存代次**（否则在途请求把撤回前的旧页写回去）；
 * 5. 退出搜索推进代次并滚回顶部（否则在途结果落在已退出的界面上、页面停在空白处）；
 * 6. 列表就绪那一次会补跑搜索（否则加载中打好的关键词永远搜不到本地两段）；
 * 7. 结果区拿到的是列表**形态**（`listState`），不是一个 `localFailed` 布尔。
 */
import { describe, expect, test } from 'bun:test'

/** 页面源码（接线层只读文本，仓库没有 Taro 组件渲染基建） */
async function source(): Promise<string> {
  return Bun.file(new URL('../src/pages/chat/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 断言 `first` 出现在 `second` 之前（两者都必须存在） */
function expectBefore(block: string, first: string, second: string): void {
  const i = block.indexOf(first)
  const j = block.indexOf(second)
  expect(i, `块里应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `块里应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i, `${first} 应在 ${second} 之前`).toBeLessThan(j)
}

const RUN_SEARCH_START = 'const runSearch = useCallback'
const CLOSE_SEARCH_START = 'const closeSearch = () => {'

/** `runSearch` 的函数体 */
function runSearchBlock(code: string): string {
  return sliceFrom(code, RUN_SEARCH_START, '[loadSearchedMessages],')
}

/** `closeSearch` 的函数体 */
function closeSearchBlock(code: string): string {
  return sliceFrom(
    code,
    CLOSE_SEARCH_START,
    'void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })',
  )
}

describe('#669 接线：搜索读会话快照，不读 items', () => {
  test('runSearch 只从快照取会话，直接吃 items 会让返回路径重跑整套搜索', async () => {
    const block = runSearchBlock(await source())
    expect(block).toContain('searchItemsRef.current')
    // 直接依赖 items：`useDidShow` 每次返回都换 items 引用 → 防抖 effect 重跑 →
    // 用户看到结果闪成「正在搜索…」并重打一次商品接口（审查 #5）
    expect(block).not.toContain('matchConversations(items')
    expect(block).not.toContain('items.slice(')
  })

  test('进搜索模式时刷新快照（退出再进不能拿空数组搜）', async () => {
    const code = await source()
    const block = sliceFrom(
      code,
      'const activateSearch = () => {',
      'void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })',
    )
    // `searchItemsRef` 的同步 effect 依赖 items：退出搜索时若把快照清空，
    // items 引用没变、effect 不会重跑 → 第二次进搜索一个人都搜不到
    expect(block).toContain('searchItemsRef.current = items')
    expect(closeSearchBlock(code)).not.toContain('searchItemsRef.current = []')
  })
})

describe('#669 接线：失败与范围都要如实进状态', () => {
  test('逐个会话的失败数写进 state，供底注与空态共用', async () => {
    const block = runSearchBlock(await source())
    expect(block).toContain('setFailedScans(failed)')
    // 实际扫了几个会话也要是**事实**（不是常量上限），否则范围文案在撒谎
    expectBefore(block, 'setScannedConversations(targets.length)', 'setSearching(false)')
  })

  test('结果区拿到的是列表形态，不是一个布尔', async () => {
    const code = await source()
    expect(code).toContain('listState={state}')
    expect(code).not.toContain('localFailed={')
  })
})

describe('#669 接线：消息缓存的两个代次', () => {
  test('列表刷新时清缓存并推进缓存代次', async () => {
    const code = await source()
    const block = sliceFrom(
      code,
      'const reloadConversations = useCallback',
      'searchMessageCache.current.clear()',
    )
    // 只 clear 不推进代次：清空之前发出的消息页请求会在 clear 之后返回，
    // 按「搜索轮次没变」的守卫把撤回前的旧页写回缓存（审查 D）
    expectBefore(block, 'searchCacheEpoch.current += 1', 'searchMessageCache.current.clear()')
  })

  test('写缓存只认缓存代次，不认搜索轮次', async () => {
    const block = sliceFrom(
      await source(),
      'const loadSearchedMessages = useCallback',
      'return page.items',
    )
    // 只让缓存代次守：搜索代次每敲一个字就前进，用它守会把在途的 10 个消息页
    // 全部丢弃且不写回 → 连续输入时每轮从零重拉，缓存等于没做（审查第 3 条）
    expect(block).toContain('cacheEpoch === searchCacheEpoch.current')
    expect(block).not.toContain('epoch === searchEpoch.current')
    expect(block).not.toContain('epoch: number')
  })
})

describe('#669 接线：退出搜索与列表就绪', () => {
  test('退出搜索推进代次并滚回顶部', async () => {
    const block = closeSearchBlock(await source())
    // 不推进代次：退出前发出的搜索会在退出后把结果写回已关闭的结果区
    expectBefore(block, 'searchEpoch.current += 1', 'setSearchResults(EMPTY_RESULTS)')
    // 不滚回顶部：结果区比列表短，退出后页面停在列表内容之外的空白处（审查 C）
    expect(block).toContain('Taro.pageScrollTo')
  })

  test('列表 loading/error → list/empty 跃迁时补跑一次搜索', async () => {
    const code = await source()
    // 判据本身是纯函数（`shouldRerunSearch`，见 chat-search.test.ts 的跃迁用例），
    // 这里只钉「页面确实用了它」，并且补跑前把挂起的防抖 timer 清掉 ——
    // 不清就是「补跑一轮 + 300ms 后整轮重扫」，后一轮必然被代次守卫丢弃，请求白发
    expect(code).toContain('shouldRerunSearch(prev, state, searchQuery)')
    const block = sliceFrom(
      code,
      'shouldRerunSearch(prev, state, searchQuery)',
      'void runSearch(query, epoch)',
    )
    expect(block).toContain('clearTimeout(searchTimer.current)')
  })

  test('消息页请求有在途表，两轮重叠时同一会话只发一次', async () => {
    const block = sliceFrom(
      await source(),
      'const loadSearchedMessages = useCallback',
      'return task',
    )
    expect(block).toContain('searchInflight.current.get(conversationId)')
    expect(block).toContain('searchInflight.current.set(conversationId, task)')
  })
})

describe('#669 接线：搜索在途时不能露出上一轮结果', () => {
  test('三段结果都被 searching 挡住', async () => {
    const ui = await Bun.file(new URL('../src/pages/chat/search-ui.tsx', import.meta.url)).text()
    // 不挡：防抖 + 10 个消息页往返期间，屏上是「正在搜索…」+ 上一轮关键词的命中行，
    // 而且照常可点 → 用户点进一个与当前输入无关的会话（审查第 4 条）
    for (const segment of ['contacts', 'listings', 'messages']) {
      expect(ui).toContain(`{!searching && results.${segment}.length > 0 ? (`)
    }
  })

  test('已经在搜索模式里再点输入框不重复滚顶', async () => {
    const block = sliceFrom(
      await source(),
      'const activateSearch = () =>',
      'void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })',
    )
    expect(block).toContain('if (searchActive) return')
  })
})

describe('#669 接线：被取代的搜索与换账号', () => {
  test('迟到的搜索结果不许写状态，也不许提前关掉新一轮的「正在搜索…」', async () => {
    const block = runSearchBlock(await source())
    // 少了这条：上一轮关键词的命中会覆盖新一轮的结果（用户看到的是「手机的搜索结果」其实是「键盘的」）
    expect(block).toContain('if (epoch !== searchEpoch.current) return')
    // 收尾必须跟着代次：放在无条件的 finally 里，旧一轮返回会把新一轮的 loading 关掉
    expect(block).toContain('if (epoch === searchEpoch.current) setSearching(false)')
  })

  test('换账号时搜索状态与两个代次一起清（验收 7）', async () => {
    const block = sliceFrom(
      await source(),
      'if (prevIdentity !== identity) {',
      'searchItemsRef.current = []',
    )
    // 不推进请求代次：上一个账号在途的搜索会在新账号界面上把它的聊天记录写回来
    expect(block).toContain('searchEpoch.current += 1')
    expect(block).toContain('searchCacheEpoch.current += 1')
    expect(block).toContain('searchMessageCache.current.clear()')
    for (const clearing of [
      'setSearchActive(false)',
      'setSearchQuery(',
      'setSearchResults(EMPTY_RESULTS)',
      'setSearching(false)',
      'setMarketSearchFailed(false)',
      'setScannedConversations(0)',
      'setFailedScans(0)',
    ]) {
      expect(block).toContain(clearing)
    }
    // 快照也要清：留着上一个账号的会话，新账号第一搜会把上个账号的联系人/商品列出来
    expect(block).toContain('searchItemsRef.current = []')
  })
})

describe('#669 接线：截断要说明，不能把「还有更多」说成「就这些」', () => {
  test('三段分别按各自上限判断是否截断，且段头带「+」', async () => {
    const ui = await Bun.file(new URL('../src/pages/chat/search-ui.tsx', import.meta.url)).text()
    for (const [segment, constant] of [
      ['contacts', 'MAX_CONTACT_HITS'],
      ['listings', 'MAX_MARKET_HITS'],
      ['messages', 'MAX_MESSAGE_HITS'],
    ] as const) {
      expect(ui).toContain(`results.${segment}.length >= ${constant}`)
      expect(ui).toContain(`truncated={${segment}Truncated}`)
    }
    // 光打「+」不够：得有一句说明「+」是什么意思，否则用户仍会读成「一共这么多」
    expect(ui).toContain("truncated ? '+' : ''")
    expect(ui).toContain('csres__more-tx')
  })
})
