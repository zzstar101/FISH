import type { RentalCard } from '@fish/contracts/rentals/schema'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useRef, useState } from 'react'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { fetchRentalFeed } from '@/features/rental/api'
import { formatAmount } from '@/lib/money'
import './index.scss'

/**
 * 租赁广场（#706 RNT-02）。
 *
 * ## 与首页 / 分类页的关系
 *
 * 广场是**独立页面**（`pkg-rental` 分包），不复用首页的瀑布流：出租卡片的字段集不同
 * （日租价、押金、可租天数区间），复用会让每张卡都带「这是出售还是出租」的分支。
 *
 * ## 筛选
 *
 * 只有两个：关键词与「能租满 N 天」。品类不在筛选里 —— M0 冻结为仅数码，给一个
 * 恒为数码的筛选项只会误导。
 *
 * ## 分页
 *
 * 服务端游标分页，客户端封顶 5 页（`fetchRentalFeed` 内部）。`truncated` 为真时
 * 底部提示「仅显示最近 N 件」，而不是假装已经到底 —— 与「我的发布」同一口径。
 */
export default function RentalSquarePage() {
  const [items, setItems] = useState<RentalCard[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [days, setDays] = useState<number | undefined>(undefined)
  const [showBackTop, setShowBackTop] = useState(false)

  /** 请求代次：切筛选 / 卸载后，旧响应不得覆盖新结果（与首页同一手法）。 */
  const requestSeq = useRef(0)

  const load = useCallback(
    async (options: { silent?: boolean; keyword?: string; days?: number | undefined } = {}) => {
      /*
       * 筛选值**显式传入**而不是只从闭包读：切 chip 时 `setDays` 还没生效，
       * 读闭包会拿上一轮的值发请求（实测：第一次点「可租 7 天」不带 days，第二次才带上，
       * 高亮的 chip 与结果永远差一步）。`'days' in options` 用于区分「没传」与「传了 undefined」。
       */
      const activeKeyword = options.keyword ?? keyword
      const activeDays = 'days' in options ? options.days : days
      const seq = ++requestSeq.current
      if (!options.silent) {
        setLoading(true)
        setFailed(false)
      }
      try {
        const page = await fetchRentalFeed({
          ...(activeKeyword.trim() ? { keyword: activeKeyword.trim() } : {}),
          ...(activeDays !== undefined ? { days: activeDays } : {}),
        })
        if (seq !== requestSeq.current) return
        setItems(page.items)
        setTruncated(page.truncated)
        setFailed(false)
      } catch {
        if (seq !== requestSeq.current) return
        setFailed(true)
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [keyword, days],
  )

  // 首次进入与每次回到本页都刷新（发布后 `redirectTo` 回来要能看到自己刚发的）。
  useDidShow(() => {
    void load({ silent: items.length > 0 })
  })

  usePullDownRefresh(async () => {
    await load({ silent: true })
    await Taro.stopPullDownRefresh()
  })

  usePageScroll((event) => {
    setShowBackTop(event.scrollTop > BACK_TOP_THRESHOLD)
  })

  const openDetail = useCallback(async (id: string) => {
    await Taro.navigateTo({ url: `/pkg-rental/pages/rental-detail/index?id=${id}` })
  }, [])

  const goPublish = useCallback(async () => {
    await Taro.navigateTo({ url: '/pkg-rental/pages/rental-publish/index' })
  }, [])

  return (
    <View className="rs">
      <TopBar variant="glass" spacer back center={<Text className="rs__title">租赁广场</Text>} />

      <View className="rs__filters">
        <View className="rs__search">
          <Text className="rs__search-icon">🔍</Text>
          <Input
            className="rs__search-input"
            value={keyword}
            placeholder="搜索想租的东西"
            maxlength={50}
            confirmType="search"
            onInput={(event) => setKeyword(String(event.detail.value))}
            onConfirm={() => void load()}
          />
        </View>
        <View className="rs__days">
          {DAY_OPTIONS.map((option) => (
            <View
              key={option.label}
              className={`rs__day${days === option.value ? ' is-on' : ''}`}
              onClick={() => {
                setDays(option.value)
                // 把新值**直接**传进去（不能靠 setTimeout 等 state 落地，那会读到旧闭包）。
                void load({ days: option.value })
              }}
            >
              {option.label}
            </View>
          ))}
        </View>
      </View>

      {failed && items.length === 0 ? (
        <LoadError onRetry={() => void load()} />
      ) : loading && items.length === 0 ? (
        <View className="rs__skeleton">
          {/* 骨架是静态装饰，用固定 key 而不是数组下标（下标 key 在数量变化时会复用错节点）。 */}
          {SKELETON_KEYS.map((key) => (
            <View key={key} className="rs__skeleton-card" />
          ))}
        </View>
      ) : items.length === 0 ? (
        <View className="rs__empty">
          <Text className="rs__empty-title">还没有人出租</Text>
          <Text className="rs__empty-hint">成为第一个出租数码产品的人</Text>
          <View className="rs__empty-btn" onClick={goPublish}>
            去发布
          </View>
        </View>
      ) : (
        <View className="rs__list">
          {items.map((item) => (
            <View key={item.id} className="rs__card" onClick={() => void openDetail(item.id)}>
              <View className="rs__cover">
                {item.coverUrl ? (
                  <Image className="rs__cover-img" src={item.coverUrl} mode="aspectFill" lazyLoad />
                ) : (
                  <View className="rs__cover-empty">暂无图片</View>
                )}
              </View>
              <View className="rs__info">
                <Text className="rs__name">{item.title}</Text>
                <View className="rs__price-row">
                  <Text className="rs__price">¥{formatAmount(item.dailyPriceCents)}</Text>
                  <Text className="rs__unit">/天</Text>
                </View>
                <View className="rs__meta">
                  <Text className="rs__meta-item">
                    {item.depositCents === 0 ? '免押' : `押金 ¥${formatAmount(item.depositCents)}`}
                  </Text>
                  <Text className="rs__meta-item">
                    {item.minDays}–{item.maxDays} 天
                  </Text>
                </View>
                <View className="rs__owner">
                  <Text className="rs__owner-name">{item.owner.nickname}</Text>
                  {item.owner.authStatus === 'VERIFIED' ? (
                    <Text className="rs__owner-badge">已认证</Text>
                  ) : null}
                </View>
              </View>
            </View>
          ))}
          {truncated ? (
            <Text className="rs__more">仅显示最近 {items.length} 件，可用搜索缩小范围</Text>
          ) : (
            <Text className="rs__end">已经到底了</Text>
          )}
        </View>
      )}

      {showBackTop ? (
        <BackTop
          show={showBackTop}
          // 抬到发布钮（44 距底 + L 档高 + 40 缝）之上，否则 88×88 的回顶钮会正好压在
          // 「+」上、把它的点击吞掉（`back-top-bottom-values.test.ts` 守这类重叠）。
          bottom="180rpx"
          onTop={() => void Taro.pageScrollTo({ scrollTop: 0 })}
        />
      ) : null}

      <View className="rs__fab" onClick={goPublish}>
        +
      </View>
    </View>
  )
}

/** 骨架占位的固定 key（见渲染处的说明）。 */
const SKELETON_KEYS = ['s1', 's2', 's3', 's4'] as const

/**
 * 租期快捷筛选。`undefined` = 不限。
 *
 * 文案是「可租 N 天」而不是「N 天起」：服务端谓词是 `minDays <= N <= maxDays`
 * （「N 天落在可租区间内」），不是「至少 N 天」。写「起」会让 `minDays=40` 的商品
 * 在「30 天起」下被排除，看起来像 bug。
 */
const DAY_OPTIONS: { label: string; value: number | undefined }[] = [
  { label: '不限', value: undefined },
  { label: '可租 1 天', value: 1 },
  { label: '可租 7 天', value: 7 },
  { label: '可租 30 天', value: 30 },
]
