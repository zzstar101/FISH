import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useCallback, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import LoadError from '@/components/load-error'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { loadWishMatches } from '@/features/fetchers'
import type { MatchView } from '@/features/match/adapt'
import { formatAmount, MATCH_SCORE_THRESHOLD, type MockWish } from '@/mock/api'
import './index.scss'

/**
 * C3 匹配结果（设计稿 `设计稿_C3-match.html`）。
 *
 * 页头是「被命中的愿望」吊牌（关键词 + 预算区间 + 已匹配 N 件商品），
 * 下面是按匹配度倒序的商品列表，每条带百分比进度条与「聊一聊」。
 *
 * **阈值**：`score < MATCH_SCORE_THRESHOLD` 的结果不展示（契约
 * `packages/contracts/src/matching/schema.ts`，值为 70）。过滤在**服务端**
 * （`apps/api/src/modules/matching/store.ts` 的 where），客户端不再二次过滤。
 *
 * 数据走 `features/fetchers.ts` 的 `loadWishMatches()`：愿望走 `GET /wishes/:id`、
 * 命中走 `GET /matches?wishId=`，**不回退 mock**。403 / 404（不是我的愿望 / 已经没了）
 * 与「没问到」分开：前者是「已结束」空态，后者是带重试的错误态。
 *
 * 空态分两种：愿望本身已经结束（已成交 / 过期 / 已不存在），与「暂时没命中」。
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
  // 契约的 wishId 是 uuid；本页只能从「我的愿望」卡带参进入，没有 mock 默认愿望可退
  const wishId = router.params.wishId ?? ''

  const [wish, setWish] = useState<MockWish | null>(null)
  const [items, setItems] = useState<MatchView[]>([])
  /** `/matches` 的 `total`：与许愿页卡片同源，计数不用 `items.length`（可能被 limit 截断） */
  const [total, setTotal] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>(
    'loading',
  )
  /** 逐条的「聊一聊」状态：已发起会话的换成「去会话」 */
  const [started, setStarted] = useState<Record<string, boolean>>({})

  /** 自增序号丢弃过期响应：连点重试时先发的请求可能后到（与许愿页同一手法） */
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    if (wishId === '') {
      // 没带 wishId（旧链接 / 手输路由）：没有可查的目标，按「已结束」处理
      setState('notFound')
      return
    }
    setState('loading')
    const result = await loadWishMatches(wishId)
    if (loadSeq.current !== seq) return
    if (result.status === 'ok') {
      setWish(result.wish)
      setItems(result.items)
      setTotal(result.total)
      setState('ready')
      return
    }
    setState(result.status)
  }, [wishId])

  useLoad(() => {
    void load()
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
  /** 「愿望已结束」：后端说这条愿望没了（404），或它本身就是终态 */
  const gone = state === 'notFound' || wishClosed
  /** 403：愿望存在但不是当前账号的 —— 不能说成「已结束」 */
  const forbidden = state === 'forbidden'

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页两个端点都挂 `requireAuth`，不拦的话跳转落地前会先画一帧空骨架。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />
  return (
    <View className="match">
      <View className="match__bg" />

      <NavBar title="匹配结果" />

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
              {/*
                稿的文案是「已匹配 N 位同学」，但命中是**商品**（同一卖家可能命中多件），
                数出来的不是人数 —— 按实际口径写成「件商品」。计数用 `/matches` 的
                `total` 而不是 `items.length`：`limit` 上限 50，超过时 `items` 会被截断。
              */}
              {wishClosed ? '已结束' : `已匹配 ${total} 件商品`}
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
          {state === 'loading'
            ? '加载中'
            : state === 'failed'
              ? '加载失败'
              : forbidden
                ? '无权查看'
                : gone
                  ? // 终态 / 目标不存在：`/matches` 对非 ACTIVE 愿望恒为空，别报「0 件」
                    '已结束'
                  : items.length < total
                    ? // `limit` 上限 50：超过时 `items` 是子集，如实说明而不是假装这是全部
                      `${total} 件 · 显示前 ${items.length} 件`
                    : `${total} 件 · 按匹配度排序`}
        </Text>
      </View>

      {/* ---- 列表 / 空态 ---- */}
      {state === 'loading' ? (
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
      ) : state === 'failed' ? (
        <LoadError title="匹配结果加载失败" text="检查网络后重试" onRetry={() => void load()} />
      ) : total === 0 ? (
        <View className="match__empty">
          <View className="match__empty-disc">
            <Image className="match__empty-ic" src={ICONS.bellInk} mode="aspectFit" />
          </View>
          <Text className="match__empty-title">
            {forbidden ? '无权查看这条愿望' : gone ? '这条愿望已结束' : '还没有匹配到'}
          </Text>
          <Text className="match__empty-text">
            {forbidden
              ? '这条愿望不属于当前账号，看不到它的匹配列表。'
              : gone
                ? '已成交或已过有效期，列表不再更新；重新发一条愿望才能继续匹配。'
                : '命中后会通知你，不用一直盯着这页看'}
          </Text>
          <View
            className="match__empty-act"
            onClick={() => void Taro.switchTab({ url: '/pages/wish/index' })}
          >
            <Text>{forbidden ? '返回我的愿望' : gone ? '重新许愿' : '调整预算 / 关键词'}</Text>
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
                    {/*
                      卖家不在 `/matches` 的响应里（`WishMatchItem` 只有 ListingCard），
                      由 `loadWishMatches` 逐条拉商品详情补；补不到就是 `null` —— 不编造卖家。
                    */}
                    {view.seller ? (
                      <Text className="match__rseller">{view.seller.nickname}</Text>
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
