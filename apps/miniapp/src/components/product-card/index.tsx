/**
 * 商品卡（首页 / 搜索 / 相似推荐共用）。
 *
 * 两个变体：
 * - `home`：设计稿首页的瀑布流卡 —— 成色印章压在标题前、价格走品牌蓝、右下「N人想要」；
 * - `search`：设计稿搜索结果的卡 —— 左上角角标、价格走深色、成色是描边胶囊、右下校区。
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
  seller: MockUser
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
  const verified = seller.authStatus === 'VERIFIED'
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
            <Text className="pcard__want">{`${listing.wants}人想要`}</Text>
          ) : (
            <Text className="pcard__cond-pill">{conditionLabel(listing.condition)}</Text>
          )}
        </View>

        <View className="pcard__seller">
          <Image className="pcard__avatar" src={seller.avatarUrl} mode="aspectFill" />
          <Text className="pcard__who">{seller.nickname}</Text>
          {verified ? (
            <Image className="pcard__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
          ) : null}
          {variant === 'home' ? (
            verified ? (
              <Text className="pcard__credit">校园认证</Text>
            ) : null
          ) : (
            <Text className="pcard__loc">{seller.campus}</Text>
          )}
        </View>
      </View>
    </View>
  )
}
