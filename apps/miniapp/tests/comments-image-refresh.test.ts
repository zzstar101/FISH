import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { MyCommentsResponse } from '@fish/contracts/comments/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import {
  IMAGE_REFRESH_MAX_PAGES,
  imageRefreshPages,
  mergeRefreshedImages,
  runImageRefresh,
} from '../src/features/comments/image-refresh'
import { type MyComment, toMyCommentFromResponseItem } from '../src/features/comments/mine'
import { createImageReloadState, IMAGE_RELOAD_MAX } from '../src/features/transaction/image-reload'

/**
 * 「我的评论」评价配图签名 URL 过期后的补读（#485 审查 P2 的回归）。
 *
 * 被钉住的事实（旧实现在前两条下是红的 —— 旧代码在 `onError` 里调不带 cursor 的
 * 首屏 `read()`：`setItems` 覆盖 + 重置 cursor + 置 error）：
 *
 * 1. **多图同时过期只补一次**：整屏缩略图一起裂是常态（同一批签名同一时刻签发），
 *    三张图在同一个 tick 里失败只能触发**一个**补读周期（旧实现各发一次首屏读，
 *    并发三次、一次耗尽三份预算，还互相顶掉落地）；
 * 2. **已加载多页时按页回走、按 id 合并**：行数、行序一个不动，没变的行连对象引用
 *    都不换（`<Image key={url}>` 不重挂、不白重载）——旧实现把列表打回第 1 页，
 *    后面已加载的行整片消失；
 * 3. **补读失败不升级成整页错误**：返回 `null`、控制台留痕，列表原样；
 * 4. **代次失守整批丢弃**：换号 / 重读 / 切段后 A 的补读结果不许落地。
 *
 * 这是**编排级**的回归：页面本身是 Taro 页面组件，本仓没有页面级渲染基建
 * （见 `listing-detail-comments-paging.test.ts` 的说明），页面接线由
 * `comments-wiring.test.ts` 的源码断言钉住（`onError` 走 `refreshImages` 且
 * 那条链里没有 `read(` / `setError(` / `setCursor(`）。
 */

/** 服务端行：评价（有图 / 无图）—— 适配器用页面同一把尺子（`toMyCommentFromResponseItem`）。 */
function serverRow(id: string, imageKeys: string[], signature: number): TransactionReviewItem {
  return {
    review: {
      id,
      transactionId: `txn_${id}`,
      authorRole: 'buyer',
      rating: 'POSITIVE',
      body: '很顺利',
      createdAt: '2026-10-02T12:00:00+08:00',
      // 签名 URL：每次读都换一代（`?sig=N`），与线上 token 每次重签出不同地址语义一致
      images: imageKeys.map((key) => ({
        url: `https://api.example.com/media/${key}?sig=${signature}`,
      })),
    },
    transaction: {
      id: `txn_${id}`,
      conversationId: 'cnv_01',
      listingId: 'l_01',
      buyerId: 'usr_a',
      sellerId: 'usr_b',
      role: 'buyer',
      listing: {
        id: 'l_01',
        title: `商品 ${id}`,
        priceCents: 4500,
        status: 'SOLD',
        coverUrl: null,
      },
      counterpart: { id: 'usr_b', nickname: '周予安', avatarUrl: null },
      amountCents: 4000,
      status: 'COMPLETED',
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      completedAt: '2026-10-02T12:00:00+08:00',
      cancelledAt: null,
      createdAt: '2026-10-01T12:00:00+08:00',
      updatedAt: '2026-10-02T12:00:00+08:00',
    },
  } as unknown as TransactionReviewItem
}

/** 一页的服务端规格：`{ 行 id, 配图对象键 }`。 */
type Spec = { id: string; images: string[] }

/** 假分页服务端：每页一次读、每次读换成新的一代签名。 */
function makeServer(pageSpecs: Spec[][]) {
  const calls: (string | undefined)[] = []
  let signature = 0
  return {
    calls,
    async fetchPage(cursor: string | undefined): Promise<MyCommentsResponse> {
      calls.push(cursor)
      signature += 1
      const index = cursor === undefined ? 0 : Number(cursor)
      const specs = pageSpecs[index] ?? []
      return {
        items: specs.map((spec) => serverRow(spec.id, spec.images, signature)),
        nextCursor: index + 1 < pageSpecs.length ? String(index + 1) : null,
        total: pageSpecs.flat().length,
      } as unknown as MyCommentsResponse
    },
  }
}

const NOW = Date.parse('2026-10-05T12:00:00+08:00')
const mapItem = (row: Parameters<typeof toMyCommentFromResponseItem>[0]) =>
  toMyCommentFromResponseItem(row, NOW)

/** 用户在屏上的当前列表：由「第 0 代签名」的首屏读渲染出来 */
function screenRows(pageSpecs: Spec[][]): MyComment[] {
  return pageSpecs.flat().map((spec) => mapItem(serverRow(spec.id, spec.images, 0)))
}

/** 三页：一页 1 图 + 1 无图、二页 2 图（同一行）+ 1 无图、三页 1 图 —— 共 5 行、4 张图。 */
const THREE_PAGES: Spec[][] = [
  [
    { id: 'rv1', images: ['k1'] },
    { id: 'rv2', images: [] },
  ],
  [
    { id: 'rv3', images: ['k3a', 'k3b'] },
    { id: 'rv4', images: [] },
  ],
  [{ id: 'rv5', images: ['k5'] }],
]

const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
afterEach(() => errorSpy.mockClear())

describe('runImageRefresh —— 多图同时过期只补一次（已加载多页）', () => {
  test('同一 tick 里三张图裂掉：一个补读周期、回走三页、不碰列表状态', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    /** 屏上那张裂掉的图（rv1 在第一页、rv3 在第二页、rv5 在第三页） */
    const urlOf = (id: string): string => {
      const url = rows.find((row) => row.id === id)?.images[0]
      if (url === undefined) throw new Error(`fixture 缺少 ${id} 的配图`)
      return url
    }

    const run = (id: string) =>
      runImageRefresh({
        state,
        url: urlOf(id),
        rowId: id,
        loadedPages: 3,
        fetchPage: server.fetchPage,
        mapItem,
        isCurrent: () => true,
      })

    // 三张缩略图在同一个 tick 里各自 onError（rv1 在第一页、rv3 在第二页、rv5 在第三页）
    const results = await Promise.all([run('rv1'), run('rv3'), run('rv5')])

    // 只有第一个发起补读，另两个并入它（旧实现：三次首屏读并发）
    expect(results[0]).not.toBeNull()
    expect(results[1]).toBeNull()
    expect(results[2]).toBeNull()
    // 一个补读周期 = 按已加载页数回走 3 页（不是每张图各发一套）
    expect(server.calls).toEqual([undefined, '1', '2'])
    // 一批只花掉一份预算（旧实现三张图各记一次，一次打满 IMAGE_RELOAD_MAX）
    expect(state.count).toBe(1)
    expect(IMAGE_RELOAD_MAX).toBeGreaterThan(1)
  })

  test('合并按行 id：行数行序不变、无图行连对象都不换、有图行换到新签名', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()

    const fresh = await runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 3,
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    expect(fresh).not.toBeNull()
    const merged = mergeRefreshedImages(rows, fresh as Map<string, string[]>)

    // 不新增、不丢失、顺序不变
    expect(merged.map((row) => row.id)).toEqual(['rv1', 'rv2', 'rv3', 'rv4', 'rv5'])
    expect(merged).toHaveLength(5)
    // 三页上的图都换到了新签名（用户在第三页，前两页的图也要能看）
    expect(merged[0]?.images).toEqual(['https://api.example.com/media/k1?sig=1'])
    expect(merged[2]?.images).toEqual([
      'https://api.example.com/media/k3a?sig=2',
      'https://api.example.com/media/k3b?sig=2',
    ])
    expect(merged[4]?.images).toEqual(['https://api.example.com/media/k5?sig=3'])
    // 无图行原样保留（对象引用不变 → 不触发多余的渲染）
    expect(merged[1]).toBe(rows[1] as MyComment)
    expect(merged[3]).toBe(rows[3] as MyComment)
    // 其余字段（标题 / 评分 / 删除目标）一个不动
    expect(merged[2]?.title).toBe(rows[2]?.title)
    expect(merged[2]?.rating).toBe('POSITIVE')
    expect(merged[2]?.deleteRef).toEqual(rows[2]?.deleteRef)
  })

  test('合并按 id 而不是下标：屏上顺序与补读顺序不一致时不会把地址贴错行', () => {
    const rows = screenRows(THREE_PAGES)
    // 用户屏上的顺序与补读回来的顺序不同（例：期间新行插到了前面 / 列表被重排）
    const reordered = [rows[2], rows[0], rows[4]] as MyComment[]
    const fresh = new Map<string, string[]>([
      ['rv1', ['https://api.example.com/media/k1?sig=9']],
      [
        'rv3',
        ['https://api.example.com/media/k3a?sig=9', 'https://api.example.com/media/k3b?sig=9'],
      ],
      ['rv5', ['https://api.example.com/media/k5?sig=9']],
    ])
    const merged = mergeRefreshedImages(reordered, fresh)
    // 按下标合并的话第一行会拿到 k1、第三行会拿到 k3a —— 这里必须各归各位
    expect(merged[0]?.id).toBe('rv3')
    expect(merged[0]?.images[0]).toContain('k3a')
    expect(merged[1]?.id).toBe('rv1')
    expect(merged[1]?.images[0]).toContain('k1')
    expect(merged[2]?.id).toBe('rv5')
    expect(merged[2]?.images[0]).toContain('k5')
  })

  test('合并只改 images：行数与行序一个不动，fresh 里没有的行原样保留', () => {
    const rows = screenRows(THREE_PAGES)
    const merged = mergeRefreshedImages(
      rows,
      new Map([['rv3', ['https://api.example.com/x?sig=1']]]),
    )
    expect(merged).toHaveLength(rows.length)
    expect(merged.map((row) => row.id)).toEqual(rows.map((row) => row.id))
    expect(merged[0]).toBe(rows[0] as MyComment)
    expect(merged[4]).toBe(rows[4] as MyComment)
    expect(merged[2]?.images).toEqual(['https://api.example.com/x?sig=1'])
  })

  test('地址没变（无图行 / 同一秒重签出同一地址）时不换对象：省一次图片重载', async () => {
    const rows = screenRows(THREE_PAGES)
    const sameUrls = new Map(rows.map((row) => [row.id, row.images]))
    const merged = mergeRefreshedImages(rows, sameUrls)
    for (const [i, row] of merged.entries()) expect(row).toBe(rows[i] as MyComment)
  })

  test('走到底提前结束：服务端 nextCursor=null 时不再空转下一页', async () => {
    const server = makeServer([[{ id: 'rv1', images: ['k1'] }], [{ id: 'rv2', images: ['k2'] }]])
    const rows = screenRows([[{ id: 'rv1', images: ['k1'] }], [{ id: 'rv2', images: ['k2'] }]])
    const state = createImageReloadState()
    const fresh = await runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 5, // 页数上限给了 5，但列表只有 2 页
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    expect(fresh).not.toBeNull()
    expect(server.calls).toEqual([undefined, '1'])
  })

  test('回走页数由「已加载页数」决定：服务端还有更多页也不越界', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    const fresh = await runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 2, // 用户只翻了两页（第三页的 rv5 还没上屏）
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    expect(fresh).not.toBeNull()
    // 只回走两页：第三页的请求不该发（旧实现若忽略 loadedPages 就会读满三页）
    expect(server.calls).toEqual([undefined, '1'])
    expect(fresh?.has('rv5')).toBe(false)
    expect(fresh?.has('rv1')).toBe(true)
    expect(fresh?.has('rv3')).toBe(true)
  })
})

describe('runImageRefresh —— 失败与失守都不动列表', () => {
  test('补读请求失败：返回 null、闸门释放、触发地址可再补', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    const staleUrl = rows[0]?.images[0] ?? ''
    let failing = true
    const flaky = async (cursor: string | undefined): Promise<MyCommentsResponse> => {
      if (failing) throw new Error('网络炸了')
      return server.fetchPage(cursor)
    }

    const failed = await runImageRefresh({
      state,
      url: staleUrl,
      rowId: 'rv1',
      loadedPages: 2,
      fetchPage: flaky,
      mapItem,
      isCurrent: () => true,
    })
    expect(failed).toBeNull()
    // 失败自动重试了一次（仍失败就停）：两批，没有无界循环
    expect(state.count).toBe(2)
    // 失败也留了排障线索（与列表失败同一口径）
    expect(errorSpy).toHaveBeenCalled()
    // 闸门必须释放：否则这一页的配图永远补不了第二次
    expect(state.inFlightUrl).toBeNull()
    // 失败批次不留后患：**同一个地址**还能再补（断网一次 ≠ 这页的图从此不自动补）
    expect(state.attempted.has(staleUrl)).toBe(false)

    failing = false
    const second = await runImageRefresh({
      state,
      url: staleUrl,
      rowId: 'rv1',
      loadedPages: 1,
      fetchPage: flaky,
      mapItem,
      isCurrent: () => true,
    })
    expect(second).not.toBeNull()
  })

  test('代次失守（换号 / 重读 / 切段）时整批丢弃、停止回走', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    let current = true
    const fetchAndFlip = async (cursor: string | undefined): Promise<MyCommentsResponse> => {
      const response = await server.fetchPage(cursor)
      current = false // 第一页回来时页面已经切走了
      return response
    }

    const result = await runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 3,
      fetchPage: fetchAndFlip,
      mapItem,
      isCurrent: () => current,
    })
    expect(result).toBeNull()
    // 失守即止：只读了第一页，不再继续回走
    expect(server.calls).toEqual([undefined])
    expect(state.inFlightUrl).toBeNull()
  })

  test('闸门在飞时第二批只并入不发请求；并入的地址不进 attempted（那批失败后它还能补）', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    const otherUrl = rows[2]?.images[0] ?? ''
    const first = runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 1,
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    const second = await runImageRefresh({
      state,
      url: otherUrl,
      rowId: 'rv3',
      loadedPages: 1,
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    expect(second).toBeNull()
    expect(state.attempted.has(otherUrl)).toBe(false)
    await first
    // 第一批（只回走了 1 页）没覆盖到第三页的行，所以那个地址没有被换新，
    // 也不该被记成「补过了」—— 它要能自己触发下一批
    expect(state.attempted.has(otherUrl)).toBe(false)
  })

  test('批次失败后同一批并入的其余图能各自再触发补读（批次计数仍单调）', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    let failing = true
    const flaky = async (cursor: string | undefined): Promise<MyCommentsResponse> => {
      if (failing) throw new Error('网络炸了')
      return server.fetchPage(cursor)
    }
    const run = (index: number) =>
      runImageRefresh({
        state,
        url: rows[index]?.images[0] ?? '',
        rowId: rows[index]?.id ?? '',
        loadedPages: 1,
        fetchPage: flaky,
        mapItem,
        isCurrent: () => true,
      })

    // 同一 tick 三张图裂掉：只有第一张起批，另两张并入；这一批失败
    const [a, b, c] = await Promise.all([run(0), run(2), run(4)])
    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(c).toBeNull()
    // 起批的那张失败后自动重试了一次（仍失败）：两批，不是一批也不是无界
    expect(state.count).toBe(2)

    failing = false
    // 并入的两张现在各自能起批（旧实现把它们记进 attempted，从此再也不补）
    const retry = await run(2)
    expect(retry).not.toBeNull()
    expect(state.count).toBe(3)
  })
})

describe('runImageRefresh —— 一次性 onError 不能因批次失败而丢（审查第四轮 P2）', () => {
  test('只触发一次 onError、第一次补读失败：无需再次调用，自动受限重试一次并恢复', async () => {
    const server = makeServer(THREE_PAGES)
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    let failures = 1
    const flakyOnce = async (cursor: string | undefined): Promise<MyCommentsResponse> => {
      if (failures > 0) {
        failures -= 1
        throw new Error('网络炸了')
      }
      return server.fetchPage(cursor)
    }

    // 整个测试里 runImageRefresh（= 一次 onError）只调用这一回
    const fresh = await runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 1,
      fetchPage: flakyOnce,
      mapItem,
      isCurrent: () => true,
    })
    expect(fresh?.has('rv1')).toBe(true)
    expect(state.count).toBe(2)
    expect(state.inFlightUrl).toBeNull()
  })

  test('持续失败：只重试一次就停（批次计数 2，不无界）', async () => {
    const rows = screenRows(THREE_PAGES)
    const state = createImageReloadState()
    let calls = 0
    const down = async (): Promise<MyCommentsResponse> => {
      calls += 1
      throw new Error('断网')
    }
    const fresh = await runImageRefresh({
      state,
      url: rows[0]?.images[0] ?? '',
      rowId: 'rv1',
      loadedPages: 1,
      fetchPage: down,
      mapItem,
      isCurrent: () => true,
    })
    expect(fresh).toBeNull()
    expect(calls).toBe(2)
    expect(state.count).toBe(2)
    expect(state.retried).toBe(false)
  })
})

describe('runImageRefresh —— 成功必须覆盖触发行（审查第四轮 P2）', () => {
  test('分页成员位移：前面新增一行把触发行挤到已加载页数之外时，继续走到它', async () => {
    // 用户屏上 2 页（rv1..rv4，每页 2 行）；之后前面新增了 rvNew，rv4 被挤到服务端第 3 页
    const shifted: Spec[][] = [
      [
        { id: 'rvNew', images: [] },
        { id: 'rv1', images: ['k1'] },
      ],
      [
        { id: 'rv2', images: [] },
        { id: 'rv3', images: ['k3'] },
      ],
      [
        { id: 'rv4', images: ['k4'] },
        { id: 'rv5', images: [] },
      ],
    ]
    const server = makeServer(shifted)
    const state = createImageReloadState()
    const triggerUrl = 'https://api.example.com/media/k4?sig=0'
    const fresh = await runImageRefresh({
      state,
      url: triggerUrl,
      rowId: 'rv4',
      loadedPages: 2,
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    expect(fresh?.get('rv4')).toEqual(['https://api.example.com/media/k4?sig=3'])
    expect(server.calls).toEqual([undefined, '1', '2'])
    // 触发行拿到了替换地址：批次成功，URL 留在 attempted
    expect(state.attempted.has(triggerUrl)).toBe(true)
  })

  test('触发行超出页数上限：不算成功、不消耗该 URL 的恢复资格、不白重试；其余行地址照常交出', async () => {
    const many: Spec[][] = [1, 2, 3, 4, 5].map((n) => [{ id: `rv${n}`, images: [`k${n}`] }])
    const server = makeServer(many)
    const state = createImageReloadState()
    const triggerUrl = 'https://api.example.com/media/k5?sig=0'
    const fresh = await runImageRefresh({
      state,
      url: triggerUrl,
      rowId: 'rv5',
      loadedPages: 3,
      maxPages: 3, // 上限 3 页，触发行在第 5 页
      fetchPage: server.fetchPage,
      mapItem,
      isCurrent: () => true,
    })
    expect(server.calls).toEqual([undefined, '1', '2'])
    // 前三页的行照常拿到新地址
    expect([...(fresh?.keys() ?? [])]).toEqual(['rv1', 'rv2', 'rv3'])
    // 触发行没被覆盖：不记成功，URL 不进 attempted；这是确定性结果，不重试（只起了一批）
    expect(state.attempted.has(triggerUrl)).toBe(false)
    expect(state.count).toBe(1)
    expect(state.inFlightUrl).toBeNull()
    expect(state.retried).toBe(false)
  })
})

describe('imageRefreshPages —— 回走页数在 1..上限 之间', () => {
  test('首屏（1 页）与多页各自取对，超过上限收敛到上限', () => {
    expect(imageRefreshPages(1)).toBe(1)
    expect(imageRefreshPages(3)).toBe(3)
    expect(imageRefreshPages(99)).toBe(IMAGE_REFRESH_MAX_PAGES)
    expect(imageRefreshPages(0)).toBe(1)
    expect(imageRefreshPages(5, 2)).toBe(2)
    expect(imageRefreshPages(1, 2)).toBe(1)
  })
})
