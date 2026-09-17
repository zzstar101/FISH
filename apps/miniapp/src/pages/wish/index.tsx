import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import TopBar from '@/components/top-bar'
import {
  categoryLabel,
  featuredWish,
  formatAmount,
  formatYuan,
  getUser,
  hotWishTags,
  type MockListing,
  type MockWish,
  wishFilters,
  wishMatches,
  wishStats,
  wishWall,
} from '@/mock/api'
import './index.scss'

/**
 * 最近心愿行的分类图标。
 *
 * 为什么按分类取图标：mock 的 `MockWish` 没有图标字段（契约里也没有），
 * 设计稿那四个线稿图标（书 / 平板 / 吉他 / 冰箱）在 `@/assets/icons` 里不存在，
 * 而 DESIGN.md 禁止手画 SVG。这里复用首页那套分类线稿（同一份设计稿生成，
 * 视觉语言一致），既不内联假数据，也不引入新资源。
 */
const WISH_CATEGORY_ICON: Record<MockWish['category'], string> = HOME_CATEGORY_ICONS

/** 预算区间文案：设计稿是「¥30–50」（中间用 en dash，不是 hyphen） */
function budgetRange(minCents: number, maxCents: number): string {
  return `¥${formatAmount(minCents)}–${formatAmount(maxCents)}`
}

/**
 * 校园文案：`MockWish.campus` 只有「肇庆 / 广州」，显示成「肇庆校区」。
 *
 * `campus` 可为 `null`（契约 `MeSchema.campus` 是 nullable，见 `mock/types.ts` 的
 * `MockUser`）—— 缺校区时返回空串，让调用方那一格自然为空，
 * 而不是拼出「null校区」。
 */
function campusText(campus: MockWish['campus'] | null): string {
  return campus ? `${campus}校区` : ''
}

/** 匹配到的商品：卖家昵称 + 校区 + 可取货说明（拼设计稿那一行副标题） */
function matchSubtitle(listing: MockListing): string {
  const seller = getUser(listing.sellerId)
  const note = seller.campus === '肇庆' ? '可当面试书' : '可代取'
  return `${seller.nickname} · ${campusText(seller.campus)} · ${note}`
}

export default function Wish() {
  const [filter, setFilter] = useState<string>(wishFilters[0])
  const [ready, setReady] = useState(false)

  useLoad(() => {
    // 数据是本地 mock（同步），这里保留 loading 位是为了将来换成真接口时页面结构不用改
    setReady(true)
  })

  const featured = featuredWish()
  const matches = wishMatches(featured.id)
  const list = useMemo(() => wishWall(filter), [filter])
  const stats = wishStats

  return (
    <View className="wish">
      <View className="wish__topbg" />

      {/*
        固定顶栏：一级标题「许愿墙」钉在顶部，右侧是发布钮。
        设计稿里「墙」走品牌色（`.navtitle em{color:var(--accent)}`），由 `titleEm` 表达。
        稿里那一行还有 20pt 副标题，但副标题在真机上会被顶栏行高挤掉，且不属于顶栏语义，
        所以放在下方内容区（见下方 `wish__lead`）。
      */}
      <TopBar
        variant="plain"
        spacer
        title="许愿"
        titleEm="墙"
        actions={
          <View
            className="wish__newbtn"
            onClick={() => void Taro.showToast({ title: '发布心愿待接入', icon: 'none' })}
          >
            <Image className="wish__newbtn-img" src={ICONS.plusInk} mode="aspectFit" />
          </View>
        }
      />

      {/* 热门排行：设计稿许愿墙顶部的榜单，数据用 hotWishTags（12 条递降） */}
      <View className="hotrank">
        <View className="hotrank__hd">
          <Text className="hotrank__title">热门排行</Text>
          <Text className="hotrank__note">近 24 小时 · 按热度</Text>
        </View>
        <View className="hotrank__grid">
          {hotWishTags.slice(0, 8).map((tag, index) => (
            <View key={tag.label} className="hotrank__row">
              <Text className={`hotrank__no num${index < 3 ? ' is-top' : ''}`}>
                {String(index + 1).padStart(2, '0')}
              </Text>
              <View className="hotrank__main">
                <Text className="hotrank__kw">{tag.label}</Text>
                <View className="hotrank__bar">
                  <View
                    className="hotrank__bar-fill"
                    // 榜首 100%，其余按比例；分母用榜首值而不是总和，视觉差异才明显
                    style={{
                      width: `${Math.round((tag.count / (hotWishTags[0]?.count ?? 1)) * 100)}%`,
                    }}
                  />
                </View>
              </View>
            </View>
          ))}
        </View>
      </View>

      <ScrollView className="wish__chips" scrollX enableFlex>
        <View className="wish__chips-inner">
          {wishFilters.map((item) => (
            <View
              key={item}
              className={`wish__chip${item === filter ? ' is-on' : ''}`}
              onClick={() => setFilter(item)}
            >
              <Text className="wish__chip-hash">#</Text>
              <Text className="wish__chip-text">{item}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View className="wish__body">
        {/* WISH 吊牌：设计稿全局唯一的手绘母题，白卡 + 顶部渐变条 + 圆孔 + 星形线稿 + 波浪底 */}
        <View className="tagcard">
          <View className="tagcard__bar" />
          <Image className="tagcard__star" src={ICONS.starLine} mode="aspectFit" />
          <View className="tagcard__hole" />
          <Text className="tagcard__wish">想要一本《{featured.keyword}》</Text>
          {featured.description ? (
            <Text className="tagcard__desc">{featured.description}</Text>
          ) : null}
          <View className="tagcard__meta">
            <View className="tagcard__budget">
              <Text className="tagcard__budget-key">预算</Text>
              <Text className="tagcard__budget-val">
                {budgetRange(featured.budgetMinCents, featured.budgetMaxCents)}
              </Text>
            </View>
            <View className="tagcard__cnt">
              <Text>已匹配</Text>
              <Text className="tagcard__cnt-num">{featured.matchCount}</Text>
              <Text>位同学</Text>
            </View>
          </View>
          {/* 设计稿这里是手绘波浪；小程序侧不引 SVG，用一条柔和渐变带 + 白椭圆咬出波峰近似 */}
          <View className="tagcard__wave">
            <View className="tagcard__wave-dip" />
            <Text className="tagcard__wave-word">WISH</Text>
          </View>
        </View>

        <View className="bento">
          <View className="bcard bcard--dark">
            <Text className="bcard__k">命中提醒</Text>
            <Text className="bcard__v num">{featured.matchCount}</Text>
            <Text className="bcard__s">位同校同学愿意接这单</Text>
          </View>
          <View className="bcard bcard--tint">
            <Text className="bcard__k">累计成真</Text>
            <Text className="bcard__v num">{stats.fulfilledTotal}</Text>
            <Text className="bcard__s">条心愿在鱼小应达成</Text>
          </View>
        </View>

        <View className="wish__sec">
          <Text className="wish__sec-title">愿望成真</Text>
          <Text className="wish__sec-note">异步匹配 · 命中即通知</Text>
        </View>

        <View>
          {matches.map(({ match, listing }) => (
            <View key={match.id} className="mcard">
              <View className="mcard__thumb">
                <Image className="mcard__img" src={listing.coverUrl} mode="aspectFill" />
              </View>
              <View className="mcard__main">
                <Text className="mcard__name">{listing.title}</Text>
                <Text className="mcard__sub">{matchSubtitle(listing)}</Text>
              </View>
              <View className="mcard__right">
                <Text className="mcard__price">{formatYuan(listing.priceCents)}</Text>
                <Text className="mcard__score">匹配度 {match.score}</Text>
              </View>
            </View>
          ))}
        </View>

        <View className="wish__sec">
          <Text className="wish__sec-title">最近的心愿</Text>
          <Text className="wish__sec-note">共 {stats.activeTotal} 条 · 按热度</Text>
        </View>

        <View>
          {ready && list.length === 0 ? (
            <View className="wish__empty">
              <Text className="wish__empty-text">这个筛选下还没有心愿</Text>
            </View>
          ) : null}
          {list.map((wish) => (
            <View key={wish.id} className="wishrow">
              <View className="wishrow__mk">
                <Image
                  className="wishrow__mk-img"
                  src={WISH_CATEGORY_ICON[wish.category]}
                  mode="aspectFit"
                />
              </View>
              <View className="wishrow__main">
                <Text className="wishrow__title">{wish.keyword}</Text>
                <View className="wishrow__meta">
                  <Text>{categoryLabel(wish.category)}</Text>
                  <View className="wishrow__dot" />
                  <Text>{wish.timeLabel}</Text>
                  {/* 校区契约里可为 null：连分隔点一起不渲染，避免留下一个孤零零的「·」 */}
                  {wish.campus ? (
                    <>
                      <View className="wishrow__dot" />
                      <Text>{campusText(wish.campus)}</Text>
                    </>
                  ) : null}
                </View>
              </View>
              <View className="wishrow__right">
                <Text className="wishrow__budget">
                  {budgetRange(wish.budgetMinCents, wish.budgetMaxCents)}
                </Text>
                <Text className={`wishrow__st${wish.matchCount > 0 ? ' is-hit' : ''}`}>
                  {wish.matchCount > 0 ? `${wish.matchCount} 个匹配` : '等待匹配'}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}
