import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
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
 * **签名 URL 只有 900 秒**（`REVIEW_MEDIA_URL_TTL_SECONDS`）：评价页挂在后台超过
 * 15 分钟再回来看，图会全部裂掉。契约不带 `expiresAt`，所以端上只能按 `onError`
 * 兜底 —— 同一个地址只补读一次（`retriedRef`），避免真 404 的图把页面拖进死循环。
 *
 * 我这一侧还没评过时给「写评价」入口，打开 `components/review-dialog`（与订单卡
 * 同一个弹层）；提交成功后本块自重读，入口随已评状态消失。
 *
 * ## 弹层**不随重读卸载**（#485 审查 P1-2）
 *
 * 重读（`reloadSignal` / `refreshTick`）把 `state` 置回 `loading`。此前 loading 走
 * 早退 `return null`，整个块连同弹层一起被卸载、fetch 回来再画一遍 —— `dialogOpen`
 * 是块自己的 state 所以不复位，弹层会「闪断重现」，里面已选的图、在途上传与草稿
 * 全部销毁。触发条件是「弹层开着的时候返回本页」（`useDidShow` 自增 show 代次），
 * 正是演示清单里「提交后切后台 → 回前台」那一步。
 *
 * 所以渲染拆成两层：**卡片区**自己承担 loading / failed / ready 三态，
 * `MeetupReviewSections` 把弹层当**兄弟**无条件画（只由 `dialogOpen` 决定），
 * 页面组件只负责取数与状态、不再对渲染做任何分支。渲染级用例见
 * `apps/miniapp/tests/review-block-render.test.tsx`。
 *
 * 加载失败**不吞**：本块是完成态的主要对账信息（「对方评了没」），给一行可重试的
 * 说明，而不是静默消失让人误以为「对方还没评」。加载中先不画卡（避免闪一帧空卡）。
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
   * 重读信号：页面的 `useDidShow` 每次真实返回自增（show 代次）—— 离页期间
   * 对方可能刚评了（评价落库不 touch 交易快照，没有别的信号可用）。
   * 组件内自己的重读（重试 / 提交成功后 / 签名 URL 过期）用 `refreshTick`。
   */
  reloadSignal?: number
}

/** `MeetupReviewSections` 的入参：全部是纯数据与回调，可脱离 hooks 静态渲染（测试用） */
export type MeetupReviewSectionsProps = {
  state: BlockState
  dialogOpen: boolean
  transactionId: string
  listingTitle: string
  /** 失败态的重试 */
  onRetry: () => void
  onOpenDialog: () => void
  onCloseDialog: () => void
  /** 弹层提交成功后：收起弹层并重读 */
  onSubmitted: () => void
  /** 配图加载失败（签名 URL 过期 / 图没了）：按地址补读一次 */
  onImageError: (url: string) => void
}

/**
 * 本块的渲染（props 驱动的纯视图）。
 *
 * **弹层与卡片是兄弟**：`dialogOpen` 是它唯一的开关。卡片区三态（loading 不画、
 * failed 给重试、ready 画两行）都不影响弹层是否挂载 —— 这正是不让它随重读卸载的机制。
 */
export function MeetupReviewSections({
  state,
  dialogOpen,
  transactionId,
  listingTitle,
  onRetry,
  onOpenDialog,
  onCloseDialog,
  onSubmitted,
  onImageError,
}: MeetupReviewSectionsProps) {
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
                    onError={() => onImageError(url)}
                    onClick={() => void Taro.previewImage({ urls: view.images, current: url })}
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : isMine ? (
          <View className="meetup__rv-write" onClick={onOpenDialog}>
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
      {state.state === 'loading' ? null : state.state === 'failed' ? (
        <View className="meetup__rvretry" onClick={onRetry}>
          <Text>交易评价加载失败，点按重试</Text>
        </View>
      ) : (
        <View className="meetup__rvcard">
          <View className="meetup__rv-head">
            <Text className="meetup__rv-title">交易评价</Text>
            <Text className="meetup__rv-note num">双方各一条 · 提交后不可修改</Text>
          </View>
          {row(state.mine, '我的评价', true)}
          <View className="meetup__rv-hair" />
          {row(state.theirs, '对方的评价', false)}
        </View>
      )}

      {dialogOpen ? (
        <ReviewDialog
          transactionId={transactionId}
          listingTitle={listingTitle}
          onClose={onCloseDialog}
          onSubmitted={onSubmitted}
        />
      ) : null}
    </>
  )
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
  /** 已因 onError 补读过的图片地址：同一地址只补一次，别让真 404 的图把页面拖进死循环 */
  const retriedRef = useRef<Set<string>>(new Set())

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
      .catch((caught: unknown) => {
        if (cancelled) return
        // 失败态不吞：这里只补一条排障线索，UI 的语义仍是「给可重试入口」
        console.error('[meetup-review] 交易评价读取失败', caught)
        setState({ state: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [transactionId, myRole, reloadSignal, refreshTick])

  /**
   * 签名 URL 过期（或图真的没了）时补读一次：重读会拿到重新签发的 URL。
   * 只对**没见过**的地址补读，且同一地址只补一次。
   */
  const retryImageOnce = (url: string) => {
    if (retriedRef.current.has(url)) return
    retriedRef.current.add(url)
    setRefreshTick((prev) => prev + 1)
  }

  return (
    <MeetupReviewSections
      state={state}
      dialogOpen={dialogOpen}
      transactionId={transactionId}
      listingTitle={listingTitle}
      onRetry={() => setRefreshTick((prev) => prev + 1)}
      onOpenDialog={() => setDialogOpen(true)}
      onCloseDialog={() => setDialogOpen(false)}
      onSubmitted={() => {
        setDialogOpen(false)
        setRefreshTick((prev) => prev + 1)
      }}
      onImageError={retryImageOnce}
    />
  )
}
