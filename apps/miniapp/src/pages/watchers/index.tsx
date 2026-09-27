import type { ChatWatchersResponse } from '@fish/contracts/chat/schema'
import type { ListingDetail } from '@fish/contracts/listings/schema'
import { Image, ScrollView, Text, View } from '@tarojs/components'
import type { ScrollViewProps } from '@tarojs/components/types/ScrollView'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchListingDetail } from '@/features/listing/api'
import { fetchChatWatchers } from '@/features/watchers/api'
import { formatAmount } from '@/lib/money'
import { isApiError } from '@/lib/request'
import { dayLabelOf } from '@/lib/time'
import './index.scss'

type Watcher = ChatWatchersResponse['items'][number]
type Page = {
  listing: ListingDetail | null
  items: Watcher[]
  total: number | null
  cursor: string | null
  phase: 'loading' | 'ready' | 'error' | 'forbidden' | 'not-found'
}

const initialPage = (): Page => ({
  listing: null,
  items: [],
  total: null,
  cursor: null,
  phase: 'loading',
})

/** C5 想要的人：仅本商品已发起聊天的买家，不含收藏与愿望匹配。 */
export default function Watchers() {
  const authStatus = useAuthGuard()
  const userId = useAuth().user?.id ?? null
  const listingId = useRouter<{ listingId?: string }>().params.listingId ?? ''
  const [page, setPage] = useState<Page>(initialPage)
  /**
   * 回到顶部钮（共享组件）：滚过一屏浮现。
   *
   * ⚠️ 本页名单在**内滚 ScrollView**（`.wt__scroll`，页面根 `.wt` 是 `height:100vh;
   * overflow:hidden`），页面本身并不滚动 —— `usePageScroll` 收不到这条滚动流，
   * `Taro.pageScrollTo` 也够不到它。所以显示判据取自容器的 `onScroll`，回顶走
   * `scrollIntoView` 锚点（同 `pages/user`、`pages/conversation` 的内滚口径）。
   */
  const [showTop, setShowTop] = useState(false)
  const onScroll = useCallback((e: { detail: ScrollViewProps.onScrollDetail }) => {
    // `onScroll` 的 `scrollTop` 是设备 px，与共享组件阈值同口径（不 ×2）
    setShowTop(e.detail.scrollTop > BACK_TOP_THRESHOLD)
  }, [])
  /**
   * `scrollIntoView` 的值不变时原生层不会重滚，所以备两个同位的锚点交替指 ——
   * 连点、滚下去再点，每次都能真的回到顶部（同 `pages/user` 的做法）。
   */
  const [topAnchor, setTopAnchor] = useState('')
  const backToTop = () => {
    setTopAnchor((prev) => (prev === 'wt-top-a' ? 'wt-top-b' : 'wt-top-a'))
  }
  const [showToken, setShowToken] = useState<number | null>(null)
  const [morePending, setMorePending] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)
  const [scope, setScope] = useState({ userId, listingId })
  const epoch = useRef(0)

  // 商品/账号变化在渲染期就清掉名单；迟到的旧请求也不能回填给新账号。
  if (scope.userId !== userId || scope.listingId !== listingId) {
    epoch.current += 1
    setScope({ userId, listingId })
    setPage(initialPage())
    setMorePending(false)
    setMoreFailed(false)
    // 名单换了一份，回顶钮的判据要跟着归零：不清的话它会悬在骨架屏 / 空态上，
    // 而那时根本没有可滚的内容（要等下一次滚动事件才会纠正）
    setShowTop(false)
  }

  useDidShow(() => setShowToken((value) => (value ?? 0) + 1))

  useEffect(() => {
    if (showToken === null || authStatus !== 'authed' || !userId) return
    const request = ++epoch.current
    setPage(initialPage())
    setMorePending(false)
    setMoreFailed(false)
    // 名单重新加载：`ScrollView` 会被骨架屏替下、新列表又从 `scrollTop=0` 开始，
    // 而浮现态是上一份名单滚出来的 —— 不归零它就会悬在不可滚的界面上（先例：user 页同坑）
    setShowTop(false)

    if (!listingId) {
      setPage((prev) => ({ ...prev, phase: 'not-found' }))
      return
    }
    void (async () => {
      try {
        const listing = await fetchListingDetail(listingId)
        if (request !== epoch.current) return
        if (!listing) {
          setPage((prev) => ({ ...prev, phase: 'not-found' }))
          return
        }
        // 不凭旧列表/路由参数推断归属；与当前登录身份再交叉校验。
        if (!listing.isOwner || listing.seller.id !== userId) {
          setPage((prev) => ({ ...prev, phase: 'forbidden' }))
          return
        }
        const result = await fetchChatWatchers(listingId)
        if (request !== epoch.current) return
        setPage({
          listing,
          items: result.items,
          total: result.total,
          cursor: result.nextCursor,
          phase: 'ready',
        })
      } catch (error) {
        if (request !== epoch.current) return
        setPage({
          ...initialPage(),
          phase: isApiError(error) && error.status === 403 ? 'forbidden' : 'error',
        })
      }
    })()
  }, [showToken, authStatus, userId, listingId])

  const retry = () => setShowToken((value) => (value ?? 0) + 1)
  const loadMore = () => {
    if (page.phase !== 'ready' || !page.cursor || morePending || !userId) return
    const current = epoch.current
    const cursor = page.cursor
    setMorePending(true)
    setMoreFailed(false)
    void (async () => {
      try {
        const result = await fetchChatWatchers(listingId, cursor)
        if (current !== epoch.current) return
        setPage((prev) =>
          prev.phase === 'ready' && prev.cursor === cursor
            ? {
                ...prev,
                items: [...prev.items, ...result.items],
                total: result.total,
                cursor: result.nextCursor,
              }
            : prev,
        )
      } catch {
        if (current === epoch.current) setMoreFailed(true)
      } finally {
        if (current === epoch.current) setMorePending(false)
      }
    })()
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />
  const owned = page.listing?.isOwner && page.listing.seller.id === userId
  const listing = owned ? page.listing : null
  const nowMs = Date.now()

  return (
    <View className="wt">
      <View className="wt__bg" />
      <NavBar title="想要的人" />
      <View className="wt__head">
        <Text className="wt__kicker num">我的发布 · 想要的人</Text>
        <Text className="wt__title">想要的人</Text>
        {listing ? (
          <View
            className="wt__lchip"
            onClick={() =>
              void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
            }
          >
            <View className="wt__lthumb">
              {listing.images[0] ? (
                <Image className="wt__lthumb-img" src={listing.images[0].url} mode="aspectFill" />
              ) : (
                <Image className="wt__lthumb-fallback" src={ICONS.starAccent} mode="aspectFit" />
              )}
            </View>
            <View className="wt__lmain">
              <Text className="wt__ltitle">{listing.title}</Text>
              <Text className="wt__lmeta num">
                ¥{formatAmount(listing.priceCents)} ·{' '}
                {listing.status === 'ACTIVE' ? '在售' : '非在售'}
              </Text>
            </View>
            <Text className="wt__lgo">查看 ›</Text>
          </View>
        ) : null}
        {page.phase === 'loading' || page.phase === 'ready' ? (
          <View className="wt__stats">
            <View className="wt__stat">
              <Text className="wt__stat-num num">
                {page.total === null ? '—' : page.total}
                {page.total === null ? null : <Text className="wt__stat-unit">人</Text>}
              </Text>
              <Text className="wt__stat-label">共有人想要</Text>
            </View>
          </View>
        ) : null}
        {page.phase === 'ready' || page.phase === 'loading' ? (
          <Text className="wt__stat-note">只统计已发起聊天的同学，不含收藏或愿望匹配</Text>
        ) : null}
      </View>

      {page.phase === 'error' ? (
        <View className="wt__fail">
          <Image className="wt__fail-img" src={ICONS.warnInk} mode="aspectFit" />
          <View className="wt__fail-main">
            <Text className="wt__fail-title">想要的人列表加载失败，请检查网络后重试</Text>
            <View className="wt__fail-act" onClick={retry}>
              <Text>重新加载</Text>
            </View>
          </View>
        </View>
      ) : null}
      {page.phase === 'forbidden' || page.phase === 'not-found' ? (
        <View className="wt__empty">
          <Image className="wt__empty-ic" src={ICONS.info} mode="aspectFit" />
          <Text className="wt__empty-title">无法查看</Text>
          <Text className="wt__empty-text">
            {page.phase === 'forbidden' ? '只有商品卖家可以查看想要的人' : '商品不存在或无法查看'}
          </Text>
        </View>
      ) : null}

      {page.phase === 'loading' || page.phase === 'ready' ? (
        <>
          <View className="wt__sec">
            <Text className="wt__sec-title">全部想要的人</Text>
            <Text className="wt__sec-cnt num">
              {page.phase === 'loading' ? '加载中' : `已显示 ${page.items.length} 人`}
            </Text>
          </View>
          {page.phase === 'loading' ? (
            <View className="wt__list">
              {[0, 1, 2].map((i) => (
                <View key={`sk-${i}`} className="wt__skel">
                  <View className="wt__skel-av" />
                  <View className="wt__skel-col">
                    <View className="wt__skel-bar" style={{ width: '38%' }} />
                    <View className="wt__skel-bar" style={{ width: '62%' }} />
                  </View>
                </View>
              ))}
            </View>
          ) : page.items.length === 0 ? (
            <View className="wt__empty">
              <Image className="wt__empty-ic" src={ICONS.starAccent} mode="aspectFit" />
              <Text className="wt__empty-title">还没有人想要</Text>
              <Text className="wt__empty-text">还没有同学为这件商品发起聊天</Text>
            </View>
          ) : (
            <ScrollView
              className="wt__scroll"
              scrollY
              scrollIntoView={topAnchor}
              onScroll={onScroll}
            >
              {/* 回到顶部的两个同位锚点：交替指（见 backToTop 的注释） */}
              <View id="wt-top-a" />
              <View id="wt-top-b" />
              <View className="wt__list">
                {page.items.map(({ user, startedAt }) => (
                  <View key={user.id} className="wt__row">
                    <View className="wt__av">
                      {user.avatarUrl ? (
                        <Image className="wt__av-img" src={user.avatarUrl} mode="aspectFill" />
                      ) : (
                        <Text className="wt__av-tx">{user.nickname.slice(0, 1) || '同'}</Text>
                      )}
                    </View>
                    <View className="wt__main">
                      <View className="wt__top">
                        <Text className="wt__name">{user.nickname}</Text>
                        {user.authStatus === 'VERIFIED' ? (
                          <View className="wt__badge">
                            <Image
                              className="wt__badge-ic"
                              src={ICONS.verifiedAccent}
                              mode="aspectFit"
                            />
                            <Text>已认证</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text className="wt__meta num">{dayLabelOf(startedAt, nowMs)}发起聊天</Text>
                    </View>
                  </View>
                ))}
              </View>
              <View className="wt__banner">
                <Image className="wt__banner-ic-img" src={ICONS.info} mode="aspectFit" />
                <Text className="wt__banner-tx">
                  只展示对方的昵称、头像、认证状态和发起聊天时间；建立会话不代表已收藏或发布愿望。
                </Text>
              </View>
              {page.cursor ? (
                <View className="wt__more-wrap">
                  <View
                    className={`wt__more${morePending ? ' is-loading' : ''}`}
                    onClick={loadMore}
                  >
                    <Text>
                      {morePending ? '加载中…' : moreFailed ? '加载失败，点击重试' : '查看更多'}
                    </Text>
                  </View>
                </View>
              ) : (
                <View className="wt__tail">
                  <View className="wt__tail-line" />
                  <Text className="wt__tail-tx num">已显示 {page.items.length} 人</Text>
                  <View className="wt__tail-line" />
                </View>
              )}
            </ScrollView>
          )}
        </>
      ) : null}

      {/* 回到顶部（内滚容器版：滚回由 `scrollIntoView` 锚点完成，见 backToTop） */}
      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
