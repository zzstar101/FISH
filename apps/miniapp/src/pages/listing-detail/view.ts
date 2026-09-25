/**
 * listing-detail 页账号作用域的生命周期判据（#170 C/D）。
 *
 * 为什么抽出来：本页是**公开页**（不挂 `useAuthGuard`，匿名可读），但留言草稿、
 * 未确认的乐观占位、收藏心形都是**账号私有**的，返回时的同步刷新又必须与在途写入
 * 排好先后。这几条判据就是 #170 的修复点，留在 `index.tsx` 里就没有任何用例能在
 * 它们被改坏时变红 —— 本页没有渲染测试基建。
 *
 * 边界：本模块只覆盖**判据**（给定状态算出该不该清 / 该不该写 / 该不该刷新），不覆盖
 * 组件接线（渲染期 setState 的时机、异步回调读 ref 的时机、`useDidShow` 的注册）。
 * 后者仍须在微信开发者工具里按 C/D 的时序实测（`docs/miniapp-dev-workflow.md` §5）。
 */

/** 乐观占位的 id 前缀：只有它能在本地列表里认出「还没被服务端确认」的那几条 */
export const PENDING_COMMENT_PREFIX = 'local-'

/** 是不是本地乐观插入、尚未被服务端确认的条目（含嵌套回复） */
export function isPendingCommentId(id: string): boolean {
  return id.startsWith(PENDING_COMMENT_PREFIX)
}

/**
 * 是否需要在**渲染期**同步清场：数据属于哪个账号变了（`null ↔ id` 两个方向都算）。
 * 用 effect 清场会晚一帧，那一帧画的还是上一个账号的草稿。
 */
export function ownerChanged(previous: string | null, next: string | null): boolean {
  return previous !== next
}

/**
 * 是不是**真正的换号**（换人 / 退出登录），而不是冷启动那一次身份解析。
 *
 * `null → id` 是 `bootstrapAuth` 把本地会话解析出来的那一帧，不是用户换了账号。
 * 判据 C 要作废的是「上一个账号留下的东西」，而身份解析之前没有任何账号的东西：
 * 把这一帧也算成换号，会连带把冷启动时**已经发起**的公开读取（首屏 `load`）判过期，
 * 页面就永远停在骨架屏上（`shouldRefreshOnShow` 又跳过了首次 show，没人补这一次）。
 */
export function isOwnerSwitch(previous: string | null): boolean {
  return previous !== null
}

/** 换号 / 退出时要清掉的账号私有 state —— 公开的商品快照与已发布留言不在其列。 */
export type PrivateScope = {
  /** 顶层留言草稿 */
  commentInput: string
  /** 回复草稿 */
  replyInput: string
  /** 正在回复哪条留言（`null` = 没有展开回复行） */
  replyTo: string | null
  /** 收藏心形（真实收藏接线归 #190/#193，现在是本页的本地态） */
  faved: boolean
}

/**
 * 清场后的初值。
 *
 * `faved` 虽然是纯本地的装饰态，但它是**账号私有**的：把上一个账号点亮的红心留给
 * 下一个账号，就是最典型的账号串台。
 */
export function clearedPrivateScope(): PrivateScope {
  return { commentInput: '', replyInput: '', replyTo: null, faved: false }
}

/**
 * 丢掉未确认的乐观占位（顶层与嵌套回复都算），已确认的留言原样保留、顺序不变。
 *
 * 为什么必须丢：换号 / 退出的那一刻，在途写入已经被 epoch 作废 —— 它的 `.then`
 * 不会再来把占位换成真实 DTO，`.catch` 也不会再来回滚。占位留在列表里就是一条
 * 永远等不到确认、对下一个账号可见的幽灵留言。
 */
export function dropPendingComments<T extends { id: string; replies: T[] }>(nodes: T[]): T[] {
  const kept: T[] = []
  for (const node of nodes) {
    if (isPendingCommentId(node.id)) continue
    const replies = node.replies.filter((reply) => !isPendingCommentId(reply.id))
    kept.push(replies.length === node.replies.length ? node : { ...node, replies })
  }
  return kept
}

/**
 * 返回刷新（静默同步）落地时把服务端快照合并回已有留言树。
 *
 * 为什么不能整体覆盖：刷新是**在返回那一刻**发起的，而用户可以在刷新飞行期间又发一条
 * 留言 —— 那条乐观占位不在刷新带回来的快照里。裸 `setComments(snapshot)` 会把它抹掉，
 * 而它的 `.then` 落地时已经找不到自己的节点（`prev.map` 匹配不到），服务端其实写成功了，
 * 界面上留言却凭空消失，要等下一次刷新才回来（同 `conversation` 页 #186 的 P2-1）。
 *
 * 合并规则（`baseIds` = 刷新**发起时**列表里出现过的全部 id，含嵌套回复）：
 * - 以服务端快照为底：它可能包含别人刚发的新留言，也可能修正本地顺序；
 * - 顶层额外保留「不在 `baseIds` 里、也不在快照里」的那些 —— 它们是刷新发起**之后**
 *   才落地的（乐观占位、或刚被服务端确认的那条），排在快照之前（本页列表最新在前）；
 * - 嵌套回复同理：快照里同一条留言下，保留它没带回来的新回复，接在原有回复之后。
 */
export function mergeRefreshedComments<T extends { id: string; replies: T[] }>(
  previous: T[],
  incoming: T[],
  baseIds: ReadonlySet<string>,
): T[] {
  const incomingIds = new Set(incoming.map((node) => node.id))
  const carried = previous.filter((node) => !baseIds.has(node.id) && !incomingIds.has(node.id))
  const merged = incoming.map((node) => {
    const before = previous.find((item) => item.id === node.id)
    if (!before) return node
    const replyIds = new Set(node.replies.map((reply) => reply.id))
    const keptReplies = before.replies.filter(
      (reply) => !baseIds.has(reply.id) && !replyIds.has(reply.id),
    )
    if (keptReplies.length === 0) return node
    return { ...node, replies: [...node.replies, ...keptReplies] }
  })
  return [...carried, ...merged]
}

/** 一次账号作用域的写入任务：`ownerId` 决定「属于谁」，`epoch` 决定「还是不是当前世代」。 */
export type WriteTask = { ownerId: string | null; epoch: number }

/** 铸任务必须在发请求**之前**：之后再换号，也能凭 epoch 把这次写入整条作废。 */
export function beginTask(epoch: number, ownerId: string | null): WriteTask {
  return { ownerId, epoch }
}

/**
 * 迟到响应是否允许写入。
 *
 * 换号与卸载都会让 epoch 前进；账号是 `null`（匿名）时同样要比对 —— 匿名不是
 * 「没有身份」，退出登录后 A 的迟到响应写进匿名态一样是串台。
 */
export function isTaskCurrent(task: WriteTask, epoch: number, ownerId: string | null): boolean {
  return task.epoch === epoch && task.ownerId === ownerId
}

/**
 * 迟到的**未认证**失败要不要照旧弹提示（判据 C 的边界）。
 *
 * 会话过期时 `apiRequest` 会就地清掉本地会话，store 随同步回到匿名 —— 于是这次
 * 写入在 `.catch` 里已经「不属于当前账号」（epoch 前进过）。但当前账号是**匿名**，
 * 说明失败的就是用户本人：静默吞掉等于「点了发送，什么都没发生」。真正换号
 * （当前账号另有其人）才彻底作废，那也是判据 C 要防的「A 的 toast 弹到 B 脸上」。
 */
export function shouldSurfaceStaleAuthFailure(
  isAuthError: boolean,
  currentOwnerId: string | null,
): boolean {
  return isAuthError && currentOwnerId === null
}

/**
 * 迟到响应是否允许写入（读取链）：只有序号仍是最新的那一次才作数。
 * 重试与返回刷新都会让序号前进，先发的响应后到即被判过期。
 */
export function isLatestLoad(seq: number, latest: number): boolean {
  return seq === latest
}

/**
 * 从子页（卖家主页 / 编辑页 / 会话）返回时是否同步服务端数据（#170 判据 D）。
 *
 * 首次 show 让给 `useLoad` 的首屏加载 —— 同一次进入，不跳过就会一进页双发。
 * 本页读取是公开的（匿名也能看），所以这里**不**带登录态门禁。
 */
export function shouldRefreshOnShow(firstShow: boolean): boolean {
  return !firstShow
}

/**
 * 「返回刷新」与「在途写入」的先后（判据 D），以及这份账**归谁**（判据 C）。
 *
 * 为什么两个量要连 `epoch` 一起带着：`inflight` 是页面级的计数，而写入是账号级的。
 * 旧实现只有一个裸计数和一个裸布尔：A 的在途写入迟到结算时会去减 B 的计数，还会用
 * A 留下的 `deferred` 标记在 B 的页面上补跑一次刷新 —— 判据 C 的「A 的 finally 及其
 * 一切副作用都不得影响 B」就破在这里（`conversation` 页 #186 已有同一套口径）。
 *
 * 判据 D 的另一半是「不能丢掉这次刷新」：所以写入在飞时把刷新**记账**（`deferred`）
 * 而不是取消，等这一代最后一个写入结算时补跑一次。
 */
export type DeferredReload = {
  /** 有一次刷新被延后了，等本代写入结算后补跑 */
  deferred: boolean
  /** 属于当前 `epoch` 的在途写入条数 */
  inflight: number
  /** 这份账属于哪一代；带旧 epoch 的结算一律不认 */
  epoch: number
}

/** 换号 / 挂载时的初值：这一代没有任何在途写入、也没有被延后的刷新。 */
export function createDeferredReload(epoch = 0): DeferredReload {
  return { deferred: false, inflight: 0, epoch }
}

/**
 * 记下一笔写入起飞（发请求**之前**调）。
 *
 * epoch 不同说明这是上一代残留下来的账（例如上一代最后的写入从没结算过）：
 * 直接丢掉它，按当前这一代重新起账，免得旧残留把新账号的返回刷新一路延后。
 */
export function beginReloadWrite(state: DeferredReload, epoch: number): DeferredReload {
  if (state.epoch !== epoch) return { deferred: false, inflight: 1, epoch }
  return { ...state, inflight: state.inflight + 1 }
}

/**
 * 一笔写入结算（`.finally`，成败都会到）。
 *
 * 带的是**发起这次写入时**的 epoch：与当前账不符就原样返回 —— 既不减当前这一代的
 * 计数（旧的 `finally` 不能替新的写入销账），也不替当前这一代判断「没有在途了」。
 */
export function settleReloadWrite(state: DeferredReload, epoch: number): DeferredReload {
  if (state.epoch !== epoch) return state
  return { ...state, inflight: Math.max(0, state.inflight - 1) }
}

/** 这一刻还有本代的写入在飞：返回刷新要先记账、不能立刻刷。 */
export function hasInflightWrites(state: DeferredReload): boolean {
  return state.inflight > 0
}

/** 这次刷新要不要先延后。判据 D 的「写入在飞可延后」：延后而不是取消。 */
export function requestDeferredReload(state: DeferredReload): DeferredReload {
  return { ...state, deferred: true }
}

/** 被延后的那次刷新该不该现在补跑：本代写入都结算完了、且确实记过一笔。 */
export function isReloadDue(state: DeferredReload): boolean {
  return state.deferred && state.inflight === 0
}

/** 标记这次补跑已经消费掉：延后的刷新只跑一次，不然后续每次写入结算都会再刷一次。 */
export function consumeDeferredReload(state: DeferredReload): DeferredReload {
  return { ...state, deferred: false }
}
