/**
 * 黑名单管理页（#466 端上批次 / #473 验收「黑名单管理及解除入口」）。
 *
 * 列出**我拉黑的**人 + 逐行解除。只列我的视角——「谁拉黑了我」契约上没有读取路径，
 * 被拉黑不是可探测状态（与 PC `/pc/blocked` 同一口径）。
 *
 * ## 口径
 *
 * - **解除是恢复性动作，直接执行**（无确认弹窗，与 PC 同）；拉黑入口在他人主页，
 *   那边才有确认弹窗。解除成功以服务端 `{blocked:false}` 为准：把该行从列表摘掉，
 *   不做整页重拉（服务端真值已落到本地形状，重拉只会多一次请求）。
 * - **真实 API，无演示分支**（同他人主页关注钮的先例）：拉黑读写都要登录，演示构建
 *   没有可扮演的身份，401 交给守卫跳登录；demo 构建下进错误/空态是如实呈现。
 * - 游标分页：`nextCursor !== null` 即还有下一页，「加载更多」走页脚（首屏失败整页
 *   错误态 + 重试；页脚失败不整页报错，列表仍是好的）。
 * - 换账号清场：本页实例会压在页面栈里跨登录态存活，账号一变**渲染期**清成未加载 +
 *   作废在飞回包（`accountSeq`，与 `pages/following` 同一手法）。
 */
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchMyBlocks, setBlock } from '@/features/blocks/api'
import {
  type BlockedRow,
  type BlocksLoad,
  describeBlockFailure,
  moreReplyLanded,
  nextBlocksLoad,
} from '@/features/blocks/view'
import { cancellable } from '@/lib/cancellable'
import { isUnauthenticatedError } from '@/lib/request'
import { relativeTimeOf } from '@/lib/time'
import './index.scss'

export default function BlockedPage() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [load, setLoad] = useState<BlocksLoad>({ kind: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  /** 正在解除的那一行（`null` = 没有在飞的写操作）。 */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 行内解除失败的提示（`null` = 没有失败残留；换行 / 重载时清掉）。 */
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  /**
   * 进页信号：`useDidShow` 每次进页 / 从子页（他人主页）返回都自增，effect 据此重拉
   * （黑名单可能刚在别处被改动）。未显示过 / 未登录时不发请求（守卫在跳登录）。
   */
  const [showToken, setShowToken] = useState<number | null>(null)
  useDidShow(() => setShowToken((value) => (value ?? 0) + 1))

  /** 在飞取数的代次：换账号 / 退出即自增，旧回包据此丢弃（following 同款）。 */
  const accountSeq = useRef(0)
  /**
   * 列表快照的代次（#484 审查第 ② 条）：解除成功即自增，让解除**之前**发出的首屏
   * 回包（那份快照里还有刚被解除的人）作废。与 `accountSeq` 分开：解除不属于换账号，
   * 不该顺手把本页自己的写收尾（`busyId` 清位）也一起作废。
   */
  const loadGen = useRef(0)
  /**
   * 「加载更多」的持有者令牌（#484 审查第 ③ 条）：只有当前持有者能清 `loadingMore`
   * 与写页脚错误，被取消 / 被顶替的旧请求不许替新请求收尾。
   */
  const moreToken = useRef<symbol | null>(null)
  const pending = useRef<(() => void) | null>(null)
  const pendingMore = useRef<(() => void) | null>(null)

  /**
   * 账号切换的渲染期清场：上一帧的列表属于上一个账号，必须在同一 commit 内清成
   * 「未加载」，effect 里 setState 要到下一帧才生效，会露出一帧旧账号的黑名单。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    setLoad({ kind: 'loading' })
    setLoadingMore(false)
    setMoreError(false)
    setBusyId(null)
    setRowError(null)
    accountSeq.current += 1
    moreToken.current = null
  }

  const loadFirstPage = useCallback(async (): Promise<BlocksLoad> => {
    // 发起时的代次：本快照属于这一代，落地时 `nextBlocksLoad` 据此判新旧
    const gen = loadGen.current
    try {
      const page = await fetchMyBlocks()
      return {
        kind: 'ready',
        rows: page.items.map((item) => ({
          id: item.id,
          nickname: item.nickname,
          avatarUrl: item.avatarUrl,
          blockedAt: item.blockedAt,
        })),
        nextCursor: page.nextCursor,
        gen,
      }
    } catch (error) {
      // 401 不是「加载失败」，守卫已在跳登录；这里统一进错误态，重试即可。
      console.debug('[miniapp] 黑名单：首屏取数失败', error)
      return { kind: 'error' }
    }
  }, [])

  const runLoad = useCallback(async (): Promise<void> => {
    pending.current?.()
    pendingMore.current?.()
    // 顶替在飞的「加载更多」：交回令牌，它的收尾不再有权清 `loadingMore`
    moreToken.current = null
    setLoadingMore(false)
    setMoreError(false)
    setRowError(null)
    // 首屏才摆加载态：已有列表时（下拉刷新 / 从他人主页返回）保留旧列表。
    setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    const seq = accountSeq.current
    const run = cancellable(loadFirstPage, () => true)
    pending.current = run.cancel
    const next = await run.promise
    if (accountSeq.current !== seq) return
    // `loadFirstPage` 产出的快照按发起时的代次落地：解除成功换代后，旧快照落地会被
    // `nextBlocksLoad` 挡掉（不让刚解除的人被塞回来）
    if (next) setLoad((prev) => nextBlocksLoad(prev, next))
  }, [loadFirstPage])

  useEffect(() => {
    if (showToken === null || authStatus !== 'authed' || userId === null) return
    void runLoad()
    return () => {
      pending.current?.()
      pendingMore.current?.()
      pending.current = null
      pendingMore.current = null
    }
  }, [showToken, authStatus, userId, runLoad])

  usePullDownRefresh(() => {
    void runLoad().then(() => Taro.stopPullDownRefresh())
  })

  /** 加载更多：页脚独立于首屏，失败只标 `moreError`，不整页报错。 */
  const loadMore = useCallback(async (): Promise<void> => {
    if (load.kind !== 'ready' || load.nextCursor === null || loadingMore) return
    const seq = accountSeq.current
    const gen = loadGen.current
    const cursor = load.nextCursor
    // 自己那一枚令牌：只有持有者能清 `loadingMore` / 写页脚错误（#484 审查第 ③ 条）
    const token = Symbol('blocks-more')
    moreToken.current = token
    const held = () =>
      moreReplyLanded({ gen, genNow: loadGen.current, token, tokenNow: moreToken.current })
    setLoadingMore(true)
    setMoreError(false)
    const run = cancellable(
      () => fetchMyBlocks(cursor),
      () => true,
    )
    pendingMore.current = run.cancel
    try {
      const page = await run.promise
      // 被取消 / 换账号 / 已被顶替 / 已换代（解除成功）后到达的旧回包一律丢弃，
      // 不写进当前列表：否则会把刚解除的人塞回来。
      if (page === null || accountSeq.current !== seq || !held()) return
      setLoad((prev) =>
        prev.kind === 'ready'
          ? {
              kind: 'ready',
              rows: [
                ...prev.rows,
                ...page.items.map((item) => ({
                  id: item.id,
                  nickname: item.nickname,
                  avatarUrl: item.avatarUrl,
                  blockedAt: item.blockedAt,
                })),
              ],
              nextCursor: page.nextCursor,
              // 快照属于发起时那一代：解除成功换代后，仅靠 `held()` 已挡住，这里保持
              // 与 `prev.gen` 同代，落地后仍是可被更新的快照
              gen: prev.gen,
            }
          : prev,
      )
    } catch (error) {
      // 取消不是失败：runLoad / 重进页会 cancel 在飞的「加载更多」，被取消的请求随后
      // reject 时不能误标成页脚失败（following 页 loadMore 同款判据）。
      if (run.isCancelled() || accountSeq.current !== seq || !held()) return
      console.debug('[miniapp] 黑名单：加载更多失败', error)
      setMoreError(true)
    } finally {
      // 只有持有者能熄加载态：被顶替的旧请求不许替新请求收尾
      if (held()) setLoadingMore(false)
    }
  }, [load, loadingMore])

  /** 解除（恢复性动作，直接执行）：成功以服务端 `{blocked:false}` 为准，摘掉该行。 */
  const unblock = (row: BlockedRow) => {
    if (busyId !== null) return
    const seq = accountSeq.current
    setBusyId(row.id)
    setRowError(null)
    void setBlock(row.id, false)
      .then((state) => {
        if (accountSeq.current !== seq) return
        if (!state.blocked) {
          // 列表换代：解除**之前**发出的首屏 / 加载更多回包里还有这个人，落地会把刚
          // 摘掉的行塞回来、且再点一次是对已经不存在的拉黑发请求（#484 审查第 ② 条）。
          // 只动 `loadGen`，不动 `accountSeq` —— 这仍是同一个账号，本行自己的收尾照旧。
          const gen = loadGen.current + 1
          loadGen.current = gen
          setLoad((prev) =>
            prev.kind === 'ready'
              ? { ...prev, rows: prev.rows.filter((item) => item.id !== row.id), gen }
              : prev,
          )
          void Taro.showToast({ title: '已解除拉黑', icon: 'none' })
        }
      })
      .catch((error: unknown) => {
        if (accountSeq.current !== seq) return
        console.debug('[miniapp] 黑名单：解除失败', error)
        setRowError({
          id: row.id,
          message: isUnauthenticatedError(error)
            ? '登录已失效，请重新登录'
            : describeBlockFailure(error),
        })
      })
      .finally(() => {
        if (accountSeq.current === seq) setBusyId(null)
      })
  }

  // 未登录 / 登录态未就绪：守卫在跳登录，这里拦住渲染（following 同款）。
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  const ready = load.kind === 'ready' ? load : null

  return (
    <View className="blk">
      <TopBar variant="glass" spacer back title="黑名单" />
      <View className="blk__body">
        {ready ? (
          <Text className="blk__note">
            拉黑后你们双方都无法互发消息、也无法新建会话；解除是单方的——对方若也拉黑了你，需对方一并解除后才恢复。
          </Text>
        ) : null}

        {load.kind === 'loading' ? (
          <View className="blk__state">
            <Text className="blk__state-tx">正在加载黑名单…</Text>
          </View>
        ) : null}

        {load.kind === 'error' ? (
          <LoadError title="黑名单加载失败" onRetry={() => void runLoad()} />
        ) : null}

        {ready && ready.rows.length === 0 ? (
          <EmptyState
            icon={ICONS.shieldLine}
            title="黑名单是空的"
            text="在他人主页点「拉黑该用户」，对方会出现在这里"
          />
        ) : null}

        {ready && ready.rows.length > 0 ? (
          <View className="blk__list">
            {ready.rows.map((row) => (
              <View key={row.id} className="blk__row">
                <View className="blk__av">
                  {row.avatarUrl ? (
                    <Image className="blk__av-photo" src={row.avatarUrl} mode="aspectFill" />
                  ) : (
                    <Text className="blk__av-tx">{row.nickname.slice(0, 1)}</Text>
                  )}
                </View>
                <View className="blk__main">
                  <Text className="blk__name">{row.nickname}</Text>
                  <Text className="blk__time num">
                    {relativeTimeOf(row.blockedAt, Date.now())}拉黑
                  </Text>
                  {rowError?.id === row.id ? (
                    <Text className="blk__err">{rowError.message}</Text>
                  ) : null}
                </View>
                <View
                  className={`blk__rel${busyId === row.id ? ' is-busy' : ''}`}
                  onClick={() => unblock(row)}
                >
                  <Text>{busyId === row.id ? '解除中…' : '解除'}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {ready && ready.nextCursor !== null ? (
          <View
            className={`blk__more${loadingMore ? ' is-busy' : ''}`}
            onClick={() => void loadMore()}
          >
            <Text>{loadingMore ? '正在加载…' : '加载更多'}</Text>
          </View>
        ) : null}

        {moreError ? (
          <View className="blk__moreerr" onClick={() => void loadMore()}>
            <Text>更多黑名单加载失败，点击重试</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}
