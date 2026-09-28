/**
 * 商品卡（首页 / 搜索 / 相似推荐共用，同一套版式）。
 *
 * 版式以 1改 稿首页瀑布流卡为准：成色印章压在标题前、价格走 --danger 红、
 * 右下「N人想要」（契约无此计数时不渲染）。历史上曾有 `search` 变体
 * （价格深色、成色胶囊挪到价格同位），Owner 2026-09-28 拍板全部统一为首页版式，变体已收掉。
 */
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { ICONS } from '@/assets/lib-icons'
import { conditionLabel, formatAmount } from '@/mock/api'
import type { MockListing, MockUser } from '@/mock/types'
import './index.scss'

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
}

export default function ProductCard({ listing, seller, imageHeight }: ProductCardProps) {
  const verified = seller?.authStatus === 'VERIFIED'
  const price = formatAmount(listing.priceCents)

  const open = () => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
  }

  return (
    <View className="pcard" onClick={open}>
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
