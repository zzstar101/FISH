import { describe, expect, test } from 'bun:test'

/**
 * 商品详情页留言「按需加载更多」的回归（性能 / 交互项）。
 *
 * 旧行为：展开留言时 `while (pageCount < 20)` 串行把剩余页拉满，然后一次
 * `setComments((prev) => [...prev, ...more])` 推入最多 20 × 50 = 1000 条 —— 真机上单次
 * setData 这么大的数组会明显卡，且用户没翻到底也已付掉全部流量。
 *
 * 新行为：首屏仍只取第一页；列表底部一颗「加载更多」，点一次取**下一页**并追加；加载中
 * 不重复发请求；`commentsCursor === null`（末页）后按钮不再渲染。
 *
 * ## 这是弱验证（weak verification）
 *
 * `index.tsx` 是 Taro 页面组件，本仓没有 React 测试渲染器（`apps/miniapp/package.json`
 * 既无 `@testing-library/*` 也无 `react-test-renderer`；`tests/**` 全仓没有一处 render），
 * 所以这里只能**静态扫描源码**：断言的是「哪条链路上有几次 `fetchComments`、按钮的渲染
 * 条件是什么、append 前有没有在飞守卫与世代守卫」。
 *
 * 它**不证明运行时时序**：React 批处理、连两次点击的真实交错、单次 setData 的实际体积与
 * 帧耗时，都只能按 `docs/miniapp-dev-workflow.md` 在微信开发者工具里实测。把本文件当端上
 * 证据是错的。
 */

/** 取 `index.tsx` 里 `from` 到其后第一个 `to` 之间的源码 */
async function pageSlice(from: string, to: string): Promise<string> {
  const code = await Bun.file(
    new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url),
  ).text()
  const start = code.indexOf(from)
  expect(start, `缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = code.indexOf(to, start + from.length)
  expect(end, `缺少片段：${to}`).toBeGreaterThan(start)
  return code.slice(start, end)
}

/** 一段源码里 `needle` 出现的次数（用 `split` 而不是正则，避免转义写错） */
function countOf(block: string, needle: string): number {
  return block.split(needle).length - 1
}

/** 断言 `first` 在 `block` 里出现在 `second` **之前**（两者都必须真的存在） */
function expectBefore(block: string, first: string, second: string): void {
  const head = block.indexOf(first)
  const tail = block.indexOf(second)
  expect(head, `缺少片段：${first}`).toBeGreaterThanOrEqual(0)
  expect(tail, `缺少片段：${second}`).toBeGreaterThanOrEqual(0)
  expect(head).toBeLessThan(tail)
}

async function source(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url),
  ).text()
}

describe('详情页留言分页 · 首屏只取一页', () => {
  test('首次加载只发一次不带游标的请求，不翻页', async () => {
    const block = await pageSlice('async function loadComments', 'function logCommentFailure')

    // 恰好一次 `fetchComments(`，且是不带游标那一发（第二参一旦出现就说明首屏就翻页了）
    expect(countOf(block, 'fetchComments(')).toBe(1)
    expect(block).toContain('const page = await fetchComments(id)')
    expect(block).not.toContain('fetchComments(id,')
    // 首屏没有 `cursor` 变量参与请求（`nextCursor` 只是把服务端游标原样交给调用方）
    expect(block).not.toContain('while (')
    expect(block).not.toContain('for (')
  })

  test('首屏落地是整体替换成第一页，不是追加', async () => {
    const block = await pageSlice('const load = () => {', '* 从子页返回时的**静默**同步')

    expect(block).toContain('setComments(loaded.comments)')
    // 旧写法若残留在这里，首屏就会把历史页叠上来
    expect(block).not.toContain('...prev,')
    // 游标只在读取成功时收下（失败分支没有游标）
    expect(block).toContain("setCommentsCursor(loaded.status === 'ok' ? loaded.nextCursor : null)")
  })
})

describe('详情页留言分页 · 「加载更多」一次一页', () => {
  test('点一次只取下一页：一次带游标的请求 + 追加 + 接管新游标', async () => {
    const block = await pageSlice(
      'const loadMoreComments = async () => {',
      'const listing = data?.listing',
    )

    expect(countOf(block, 'fetchComments(')).toBe(1)
    expect(block).toContain('const page = await fetchComments(id, cursor)')
    // 游标前进才追加；没前进就是末页（判据见下面「末页后按钮消失」那组）
    expect(block).toContain('if (next === cursor) {')
    expect(block).toContain('setComments((prev) => [...prev, ...page.items.map(dtoToNode)])')
    expect(block).toContain('setCommentsCursor(next)')
    expectBefore(block, 'const next = page.nextCursor', 'setComments((prev)')
    expectBefore(
      block,
      'fetchComments(id, cursor)',
      'setComments((prev) => [...prev, ...page.items.map(dtoToNode)])',
    )
    // 旧实现的批量循环必须已经不在：留着就还是「一次拉满 20 页」
    expect(block).not.toContain('while (')
    expect(block).not.toContain('for (')
    expect(block).not.toContain('more.push(')
  })

  test('没有游标就什么都不做：末页点不动（不空发请求）', async () => {
    const block = await pageSlice(
      'const loadMoreComments = async () => {',
      'const listing = data?.listing',
    )
    expectBefore(
      block,
      'if (!cursor || loadingMoreRef.current) return',
      'fetchComments(id, cursor)',
    )
  })

  test('加载中重复点击被拦下：在飞标记在请求之前置位、finally 才复位', async () => {
    const block = await pageSlice(
      'const loadMoreComments = async () => {',
      'const listing = data?.listing',
    )
    expectBefore(block, 'loadingMoreRef.current = true', 'await fetchComments(id, cursor)')
    expectBefore(block, 'await fetchComments(id, cursor)', 'loadingMoreRef.current = false')
    // 按钮文字跟着在飞状态走（`following` / `chat` 页脚同款的「正在加载…」写法）
    expect(block).toContain('setLoadingMore(true)')
    expect(block).toContain('setLoadingMore(false)')
  })

  test('追加前先确认读取世代没被重试 / 返回刷新顶掉', async () => {
    const block = await pageSlice(
      'const loadMoreComments = async () => {',
      'const listing = data?.listing',
    )
    expectBefore(block, 'if (!isLatestLoad(seq, loadSeqRef.current)) return', 'setComments((prev)')
    expectBefore(block, 'if (!mountedRef.current) return', 'setComments((prev)')
  })

  test('展开本身不再发请求：`toggleComments` 只切显隐', async () => {
    const block = await pageSlice('const toggleComments = () => {', 'const loadMoreComments')

    expect(block).toContain('setCommentsOpen((prev) => !prev)')
    expect(block).not.toContain('fetchComments')
    expect(block).not.toContain('cursor')
    // 已经不返回 Promise（旧实现是 async 的，展开即拉取）
    expect(block).not.toContain('async')
  })
})

describe('详情页留言分页 · 末页后按钮消失', () => {
  test('服务端把同一个游标再发回来时按末页收口（不会一遍遍叠同一页）', async () => {
    const block = await pageSlice(
      'const loadMoreComments = async () => {',
      'const listing = data?.listing',
    )

    // 游标没前进 ⇒ 当末页收口，而且**在 append 之前**就掉头：
    // 那一批就是刚才那批，先追加再收口会白多出一页重复行（第六轮独立审查 D-1）
    expect(block).toContain('const next = page.nextCursor')
    expect(block).toContain('if (next === cursor) {')
    expect(block).toContain('setCommentsCursor(null)')
    expectBefore(block, 'const next = page.nextCursor', 'if (next === cursor)')
    expectBefore(block, 'if (next === cursor) {', 'setComments((prev)')
    // 无条件接管服务端游标的旧写法不能回来（服务端违约时会无限重复追加）
    expect(block).not.toContain('setCommentsCursor(page.nextCursor)')
    expect(block).not.toContain('setCommentsCursor(next === cursor ? null : next)')
  })

  test('按钮只在「已展开且还有下一页」时渲染 —— 游标为 null 即下线', async () => {
    const block = await pageSlice('{/* 分页脚', '{/* 计数按')

    expect(block).toContain('{commentsOpen && commentsCursor ? (')
    expect(block).toContain('onClick={() => void loadMoreComments()}')
    expect(block).toContain("{loadingMore ? '正在加载…' : '加载更多'}")
    // 复用页面既有的文字链样式，不新增视觉
    expect(block).toContain('className="detail__cmt-more"')
    expect(block).toContain('className="detail__cmt-more-text"')
    // 没有自动滚动加载这回事：按钮的点击是唯一触发点
    expect(block).toContain('onClick={')
  })

  test('整个源码里没有把剩余页一次拉满的循环（旧实现的成因）', async () => {
    const code = await source()

    expect(code).not.toContain('pageCount')
    expect(code).not.toContain('more.push(')
    // 留言相关的 `fetchComments(` 只有两处：首屏一次、加载更多一次
    expect(countOf(code, 'fetchComments(')).toBe(2)
  })
})
