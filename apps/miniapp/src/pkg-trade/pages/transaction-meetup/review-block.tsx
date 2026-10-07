import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'
import ReviewDialog from '@/components/review-dialog'
import { fetchTransactionReviews } from '@/features/transaction/api'
import { type ReviewRowView, ratingViewOf, splitReviews } from './review-block-view'

/**
 * 面交页完成态的「交易评价」块（#195 PR2 的两方评价读路径 + #475 的写入口）。
 *
 * 数据是 `GET /transactions/:id/reviews`（至多两行：buyer / seller 各一条），
 * 按 `authorRole` 与本页角色拆成「我的评价 / 对方的评价」（映射在 `review-block-view.ts`，
 * 那里有测试钉角色归属）。评价图是服务端签好的短期 capability URL
 * （`/api/uploads/media/:token`，无会话鉴权是刻意的 —— 小程序 `<Image>` 不带 cookie），
 * 直接渲染即可；点缩略图进 `previewImage` 看大图。
 *
 * 我这一侧还没评过时给「写评价」入口，打开 `components/review-dialog`（与订单卡
 * 同一个弹层）；提交成功后本块自重读，入口随已评状态消失。
 *
 * 加载失败**不吞**：本块是完成态的主要对账信息（「对方评了没」），给一行可重试的
 * 说明，而不是静默消失让人误以为「对方还没评」。加载中先不渲染（避免闪一帧空卡）。
 */

type BlockState =
  | { state: 'loading' }
  | { state: 'ready'; mine: ReviewRowView | null; theirs: ReviewRowView | null }
  | { state: 'failed' }

type Props = {
  transactionId: string
  /** 查看者在这笔交易里的角色：`authorRole === myRole` 的行是「我的评价」 */
  myRole: 'buyer' | 'seller'
  /** 评价弹层副标题（这笔交易的商品标题） */
  listingTitle: string
  /**
   * 重读信号：页面的 `syncOnShow` 刷到更新的交易快照（`updatedAt`）时值会变 ——
   * 离页期间对方可能刚评了，返回本页时随之重读。组件内自己的重读用 `refreshTick`。
   */
  reloadSignal?: string
}

export default function MeetupReviewBlock({
  transactionId,
  myRole,
  listingTitle,
  reloadSignal,
}: Props) {
  const [state, setState] = useState<BlockState>({ state: 'loading' })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadSignal/refreshTick 是刻意的重读信号，不是体内读到的值
  useEffect(() => {
    let cancelled = false
    setState({ state: 'loading' })
    fetchTransactionReviews(transactionId)
      .then((response) => {
        if (cancelled) return
        const { mine, theirs } = splitReviews(response.items, myRole)
        setState({ state: 'ready', mine, theirs })
      })
      .catch(() => {
        if (cancelled) return
        setState({ state: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [transactionId, myRole, reloadSignal, refreshTick])

  if (state.state === 'loading') return null

  if (state.state === 'failed') {
    return (
      <View className="meetup__rvretry" onClick={() => setRefreshTick((prev) => prev + 1)}>
        <Text>交易评价加载失败，点按重试</Text>
      </View>
    )
  }

  const row = (view: ReviewRowView | null, label: string, isMine: boolean) => {
    const chip = view !== null ? ratingViewOf(view.rating) : null
    return (
      <View className="meetup__rv-row">
        <View className="meetup__rv-rowhead">
          <Text className="meetup__rv-label">{label}</Text>
          {chip !== null ? (
            <Text className={`meetup__rv-chip ${chip.cls}`}>{chip.label}</Text>
          ) : null}
        </View>
        {view !== null ? (
          <>
            {view.body !== '' ? <Text className="meetup__rv-text">{view.body}</Text> : null}
            {view.images.length > 0 ? (
              <View className="meetup__rv-imgs">
                {view.images.map((url) => (
                  <Image
                    key={url}
                    className="meetup__rv-img"
                    src={url}
                    mode="aspectFill"
                    onClick={() => void Taro.previewImage({ urls: view.images, current: url })}
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : isMine ? (
          <View className="meetup__rv-write" onClick={() => setDialogOpen(true)}>
            <Text>写评价</Text>
          </View>
        ) : (
          <Text className="meetup__rv-empty">对方还没评价</Text>
        )}
      </View>
    )
  }

  return (
    <>
      <View className="meetup__rvcard">
        <View className="meetup__rv-head">
          <Text className="meetup__rv-title">交易评价</Text>
          <Text className="meetup__rv-note num">双方各一条 · 提交后不可修改</Text>
        </View>
        {row(state.mine, '我的评价', true)}
        <View className="meetup__rv-hair" />
        {row(state.theirs, '对方的评价', false)}
      </View>

      {dialogOpen ? (
        <ReviewDialog
          transactionId={transactionId}
          listingTitle={listingTitle}
          onClose={() => setDialogOpen(false)}
          onSubmitted={() => {
            setDialogOpen(false)
            setRefreshTick((prev) => prev + 1)
          }}
        />
      ) : null}
    </>
  )
}
