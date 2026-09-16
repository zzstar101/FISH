import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import {
  fetchMyListings,
  formatAmount,
  type MockMyListing,
  type MyListingStatusKey,
  myListingStats,
} from '@/mock/api'
import './index.scss'

/**
 * C4 我的发布（设计稿 `设计稿_C4-mylist.html`）。
 *
 * 状态分段（在售 / 已预订 / 已售出 / 已下架，计数来自 `myListingStats()`）
 * → 商品行（缩略图 + 标题 + 价格 + 浏览/想要 + 状态胶囊）→ 行尾动作 → 悬浮「+ 发布」。
 *
 * **锁定规则（稿子第 02 帧的验收要点）**：`RESERVED`（已预订）在成交或买家取消前、
 * `SOLD`（已售出）成交后，都**不可编辑**——锁定态来自 fixture 的 `editable`，
 * 不由页面按 statusKey 自己推，避免两处判断漂移。
 * 禁用不是 `disabled` 属性（小程序不支持，也不会保留热区）：仍然渲染成可点元素，
 * 但点击只弹一行说明，视觉上是置灰底 + 灰字，热区高度仍是 44pt 以上。
 *
 * **下架要二次确认**（稿子第 03 帧）：遮罩 + 居中确认卡（含商品摘要 + 可恢复提示），
 * 而不是吸底 sheet —— 稿子画的就是居中卡。确认按钮有「默认可点 / 下架中 / 失败重试」三态。
 *
 * **与后端的边界**：`GET /listings?sellerId=&status=` + `POST /listings/:id/offline|online`
 * 都可接，但本页数据仍走 mock；下架/上架只做本地状态变更 + toast，不假装调了后端。
 */

/** 分段顺序与稿子一致；`count` 从 `myListingStats()` 取 */
const SEGMENTS: { key: MyListingStatusKey; label: string }[] = [
  { key: 'sale', label: '在售' },
  { key: 'reserved', label: '已预订' },
  { key: 'sold', label: '已售出' },
  { key: 'off', label: '已下架' },
]

/** 状态胶囊配色（在售浅蓝 / 已预订 warn / 已售出灰 / 已下架描边） */
const PILL_CLASS: Record<MyListingStatusKey, string> = {
  sale: 'is-sale',
  reserved: 'is-reserved',
  sold: 'is-sold',
  off: 'is-off',
}

/** 提交中的三态（稿子第 04 帧的对照卡） */
type SubmitState = 'idle' | 'busy' | 'failed'

export default function MyList() {
  const [items, setItems] = useState<MockMyListing[]>([])
  const [loading, setLoading] = useState(true)
  const [segment, setSegment] = useState<MyListingStatusKey>('sale')
  /** 下架确认弹层：null = 关闭；否则是被操作的那一行 */
  const [confirming, setConfirming] = useState<MockMyListing | null>(null)
  const [submit, setSubmit] = useState<SubmitState>('idle')

  const stats = myListingStats()

  useLoad(() => {
    void (async () => {
      setItems(await fetchMyListings())
      setLoading(false)
    })()
  })

  const shown = items.filter((item) => item.statusKey === segment)

  const countOf = (key: MyListingStatusKey): number => stats[key]

  /** 切分段：关掉可能开着的确认弹层，避免弹层停在错的商品上 */
  const pickSegment = (key: MyListingStatusKey) => {
    setSegment(key)
    setConfirming(null)
    setSubmit('idle')
  }

  const openListing = (item: MockMyListing) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.listing.id}` })
  }

  /** 编辑：锁定态只给说明，不跳转（这是本页最容易被做错的一处） */
  const edit = (item: MockMyListing) => {
    if (!item.editable) {
      void Taro.showToast({
        title:
          item.statusKey === 'reserved'
            ? '已预订：成交或取消前不能改价改文案'
            : '已售出：成交后编辑永久禁用',
        icon: 'none',
      })
      return
    }
    void Taro.navigateTo({ url: `/pages/sell/index?id=${item.listing.id}` })
  }

  /** 下架 / 上架：下架要二次确认，上架是低风险操作，直接执行 */
  const toggleOffline = (item: MockMyListing) => {
    if (item.statusKey === 'sale') {
      setConfirming(item)
      setSubmit('idle')
      return
    }
    applyOnline(item)
  }

  const applyOnline = (item: MockMyListing) => {
    setItems((prev) =>
      prev.map((row) =>
        row.listing.id === item.listing.id
          ? { ...row, statusKey: 'sale', statusLabel: '在售', editable: true }
          : row,
      ),
    )
    setSegment('sale')
    void Taro.showToast({ title: '已重新上架（接口待接入）', icon: 'none' })
  }

  const confirmOffline = () => {
    if (!confirming || submit === 'busy') return
    setSubmit('busy')
    // 真实实现：POST /listings/:id/offline，失败时把状态置回 idle 并给「重试」
    setTimeout(() => {
      const target = confirming
      setItems((prev) =>
        prev.map((row) =>
          row.listing.id === target.listing.id
            ? { ...row, statusKey: 'off', statusLabel: '已下架', editable: true }
            : row,
        ),
      )
      setSubmit('idle')
      setConfirming(null)
      setSegment('off')
      void Taro.showToast({ title: '已下架（接口待接入）', icon: 'none' })
    }, 700)
  }

  /** 「N 人想要」进想要的人页，带上是哪件商品（C5 的入口就在这里） */
  const openWatchers = (item: MockMyListing) => {
    void Taro.navigateTo({
      url: `/pages/watchers/index?listingId=${item.listing.id}&title=${encodeURIComponent(
        item.listing.title,
      )}`,
    })
  }

  const openConversations = () => {
    void Taro.switchTab({ url: '/pages/chat/index' })
  }

  const goPublish = () => {
    void Taro.switchTab({ url: '/pages/sell/index' })
  }

  /** 页头副标题：稿子第 01 帧是总计，第 02/03 帧换成当前分段说明 */
  const headSub =
    segment === 'sale'
      ? `全部 ${stats.all} 件 · 在售 ${stats.sale} · 已预订 ${stats.reserved} · 已售出 ${stats.sold} · 已下架 ${stats.off}`
      : segment === 'reserved'
        ? '已预订的商品在成交或取消前不能改价改文案'
        : `${SEGMENTS.find((seg) => seg.key === segment)?.label} · ${stats[segment]} 件`

  return (
    <View className="ml">
      <View className="ml__bg" />

      <NavBar />

      <View className="ml__head">
        <Text className="ml__title">我的发布</Text>
        <Text className="ml__sub num">{headSub}</Text>

        <View className="ml__seg">
          {SEGMENTS.map((seg) => (
            <View
              key={seg.key}
              className={`ml__seg-item${seg.key === segment ? ' is-on' : ''}`}
              onClick={() => pickSegment(seg.key)}
            >
              <Text>{seg.label}</Text>
              <Text className="ml__seg-n num">{countOf(seg.key)}</Text>
            </View>
          ))}
        </View>
      </View>

      <View className="ml__body">
        {loading ? (
          [0, 1, 2].map((i) => (
            <View key={`sk-${i}`} className="ml__skel">
              <View className="ml__skel-sq" />
              <View className="ml__skel-col">
                <View className="ml__skel-bar" style={{ width: '82%' }} />
                <View className="ml__skel-bar ml__skel-bar--price" style={{ width: '30%' }} />
                <View className="ml__skel-bar ml__skel-bar--meta" style={{ width: '52%' }} />
              </View>
            </View>
          ))
        ) : shown.length === 0 ? (
          <View className="ml__empty">
            <View className="ml__empty-disc">
              <Image className="ml__empty-ic" src={ICONS.box} mode="aspectFit" />
            </View>
            <Text className="ml__empty-title">这个状态下还没有东西</Text>
            <Text className="ml__empty-text">
              {segment === 'off'
                ? '被下架的商品会出现在这里，可随时重新上架'
                : '换个状态看看，或者发布一件新的闲置'}
            </Text>
            <View
              className="ml__empty-act"
              onClick={() => (segment === 'sale' ? goPublish() : pickSegment('sale'))}
            >
              <Text>{segment === 'sale' ? '去发布' : '回「在售」看看'}</Text>
            </View>
          </View>
        ) : (
          <View className="ml__list">
            {shown.map((item) => (
              <View key={item.listing.id} className="ml__item">
                <View className="ml__row">
                  <View className="ml__thumb" onClick={() => openListing(item)}>
                    <Image
                      className="ml__thumb-img"
                      src={item.listing.coverUrl}
                      mode="aspectFill"
                    />
                  </View>

                  <View className="ml__main">
                    <View className="ml__rtop">
                      <Text className="ml__rtitle" onClick={() => openListing(item)}>
                        {item.listing.title}
                      </Text>
                      <Text className={`ml__pill ${PILL_CLASS[item.statusKey]}`}>
                        {item.statusLabel}
                      </Text>
                    </View>

                    <View className="ml__price">
                      <Text className="ml__price-amt num">
                        ¥{formatAmount(item.listing.priceCents)}
                      </Text>
                    </View>

                    <View className="ml__rstats">
                      <Text className="ml__rstat num">{`浏览 ${item.listing.views}`}</Text>
                      <View className="ml__dot" />
                      {/* 「N 人想要」是 C5 的入口，这行本身就是唯一的跳转点 */}
                      <Text className="ml__rstat ml__rstat--want num" onClick={() => openWatchers(item)}>
                        {`想要 ${item.wants}`}
                      </Text>
                    </View>
                  </View>
                </View>

                <View className="ml__acts">
                  {item.editable ? null : (
                    <View className="ml__locks">
                      <View className="ml__lock-ic" />
                      <Text>
                        {item.statusKey === 'reserved'
                          ? '成交前锁定 · 不可编辑'
                          : '已成交 · 编辑永久禁用'}
                      </Text>
                    </View>
                  )}

                  <View
                    className={`ml__act${item.editable ? '' : ' is-locked'}`}
                    onClick={() => edit(item)}
                  >
                    <Text>编辑</Text>
                  </View>

                  {item.statusKey === 'reserved' || item.statusKey === 'sold' ? (
                    <View className="ml__act" onClick={openConversations}>
                      <Text>查看会话</Text>
                    </View>
                  ) : item.statusKey === 'off' ? (
                    <View className="ml__act ml__act--primary" onClick={() => applyOnline(item)}>
                      <Text>上架</Text>
                    </View>
                  ) : (
                    <View
                      className="ml__act ml__act--danger"
                      onClick={() => toggleOffline(item)}
                    >
                      <Text>下架</Text>
                    </View>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      <View className="ml__fab" onClick={goPublish}>
        <Image className="ml__fab-ic" src={ICONS.plusLine} mode="aspectFit" />
        <Text>发布</Text>
      </View>

      {/* ---------------- 下架二次确认（居中卡，稿子第 03 帧） ---------------- */}
      {confirming ? (
        <>
          <View className="ml__scrim" onClick={() => setConfirming(null)} />
          <View className="ml__dialog">
            <Text className="ml__dialog-title">确认下架这件商品？</Text>
            <Text className="ml__dialog-sub">
              下架后买家在首页与搜索里都看不到它，已有的会话不受影响。
            </Text>

            <View className="ml__dlg-item">
              <View className="ml__dlg-thumb">
                <Image
                  className="ml__dlg-thumb-img"
                  src={confirming.listing.coverUrl}
                  mode="aspectFill"
                />
              </View>
              <View className="ml__dlg-main">
                <Text className="ml__dlg-title">{confirming.listing.title}</Text>
                <Text className="ml__dlg-price num">
                  ¥{formatAmount(confirming.listing.priceCents)}
                </Text>
              </View>
            </View>

            <View className="ml__dlg-tip">
              <Text>
                下架是可恢复操作：之后在「已下架」里点「重新上架」即可回到在售，浏览 /
                想要数会保留。
              </Text>
            </View>

            <View className="ml__dlg-acts">
              <View
                className="ml__dlg-cancel"
                onClick={() => {
                  setConfirming(null)
                  setSubmit('idle')
                }}
              >
                <Text>取消</Text>
              </View>
              <View
                className={`ml__dlg-ok${submit === 'busy' ? ' is-busy' : ''}${
                  submit === 'failed' ? ' is-failed' : ''
                }`}
                onClick={confirmOffline}
              >
                {submit === 'busy' ? <View className="ml__spin" /> : null}
                <Text>{submit === 'busy' ? '下架中' : submit === 'failed' ? '重试' : '确认下架'}</Text>
              </View>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
