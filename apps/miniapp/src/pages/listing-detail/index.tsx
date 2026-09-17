/**
 * 商品详情页（设计稿：`listing.html`，冰蓝荧光版）。
 *
 * 区块顺序与设计稿一一对应：
 *   漂浮导航（返回/分享/更多）→ 图集轮播（378pt，右下圆点）→ 价格区 → 描述段
 *   → 卖家卡 → 留言区（默认 2 条，可展开）→ 同校相似闲置（两列瀑布流）→ 底部操作栏
 *
 * 数据走 `@/features/fetchers`（先试真实接口，不可用时内部回退 mock）；尺寸 = 设计稿 pt × 2
 * （见 apps/miniapp/DESIGN.md）。
 */
import { Image, Swiper, SwiperItem, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'

import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import NavBar from '@/components/nav-bar'
import ProductCard from '@/components/product-card'
import { loadListingDetail } from '@/features/fetchers'
import { conditionLabel, formatAmount, type ListingDetailView, type MockListing } from '@/mock/api'
import { findUser } from '@/mock/users'
import './index.scss'

/** 拿不到 id 时的回退商品 */
const FALLBACK_ID = 'l-001'

/** 默认露出的留言条数（设计稿的 LIMIT = 2） */
const COMMENT_LIMIT = 2

/** 瀑布流列宽：750 - 左右各 40 - 列间距 24，再除以 2 */
const COLUMN_WIDTH = 343

/** 设计稿 `.mini` 的错落比例 → 图片区高度（rpx） */
const RATIO_HEIGHT: Record<MockListing['ratio'], number> = {
  '1x1': COLUMN_WIDTH,
  '4x5': Math.round((COLUMN_WIDTH * 5) / 4),
  '5x6': Math.round((COLUMN_WIDTH * 6) / 5),
  '3x4': Math.round((COLUMN_WIDTH * 4) / 3),
  '4x3': Math.round((COLUMN_WIDTH * 3) / 4),
}

/** 「2 小时前发布」——mock 只给相对小时数 */
function postedLabel(hoursAgo: number): string {
  if (hoursAgo < 1) return '刚刚发布'
  if (hoursAgo < 24) return `${Math.round(hoursAgo)} 小时前发布`
  const days = Math.round(hoursAgo / 24)
  return days <= 1 ? '昨天发布' : `${days} 天前发布`
}

/** 设计稿的描述是两段；mock 只有一段时按第一个句末标点断成两行 */
function descriptionLines(description: string): string[] {
  const trimmed = description.trim()
  if (!trimmed) return []
  const explicit = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (explicit.length > 1) return explicit
  const cut = trimmed.search(/。(?![\d])/)
  if (cut < 0 || cut >= trimmed.length - 1) return [trimmed]
  return [trimmed.slice(0, cut + 1), trimmed.slice(cut + 1)]
}

function splitColumns(items: MockListing[]): [MockListing[], MockListing[]] {
  const left: MockListing[] = []
  const right: MockListing[] = []
  items.forEach((item, index) => {
    if (index % 2 === 0) left.push(item)
    else right.push(item)
  })
  return [left, right]
}

export default function ListingDetail() {
  const router = useRouter()
  const id = router.params.id ?? FALLBACK_ID

  const [data, setData] = useState<ListingDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  /** 真实接口失败且没有回退 mock（生产口径）：走错误态，**不能**停在骨架屏上 */
  const [failed, setFailed] = useState(false)
  const [slide, setSlide] = useState(0)
  const [faved, setFaved] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)

  const load = () => {
    setLoading(true)
    // 三态分明：`ok` 渲染详情、`notFound` 走空态（商品真不存在）、
    // `failed` 走错误态 —— 生产口径不退回 mock，拿演示商品顶上比空态更误导
    void loadListingDetail(id).then((result) => {
      setData(result.status === 'ok' ? result.view : null)
      setFailed(result.status === 'failed')
      setLoading(false)
    })
  }

  useLoad(() => {
    load()
  })

  const [leftSimilar, rightSimilar] = useMemo(() => splitColumns(data?.similar ?? []), [data])

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const listing = data?.listing
  const images = listing?.images ?? []
  const comments = data?.comments ?? []
  const visibleComments = commentsOpen ? comments : comments.slice(0, COMMENT_LIMIT)
  const paragraphs = listing ? descriptionLines(listing.description) : []

  return (
    <View className="detail">
      <NavBar
        actions={
          <>
            <View className="detail__glassbtn" onClick={() => toast('分享能力待接入')}>
              <Image className="detail__glassbtn-img" src={ICONS.share} mode="aspectFit" />
            </View>
            <View className="detail__glassbtn" onClick={() => toast('更多操作待接入')}>
              <Image className="detail__glassbtn-img" src={ICONS.moreInk} mode="aspectFit" />
            </View>
          </>
        }
      />

      {failed ? (
        /* 真接口失败：明确错误态 + 重试。不能落到下面的骨架屏分支（`!data` 会一直为真 → 永久骨架屏） */
        <View className="detail__emptypad">
          <LoadError
            title="加载失败"
            text="没能取到这件商品。检查网络或后端地址后重试"
            onRetry={load}
          />
        </View>
      ) : loading || !data ? (
        <View className="detail__skeleton">
          <View className="detail__sk-gallery" />
          <View className="detail__sk-line detail__sk-line--lg" />
          <View className="detail__sk-line" />
          <View className="detail__sk-line detail__sk-line--sm" />
          <View className="detail__sk-block" />
        </View>
      ) : !listing ? (
        /* 商品不存在 / 已下架：不留无限骨架屏，也不拿 mock 商品顶替 */
        <View className="detail__emptypad">
          <EmptyState
            title="商品不存在或已下架"
            text="这件闲置可能已被卖家删除或下架了，去看看别的吧"
          />
        </View>
      ) : (
        <View className="detail__sections">
          {/* ---------------------------------------------------- 图集 */}
          <View className="detail__gallery">
            {images.length > 0 ? (
              <Swiper
                className="detail__swiper"
                circular
                current={slide}
                onChange={(event) => setSlide(event.detail.current)}
              >
                {images.map((url) => (
                  <SwiperItem key={url} className="detail__slide">
                    <Image className="detail__slide-img" src={url} mode="aspectFill" />
                  </SwiperItem>
                ))}
              </Swiper>
            ) : (
              <View className="detail__slide-ph">
                <Text className="detail__slide-ph-text">暂无商品图</Text>
              </View>
            )}

            <View className="detail__dots">
              {images.map((url, index) => (
                <View
                  key={url}
                  className={`detail__dot${index === slide ? ' is-on' : ''}`}
                  onClick={() => setSlide(index)}
                />
              ))}
            </View>
          </View>

          {/* ---------------------------------------------------- 价格 / 标题 */}
          <View className="detail__meta">
            <View className="detail__priceline">
              <View className="detail__price">
                <Text className="detail__price-cur">¥</Text>
                <Text className="detail__price-amt">{formatAmount(listing.priceCents)}</Text>
              </View>
              {listing.originalPriceCents ? (
                <Text className="detail__was">
                  {`原价 ¥${formatAmount(listing.originalPriceCents)}`}
                </Text>
              ) : null}
              <Text className="detail__cond">{conditionLabel(listing.condition)}</Text>
            </View>

            <Text className="detail__title">{listing.title}</Text>
            <Text className="detail__spec">{listing.spec}</Text>

            <View className="detail__stats">
              <Text className="detail__posted">{postedLabel(listing.createdHoursAgo)}</Text>
              <View className="detail__metrics">
                {/* 浏览量 / 想要数都不在契约里：真实数据下为 null，该指标整块不画，不显示 0 */}
                {listing.views === null ? null : (
                  <Text className="detail__metric">
                    <Text className="detail__metric-num">{listing.views}</Text>
                    <Text> 浏览</Text>
                  </Text>
                )}
                {listing.wants === null ? null : (
                  <Text className="detail__metric">
                    <Text className="detail__metric-num">{listing.wants}</Text>
                    <Text> 想要</Text>
                  </Text>
                )}
              </View>
            </View>
          </View>

          {/* ---------------------------------------------------- 描述 */}
          <View className="detail__desc">
            {paragraphs.map((line) => (
              <Text key={line} className="detail__para">
                {line}
              </Text>
            ))}
          </View>

          {/* ---------------------------------------------------- 卖家 */}
          <View className="detail__seller-section">
            <View className="detail__seller">
              <Image className="detail__avatar" src={data.seller.avatarUrl} mode="aspectFill" />
              <View className="detail__sinfo">
                <View className="detail__sname">
                  <Text className="detail__snick">{data.seller.nickname}</Text>
                  {data.seller.authStatus === 'VERIFIED' ? (
                    <Image className="detail__stick" src={ICONS.checkMuted} mode="aspectFit" />
                  ) : null}
                  {/* 校区契约里可为 null：缺了就不渲染这一格，不拼「null校区」 */}
                  {data.seller.campus ? (
                    <Text className="detail__sloc">{`${data.seller.campus}校区`}</Text>
                  ) : null}
                </View>
                {/*
                  卖出件数与好评率契约里没有（见 mock/types.ts 的 MockUser 注释）。
                  真实数据下两者都是 null，此时整行不渲染 —— 不编「卖出 0 件 · 好评率 0%」。
                */}
                {data.seller.soldCount !== null || data.seller.goodRate !== null ? (
                  <View className="detail__ssub">
                    {data.seller.soldCount !== null ? (
                      <Text>{`卖出 ${data.seller.soldCount} 件`}</Text>
                    ) : null}
                    {data.seller.soldCount !== null && data.seller.goodRate !== null ? (
                      <Text>·</Text>
                    ) : null}
                    {data.seller.goodRate !== null ? (
                      <Text>{`好评率 ${data.seller.goodRate}%`}</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View className="detail__go" onClick={() => toast('TA 的主页待接入')}>
                <Text>进TA主页</Text>
              </View>
            </View>
          </View>

          {/* ---------------------------------------------------- 留言 */}
          <View className="detail__comments">
            {comments.length === 0 ? (
              <Text className="detail__cmt-empty">还没有人留言，来问一句吧</Text>
            ) : (
              <>
                <View className="detail__cmts">
                  {visibleComments.map((comment) => (
                    <View key={comment.id} className="detail__cmt">
                      <View className="detail__cav">
                        <Text className="detail__cav-text">{comment.authorInitial}</Text>
                      </View>
                      <View className="detail__cbody">
                        <View className="detail__chd">
                          <Text className="detail__cn">{comment.authorName}</Text>
                          {comment.isSeller ? <Text className="detail__ctag">卖家</Text> : null}
                          <Text className="detail__ct">{comment.timeLabel}</Text>
                        </View>
                        <Text className="detail__cx">{comment.content}</Text>
                      </View>
                    </View>
                  ))}
                </View>

                {comments.length > COMMENT_LIMIT ? (
                  <View
                    className="detail__cmt-more"
                    onClick={() => setCommentsOpen((prev) => !prev)}
                  >
                    <Text className="detail__cmt-more-text">
                      {commentsOpen ? '收起留言' : `查看全部 ${data.commentTotal} 条留言`}
                    </Text>
                    <Image
                      className={`detail__cmt-more-img${commentsOpen ? ' is-open' : ''}`}
                      src={ICONS.chevronDownMuted}
                      mode="aspectFit"
                    />
                  </View>
                ) : null}
              </>
            )}
          </View>

          {/* ---------------------------------------------------- 同校相似闲置 */}
          <View className="detail__similar">
            <View className="detail__seclabel">
              <Image className="detail__seclabel-img" src={ICONS.category} mode="aspectFit" />
              <Text>同校相似闲置</Text>
            </View>

            <View className="detail__waterfall">
              <View className="detail__wf-col">
                {/* 卡片自带点击 → `navigateTo('/pages/listing-detail/index?id=' + id)`，
                    这里不再包一层 onClick，避免同一次点击 push 两次路由 */}
                {leftSimilar.map((item) => (
                  <ProductCard
                    key={item.id}
                    listing={item}
                    /*
                      卖家用**这张卡自己的** sellerId 查，不能用 `data.seller`。
                      `data.seller` 是**当前这件商品**的卖家；相似推荐是别人的商品，
                      把当前卖家挂上去就是给别人的商品捏造了一个卖家。
                      真实数据下 `item.sellerId` 是空串哨兵 → `findUser` 给 null → 整行不渲染；
                      mock 数据下每件相似商品本来就带自己的 sellerId，这里比原来更准确。
                    */
                    seller={findUser(item.sellerId)}
                    variant="search"
                    imageHeight={RATIO_HEIGHT[item.ratio]}
                  />
                ))}
              </View>
              <View className="detail__wf-col">
                {rightSimilar.map((item) => (
                  <ProductCard
                    key={item.id}
                    listing={item}
                    /* 同左列：用卡片自己的 sellerId，不用当前商品的卖家 */
                    seller={findUser(item.sellerId)}
                    variant="search"
                    imageHeight={RATIO_HEIGHT[item.ratio]}
                  />
                ))}
              </View>
            </View>
          </View>
        </View>
      )}

      {/* ---------------------------------------------------- 底部操作栏 */}
      <View className="detail__bar">
        <View
          className={`detail__fav${faved ? ' is-on' : ''}`}
          onClick={() => setFaved((prev) => !prev)}
        >
          <Image
            className="detail__fav-img"
            src={faved ? ICONS.heartOn : ICONS.heartMuted}
            mode="aspectFit"
          />
        </View>
        <View className="detail__btn detail__btn--ghost" onClick={() => toast('聊天待接入')}>
          <Text>聊一聊</Text>
        </View>
        <View className="detail__btn detail__btn--solid" onClick={() => toast('下单待接入')}>
          <Text>我想要</Text>
        </View>
      </View>
    </View>
  )
}
