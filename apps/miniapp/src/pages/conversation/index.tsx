import type { ConversationListing } from '@fish/contracts/chat/schema'
import { Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import { useAuthGuard } from '@/features/auth/guard'
import { readNavMetrics } from '@/lib/nav-metrics'
import {
  failedTextIds,
  conversation as findConversation,
  formatAmount,
  ME,
  type MockConversation,
  type MockMediaMessage,
  type MockMessage,
  mediaMessages as mediaOf,
  messages as messagesOf,
} from '@/mock/api'
import './index.scss'

/**
 * 会话详情页（1版稿落地，见 `D:\Downloads\1改\小程序1版conversation.html`）。
 *
 * 相比 D2 版的主要变化：
 * 1. **页头合一**：导航条单行标题（返回 + 对方昵称 + 认证徽章）+ 紧凑商品摘要条，
 *    同处一块渐变圆角头里；原「与XX」大标题与在线状态行删掉。页头不随消息滚动，
 *    消息区是独立的 ScrollView（与稿子一致，不需要滚动变玻璃的导航）。
 * 2. **气泡带头像**：30pt 圆头像（真实 avatarUrl），气泡上限 200pt、圆角 12pt 均匀；
 *    图片气泡满铺（无内衬无描边，圆角由气泡裁）。
 * 3. **SYSTEM 新口径**：`tx.proposal` → 灰胶囊「待对方同意」；`tx.accepted` →
 *    灰胶囊「已接受交易，待面交」+ 交易码卡（CTA 在卡片右侧）；`tx.completed`
 *    （契约外演示事件，见 `mock/chat.ts`）→ 「已完成」胶囊 + 评价卡。
 * 4. **输入栏改版**：语音/键盘切换 + 自动长高输入框 + 文字「发送」钮；
 *    「+」面板改 3 格（图片 / 拍照 / 商品）。文本发送失败态（mock-only）有重试条。
 *
 * **与契约的边界**：媒体消息、`tx.completed` 与文本发送失败都是契约外的本地展示扩展
 * （见 `MockMediaMessage` / `FAILED_TEXT_IDS`），接真实后端时整块替换。
 */

/** 路由没带 id 时的回退会话（与消息页第一条会话一致） */
const FALLBACK_ID = 'c-001'

/** 交易 SYSTEM 事件（`transactions/schema.ts` 协议 + 契约外的 `tx.completed` 演示事件） */
type TxEvent = { type: string }

/**
 * 解析交易 SYSTEM 事件的 JSON；非 JSON（普通文本系统消息）返回 null。
 * 与消息列表页 `previewText` 的降级口径一致。
 */
function parseTxEvent(content: string): TxEvent | null {
  try {
    const event: unknown = JSON.parse(content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (typeof type === 'string') return { type }
    }
  } catch {
    // 非 JSON：当普通文本
  }
  return null
}

/** 不属于专门卡片的 SYSTEM 消息的胶囊文案（proposal / rejected / 普通文本） */
function systemPillText(content: string): string {
  const event = parseTxEvent(content)
  if (!event) return content
  if (event.type === 'tx.proposal') return '待对方同意'
  if (event.type === 'tx.rejected') return '卖家已拒绝这次交易'
  return content
}

/** 气泡下方的时间戳：HH:mm（mock 的 createdAt 是 ISO 字符串） */
function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 商品摘要条的状态文案（与「我的发布」同一口径） */
const LISTING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '在售',
  RESERVED: '已预订',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

/**
 * 语音波形的高度（rpx）。12 根固定高度，天然是「同一段语音每次看到都一样」——
 * 真实实现里应由音频采样给这组值，mock 阶段固定。
 */
const WAVE = [14, 24, 36, 20, 40, 28, 16, 32, 22, 12, 26, 18]

/**
 * 波形条的稳定 id：12 根条「位置即身份」，所以在模块级生成一次，
 * key 用 id 而不是渲染下标（`noArrayIndexKey`）。
 */
const WAVE_BARS = WAVE.map((height, index) => ({ id: `wave-${index}`, height }))

/** 评价卡的 5 颗星：位置即身份，同波形条的稳定 id 手法 */
const RATE_STARS = [1, 2, 3, 4, 5].map((n) => ({ id: `star-${n}`, value: n }))

/** 「+」面板（1版稿 3 格）；图片与拍照走同一条本地上传演示 */
const PANEL_TILES = [
  { key: 'image', label: '图片', icon: ICONS.image },
  { key: 'camera', label: '拍照', icon: ICONS.camera },
  { key: 'product', label: '商品', icon: ICONS.cart },
] as const

/**
 * 会话流里的一行（文本 / SYSTEM / 媒体按时间合并）。
 * `keyId` 兼作 React key 与 scroll-into-view 的 DOM id（消息/媒体 id 全页唯一）。
 */
type Entry =
  | { kind: 'message'; createdAt: string; keyId: string; message: MockMessage }
  | { kind: 'media'; createdAt: string; keyId: string; media: MockMediaMessage }

export default function Conversation() {
  const authStatus = useAuthGuard()
  const router = useRouter<{ id?: string }>()
  const conversationId = router.params.id || FALLBACK_ID

  const [conversation, setConversation] = useState<MockConversation | null>(null)
  /** 契约 `ConversationDto.listing`（数据层已组装，本页不再查表） */
  const [listing, setListing] = useState<ConversationListing | null>(null)
  /**
   * 契约 `ConversationDto.counterpart`。类型用 mock 的扩展版（带 `authStatus`，
   * 认证徽章要用）：徽章判据与消息列表行同一口径（`VERIFIED` 才亮）。
   */
  const [counterpart, setCounterpart] = useState<MockConversation['counterpart'] | null>(null)
  const [items, setItems] = useState<MockMessage[]>([])
  const [media, setMedia] = useState<MockMediaMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  /** 「+」面板展开态（与语音模式互斥：开面板回键盘态，开语音收面板） */
  const [panelOpen, setPanelOpen] = useState(false)
  /** 语音输入态：输入框换成「按住 说话」 */
  const [voiceMode, setVoiceMode] = useState(false)
  /** 正在播放的语音 id（null = 没在播） */
  const [playingId, setPlayingId] = useState<string | null>(null)
  /** 已播放秒数（驱动波形高亮） */
  const [playedSec, setPlayedSec] = useState(0)
  /** 评价卡的本地星级（0 = 未选；mock 阶段不落库） */
  const [rating, setRating] = useState(0)
  /** 发送失败态被重试成功的文本消息 id（本地清除，不写回 fixture） */
  const [sentIds, setSentIds] = useState<string[]>([])

  /** 本地新增媒体消息的自增序号（避免与 fixture 的 id 撞车） */
  const localSeq = useRef(0)

  const metrics = useMemo(() => readNavMetrics(), [])

  /** 标题可用宽度：两侧都按胶囊避让宽收（返回钮比胶囊窄，对称约束天然覆盖） */
  const titleMaxWidth = useMemo(() => {
    try {
      return Taro.getWindowInfo().windowWidth - metrics.capsuleInset * 2
    } catch {
      return 163
    }
  }, [metrics])

  /** fixture 里处于发送失败态的文本（模块数据，进页面取一次） */
  const failedIds = useMemo(() => failedTextIds(), [])

  useLoad(() => {
    const found = findConversation(conversationId)
    setConversation(found)
    setItems(messagesOf(conversationId))
    setMedia(mediaOf(conversationId))
    if (found) {
      setListing(found.listing)
      setCounterpart(found.counterpart)
    }
  })

  /**
   * 「打开即看最新」：会话流挂在 ScrollView 的 `scrollIntoView` 上，指向最后一条
   * 消息的 DOM id。内容追加时 id 必然变化 → 小程序必然重新滚动，不存在
   * `scroll-top` 先置 0 再置大值那套舞蹈在真机上的竞态（实测会停在顶部）。
   * 尾行高度小于容器，scroll-into-view 被最大滚动距离截住，效果就是贴底。
   *
   * DOM 那一次**只给预览（h5）用**：预览桩把 scrollIntoView 透传成普通属性、
   * 不会真的滚动，截图验收要在「已滚到底」的状态下看最后一屏。
   *
   * ⚠️ 小程序运行时没有 `HTMLElement`（#64 Done 第 3 条：不依赖 Web DOM / Browser-only API），
   * 所以这一支必须按环境整段跳过 —— 否则每次进页面都会抛一次 ReferenceError。
   */
  /**
   * 模拟上传进度：所有处于 UPLOADING 的媒体每 0.5s 推进 8%，
   * 到 100% 转 DONE。真实实现由上传 SDK 的进度回调驱动，这里只是让
   * 「上传中环形进度」这个态在演示里真的能走到终点。
   */
  useEffect(() => {
    const uploading = media.some((item) => item.state === 'UPLOADING')
    if (!uploading) return undefined
    const timer = setInterval(() => {
      setMedia((prev) =>
        prev.map((item) => {
          if (item.state !== 'UPLOADING') return item
          const progress = Math.min(100, item.progress + 8)
          return { ...item, progress, state: progress >= 100 ? 'DONE' : 'UPLOADING' }
        }),
      )
    }, 500)
    return () => clearInterval(timer)
  }, [media])

  /** 语音播放：按 1 秒推进，播满时长后自动停 */
  useEffect(() => {
    if (!playingId) return undefined
    const target = media.find((item) => item.id === playingId)
    const total = target?.durationSec ?? 0
    if (total <= 0) {
      setPlayingId(null)
      return undefined
    }
    const timer = setInterval(() => {
      setPlayedSec((prev) => {
        if (prev + 1 >= total) {
          setPlayingId(null)
          return 0
        }
        return prev + 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [playingId, media])

  /** 文本 + 媒体按时间合并（这就是契约里 `lastMessage` 之外的「消息流」语义） */
  const entries = useMemo<Entry[]>(() => {
    const merged: Entry[] = [
      ...items.map((message) => ({
        kind: 'message' as const,
        createdAt: message.createdAt,
        keyId: message.id,
        message,
      })),
      ...media.map((item) => ({
        kind: 'media' as const,
        createdAt: item.createdAt,
        keyId: item.id,
        media: item,
      })),
    ]
    return merged.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [items, media])

  /**
   * 「打开即看最新」：会话流挂在 ScrollView 的 `scrollIntoView` 上，指向最后一条
   * 消息的 DOM id。内容追加时 id 必然变化 → 小程序必然重新滚动，不存在
   * `scroll-top` 先置 0 再置大值那套舞蹈在真机上的竞态（实测会停在顶部）。
   * 尾行高度小于容器，scroll-into-view 被最大滚动距离截住，效果就是贴底。
   *
   * DOM 那一次**只给预览（h5）用**：预览桩把 scrollIntoView 透传成普通属性、
   * 不会真的滚动，截图验收要在「已滚到底」的状态下看最后一屏。
   *
   * ⚠️ 小程序运行时没有 `HTMLElement`（#64 Done 第 3 条：不依赖 Web DOM / Browser-only API），
   * 所以这一支必须按环境整段跳过 —— 否则每次进页面都会抛一次 ReferenceError。
   */
  // 不用 `entries.at(-1)`：那是 ES2022 运行时 API，#113 的 ES5 检查只管语法不管
  // polyfill，旧 JSCore 上会直接 `is not a function`（review #117 第 2 条）
  const tail = entries.length > 0 ? entries[entries.length - 1] : undefined
  const tailId = tail ? `e-${tail.keyId}` : ''

  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5') return undefined
    if (!tailId) return undefined
    if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return undefined
    const raf = requestAnimationFrame(() => {
      const node = document.querySelector('.conv__scroll')
      if (node instanceof HTMLElement) node.scrollTop = node.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [tailId])

  const send = () => {
    const text = inputValue.trim()
    if (!text) return
    setItems((prev) => [
      ...prev,
      {
        id: `${conversationId}-local-${prev.length + 1}`,
        conversationId,
        senderId: ME.id,
        type: 'TEXT',
        content: text,
        createdAt: new Date().toISOString(),
      },
    ])
    setInputValue('')
  }

  /** 新增一条本地媒体消息并起上传（图片 / 拍照共用） */
  const addPhoto = () => {
    const cover = listing?.coverUrl ?? ''
    localSeq.current += 1
    const seq = localSeq.current
    setMedia((prev) => [
      ...prev,
      {
        id: `${conversationId}-local-media-${seq}`,
        conversationId,
        senderId: ME.id,
        kind: 'IMAGE',
        imageUrl: cover,
        durationSec: 0,
        createdAt: new Date().toISOString(),
        state: 'UPLOADING',
        progress: 8,
      },
    ])
    setPanelOpen(false)
  }

  /** 失败重试：上传失败的图重新跑一遍进度 */
  const retryMedia = (id: string) => {
    setMedia((prev) =>
      prev.map((item) => (item.id === id ? { ...item, state: 'UPLOADING', progress: 8 } : item)),
    )
  }

  /** 文本发送失败的重试（mock：本地标成已发送） */
  const retryText = (id: string) => {
    setSentIds((prev) => [...prev, id])
    void Taro.showToast({ title: '已重新发送', icon: 'none' })
  }

  const toggleVoice = (item: MockMediaMessage) => {
    if (playingId === item.id) {
      setPlayingId(null)
      setPlayedSec(0)
      return
    }
    setPlayedSec(0)
    setPlayingId(item.id)
  }

  /** 语音/键盘切换：进语音态时收起面板（两态不并存，与稿子一致） */
  const toggleVoiceMode = () => {
    if (!voiceMode) setPanelOpen(false)
    setVoiceMode(!voiceMode)
  }

  /** 「+」开合面板：开面板时退回键盘态 */
  const togglePanel = () => {
    if (!panelOpen) setVoiceMode(false)
    setPanelOpen(!panelOpen)
  }

  const openListing = () => {
    if (!listing) return
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
  }

  const openMeetup = () => {
    // 交易码页需要交易 id；会话里只做入口，不在这里推断是哪一笔（那是 A1/A2 的事）
    void Taro.navigateTo({ url: '/pages/transaction-meetup/index' })
  }

  const panelAction = (key: string) => {
    switch (key) {
      case 'image':
      case 'camera':
        addPhoto()
        break
      default:
        void Taro.showToast({ title: '商品卡片待接入', icon: 'none' })
    }
  }

  /**
   * 返回：有上一页就回退，否则回消息 Tab（Tab 页不能 navigateBack 跨栈）。
   * 与 `components/nav-bar` / 商品详情页同一行为；本页页头是页面自己的
   * 渐变头（稿子 `.chathead`），不再用漂浮导航组件。
   */
  const handleBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack()
    } else {
      void Taro.switchTab({ url: '/pages/chat/index' })
    }
  }

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   *
   * 必须放在「会话不存在」分支**之前**：未登录带一个非法 id 进来会先命中空态，
   * 于是跳转被绕过一帧（守卫的 effect 与渲染在同一轮里，早返回的分支先出图）。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /* 取不到会话（例如手输了一个不存在的 id）：给空态兜底，不留白屏 */
  if (!conversation) {
    return (
      <View className="conv">
        <View className="conv__bg" />
        <View className="conv__emptypad">
          <EmptyState
            title="会话不存在或已结束"
            text="这条对话可能已被删除，回消息列表看看其它同学的消息吧"
            actionText="返回消息"
            onAction={() => void Taro.switchTab({ url: '/pages/chat/index' })}
          />
        </View>
      </View>
    )
  }

  /** 会话的日期分组标签：用 fixture 的相对时间（「今天」）+ 第一条的时刻 */
  const firstEntry = entries[0]
  const dayLabel = firstEntry
    ? `${conversation.timeLabel} ${clockTime(firstEntry.createdAt)}`
    : conversation.timeLabel

  const isFailedText = (id: string) => failedIds.includes(id) && !sentIds.includes(id)

  /** 30pt 圆头像：真实 avatarUrl 优先，无图回退首字（同消息列表行的降级） */
  const renderAvatar = (mine: boolean) => {
    const url = mine ? ME.avatarUrl : (counterpart?.avatarUrl ?? '')
    const initial = mine ? '我' : (counterpart?.nickname[0] ?? '同')
    return (
      <View className={`conv__ava${mine ? ' is-mine' : ''}`}>
        {url ? (
          <Image className="conv__ava-img" src={url} mode="aspectFill" />
        ) : (
          <Text className="conv__ava-tx">{initial}</Text>
        )}
      </View>
    )
  }

  const renderMedia = (item: MockMediaMessage) => {
    const mine = item.senderId === ME.id
    const playing = playingId === item.id

    if (item.kind === 'VOICE') {
      /* 波形高亮：播放时按已播秒数点亮对应比例的竖条 */
      const lit = playing
        ? Math.max(1, Math.round((playedSec / Math.max(1, item.durationSec)) * WAVE.length))
        : 0
      return (
        <View key={item.id} id={`e-${item.id}`} className={`conv__row${mine ? ' is-mine' : ''}`}>
          {renderAvatar(mine)}
          <View className="conv__col">
            <View className={`conv__bubble conv__bubble--voice${mine ? ' is-mine' : ''}`}>
              <View
                className={`conv__play${mine ? ' is-mine' : ''}${playing ? ' is-pause' : ''}`}
                onClick={() => toggleVoice(item)}
              >
                <View className="conv__play-glyph" />
              </View>
              <View className="conv__wave">
                {WAVE_BARS.map((bar, i) => (
                  <View
                    key={bar.id}
                    className={`conv__wave-bar${mine ? ' is-mine' : ''}${i < lit ? ' is-on' : ''}`}
                    style={{ height: `${bar.height}rpx` }}
                  />
                ))}
              </View>
              <Text
                className={`conv__dur num${mine ? ' is-mine' : ''}`}
              >{`${item.durationSec}"`}</Text>
            </View>
            <Text className="conv__time num">
              {playing
                ? `正在播放 00:${String(playedSec).padStart(2, '0')}`
                : clockTime(item.createdAt)}
            </Text>
          </View>
        </View>
      )
    }

    /* ---- 图片气泡：图满铺，不留内衬也不描边（圆角由气泡裁） ---- */
    const uploading = item.state === 'UPLOADING'
    const failed = item.state === 'FAILED'
    return (
      <View key={item.id} id={`e-${item.id}`} className={`conv__row${mine ? ' is-mine' : ''}`}>
        {renderAvatar(mine)}
        <View className="conv__col">
          <View className="conv__bubble conv__bubble--media">
            <View className="conv__photo">
              {item.imageUrl ? (
                <Image className="conv__photo-img" src={item.imageUrl} mode="aspectFill" />
              ) : null}

              {/* 上传中：右下角深色底盘 + 环形进度 */}
              {uploading ? (
                <View className="conv__prog">
                  <View
                    className="conv__ring"
                    style={{
                      background: `conic-gradient(#fff 0 ${item.progress}%, rgba(255,255,255,.28) ${item.progress}% 100%)`,
                    }}
                  />
                </View>
              ) : null}

              {/* 上传失败：左上角 `!` 角标（贴满气泡后要往内收，否则被裁掉） */}
              {failed ? <View className="conv__failmark">!</View> : null}
            </View>
          </View>

          {uploading ? (
            <Text className="conv__time num">{`上传中 ${item.progress}%`}</Text>
          ) : failed ? (
            <View className="conv__retry" onClick={() => retryMedia(item.id)}>
              <Image className="conv__retry-ic" src={ICONS.refresh} mode="aspectFit" />
              <Text>上传失败 · 重试</Text>
            </View>
          ) : (
            <Text className="conv__time num">
              {clockTime(item.createdAt)}
              {mine ? (
                <Text>
                  {' · '}
                  <Text className="conv__rd">已读</Text>
                </Text>
              ) : null}
            </Text>
          )}
        </View>
      </View>
    )
  }

  /**
   * SYSTEM 消息按 1版稿口径渲染：
   * - `tx.proposal` → 灰胶囊「待对方同意」；
   * - `tx.accepted` → 灰胶囊「已接受交易，待面交」+ 交易码卡（进 A2 的入口，CTA 在右）；
   * - `tx.completed`（契约外演示事件）→ 灰胶囊「已完成」+ 评价卡；
   * - 其余（含 `tx.rejected` / 普通系统文本）→ 居中灰胶囊。
   */
  const renderSystem = (message: MockMessage) => {
    const event = parseTxEvent(message.content)

    if (event?.type === 'tx.accepted') {
      return (
        <View key={message.id} id={`e-${message.id}`} className="conv__syswrap">
          <View className="conv__sys">
            <Text className="conv__sys-tx">已接受交易，待面交</Text>
          </View>
          <View className="conv__txcard">
            <Image className="conv__txcard-ic" src={ICONS.qr} mode="aspectFit" />
            <View className="conv__txcard-main">
              <Text className="conv__txcard-t">卖家已接受交易</Text>
              <Text className="conv__txcard-d">
                面交时与对方核对 6 位交易码，确认后订单才算完成。
              </Text>
            </View>
            <View className="conv__txcard-act" onClick={openMeetup}>
              <Text>查看交易码</Text>
            </View>
          </View>
        </View>
      )
    }

    if (event?.type === 'tx.completed') {
      return (
        <View key={message.id} id={`e-${message.id}`} className="conv__syswrap">
          <View className="conv__sys">
            <Text className="conv__sys-tx">已完成</Text>
          </View>
          <View className="conv__rate">
            <Image className="conv__rate-ic" src={ICONS.starAccent} mode="aspectFit" />
            <View className="conv__rate-main">
              <View className="conv__rate-row">
                <Text className="conv__rate-t">给 TA 一个评价</Text>
                <View className="conv__rate-stars">
                  {RATE_STARS.map((star) => (
                    <Image
                      key={star.id}
                      className="conv__rate-star"
                      src={star.value <= rating ? ICONS.starAccent : ICONS.starLine}
                      mode="aspectFit"
                      onClick={() => setRating(star.value)}
                    />
                  ))}
                </View>
              </View>
              <Text className="conv__rate-d">评价会显示在对方主页，影响你的信用分</Text>
            </View>
            <View
              className="conv__rate-act"
              onClick={() => void Taro.showToast({ title: '评价待接入', icon: 'none' })}
            >
              <Text>去评价</Text>
            </View>
          </View>
        </View>
      )
    }

    return (
      <View key={message.id} id={`e-${message.id}`} className="conv__sys">
        <Text className="conv__sys-tx">{systemPillText(message.content)}</Text>
      </View>
    )
  }

  const statusLabel = listing ? (LISTING_STATUS_LABEL[listing.status] ?? '在售') : ''

  return (
    <View className="conv">
      {/*
        渐变圆角头（稿子 .chathead）：导航条 + 商品摘要条都在里面，不随消息滚动。
        状态栏高度用内联 px（设备相关，不走 rpx），导航行高 88rpx 与商品详情页一致。
      */}
      <View className="conv__head" style={{ paddingTop: `${metrics.statusBarHeight}px` }}>
        <View className="conv__navrow">
          <View className="conv__back" onClick={handleBack}>
            <View className="conv__chevron" />
          </View>
          <View className="conv__title">
            <View className="conv__title-in" style={{ maxWidth: `${titleMaxWidth}px` }}>
              <Text className="conv__title-nm">{counterpart?.nickname ?? '对话'}</Text>
              {counterpart?.authStatus === 'VERIFIED' ? (
                <View className="conv__cert">
                  <Image className="conv__cert-ic" src={ICONS.verifiedAccent} mode="aspectFit" />
                  <Text className="conv__cert-tx">已认证</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* 商品摘要条：本页唯一的吸顶锚点，点它进商品详情 */}
        <View className="conv__pcard" onClick={openListing}>
          <View className="conv__pcard-thumb">
            {listing?.coverUrl ? (
              <Image className="conv__pcard-img" src={listing.coverUrl} mode="aspectFill" />
            ) : (
              <Image className="conv__pcard-ph" src={ICONS.imageMuted} mode="aspectFit" />
            )}
          </View>
          <View className="conv__pcard-main">
            <Text className="conv__pcard-title">{listing?.title ?? '商品已下架'}</Text>
            <Text className="conv__pcard-meta num">
              {'¥'}
              <Text className="conv__pcard-price">{formatAmount(listing?.priceCents ?? 0)}</Text>
              {` · ${statusLabel} · 我们正在聊这件`}
            </Text>
          </View>
          <View className="conv__pcard-go">
            <Text className="conv__pcard-go-tx">查看</Text>
            <Image className="conv__pcard-caret" src={ICONS.chevronRightMuted} mode="aspectFit" />
          </View>
        </View>
      </View>

      {/* 消息流：打开即停在最新（底部） */}
      <ScrollView className="conv__scroll" scrollY scrollIntoView={tailId} scrollWithAnimation>
        <View className="conv__list">
          <View className="conv__daysep">
            <Text className="conv__daysep-tx num">{dayLabel}</Text>
          </View>

          {entries.map((entry) => {
            if (entry.kind === 'media') return renderMedia(entry.media)

            const message = entry.message
            if (message.type === 'SYSTEM') return renderSystem(message)

            const mine = message.senderId === ME.id
            const failed = mine && isFailedText(message.id)
            return (
              <View
                key={message.id}
                id={`e-${message.id}`}
                className={`conv__row${mine ? ' is-mine' : ''}`}
              >
                {renderAvatar(mine)}
                <View className="conv__col">
                  <View
                    className={`conv__bubble${mine ? ' is-mine' : ''}${failed ? ' is-failed' : ''}`}
                  >
                    <Text className="conv__bubble-tx">{message.content}</Text>
                  </View>
                  {failed ? (
                    <View className="conv__retry" onClick={() => retryText(message.id)}>
                      <Image className="conv__retry-ic" src={ICONS.refresh} mode="aspectFit" />
                      <Text>发送失败 · 重试</Text>
                    </View>
                  ) : (
                    <Text className="conv__time num">
                      {clockTime(message.createdAt)}
                      {mine ? (
                        <Text>
                          {' · '}
                          <Text className="conv__rd">已读</Text>
                        </Text>
                      ) : null}
                    </Text>
                  )}
                </View>
              </View>
            )
          })}
        </View>
      </ScrollView>

      {/*
        输入栏（稿子 .composer）：语音/键盘切换 + 自动长高输入框 + 「+」+ 发送。
        空内容时「发送」置灰（稿子 .send.is-off）。
      */}
      <View className="conv__bar">
        <View className="conv__bar-row">
          <View className={`conv__cbtn${voiceMode ? ' is-on' : ''}`} onClick={toggleVoiceMode}>
            <Image className="conv__cbtn-ic" src={ICONS.mic} mode="aspectFit" />
          </View>

          {voiceMode ? (
            <View
              className="conv__hold"
              onClick={() => void Taro.showToast({ title: '录音待接入', icon: 'none' })}
            >
              <Text className="conv__hold-tx">按住 说话</Text>
            </View>
          ) : (
            <Textarea
              className="conv__input"
              value={inputValue}
              placeholder="发消息…"
              placeholderClass="conv__input-ph"
              autoHeight
              maxlength={2000}
              disableDefaultPadding
              onFocus={() => setPanelOpen(false)}
              onInput={(event) => setInputValue(event.detail.value)}
            />
          )}

          <View className={`conv__plus${panelOpen ? ' is-open' : ''}`} onClick={togglePanel}>
            <Image className="conv__plus-ic" src={ICONS.plusLine} mode="aspectFit" />
          </View>

          <View className={`conv__send${inputValue.trim() ? '' : ' is-off'}`} onClick={send}>
            <Text className="conv__send-tx">发送</Text>
          </View>
        </View>

        {/* 「+」展开面板（稿子 3 格）：图片 / 拍照 / 商品 */}
        {panelOpen ? (
          <View className="conv__panel">
            {PANEL_TILES.map((tile) => (
              <View key={tile.key} className="conv__ptile" onClick={() => panelAction(tile.key)}>
                <View className="conv__ptile-disc">
                  <Image className="conv__ptile-ic" src={tile.icon} mode="aspectFit" />
                </View>
                <Text className="conv__ptile-label">{tile.label}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}
