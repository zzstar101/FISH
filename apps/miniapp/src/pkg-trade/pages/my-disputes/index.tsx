import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { loadDisputePage } from '@/features/disputes/load'
import type { DisputeRecord } from '@/features/disputes/map'
import { shortDisputeId } from '@/features/disputes/meta'
import './index.scss'

/**
 * 我的争议（#497）：我发起的 + 我被诉的，服务端按时间倒序，触底加载。
 *
 * ## 为什么不按身份分 Tab
 *
 * 服务端一次返回两种身份的行（`listMine`），而分页是游标式的：在端上按身份过滤只会筛
 * 当前已加载的那几页，会出现「切到「我被诉」先空着、再往下拉才冒出来」的错觉。所以两种
 * 身份放在同一列，用行内的「我发起 / 对方发起」标签区分。
 *
 * ## 账号作用域（#170 A–D）
 *
 * 与 `pages/my-reports` 同一套：`useAuthGuard()` 驱动，authed 才发请求；换号在渲染期清空
 * 列表并用加载代次丢弃迟到响应。
 */
export default function MyDisputes() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [items, setItems] = useState<DisputeRecord[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)

  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  const loadEpoch = useRef(0)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    loadEpoch.current += 1
    loadingMoreRef.current = false
    setItems([])
    setNextCursor(null)
    setFailed(false)
    setLoading(true)
    setLoadingMore(false)
  }

  /**
   * 第一页。`silent`（从详情页返回 / 下拉刷新）不闪骨架屏、也不把列表换掉：
   * 刷新失败只提示一句，保留用户手上这份快照。
   */
  const read = useCallback(
    async (silent = false) => {
      const epoch = ++loadEpoch.current
      loadingMoreRef.current = false
      if (!silent) {
        setLoading(true)
        setFailed(false)
      }
      const result = await loadDisputePage(undefined, userId, Date.now())
      if (epoch !== loadEpoch.current) return
      if (silent) {
        if (result.failed) {
          void Taro.showToast({ title: '刷新没成功，稍后再试', icon: 'none' })
          return
        }
        setItems(result.items)
        setNextCursor(result.nextCursor)
        setFailed(false)
        setLoading(false)
        return
      }
      setItems(result.items)
      setNextCursor(result.nextCursor)
      setFailed(result.failed)
      setLoading(false)
    },
    [userId],
  )

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void read()
  }, [authStatus, userId, read])

  /**
   * 从详情页返回时补一次重拉（首次 show 跳过：那次由上面的登录态 effect 负责）。
   * 详情页里可能刚撤回过 / 刚补了材料，返回后列表不能停在旧快照。
   */
  const skipFirstShow = useRef(true)
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'
  useDidShow(() => {
    if (skipFirstShow.current) {
      skipFirstShow.current = false
      return
    }
    if (!authedRef.current) return
    void read(true)
  })

  usePullDownRefresh(() => {
    void read(true).then(() => Taro.stopPullDownRefresh())
  })

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || nextCursor === null || loading || failed) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const epoch = loadEpoch.current
    const result = await loadDisputePage(nextCursor, userId, Date.now())
    if (epoch === loadEpoch.current) {
      if (result.failed) {
        void Taro.showToast({ title: '加载更多没成功，再往下拉试试', icon: 'none' })
      } else {
        setItems((prev) => [...prev, ...result.items])
        setNextCursor(result.nextCursor)
      }
    }
    loadingMoreRef.current = false
    setLoadingMore(false)
  }, [nextCursor, loading, failed, userId])

  useReachBottom(() => {
    void loadMore()
  })

  const openDispute = (disputeId: string) => {
    void Taro.navigateTo({
      url: `/pkg-trade/pages/dispute-detail/index?id=${encodeURIComponent(disputeId)}`,
    })
  }

  if (authStatus !== 'authed') {
    return <AuthRequired restoring={authStatus === 'unknown'} />
  }

  return (
    <View className="dsp">
      <View className="dsp__bg" />

      <TopBar variant="glass" spacer back title="我的" titleEm="争议" />

      <View className="dsp__body">
        {loading ? (
          <View className="dsp__skeleton">
            {[0, 1, 2].map((i) => (
              <View key={`sk-${i}`} className="dsp__skel">
                <View className="dsp__skel-lines">
                  <View className="dsp__skel-bar" />
                  <View className="dsp__skel-bar" style={{ width: '62%' }} />
                  <View className="dsp__skel-bar" style={{ width: '38%' }} />
                </View>
              </View>
            ))}
            <Text className="dsp__skel-hint">正在读取争议…</Text>
          </View>
        ) : failed ? (
          <LoadError
            title="争议列表加载失败"
            text="网络似乎不太顺畅，稍后再试试"
            onRetry={() => {
              void read()
            }}
          />
        ) : items.length === 0 ? (
          <View className="dsp__emptypad">
            <EmptyState
              title="还没有交易争议"
              text="交易有问题时，可以在订单详情里发起争议，平台会介入处理。"
              icon={ICONS.shieldLine}
              // 不按角色分流（买家/卖家都可能在这里）：留一个中性的返回
              actionText="返回"
              onAction={() => {
                void Taro.navigateBack()
              }}
            />
          </View>
        ) : (
          <View className="dsp__list">
            {items.map((record) => (
              <View key={record.id} className="dsp__card" onClick={() => openDispute(record.id)}>
                <View className="dsp__top">
                  <View className={`dsp__chip is-${record.tone}`}>
                    <View className="dsp__chip-dot" />
                    <Text>{record.statusLabel}</Text>
                  </View>
                  <Text className="dsp__type">{record.typeLabel}</Text>
                  <Text className="dsp__time num">{record.timeLabel}</Text>
                </View>
                <Text className="dsp__title">{record.listingTitle}</Text>
                <View className="dsp__sub">
                  <Text className="dsp__role">{record.roleLabel}</Text>
                  <Text className="dsp__sep">·</Text>
                  <Text className="dsp__counter">{`对方 ${record.counterpartNickname}`}</Text>
                  <Text className="dsp__sep">·</Text>
                  <Text className="dsp__amount num">{`¥${record.amountText}`}</Text>
                </View>
                <View className="dsp__foot">
                  <Text className="dsp__id num">{shortDisputeId(record.id)}</Text>
                  <Image className="dsp__chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
                </View>
              </View>
            ))}
            <Text className="dsp__more">
              {loadingMore
                ? '正在加载…'
                : nextCursor === null
                  ? '· 已经到底了 ·'
                  : '· 上拉加载更多 ·'}
            </Text>
          </View>
        )}
      </View>
    </View>
  )
}
