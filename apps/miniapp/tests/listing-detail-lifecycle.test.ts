import { describe, expect, test } from 'bun:test'
import {
  beginReloadWrite,
  beginTask,
  type CommentsRead,
  clearedPrivateScope,
  consumeDeferredReload,
  createDeferredReload,
  type DeferredReload,
  dropPendingComments,
  hasInflightWrites,
  isLatestLoad,
  isOwnerSwitch,
  isReloadDue,
  isTaskCurrent,
  mergeRefreshedComments,
  ownerChanged,
  PENDING_COMMENT_PREFIX,
  requestDeferredReload,
  resolveRefreshedComments,
  settleReloadWrite,
  shouldRefreshOnShow,
  shouldSurfaceStaleAuthFailure,
  type WriteTask,
} from '../src/pages/listing-detail/view'

/**
 * 商品详情页账号作用域与返回同步判据的回归（#170 判据 C/D）。
 *
 * 本页特殊在它是**公开页**：不挂守卫、匿名可读，所以「切号清场」清的只是留言草稿、
 * 未确认的乐观占位与收藏心形 —— 公开的商品快照与已发布留言对任何账号都是同一份。
 * 锁的是只看单帧状态看不出来的时序：
 * - `authed(A) → authed(B)`（含 `→ 匿名`）的**同一渲染周期**内清掉 A 的草稿与未确认占位；
 * - A 的在途留言 / 回复（成功换 DTO、失败回滚 + toast）不得落进 B 的页面；
 * - `A → B → A` 时 A 的**旧**响应不得写进 A 的新会话 —— 只比对 ownerId 挡不住这条；
 * - 从子页返回要同步服务端数据（判据 D），且重试 / 返回刷新互不接受陈旧响应；
 * - 写入在飞时那次返回刷新可以延后，但**不能丢**；
 * - 刷新在飞时**新开始**的那笔写入不能被服务端快照抹掉（`conversation` 页 #186 的 P2-1）。
 *
 * 两层：
 * 1. 判据层 —— 跑 `view.ts` 的纯函数，用最小的「页面 + 写任务」模型模拟交错；
 * 2. 接线层 —— 读 `index.tsx` 源码，断言两条写入链与读取链**确实**接上了这些守卫，
 *    且守卫在**落地语句之前**（只钉「子串存在」的话，把守卫挪到 setter 之后仍会全绿）。
 *
 * 边界：接线层只证明源码里这些语句的**位置**，不证明运行时时序（React 批处理、Taro
 * `useDidShow` 与 `useLoad` 的先后、ref 读取时刻）。那部分按 C/D 时序在微信开发者
 * 工具实测（`docs/miniapp-dev-workflow.md` §5），不拿本文件当端上证明。
 */

/** 页面本地的留言节点（判据只需要 id 与嵌套回复） */
type Node = { id: string; replies: Node[] }

function node(id: string, replies: Node[] = []): Node {
  return { id, replies }
}

/** 一个未确认的乐观占位（id 带 `local-` 前缀，切号清场要认得它） */
function pendingNode(seq = 1): Node {
  return node(`${PENDING_COMMENT_PREFIX}${seq}`)
}

/** 一个最小的「页面 + 写入 / 读取」模型：只保留跨账号交错与刷新排序需要的字段 */
function page() {
  return {
    ownerId: null as string | null,
    epoch: 0,
    comments: [] as Node[],
    listed: '商品快照',
    loadSeq: 0,
    /** 在途写入与延后刷新的账（判据 D 的先后 + 判据 C 的归属） */
    reload: createDeferredReload() as DeferredReload,
    ...clearedPrivateScope(),
  }
}

type Page = ReturnType<typeof page>

/** 换账号：渲染期同步清场 + 代次前进（对应 index.tsx 的 `ownerChanged` 分支） */
function switchOwner(p: Page, next: string | null): void {
  if (!ownerChanged(p.ownerId, next)) return
  const previous = p.ownerId
  p.ownerId = next
  p.epoch += 1
  // 在途写入的账整本换新：上一代的结算从此不认（否则 A 的 finally 会替 B 销账）
  p.reload = createDeferredReload(p.epoch)
  // 真正的换号连读取世代一起推进；冷启动解析身份（null → id）不算换号
  if (isOwnerSwitch(previous)) p.loadSeq += 1
  Object.assign(p, clearedPrivateScope())
  p.comments = dropPendingComments(p.comments)
}

/** 页面卸载：在途任务一并作废（对应 index.tsx 的卸载 effect） */
function unmount(p: Page): void {
  p.epoch += 1
  p.loadSeq += 1
}

/** 一次写入响应落地：只有任务仍属于当前账号、且这一轮没被作废才允许写入 */
function settle(p: Page, task: WriteTask, write: () => void): boolean {
  if (!isTaskCurrent(task, p.epoch, p.ownerId)) return false
  write()
  return true
}

/** 页面里的 `requestRefresh`：本代有写入在飞就先记账延后，否则立刻刷 */
function requestRefresh(p: Page): 'refresh' | 'deferred' {
  if (hasInflightWrites(p.reload)) {
    p.reload = requestDeferredReload(p.reload)
    return 'deferred'
  }
  return 'refresh'
}

/** 页面里的 `finishWrite`：按发起那次写入的 epoch 销账，该补跑才补跑 */
function finishWrite(p: Page, epoch: number): boolean {
  p.reload = settleReloadWrite(p.reload, epoch)
  if (!isReloadDue(p.reload)) return false
  p.reload = consumeDeferredReload(p.reload)
  return true
}

describe('详情页账号私有 state 的清场（#170 判据 C）', () => {
  test('换号与退出都算换场，同一账号重渲染不算', () => {
    expect(ownerChanged(null, 'user-a')).toBe(true)
    expect(ownerChanged('user-a', 'user-b')).toBe(true)
    expect(ownerChanged('user-a', null)).toBe(true)
    expect(ownerChanged('user-a', 'user-a')).toBe(false)
  })

  test('清场只覆盖草稿、收藏与购买请求，公开快照不在其中', () => {
    expect(clearedPrivateScope()).toEqual({
      commentInput: '',
      replyInput: '',
      replyTo: null,
      faved: false,
      buyRequested: false,
    })
  })

  test('换号后 A 的草稿、回复行、收藏心形与购买请求都不留在 B 的页面上', () => {
    const p = page()
    switchOwner(p, 'user-a')
    p.commentInput = 'A 写到一半的留言'
    p.replyInput = 'A 的回复草稿'
    p.replyTo = 'c-1'
    p.faved = true
    p.buyRequested = true

    switchOwner(p, 'user-b')
    expect(p.commentInput).toBe('')
    expect(p.replyInput).toBe('')
    expect(p.replyTo).toBeNull()
    expect(p.faved).toBe(false)
    expect(p.buyRequested).toBe(false)
  })

  test('换号不动公开的商品快照与已发布留言', () => {
    const p = page()
    switchOwner(p, 'user-a')
    p.comments = [node('c-1'), node('c-2', [node('r-1')])]

    switchOwner(p, 'user-b')
    expect(p.listed).toBe('商品快照')
    expect(p.comments.map((entry) => entry.id)).toEqual(['c-1', 'c-2'])
    expect(p.comments[1]?.replies.map((entry) => entry.id)).toEqual(['r-1'])
  })

  test('退出登录同样清场（匿名不是「没有身份」，不能继承上一个账号的草稿）', () => {
    const p = page()
    switchOwner(p, 'user-a')
    p.commentInput = 'A 的草稿'
    p.faved = true
    p.buyRequested = true

    switchOwner(p, null)
    expect(p.commentInput).toBe('')
    expect(p.faved).toBe(false)
    expect(p.buyRequested).toBe(false)
  })

  test('未确认的乐观占位随换号丢掉，已确认的留言保持原序', () => {
    const p = page()
    switchOwner(p, 'user-a')
    p.comments = [pendingNode(2), node('c-1'), node('c-2')]

    switchOwner(p, 'user-b')
    expect(p.comments.map((entry) => entry.id)).toEqual(['c-1', 'c-2'])
  })

  test('嵌套回复里的未确认占位也丢掉，同一节点其余回复不动', () => {
    const dropped = dropPendingComments([node('c-1', [pendingNode(3), node('r-1')])])
    expect(dropped.map((entry) => entry.id)).toEqual(['c-1'])
    expect(dropped[0]?.replies.map((entry) => entry.id)).toEqual(['r-1'])
  })

  test('没有占位时不做无谓的重建（引用原样保留）', () => {
    const original = node('c-1', [node('r-1')])
    expect(dropPendingComments([original])[0]).toBe(original)
  })
})

describe('详情页在途写入的账号守卫（#170 判据 C）', () => {
  test('同账号同世代：写入照常落地', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')
    expect(settle(p, task, () => undefined)).toBe(true)
  })

  test('换号后：A 的迟到成功与迟到失败都不再落地（回滚与 toast 是副作用）', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    expect(settle(p, task, () => undefined)).toBe(false)
  })

  test('A → B → A：只比对账号挡不住，代次必须前进', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const staleTaskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    switchOwner(p, 'user-a')
    // 账号又是 A 了，但这是 A 的**新**会话
    expect(isTaskCurrent(staleTaskA, p.epoch, p.ownerId)).toBe(false)
  })

  test('卸载后任务一并作废', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')

    unmount(p)
    expect(settle(p, task, () => undefined)).toBe(false)
  })

  test('匿名自己发起的写入仍允许落地（匿名沿用既有 401 口径，不是新增门禁）', () => {
    const p = page()
    const task = beginTask(p.epoch, null)
    expect(settle(p, task, () => undefined)).toBe(true)
  })

  test('退出登录后 A 的迟到响应不得写进匿名态', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')

    switchOwner(p, null)
    expect(settle(p, task, () => undefined)).toBe(false)
  })

  test('会话过期（401）造成的「迟到」失败仍要弹提示，真正换号才彻底作废', () => {
    // 401 会让 `apiRequest` 清会话、store 同步回到匿名 —— 失败的正是本人，不能静默
    expect(shouldSurfaceStaleAuthFailure(true, null)).toBe(true)
    // 换到别人：A 的 toast 不许弹在 B 脸上
    expect(shouldSurfaceStaleAuthFailure(true, 'user-b')).toBe(false)
    // 非未认证错误（网络抖动等）照旧由当前账号那条链自己处理
    expect(shouldSurfaceStaleAuthFailure(false, null)).toBe(false)
  })

  test('A 发留言时会话过期：占位随匿名清场丢掉，但失败提示要弹出来', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')
    p.comments = [pendingNode(9)]

    switchOwner(p, null)
    expect(settle(p, task, () => undefined)).toBe(false)
    expect(p.comments).toEqual([])
    expect(shouldSurfaceStaleAuthFailure(true, p.ownerId)).toBe(true)
  })
})

describe('详情页读取世代与延后刷新（#170 判据 D）', () => {
  test('首次 show 让给 useLoad 的首屏加载，不重复拉一次', () => {
    expect(shouldRefreshOnShow(true)).toBe(false)
  })

  test('从子页返回要同步服务端数据', () => {
    expect(shouldRefreshOnShow(false)).toBe(true)
  })

  test('重试与返回刷新只有最新一次能写入，先发后到的被判过期', () => {
    const p = page()
    p.loadSeq += 1
    const stale = p.loadSeq
    p.loadSeq += 1

    expect(isLatestLoad(stale, p.loadSeq)).toBe(false)
    expect(isLatestLoad(p.loadSeq, p.loadSeq)).toBe(true)
  })

  test('翻页途中若重来过，那一批（旧游标拼的）不再追加', () => {
    const p = page()
    p.loadSeq += 1
    const paginationSeq = p.loadSeq
    p.loadSeq += 1

    expect(isLatestLoad(paginationSeq, p.loadSeq)).toBe(false)
  })

  test('冷启动解析身份不算换号（否则首屏加载永远被判过期），真正的换号才算', () => {
    const p = page()
    p.loadSeq += 1
    const firstLoad = p.loadSeq

    switchOwner(p, 'user-a')
    expect(isOwnerSwitch(null)).toBe(false)
    expect(isLatestLoad(firstLoad, p.loadSeq)).toBe(true)

    switchOwner(p, 'user-b')
    expect(isOwnerSwitch('user-a')).toBe(true)
    expect(isLatestLoad(firstLoad, p.loadSeq)).toBe(false)
  })

  test('写入在飞时这次刷新延后而不是取消，写入结算后补跑一次', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')
    p.reload = beginReloadWrite(p.reload, task.epoch)

    expect(requestRefresh(p)).toBe('deferred')
    // 还有写入在飞时不补跑
    expect(isReloadDue(p.reload)).toBe(false)

    expect(finishWrite(p, task.epoch)).toBe(true)
    // 补跑只消费一次：后续结算不会凭空再刷一次
    expect(isReloadDue(p.reload)).toBe(false)
  })

  test('多条写入在飞时等最后一条结算才补跑', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const first = beginTask(p.epoch, 'user-a')
    const second = beginTask(p.epoch, 'user-a')
    p.reload = beginReloadWrite(p.reload, first.epoch)
    p.reload = beginReloadWrite(p.reload, second.epoch)

    expect(requestRefresh(p)).toBe('deferred')
    expect(finishWrite(p, first.epoch)).toBe(false)
    expect(finishWrite(p, second.epoch)).toBe(true)
  })

  test('没有写入在飞时刷新立即执行，也不留下待补跑的标记', () => {
    const p = page()
    switchOwner(p, 'user-a')
    expect(requestRefresh(p)).toBe('refresh')
    expect(p.reload.deferred).toBe(false)
  })

  test('没有刷新被延后时结算不空跑一次刷新', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')
    p.reload = beginReloadWrite(p.reload, task.epoch)

    expect(finishWrite(p, task.epoch)).toBe(false)
  })

  test('换号后 A 的迟到结算不会替 B 销账，也不会在 B 的页面上补跑刷新', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')
    p.reload = beginReloadWrite(p.reload, taskA.epoch)
    expect(requestRefresh(p)).toBe('deferred')

    switchOwner(p, 'user-b')
    // A 的请求迟到结算：带的是 A 那一代的 epoch，整笔账对 B 无效
    expect(finishWrite(p, taskA.epoch)).toBe(false)
    expect(p.reload).toEqual(createDeferredReload(p.epoch))
  })

  test('换号后 B 自己的写入结算照常补跑 B 的那次返回刷新', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')
    p.reload = beginReloadWrite(p.reload, taskA.epoch)

    switchOwner(p, 'user-b')
    const taskB = beginTask(p.epoch, 'user-b')
    p.reload = beginReloadWrite(p.reload, taskB.epoch)
    expect(requestRefresh(p)).toBe('deferred')
    expect(finishWrite(p, taskA.epoch)).toBe(false)
    expect(finishWrite(p, taskB.epoch)).toBe(true)
  })
})

describe('详情页返回刷新与服务端快照的合并（#170 判据 D）', () => {
  test('刷新期间才发起的留言不会被服务端快照抹掉', () => {
    const previous = [pendingNode(7), node('c-1')]
    const incoming = [node('c-1'), node('c-2')]

    const merged = mergeRefreshedComments(previous, incoming, new Set(['c-1']))
    // 本地新增排在最前（本页列表最新在前），服务端快照为底
    expect(merged.map((entry) => entry.id)).toEqual([`${PENDING_COMMENT_PREFIX}7`, 'c-1', 'c-2'])
  })

  test('刚被服务端确认、但快照早于它落地的那条也要留住', () => {
    // 占位已被 `.then` 换成服务端 id，而刷新起飞时的快照里只有当时的 `local-` id
    const previous = [node('c-9'), node('c-1')]
    const merged = mergeRefreshedComments(previous, [node('c-1')], new Set(['local-1', 'c-1']))

    expect(merged.map((entry) => entry.id)).toEqual(['c-9', 'c-1'])
  })

  test('服务端已经带回的同一条不重复', () => {
    const merged = mergeRefreshedComments([node('c-1')], [node('c-1')], new Set(['c-1']))
    expect(merged.map((entry) => entry.id)).toEqual(['c-1'])
  })

  test('嵌套回复：刷新期间才发出的回复接在该条留言的回复之后', () => {
    const previous = [node('c-1', [pendingNode(8), node('r-1')])]
    const incoming = [node('c-1', [node('r-1')])]

    const merged = mergeRefreshedComments(previous, incoming, new Set(['c-1', 'r-1']))
    expect(merged[0]?.replies.map((entry) => entry.id)).toEqual([
      'r-1',
      `${PENDING_COMMENT_PREFIX}8`,
    ])
  })

  test('服务端快照带回来的修正（顺序 / 删除）以快照为准', () => {
    const merged = mergeRefreshedComments(
      [node('c-1'), node('c-2')],
      [node('c-2')],
      new Set(['c-1', 'c-2']),
    )
    expect(merged.map((entry) => entry.id)).toEqual(['c-2'])
  })

  test('没有本地新增时合并结果就是服务端快照（节点引用原样）', () => {
    const incoming = [node('c-1')]
    const merged = mergeRefreshedComments([node('c-1')], incoming, new Set(['c-1']))
    expect(merged).toEqual(incoming)
    expect(merged[0]).toBe(incoming[0])
  })
})

describe('详情页静默刷新的留言读取成败语义（#170 复查 N6）', () => {
  test('留言读取失败：这次刷新不落地，已显示的留言与游标保持不动', () => {
    expect(resolveRefreshedComments<Node>({ status: 'failed', comments: [] })).toBeNull()
  })

  test('失败分支带着 fixture 兜底列表时同样不落地（兜底只给首次加载用）', () => {
    const failed: CommentsRead<Node> = { status: 'failed', comments: [node('c-1')] }
    expect(resolveRefreshedComments(failed)).toBeNull()
  })

  test('失败与换号交错：结果本身不可落地，旧账号的兜底留言没有机会回填到新账号', () => {
    // 刷新起飞时是 A、落地时已是 B。守卫先把这次刷新整条作废；即便守卫先放行，
    // 失败结果也只会得到 `null`（而不是一份「A 的留言」），B 的列表不可能被回填。
    const failed: CommentsRead<Node> = { status: 'failed', comments: [node('c-a')] }
    expect(resolveRefreshedComments(failed)).toBeNull()
  })

  test('成功读到空列表：按服务端确认的空结果更新，不永久保留旧快照', () => {
    const applied = resolveRefreshedComments<Node>({ status: 'ok', comments: [], nextCursor: null })
    expect(applied).toEqual({ comments: [], nextCursor: null })
    // 刷新起飞时见过的旧留言既不在快照里、也不在 baseIds 之外 ⇒ 以快照为准被移除
    expect(
      mergeRefreshedComments([node('c-1')], applied?.comments ?? [], new Set(['c-1'])),
    ).toEqual([])
  })

  test('成功读到空列表：刷新期间新写入的那条仍然留住', () => {
    const applied = resolveRefreshedComments<Node>({ status: 'ok', comments: [], nextCursor: null })
    const merged = mergeRefreshedComments(
      [pendingNode(9), node('c-1')],
      applied?.comments ?? [],
      new Set(['c-1']),
    )
    expect(merged.map((entry) => entry.id)).toEqual([`${PENDING_COMMENT_PREFIX}9`])
  })

  test('成功读取带回留言与游标：一起交给合并与游标提交', () => {
    const incoming = [node('c-2')]
    const applied = resolveRefreshedComments<Node>({
      status: 'ok',
      comments: incoming,
      nextCursor: 'c-2',
    })
    expect(applied).toEqual({ comments: incoming, nextCursor: 'c-2' })
  })
})

/** 取 `index.tsx` 里 `from` 到其后第一个 `to` 之间的源码 */
async function source(): Promise<string> {
  return await Bun.file(new URL('../src/pages/listing-detail/index.tsx', import.meta.url)).text()
}

async function pageSlice(from: string, to: string): Promise<string> {
  const code = await source()
  const start = code.indexOf(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = code.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return code.slice(start, end)
}

/** 在已切好的一段源码里再切一段：`from` 之后到其后第一个 `to` 之前 */
function inner(from: string, to: string) {
  return (block: string): string => {
    const start = block.indexOf(from)
    expect(start, `缺少片段：${from}`).toBeGreaterThanOrEqual(0)
    const end = block.indexOf(to, start + from.length)
    expect(end, `缺少片段：${to}`).toBeGreaterThan(start)
    return block.slice(start + from.length, end)
  }
}

/** 断言 `first` 在 `block` 里出现在 `second` **之前**（两者都必须真的存在） */
function expectBefore(block: string, first: string, second: string): void {
  const head = block.indexOf(first)
  const tail = block.indexOf(second)
  expect(head, `缺少片段：${first}`).toBeGreaterThanOrEqual(0)
  expect(tail, `缺少片段：${second}`).toBeGreaterThanOrEqual(0)
  expect(head).toBeLessThan(tail)
}

describe('详情页接线（#170 判据 C/D）', () => {
  test('换号清场块清账号私有 state、丢掉未确认占位、推进代次与读取世代，且不动公开快照', async () => {
    const block = await pageSlice('if (ownerChanged(prevUserId, userId)) {', 'useEffect(')
    expect(block).toContain('setPrevUserId(userId)')
    expect(block).toContain('setCommentInput(cleared.commentInput)')
    expect(block).toContain('setReplyInput(cleared.replyInput)')
    expect(block).toContain('setReplyTo(cleared.replyTo)')
    expect(block).toContain('setFaved(cleared.faved)')
    expect(block).toContain('epochRef.current += 1')
    // 在途写入的账整本换新，读取世代只在**真正的换号**时推进（冷启动解析身份不算）
    expect(block).toContain('reloadRef.current = createDeferredReload(epochRef.current)')
    expect(block).toContain('if (isOwnerSwitch(prevUserId)) loadSeqRef.current += 1')
    expect(block).toContain('setComments((prev) => dropPendingComments(prev))')
    // 公开快照不清：清了只会白闪一次骨架屏
    expect(block).not.toContain('setData(')
    expect(block).not.toContain('setLoadState(')
    expect(block).not.toContain('setComments([])')
  })

  test('账号私有态的初值按当前账号播种（冷启动已登录时不白跑一次清场）', async () => {
    const code = await source()
    expect(code).toContain('useState<string | null>(userId)')
    // 每帧把当前账号写进 ref：写成 `prevUserId` 的话守卫比的永远是上一帧的账号
    expect(code).toContain('ownerRef.current = userId')
    // 刷新合并以「发起刷新那一刻」的留言树为基准
    expect(code).toContain('commentsRef.current = comments')
  })

  test('本页仍是公开页：不挂守卫（匿名可读的口径不变）', async () => {
    const code = await source()
    // 注释里会提到 `useAuthGuard`，所以看的是**真的没接**：既不引守卫模块，也不调它
    expect(code).not.toContain("from '@/features/auth/guard'")
    expect(code).not.toMatch(/useAuthGuard\(/)
  })

  test('卸载时作废在途任务并让读取世代前进', async () => {
    const block = await pageSlice('mountedRef.current = false', 'const metrics = useMemo')
    expect(block).toContain('epochRef.current += 1')
    expect(block).toContain('loadSeqRef.current += 1')
  })

  test('发留言：任务与在途账都在乐观插入 / 发请求之前记好', async () => {
    const block = await pageSlice('const sendComment = () => {', '/** 回复某条顶层留言')
    expectBefore(block, 'const task = beginTask(', 'const pending = localComment(')
    expectBefore(
      block,
      'beginReloadWrite(reloadRef.current, task.epoch)',
      'postComment(id, content)',
    )
    // 旧实现的裸计数 / 裸布尔不再出现：账必须带 epoch
    expect(block).not.toMatch(/pendingWritesRef|deferredRefreshRef/)
    // 结算按发起那次写入的 epoch 走：旧世代的结算不能替新账号销账
    expect(block).toContain('finishWrite(task.epoch)')
    expectBefore(block, '.finally(() => {', 'finishWrite(task.epoch)')
  })

  test('发留言：成功落地前确认任务仍有效（守卫在 setter 之前）', async () => {
    const block = await pageSlice('const sendComment = () => {', '/** 回复某条顶层留言')
    const thenBlock = inner('.then((created) => {', '.catch((error) => {')(block)
    expectBefore(
      thenBlock,
      'if (!isTaskCurrent(task, epochRef.current, ownerRef.current)) return',
      'setComments(',
    )
  })

  test('发留言：失败的回滚与 toast 都在守卫之后，且会话过期仍要提示', async () => {
    const block = await pageSlice('const sendComment = () => {', '/** 回复某条顶层留言')
    const catchBlock = inner('.catch((error) => {', '.finally(() => {')(block)
    const guard = 'if (!isTaskCurrent(task, epochRef.current, ownerRef.current))'
    expectBefore(catchBlock, guard, 'setComments((prev) => prev.filter')
    expectBefore(catchBlock, guard, "notifyCommentFailure('留言', error)")
    // 守卫内部：会话过期（401）造成的迟到失败例外放行，其余静默
    expect(catchBlock).toContain('shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error)')
  })

  test('发回复：同一条守卫口径', async () => {
    const block = await pageSlice('const sendReply = (commentId: string) => {', 'const toggleReply')
    expectBefore(block, 'const task = beginTask(', 'const pending = localComment(')
    expectBefore(block, 'beginReloadWrite(reloadRef.current, task.epoch)', 'postReply(commentId')
    expect(block).toContain('finishWrite(task.epoch)')
    const thenBlock = inner('.then((created) => {', '.catch((error) => {')(block)
    expectBefore(
      thenBlock,
      'if (!isTaskCurrent(task, epochRef.current, ownerRef.current)) return',
      'setComments(',
    )
    const catchBlock = inner('.catch((error) => {', '.finally(() => {')(block)
    const guard = 'if (!isTaskCurrent(task, epochRef.current, ownerRef.current))'
    expectBefore(catchBlock, guard, 'setComments((prev) =>')
    expectBefore(catchBlock, guard, "notifyCommentFailure('回复', error)")
    expect(catchBlock).toContain('shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error)')
  })

  test('首屏加载：详情与留言落地前都确认是最新的一次请求', async () => {
    const block = await pageSlice('const load = () => {', '* 从子页返回时的**静默**同步')
    const guard = 'if (!isLatestLoad(seq, loadSeqRef.current)) return'
    expect(block.split(guard).length - 1).toBe(2)
    expectBefore(block, guard, 'setData(view)')
    expectBefore(block, guard, 'setComments(loaded.comments)')
  })

  test('返回刷新是静默的：不清残留、不回骨架屏，失败保留内容，只有 notFound 才切空态', async () => {
    const block = await pageSlice('const refresh = () => {', 'const requestRefresh')
    // 静默 = 开头不重置：`setData(null)` 只允许出现在 notFound 分支里（商品真没了才清）
    expect(block).not.toContain("setLoadState('loading')")
    expect(block).toContain("if (result.status === 'notFound')")
    expect(block.indexOf('setData(null)')).toBeGreaterThan(
      block.indexOf("if (result.status === 'notFound')"),
    )
    expect(block).toContain('setComments([])')
    expect(block).toContain('setCommentsCursor(null)')
    const guard = 'if (!isLatestLoad(seq, loadSeqRef.current)) return'
    expect(block.split(guard).length - 1).toBe(2)
    expectBefore(block, guard, 'setData(result.view)')
    // 留言那一次落地也要先判序号：只看整块的话，详情那次守卫会把它遮住
    const mergeBlock = inner('setData(result.view)', 'setCommentsCursor(applied.nextCursor)')(block)
    expectBefore(mergeBlock, guard, 'setComments((prev) => mergeRefreshedComments')
    // 留言读失败时不落地（#170 复查 N6）：先取决策，`null` 直接返回，绝不动留言与游标
    expectBefore(
      mergeBlock,
      'const applied = resolveRefreshedComments(loaded)',
      'if (!applied) return',
    )
    expectBefore(mergeBlock, 'if (!applied) return', 'setComments((prev) => mergeRefreshedComments')
    expectBefore(block, 'if (!applied) return', 'setCommentsCursor(applied.nextCursor)')
  })

  test('返回刷新按起飞时的 id 快照合并，不整体覆盖留言树', async () => {
    const block = await pageSlice('const refresh = () => {', 'const requestRefresh')
    expectBefore(block, 'const baseIds = new Set(', 'loadListingDetail(id)')
    expectBefore(block, 'const baseIds = new Set(', 'mergeRefreshedComments(')
    expect(block).toContain('mergeRefreshedComments(prev, applied.comments, baseIds)')
    // 旧写法（直接拿读取结果整体合并）必须已经不存在：它正是 N6 的成因
    expect(block).not.toContain('mergeRefreshedComments(prev, loaded.comments, baseIds)')
  })

  test('返回刷新要等写入结算：在飞时先记账，结算时按发起那次写入的 epoch 销账', async () => {
    const requestBlock = await pageSlice('const requestRefresh = () => {', 'const finishWrite')
    expectBefore(requestBlock, 'if (hasInflightWrites(reloadRef.current))', 'refresh()')
    expect(requestBlock).toContain('reloadRef.current = requestDeferredReload(reloadRef.current)')

    const finishBlock = await pageSlice(
      'const finishWrite = (epoch: number) => {',
      'useLoad(() => {',
    )
    expectBefore(finishBlock, 'settleReloadWrite(reloadRef.current, epoch)', 'isReloadDue(')
    // 极性也要钉住：写成 `if (isReloadDue(...)) return` 就是「该补跑时不补、不该补时补」
    expect(finishBlock).toContain('if (!isReloadDue(reloadRef.current)) return')
    expectBefore(finishBlock, 'consumeDeferredReload(reloadRef.current)', 'refresh()')
    expect(finishBlock).toContain('refresh()')
  })

  test('useDidShow 接线：首屏跳过，其余交给刷新判定', async () => {
    const block = await pageSlice('useDidShow(() => {', 'const [leftSimilar')
    expect(block).toContain('const firstShow = firstShowRef.current')
    expect(block).toContain('firstShowRef.current = false')
    expect(block).toContain('if (!shouldRefreshOnShow(firstShow)) return')
    expect(block).toContain('requestRefresh()')
  })

  test('翻页：追加前确认读取世代没被重试 / 刷新顶掉', async () => {
    const block = await pageSlice(
      'const toggleComments = async () => {',
      'const listing = data?.listing',
    )
    expect(block).toContain('const seq = loadSeqRef.current')
    expectBefore(block, 'if (!isLatestLoad(seq, loadSeqRef.current)) return', 'setComments((prev)')
  })

  test('留言读取带成败（N6）：失败分支带兜底列表但没有游标，成功分支才带游标', async () => {
    const block = await pageSlice('async function loadComments', 'function logCommentFailure')
    expect(block).toContain(
      "return { status: 'ok', comments: page.items.map(dtoToNode), nextCursor: page.nextCursor }",
    )
    expect(block).toContain(
      "return { status: 'failed', comments: mockFallback.map(mockCommentToNode) }",
    )
    // 失败分支不再回一个「看起来像成功」的 `nextCursor: null`
    expect(block).not.toContain('nextCursor: null')
  })

  test('首屏加载：分页游标只在留言读取成功时收下', async () => {
    const block = await pageSlice('const load = () => {', '* 从子页返回时的**静默**同步')
    expectBefore(
      block,
      'setComments(loaded.comments)',
      "setCommentsCursor(loaded.status === 'ok' ? loaded.nextCursor : null)",
    )
  })
})
