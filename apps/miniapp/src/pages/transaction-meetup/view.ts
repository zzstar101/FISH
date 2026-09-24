/**
 * transaction-meetup 页的时序判据（#147 P2 / #170 D）。
 *
 * 为什么抽出来：这几条判据本身就是修复点 —— 自动 confirm 的终态分类、同步提交锁的
 * 取得与释放、子页返回的延后刷新 —— 但本页没有渲染测试基建，判据留在 `index.tsx`
 * 里就没有任何用例能在它们被改坏时变红（同 `pages/match/view.ts` 的取舍）。
 *
 * 边界：这里只覆盖**判据**（给定状态算出该不该取锁 / 该怎么分类失败 / 该不该重同步），
 * 不覆盖组件接线（ref 赋值时机、`useDidShow` 注册顺序、渲染期 setState）。后者仍须在
 * 微信开发者工具里按双账号时序实测，不能用本文件的用例代替端上验收。
 */

/** 同步提交锁的持有者：持锁那条操作链所属的账号代次；`null` = 空闲。 */
export type SubmitLock = number | null

/**
 * 同 tick 双击 / 换账号后重入能否取锁（#147 P2）。
 *
 * 为什么不能只靠 `submitting` state：同一个 tick 里连点两下，第二下读到的仍是上一帧
 * 的 `false`，两次都会发请求。用代次比较则第二次点击当场就看到锁已被**本代次**持有。
 * 换账号后代次前进，新账号照常可取锁，不受旧链还没收尾的阻碍。
 */
export function canAcquire(holder: SubmitLock, epoch: number): boolean {
  return holder !== epoch
}

/**
 * 释放锁：**只有持锁者本人**能释放（#147 P2）。
 *
 * 场景：A 的操作链在飞时换到 B，B 随即开始自己的提交并持锁；A 的 `finally` 迟到，
 * 若无条件置空就会把 B 的锁放掉，B 页面同 tick 又能再发一次。代次不匹配时原样返回，
 * 谁持锁谁释放。
 */
export function releaseLock(holder: SubmitLock, epoch: number): SubmitLock {
  return holder === epoch ? null : holder
}

/** 核销成功后自动 confirm 失败的处置口径。 */
export type ConfirmFailure = 'terminal' | 'retry'

/**
 * 409 `TRANSACTION_NOT_IN_PENDING` = 核销那一瞬交易已到终态（对方取消 / 另一侧已确认）：
 * 必须重读终态并撤下「还差最后一步确认」（#147 P2）—— 停在待确认会把 CANCELLED 与
 * COMPLETED 两种结果都说错。其余错误（网络等）才回到可重试的确认入口。
 *
 * 只收错误码而不收 `Error`：把 `isApiError` 的判定留在调用点，本模块保持零依赖，
 * 用例不必为了它去 mock `@tarojs/taro`。
 */
export function classifyConfirmFailure(code: string | null): ConfirmFailure {
  return code === 'TRANSACTION_NOT_IN_PENDING' ? 'terminal' : 'retry'
}

/**
 * 从子页（扫码页）返回时的重同步结论（#170 D / #147 返回刷新）。
 *
 * - `skip`：首次 show，或登录态 / 身份未就绪。首次那次让渡给登录态 effect ——
 *   冷启动时 `authStatus` 可能还是 `unknown`，交给它时点才准，不跳过就会一进页双发。
 * - `defer`：本代次有写入在飞。立刻重读会把页面拉回写入前的快照，改为挂起，
 *   等这条链收尾后补一次：既不丢刷新，也不打断在途任务（不把有效任务卡死）。
 * - `sync`：立刻重读。
 */
export type ShowSync = 'skip' | 'defer' | 'sync'

export function showSync(input: {
  firstShow: boolean
  authed: boolean
  userId: string | null
  submitInFlight: boolean
}): ShowSync {
  if (input.firstShow) return 'skip'
  if (!input.authed || input.userId === null) return 'skip'
  return input.submitInFlight ? 'defer' : 'sync'
}

/** 一次 confirm 请求的落定结果：成功看交易终态，失败看分类。 */
export type ConfirmOutcome =
  | { kind: 'ok'; status: string }
  | { kind: 'error'; failure: ConfirmFailure }

/**
 * 一次 confirm 落定后，「还差最后一步确认」这个入口的下一帧值（#147 P2）。
 *
 * - 成功：只有交易仍是 `PENDING_MEETUP`（还差另一侧）才保留入口；两个终态
 *   （`COMPLETED` / `CANCELLED`）一律撤下。
 * - 失败：只有终态冲突才撤下；网络类失败保留入口供重试。
 *
 * 判定留在这里而不是散在组件的两个 catch 里：CANCELLED 不得停在待确认、COMPLETED 不得
 * 停在待确认，这两条正是本 issue 的验收点，抽成纯函数才有能变红的用例（组件里那一行
 * 接线本身测不到，判定可以）。
 */
export function nextConfirmPending(outcome: ConfirmOutcome): boolean {
  if (outcome.kind === 'ok') return outcome.status === 'PENDING_MEETUP'
  return outcome.failure === 'retry'
}

/**
 * 终态 409 之后重读交易，确认入口该留还是该撤（#147 P2）。
 *
 * 409 `TRANSACTION_NOT_IN_PENDING` 已经确证交易**离开了** `PENDING_MEETUP`，所以只有读到
 * 仍是 `PENDING_MEETUP` 时才保留入口（与那个 409 自相矛盾，但以「凭证已消耗」为准：留着
 * 至少还能重试确认）；读到任一种终态一律撤下 —— `CANCELLED` 不得继续显示「还差最后一步
 * 确认」，`COMPLETED` 也不能停在待确认。
 *
 * `dto === null`（重读失败）同样撤下：保留入口会让已取消的单子继续显示「还差最后一步
 * 确认」，正是那条验收要挡住的。但本地快照此刻还停在 `PENDING_MEETUP`，照它渲染出来的
 * 6 位码输入态同样是错的（凭证已经 CONSUMED，再输、再扫都只会被拒）—— 两种渲染都不可信。
 * 所以调用点在 `dto === null` 时必须把这份旧快照一起丢掉，落到「加载失败 + 重试」，由
 * `bootstrap` 重读后落到正确的终态卡。
 */
export function pendingAfterTerminalRefetch(dto: { status: string } | null): boolean {
  return dto !== null && dto.status === 'PENDING_MEETUP'
}

/**
 * 同步期间是否发生过一次写入（#147 返回刷新 / #170 D）。
 *
 * 只判「此刻有没有人持锁」不够：这份快照可能在拿到响应之前就被一次**已经完成**的写入
 * 超越 —— 那时锁已放掉，检查通过，却会拿写入前的旧快照把刚写成的结果盖回去
 * （`COMPLETED` 被倒回 `PENDING_MEETUP`）。序号变了就丢弃这份快照：写入路径自己已经把
 * 服务端返回的最新 DTO 落到页面上，丢比盖安全。
 */
export function snapshotSuperseded(seen: number, current: number): boolean {
  return seen !== current
}

/** 写链收尾时，被挂起的返回刷新该怎么处置。 */
export type PendingFlush = {
  /** 现在是否补做一次返回刷新 */
  sync: boolean
  /** 挂起标记的下一帧值 */
  pending: boolean
}

/**
 * 被挂起的返回刷新如何收尾（#147 返回刷新 / #170 D）。
 *
 * 代次不是当前时**只留标记**：此时能观察到的标记只可能是**新代次**自己写下的
 * （代次自增那次渲染已经把旧标记清掉了），旧链没资格替新账号做这次刷新，更不能顺手
 * 把标记清掉 —— 清了，新账号那次刷新就永远丢了（旧链收尾晚于新账号入页是常态）。
 * 同代次才补做并清标记。
 */
export function nextPendingSync(
  pending: boolean,
  epoch: number,
  currentEpoch: number,
): PendingFlush {
  if (!pending) return { sync: false, pending: false }
  if (epoch !== currentEpoch) return { sync: false, pending: true }
  return { sync: true, pending: false }
}
