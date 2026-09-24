/**
 * 商品卡（首页 / 搜索 / 相似推荐共用）。
 *
 * 两个变体：
 * - `home`：设计稿首页的瀑布流卡 —— 成色印章压在标题前、价格走品牌蓝、右下「N人想要」；
 * - `search`：设计稿搜索结果的卡 —— 左上角角标、价格走深色、成色是描边胶囊。
 */
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { ICONS } from '@/assets/lib-icons'
import { conditionLabel, formatAmount } from '@/mock/api'
import type { MockListing, MockUser } from '@/mock/types'
import './index.scss'

export type ProductCardVariant = 'home' | 'search'

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
  variant?: ProductCardVariant
  /** 图片区高度（rpx），由瀑布流按列宽 × 比例算好后传入 */
  imageHeight: number
}

export default function ProductCard({
  listing,
  seller,
  variant = 'home',
  imageHeight,
}: ProductCardProps) {
  const verified = seller?.authStatus === 'VERIFIED'
  const price = formatAmount(listing.priceCents)

  const open = () => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
  }

  return (
    <View className={`pcard pcard--${variant}`} onClick={open}>
      <View className="pcard__ph" style={{ height: `${imageHeight}rpx` }}>
        <Image className="pcard__img" src={listing.coverUrl} mode="aspectFill" />
        {listing.badge ? <Text className="pcard__badge">{listing.badge}</Text> : null}
      </View>

      <View className="pcard__body">
        <View className="pcard__title">
          {variant === 'home' ? (
            <Text className="pcard__cond">{conditionLabel(listing.condition)}</Text>
          ) : null}
          <Text className="pcard__title-text">{listing.title}</Text>
        </View>

        <View className="pcard__foot">
          <View className="pcard__price">
            <Text className="pcard__cur">¥</Text>
            <Text className="pcard__amt">{price}</Text>
          </View>
          {variant === 'home' ? (
            // 契约没有「想要」计数：真实数据下为 null，整块不渲染，不编成 0
            listing.wants === null ? null : (
              <Text className="pcard__want">{`${listing.wants}人想要`}</Text>
            )
          ) : (
            <Text className="pcard__cond-pill">{conditionLabel(listing.condition)}</Text>
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
