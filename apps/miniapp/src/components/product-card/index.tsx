/**
 * 商品卡（首页 / 搜索 / 相似推荐共用，同一套版式与同一套长按菜单）。
 *
 * 版式以 1改 稿首页瀑布流卡为准：成色印章压在标题前、价格走 --danger 红、
 * 右下「N人想要」（契约无此计数时不渲染）。历史上曾有 `search` 变体
 * （价格深色、成色胶囊挪到价格同位），Owner 2026-09-28 拍板全部统一为首页版式，变体已收掉。
 *
 * **长按菜单长在卡片身上**（收藏 / 不感兴趣）：三处调用方拿到的是同一套交互，页面不再各自
 * 传长按回调 —— 否则「搜索页和相似推荐位没有长按」这类缺口只能靠每个页面记得接一遍。
 * 页面只按需接两个钩子做自己才做得了的账：`hidden`（页面那份跨页的隐藏名单，决定这张卡还画不画）
 * 与 `onDislike`（首页要结算曝光计时、把 id 记进页面名单）。
 */
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { isListingFaved, setListingFavorite } from '@/features/favorites/local'
import { buildListingDetailUrl, type FeedAttribution } from '@/features/recommendation/attribution'
import { hideListing, readHiddenListingIds } from '@/features/recommendation/hidden'
import { trackRecommendationEvent } from '@/features/recommendation/track'
import { conditionLabel, formatAmount } from '@/mock/api'
import type { MockListing, MockUser } from '@/mock/types'
import './index.scss'

/** 长按菜单的选项；顺序即 `tapIndex`，判定用它而不是文案 */
const MENU_FAVORITE = 0
const MENU_DISLIKE = 1

type ProductCardProps = {
  listing: MockListing
  /**
   * 卖家。**可为 `null`**：契约的 `ListingCard` 没有卖家字段
   * （`packages/contracts/src/listings/schema.ts` 只给了 id/title/price/…），
   * 真实接口的列表卡因此拿不到卖家。此时整行不渲染 ——
   * 不编一个卖家出来（`mock/users.ts` 的 `getUser` 会对未知 id 兜底到某个真实演示用户，
   * 所以调用方必须用 `findUser` 并把 `null` 原样传进来）。
   */
  seller: MockUser | null
  /** 图片区高度（rpx），由瀑布流按列宽 × 比例算好后传入 */
  imageHeight: number
  /**
   * 推荐归因（R1 §3.5）：从推荐流点进详情时把它拼进详情页 URL，详情页据此发带 requestId 的事件。
   * 搜索 / 相似推荐等入口没有推荐来源，传 `null` 或不传 —— 详情页照样发 DETAIL_VIEW，只是不带归因。
   * 卡片菜单里的 HIDE / FAVORITE / UNFAVORITE 同样用它：来自推荐就带归因，其它入口照发（见下）。
   */
  attribution?: FeedAttribution | null
  /** 点开之前的钩子：首页推荐流用它记「这张卡被点开过」（快速划过的判定要求「未点开」） */
  onOpen?: () => void
  /**
   * 页面按本机隐藏名单判定的「这件已经不想看了」。卡片自己也记一份（长按那一刻 + 进页兜底），
   * 但**跨页**这件事只有页面做得到：在详情页隐藏了 B、返回首页时首页那份名单已经变了，
   * 卡片只靠自己 mount 时读一次的话，B 会一直留在首页。页面把判定传下来，卡片就地不渲染。
   */
  hidden?: boolean
  /**
   * 「不感兴趣」的页面钩子。卡片自己已经做完通用那几步（发 HIDE、记本地隐藏名单、把自己从
   * 这一屏摘掉），这里只留给**页面才知道**的事 —— 首页要结算曝光计时、把这条 id 记进页面
   * 那份名单（计数 / 空态 / 同类推荐区块的显隐读的都是它）。不传即无事。
   */
  onDislike?: () => void
}

export default function ProductCard({
  listing,
  seller,
  imageHeight,
  attribution = null,
  onOpen,
  hidden = false,
  onDislike,
}: ProductCardProps) {
  const verified = seller?.authStatus === 'VERIFIED'
  const price = formatAmount(listing.priceCents)

  /**
   * 长按「不感兴趣」那一刻自己记下的隐藏态；`hidden` 那份来自页面，两处任一为真就整张不渲染。
   *
   * 为什么两处都要：页面那份管跨页同步（详情页隐藏的、回到首页也要消失），这一份管
   * 「没有页面级名单的调用方」与「长按当场」——进页时的兜底也读它，所以两者都不算多余。
   */
  const [ownHidden, setOwnHidden] = useState(() => readHiddenListingIds().includes(listing.id))
  const [faved, setFaved] = useState(() => isListingFaved(listing.id))

  /**
   * 长按之后微信仍会补一次 tap：不拦住的话菜单刚关，人就跳进详情页了。
   *
   * 用「吃掉紧随长按的那一次 tap」而不是时间窗：长按到松手的间隔是用户自己决定的，
   * 时间窗挡不住（长按 5 秒再松手，时间窗早过了）。
   */
  const swallowNextTapRef = useRef(false)

  const handleOpen = () => {
    if (swallowNextTapRef.current) {
      swallowNextTapRef.current = false
      return
    }
    onOpen?.()
    void Taro.navigateTo({ url: buildListingDetailUrl(listing.id, attribution) })
  }

  /**
   * 收藏 / 取消收藏。
   *
   * 先写本机名单，**按落盘结果**回报：`setListingFavorite` 返回的是写完重读的真实状态，
   * 存储写失败时它与点击前一样 —— 那种情况下如实说「没保存成功」，不把没存上的说成存上了，
   * 也不发一条与事实不符的 FAVORITE / UNFAVORITE。名单是「这台设备认不认这个状态」的真值
   * （菜单文案读它），事件是给服务端的原料 —— 收藏没有写端点（见 `features/favorites/local`），
   * `FAVORITE` / `UNFAVORITE` 本来就是客户端上报的两类，所以这里如实报，但**不**说成
   * 「已经存到服务端了」。
   */
  const handleFavorite = () => {
    const next = setListingFavorite(listing.id, !faved)
    if (next === faved) {
      void Taro.showToast({
        title: faved ? '取消收藏没保存成功，请重试' : '收藏没保存成功，请重试',
        icon: 'none',
      })
      return
    }
    setFaved(next)
    trackRecommendationEvent({
      listingId: listing.id,
      eventType: next ? 'FAVORITE' : 'UNFAVORITE',
      attribution,
    })
    void Taro.showToast({
      title: next ? '已收藏到本机（收藏接口未上线）' : '已取消收藏',
      icon: 'none',
    })
  }

  /**
   * 不感兴趣：发 HIDE、记进本地隐藏名单、把这张卡从屏幕上摘掉。
   *
   * R1 **没有**服务端隐藏接口（见 `recommendation/hidden`），所以这三步都在本地完成、
   * 立刻生效 —— 也就不会出现「点了没反应」这种最容易被读成坏了的状态。HIDE 是行为信号：
   * 来自推荐流就带上归因，搜索 / 相似推荐没有归因也照发（与 web-pc 卡片同口径）。
   */
  const handleDislike = () => {
    trackRecommendationEvent({ listingId: listing.id, eventType: 'HIDE', attribution })
    hideListing(listing.id)
    setOwnHidden(true)
    onDislike?.()
  }

  /**
   * 长按 → 原生菜单。**没有「调用方不传回调就不弹」这条分支**：菜单是卡片自己的能力，
   * 三处复用它的页面因此一致（原生 ActionSheet 够用，不自绘面板）。
   */
  const handleLongPress = async () => {
    // 先合上「吃掉下一次 tap」的开关：菜单弹出与关闭之间隔着好几帧，事后再设就晚了
    swallowNextTapRef.current = true

    let tapIndex: number
    try {
      const result = await Taro.showActionSheet({
        itemList: [faved ? '取消收藏' : '收藏', '不感兴趣'],
      })
      tapIndex = result.tapIndex
    } catch {
      // 用户点了取消 / 蒙层：`showActionSheet` 以 reject 收场，这不是错误
      return
    }

    if (tapIndex === MENU_FAVORITE) handleFavorite()
    else if (tapIndex === MENU_DISLIKE) handleDislike()
  }

  // 已隐藏的卡片整张不渲染（hooks 全部在上面，条件分支之后没有 hooks）
  if (hidden || ownHidden) return null

  return (
    <View
      className="pcard"
      /*
        曝光观察器靠这两个属性把回调对回具体商品：`data-listing-id` 走 dataset，
        `id` 走回调的 `id` 字段。两条都写是因为宿主对 observeAll 回调的填充不完全一致，
        哪条先被认出来都能用（见 `features/recommendation/use-impressions.ts`）。
      */
      id={`pcard-${listing.id}`}
      data-listing-id={listing.id}
      onClick={handleOpen}
      onLongPress={() => void handleLongPress()}
    >
      <View className="pcard__ph" style={{ height: `${imageHeight}rpx` }}>
        <Image className="pcard__img" src={listing.coverUrl} mode="aspectFill" />
        {listing.badge ? <Text className="pcard__badge">{listing.badge}</Text> : null}
      </View>

      <View className="pcard__body">
        <View className="pcard__title">
          <Text className="pcard__cond">{conditionLabel(listing.condition)}</Text>
          <Text className="pcard__title-text">{listing.title}</Text>
        </View>

        <View className="pcard__foot">
          <View className="pcard__price">
            <Text className="pcard__cur">¥</Text>
            <Text className="pcard__amt">{price}</Text>
          </View>
          {/* 契约没有「想要」计数：真实数据下为 null，整块不渲染，不编成 0 */}
          {listing.wants === null ? null : (
            <Text className="pcard__want">{`${listing.wants}人想要`}</Text>
          )}
        </View>

        {/*
          卖家行整行依赖 seller：真实列表卡没有卖家字段，传进来就是 null。
          此时不渲染这一行，而不是显示一个占位名 —— 卡片下方留白比假人诚实。
        */}
        {seller ? (
          <View className="pcard__seller">
            <Image className="pcard__avatar" src={seller.avatarUrl} mode="aspectFill" />
            <Text className="pcard__who">{seller.nickname}</Text>
            {verified ? (
              <Image className="pcard__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  )
}
