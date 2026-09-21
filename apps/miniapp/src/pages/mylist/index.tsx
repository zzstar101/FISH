import type { ListingCard, ListingDetail } from '@fish/contracts/listings/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import LoadError from '@/components/load-error'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { toMockListing } from '@/features/listing/adapt'
import { fetchMyListings, offlineListing, onlineListing } from '@/features/listing/api'
import { requestSellEdit } from '@/features/listing/edit-target'
import { isApiError } from '@/lib/request'
import { formatAmount } from '@/mock/api'
import type { MockListing } from '@/mock/types'
import {
  countBySegment,
  emptyText,
  isEditable,
  lockedHint,
  type MyListSegment,
  SEGMENTS,
  segmentLabel,
  segmentOf,
} from './list'
import './index.scss'

/**
 * C4 我的发布（设计稿 `设计稿_C4-mylist.html`）。**本轮从 mock 改为真实读写**（#89 mylist 行 / #74）。
 *
 * 数据源：`GET /listings?sellerId=自己`（本人查询才包含全部状态，且只有本人视角带
 * `moderationStatus`）。状态分段（在售 / 已预订 / 已售出 / **审核中** / 已下架，计数由本地
 * 按卡片算 —— 服务端 feed 不返回分档计数）。
 *
 * **审核中单列一段**（本轮新增）：`REVIEW` / `BLOCKED` 的商品在库里同样是 `status = OFFLINE`，
 * 只按 status 分档会把「等你改内容」混进「已下架」。分档判定在 `./list.ts`。
 *
 * **锁定规则**：`RESERVED` / `SOLD` 在成交前后不可编辑（与服务端 `LOCKED_LISTING_STATUSES`
 * 同一口径）。审核中**可以**编辑 —— 服务端允许 PATCH 并重新审核，这是改掉被拦内容的唯一路径。
 * 禁用不是 `disabled`（小程序不保留热区）：仍渲染成可点元素，点击只弹一行说明。
 *
 * **下架要二次确认**（稿子第 03 帧）：遮罩 + 居中确认卡，确认按钮有「默认可点 / 下架中 /
 * 失败重试」三态；成功与失败都以服务端响应为准，不本地假装成功。
 *
 * **编辑入口**：出物是 Tab 页，不能带 query 跳转 —— 走 `features/listing/edit-target.ts`
 * 的一次性交接 + `switchTab`。
 *
 * **账号作用域（correctness）**：`cards` / `confirming` / `segment` / `loading` 全都属于
 * 「当前登录用户」。换账号时必须在**渲染期同步**清空，并用加载代次丢弃迟到响应 ——
 * 否则会出现「B 的身份已经渲染、画的却是 A 的商品」，甚至拿着 A 的 listing id 去发下架请求。
 * 详见 `prevUserId` / `loadEpoch` 处的注释。
 */
type SubmitState = 'idle' | 'busy' | 'failed'

/** 一行的渲染视图：契约卡片投影成页面既有的 `MockListing`（`adapt.ts` 负责「不编造字段」） */
type Row = {
  listing: MockListing
  segment: MyListSegment
  statusLabel: string
  editable: boolean
}

/** 状态胶囊配色（在售浅蓝 / 已预订 warn / 已售出灰 / 审核中 warn / 已下架描边） */
const PILL_CLASS: Record<MyListSegment, string> = {
  sale: 'is-sale',
  reserved: 'is-reserved',
  sold: 'is-sold',
  review: 'is-review',
  off: 'is-off',
}

export default function MyList() {
  const authStatus = useAuthGuard()
  const auth = useAuth()
  const userId = auth.user?.id ?? null

  const [cards, setCards] = useState<ListingCard[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [segment, setSegment] = useState<MyListSegment>('sale')
  /** 下架确认弹层：null = 关闭；否则是被操作的那一行 */
  const [confirming, setConfirming] = useState<Row | null>(null)
  const [submit, setSubmit] = useState<SubmitState>('idle')
  /**
   * 每次显示本页 +1，驱动重新拉取。
   *
   * 初值是 `null`（还没显示过）而不是 0：`useDidShow` 会在首次显示时置 1，
   * 这样「已登录时进入本页」只会请求一次，而不是 effect 与 didShow 各拉一遍。
   */
  const [showToken, setShowToken] = useState<number | null>(null)
  /**
   * 本页数据**属于哪个账号**。
   *
   * 渲染期就能拿到上一帧的 `userId`，所以在**同一帧内**把账号作用域状态清干净，
   * 不会出现「B 的身份已经渲染出来了，画的却还是 A 的商品」那一帧。
   * 换成 `useEffect(() => setCards([]), [userId])` 不行：effect 在 commit 之后才跑，
   * 泄漏帧照样存在。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  /** 加载代次：切换账号、重新拉取都会 +1，用来丢弃迟到响应（见下） */
  const loadEpoch = useRef(0)

  if (prevUserId !== userId) {
    setPrevUserId(userId)
    // 旧账号所有在飞的请求立即作废
    loadEpoch.current += 1
    // 账号作用域的界面状态一律重置：卡片、加载态、分段、下架确认弹层
    setCards([])
    setLoading(true)
    setFailed(false)
    setSegment('sale')
    setConfirming(null)
    setSubmit('idle')
  }

  useDidShow(() => {
    setShowToken((token) => (token ?? 0) + 1)
  })

  useEffect(() => {
    if (showToken === null || authStatus !== 'authed' || userId === null) return

    // 本次请求的代次：返回时若已不是最新一次，整批结果（含失败态）全部丢弃
    const epoch = ++loadEpoch.current

    setLoading(true)
    setFailed(false)

    void (async () => {
      try {
        const next = await fetchMyListings(userId)
        if (epoch !== loadEpoch.current) return
        setCards(next)
      } catch {
        if (epoch !== loadEpoch.current) return
        // 失败不能留着上一个账号的卡片：清空并进错误态
        setCards([])
        setFailed(true)
      } finally {
        // 不能写成 `if (…) return`：`noUnsafeFinally`（finally 里的 return 会吞异常）
        if (epoch === loadEpoch.current) setLoading(false)
      }
    })()
  }, [showToken, authStatus, userId])

  const counts = countBySegment(cards)
  const rows: Row[] = cards.map((card) => {
    const key = segmentOf(card)
    return {
      listing: toMockListing(card),
      segment: key,
      statusLabel: segmentLabel(card, key),
      editable: isEditable(key),
    }
  })
  const shown = rows.filter((row) => row.segment === segment)

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

  const reload = () => {
    setShowToken((token) => (token ?? 0) + 1)
  }

  /** 切分段：关掉可能开着的确认弹层，避免弹层停在错的商品上 */
  const pickSegment = (key: MyListSegment) => {
    setSegment(key)
    setConfirming(null)
    setSubmit('idle')
  }

  const openListing = (row: Row) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${row.listing.id}` })
  }

  /**
   * 编辑：锁定态只给说明，不跳转（这是本页最容易被做错的一处）。
   * 未锁定时把 id 交给出物页并切到那个 Tab —— Tab 页不能带 query（见 edit-target 说明）。
   */
  const edit = (row: Row) => {
    if (!row.editable) {
      toast(lockedHint(row.segment))
      return
    }
    requestSellEdit(row.listing.id)
    void Taro.switchTab({ url: '/pages/sell/index' })
  }

  /** 上下架成功后只改这两个字段：其余字段服务器没动，本地不重造整张卡 */
  const applyTransition = (detail: ListingDetail) => {
    setCards((prev) =>
      prev.map((card) =>
        card.id === detail.id
          ? { ...card, status: detail.status, moderationStatus: detail.moderationStatus }
          : card,
      ),
    )
  }

  const errorText = (error: unknown, fallback: string): string =>
    isApiError(error) ? error.message || fallback : fallback

  const confirmOffline = () => {
    if (!confirming || submit === 'busy') return
    const target = confirming
    setSubmit('busy')
    void (async () => {
      try {
        const detail = await offlineListing(target.listing.id)
        applyTransition(detail)
        setSubmit('idle')
        setConfirming(null)
        setSegment('off')
        toast('已下架')
      } catch (error) {
        // 失败就停在弹层里给「重试」，不关弹层、也不本地改状态
        setSubmit('failed')
        toast(errorText(error, '下架失败，请重试'))
      }
    })()
  }

  /** 上架是低风险操作，直接执行；失败（例如审核中）以服务端结论为准 */
  const applyOnline = (row: Row) => {
    void (async () => {
      try {
        const detail = await onlineListing(row.listing.id)
        applyTransition(detail)
        setSegment('sale')
        toast('已重新上架')
      } catch (error) {
        toast(errorText(error, '上架失败，请重试'))
      }
    })()
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
      ? `全部 ${cards.length} 件 · 在售 ${counts.sale} · 已预订 ${counts.reserved} · 已售出 ${counts.sold} · 审核中 ${counts.review} · 已下架 ${counts.off}`
      : segment === 'reserved'
        ? '已预订的商品在成交或取消前不能改价改文案'
        : `${SEGMENTS.find((seg) => seg.key === segment)?.label ?? ''} · ${counts[segment]} 件`

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页写操作必须带会话，不拦的话跳转落地前会先画一帧别人的数据。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />
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
              <Text className="ml__seg-n num">{counts[seg.key]}</Text>
            </View>
          ))}
        </View>
      </View>

      <View className="ml__body">
        {loading && cards.length === 0 ? (
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
        ) : failed && cards.length === 0 ? (
          // 加载失败不是空态：空态会被读成「这个状态下没有商品」
          <LoadError onRetry={reload} text="我的发布加载失败,请重试" />
        ) : shown.length === 0 ? (
          <View className="ml__empty">
            <View className="ml__empty-disc">
              <Image className="ml__empty-ic" src={ICONS.box} mode="aspectFit" />
            </View>
            <Text className="ml__empty-title">这个状态下还没有东西</Text>
            <Text className="ml__empty-text">{emptyText(segment)}</Text>
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
                      <Text className={`ml__pill ${PILL_CLASS[item.segment]}`}>
                        {item.statusLabel}
                      </Text>
                    </View>

                    <View className="ml__price">
                      <Text className="ml__price-amt num">
                        ¥{formatAmount(item.listing.priceCents)}
                      </Text>
                    </View>
                    {/* 契约没有浏览 / 想要计数：不编数字，这一行整体不画 */}
                  </View>
                </View>

                <View className="ml__acts">
                  {item.editable ? null : (
                    <View className="ml__locks">
                      <View className="ml__lock-ic" />
                      <Text>
                        {item.segment === 'reserved'
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

                  {item.segment === 'reserved' || item.segment === 'sold' ? (
                    <View className="ml__act" onClick={openConversations}>
                      <Text>查看会话</Text>
                    </View>
                  ) : item.segment === 'off' ? (
                    <View className="ml__act ml__act--primary" onClick={() => applyOnline(item)}>
                      <Text>上架</Text>
                    </View>
                  ) : item.segment === 'sale' ? (
                    <View className="ml__act ml__act--danger" onClick={() => setConfirming(item)}>
                      <Text>下架</Text>
                    </View>
                  ) : null}
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
                下架是可恢复操作：之后在「已下架」里点「上架」即可回到在售，已有的会话不受影响。
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
                <Text>
                  {submit === 'busy' ? '下架中' : submit === 'failed' ? '重试' : '确认下架'}
                </Text>
              </View>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
