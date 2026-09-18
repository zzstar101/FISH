import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import {
  fetchMatches,
  findWish,
  formatAmount,
  MATCH_DEFAULT_WISH,
  MATCH_SCORE_THRESHOLD,
  type MatchView,
  type MockWish,
} from '@/mock/api'
import './index.scss'

/**
 * C3 匹配结果（设计稿 `设计稿_C3-match.html`）。
 *
 * 页头是「被命中的愿望」吊牌（关键词 + 预算区间 + 已匹配 N 位同学），
 * 下面是按匹配度倒序的商品列表，每条带百分比进度条与「聊一聊」。
 *
 * **阈值**：`score < 60` 的结果不展示（契约 `matching/schema.ts` 的
 * `MATCH_SCORE_THRESHOLD` 语义）——低于阈值的算「可能不相关」，避免打扰。
 * 因此稿子里 64% 那条会正常出现，而更低分的结果不会进列表。
 *
 * 空态分两种：愿望本身已经结束（已成交 / 过期），与「暂时没命中」。
 */

/** 匹配度的文案分档（稿子：高度匹配 / 关键字全中 / 价钱贴上限） */
function scoreLabel(score: number, wish: MockWish | undefined): string {
  if (score >= 90) return '高度匹配'
  if (score >= 75) return '关键字全中'
  if (wish && wish.budgetMaxCents > 0) return '价钱贴上限'
  return '基本符合'
}

export default function Match() {
  const authStatus = useAuthGuard()
  const router = useRouter<{ wishId?: string }>()
  const wishId = router.params.wishId ?? MATCH_DEFAULT_WISH

  const [wish, setWish] = useState<MockWish | null>(null)
  const [items, setItems] = useState<MatchView[]>([])
  const [loading, setLoading] = useState(true)
  /** 逐条的「聊一聊」状态：已发起会话的换成「去会话」 */
  const [started, setStarted] = useState<Record<string, boolean>>({})

  useLoad(() => {
    void (async () => {
      const found = findWish(wishId)
      setWish(found ?? null)
      setItems(await fetchMatches(wishId))
      setLoading(false)
    })()
  })

  const chat = (view: MatchView) => {
    const id = view.match.id
    if (started[id]) {
      void Taro.switchTab({ url: '/pages/chat/index' })
      return
    }
    setStarted((prev) => ({ ...prev, [id]: true }))
    void Taro.showToast({ title: '发起会话待接入', icon: 'none' })
  }

  const wishClosed = wish?.status === 'CLOSED' || wish?.status === 'FULFILLED'

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页数据源全是 `@/mock/api`（同步可得），不拦的话跳转落地前会先画一帧演示账号的数据。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />
  return (
    <View className="match">
      <View className="match__bg" />

      <NavBar />

      <View className="match__head">
        <Text className="match__title">匹配结果</Text>
        <Text className="match__sub">愿望命中通知 · 找到对得上的东西了</Text>
      </View>

      {/* ---- 愿望吊牌 ---- */}
      {wish ? (
        <View className="match__wish">
          <View className="match__wish-top">
            <Text className="match__wish-tag">WISH</Text>
            <Text className="match__wish-status num">
              {wishClosed ? '已结束' : `已匹配 ${items.length} 位同学`}
            </Text>
          </View>
          <Text className="match__wish-kw">{wish.keyword}</Text>
          <Text className="match__wish-budget num">
            ¥{formatAmount(wish.budgetMinCents)} – ¥{formatAmount(wish.budgetMaxCents)}
          </Text>
          <Text className="match__wish-hint">
            命中标准：标题或描述含「{wish.keyword}」，价格落在预算区间内
          </Text>
        </View>
      ) : null}

      <View className="match__sect">
        <Text className="match__sect-title">匹配到的商品</Text>
        <Text className="match__sect-cnt num">
          {loading ? '加载中' : `${items.length} 件 · 按匹配度排序`}
        </Text>
      </View>

      {/* ---- 列表 / 空态 ---- */}
      {loading ? (
        <View className="match__list">
          {[0, 1, 2].map((i) => (
            <View key={`sk-${i}`} className="match__skel">
              <View className="match__skel-sq" />
              <View className="match__skel-lines">
                <View className="match__skel-bar" />
                <View className="match__skel-bar" style={{ width: '52%' }} />
              </View>
            </View>
          ))}
        </View>
      ) : items.length === 0 ? (
        <View className="match__empty">
          <View className="match__empty-disc">
            <Image className="match__empty-ic" src={ICONS.bellInk} mode="aspectFit" />
          </View>
          <Text className="match__empty-title">
            {wishClosed ? '这条愿望已结束' : '还没有匹配到'}
          </Text>
          <Text className="match__empty-text">
            {wishClosed
              ? '已成交或已过有效期，列表不再更新；重新发一条愿望才能继续匹配。'
              : '命中后会通知你，不用一直盯着这页看'}
          </Text>
          <View
            className="match__empty-act"
            onClick={() => void Taro.switchTab({ url: '/pages/wish/index' })}
          >
            <Text>{wishClosed ? '重新许愿' : '调整预算 / 关键词'}</Text>
          </View>
        </View>
      ) : (
        <View className="match__list">
          {items.map((view) => {
            const on = started[view.match.id]
            return (
              <View key={view.match.id} className="match__row">
                <View
                  className="match__thumb"
                  onClick={() =>
                    void Taro.navigateTo({
                      url: `/pages/listing-detail/index?id=${view.listing.id}`,
                    })
                  }
                >
                  <Image
                    className="match__thumb-img"
                    src={view.listing.coverUrl}
                    mode="aspectFill"
                  />
                </View>

                <View className="match__main">
                  <Text className="match__rtitle">{view.listing.title}</Text>
                  <View className="match__rmeta">
                    <Text className="match__rprice num">
                      ¥{formatAmount(view.listing.priceCents)}
                    </Text>
                    <Text className="match__rseller">{view.seller.nickname}</Text>
                    {/* 校区契约里可为 null：缺了不渲染，不拼「null校区」 */}
                    {view.seller.campus ? (
                      <Text className="match__rcampus">{`${view.seller.campus}校区`}</Text>
                    ) : null}
                  </View>

                  {/* 匹配度：百分比 + 进度条 */}
                  <View className="match__bar">
                    <View className="match__track">
                      <View
                        className="match__fill"
                        style={{ width: `${Math.min(100, view.match.score)}%` }}
                      />
                    </View>
                    <Text className="match__pct num">{`${view.match.score}%`}</Text>
                    <Text className="match__lvl">
                      {scoreLabel(view.match.score, wish ?? undefined)}
                    </Text>
                  </View>
                </View>

                <View className={`match__chat${on ? ' is-on' : ''}`} onClick={() => chat(view)}>
                  <Text>{on ? '去会话' : '聊一聊'}</Text>
                </View>
              </View>
            )
          })}
        </View>
      )}

      <Text className="match__foot">
        {`低于 ${MATCH_SCORE_THRESHOLD}% 的结果不展示：匹配度 = 关键词命中 + 预算贴合度 + 成色描述的综合分。`}
      </Text>
    </View>
  )
}
