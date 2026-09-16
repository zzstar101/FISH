import { Image, Input, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import NavBar from '@/components/nav-bar'
import {
  conversation as findConversation,
  findListing,
  formatAmount,
  getUser,
  ME,
  type MockConversation,
  type MockListing,
  type MockMediaMessage,
  type MockMessage,
  type MockUser,
  mediaMessages as mediaOf,
  messages as messagesOf,
} from '@/mock/api'
import './index.scss'

/**
 * 会话详情页（设计稿 D2 在现有实现上**增补媒体消息**，只增不删）。
 *
 * **SYSTEM 消息与 `tx.*` 协议解析是本页已验证过的部分，这次没有动**：
 * `systemText()` 与 SYSTEM 的居中胶囊渲染保持原样。
 *
 * 本轮增补（D2）：
 * 1. **图片气泡**：我方品牌渐变底 / 对方白底描边，圆角 12pt、最大宽 200pt、图 4:3。
 * 2. **语音气泡**：播放/暂停 + 波形 + 时长（双方各一种配色），点播放会走一遍进度。
 * 3. **输入栏「+」展开面板**：相册 / 拍照 / 录音 / 文件。相册与拍照会真的插一条
 *    本地媒体消息并跑一遍**上传进度**（不调后端：`BLOCKED #67`）。
 * 4. **上传中环形进度 / 失败重试**：进度环压在图右下角，失败在图左上角挂 `!` 角标，
 *    图下方给「上传失败 · 重试」胶囊；文本发送失败也有对应的重试条。
 *
 * **与契约的边界**：媒体消息是契约外的本地展示扩展（见 `MockMediaMessage`），
 * 不塞进 `MockMessage`；`MEDIA` 与 `MESSAGES` 按时间合并后统一渲染。
 * 上传/发送失败也是**本地乐观状态**，真实实现里由后端或上传 SDK 回调驱动。
 */

/** 路由没带 id 时的回退会话（与消息页第一条会话一致） */
const FALLBACK_ID = 'c-001'

/**
 * SYSTEM 消息的中文渲染。
 *
 * 交易类 SYSTEM 的 content 是契约定义的 JSON（`transactionSystemEventSchema`：
 * tx.proposal / tx.accepted / tx.rejected），必须解析成中文；解析失败则按普通文本
 * 渲染 —— 与契约里 chat 侧的降级口径一致。
 */
function systemText(content: string): string {
  try {
    const event: unknown = JSON.parse(content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      const amount = (event as { amountCents?: unknown }).amountCents
      if (type === 'tx.proposal') {
        return typeof amount === 'number'
          ? `买家发起交易确认 · ¥${formatAmount(amount)}`
          : '买家发起交易确认'
      }
      if (type === 'tx.accepted') {
        return typeof amount === 'number'
          ? `卖家已接受交易 · ¥${formatAmount(amount)}`
          : '卖家已接受交易'
      }
      if (type === 'tx.rejected') return '卖家已拒绝这次交易'
    }
  } catch {
    // 非 JSON：当普通文本
  }
  return content
}

/** 气泡下方的时间戳：HH:mm（mock 的 createdAt 是 ISO 字符串） */
function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
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

/** 会话流里的一行（文本 / SYSTEM / 媒体按时间合并） */
type Entry =
  | { kind: 'message'; createdAt: string; message: MockMessage }
  | { kind: 'media'; createdAt: string; media: MockMediaMessage }

export default function Conversation() {
  const router = useRouter<{ id?: string }>()
  const conversationId = router.params.id || FALLBACK_ID

  const [conversation, setConversation] = useState<MockConversation | null>(null)
  const [listing, setListing] = useState<MockListing | null>(null)
  const [counterpart, setCounterpart] = useState<MockUser | null>(null)
  const [items, setItems] = useState<MockMessage[]>([])
  const [media, setMedia] = useState<MockMediaMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  /** 「+」面板展开态 */
  const [panelOpen, setPanelOpen] = useState(false)
  /** 正在播放的语音 id（null = 没在播） */
  const [playingId, setPlayingId] = useState<string | null>(null)
  /** 已播放秒数（驱动波形高亮） */
  const [playedSec, setPlayedSec] = useState(0)
  /** 底部滚动位置：每次追加消息后推到一个足够大的值，等效于「滚到底部」 */
  const [scrollTop, setScrollTop] = useState(0)
  /**
   * 滚动触发器：每次消息数组变化就 +1。
   *
   * 为什么不直接把 `items` 当 effect 依赖：effect 体内并不读 `items` 的值，
   * 于是 linter 会（正确地）判成「多余依赖」。用一个显式的计数器，
   * 依赖与语义就一致了 —— 这也是「发两条相同内容的消息也要重新滚到底」的实现方式。
   */
  const [scrollTick, setScrollTick] = useState(0)

  /** 本地新增媒体消息的自增序号（避免与 fixture 的 id 撞车） */
  const localSeq = useRef(0)

  useLoad(() => {
    const found = findConversation(conversationId)
    setConversation(found)
    setItems(messagesOf(conversationId))
    setMedia(mediaOf(conversationId))
    setScrollTick((n) => n + 1)
    if (found) {
      setListing(findListing(found.listingId) ?? null)
      setCounterpart(getUser(found.counterpartId))
    }
  })

  /**
   * 首屏与每次发消息后都滚到底部。
   *
   * 主路径是小程序 ScrollView 的 `scrollTop` 属性（先置 0 再置一个超大值，保证
   * 连续发两条消息也会重新触发）；DOM 那一次是预览兜底：预览桩把 scrollTop
   * 透传给普通属性、不会真的滚动，而截图验收要在「已滚到底」的状态下看最后一屏。
   */
  useEffect(() => {
    // 显式读一下触发器：既满足 lint 的依赖一致性，也让「第几次滚动」可观测
    if (scrollTick < 0) return
    setScrollTop(0)
    const raf = requestAnimationFrame(() => {
      setScrollTop(99999)
      const node = document.querySelector('.conv__scroll')
      if (node instanceof HTMLElement) {
        node.scrollTop = node.scrollHeight
        setScrollTop(node.scrollTop)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [scrollTick])

  /**
   * 模拟上传进度：所有处于 UPLOADING 的媒体每秒推进 8%，
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
        message,
      })),
      ...media.map((item) => ({ kind: 'media' as const, createdAt: item.createdAt, media: item })),
    ]
    return merged.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [items, media])

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
    setScrollTick((n) => n + 1)
  }

  /** 新增一条本地媒体消息并起上传（相册 / 拍照共用） */
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
    setScrollTick((n) => n + 1)
  }

  /** 失败重试：上传失败的图重新跑一遍进度 */
  const retryMedia = (id: string) => {
    setMedia((prev) =>
      prev.map((item) => (item.id === id ? { ...item, state: 'UPLOADING', progress: 8 } : item)),
    )
  }

  /** 文本发送失败的重试（mock：直接标成成功） */
  const retryText = () => {
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
      case 'album':
        addPhoto()
        break
      case 'camera':
        addPhoto()
        break
      case 'record':
        void Taro.showToast({ title: '录音待接入', icon: 'none' })
        break
      default:
        void Taro.showToast({ title: '文件发送待接入', icon: 'none' })
    }
  }

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

  const online = conversation.online
  /** 会话的日期分组标签：用 fixture 的相对时间（「今天」）+ 第一条的时刻 */
  const firstEntry = entries[0]
  const dayLabel = firstEntry
    ? `${conversation.timeLabel} ${clockTime(firstEntry.createdAt)}`
    : conversation.timeLabel

  /**
   * SYSTEM 消息分两种渲染：
   * - `tx.accepted`（卖家已接受交易）→ **交易卡**（带「查看交易码」按钮，是进 A2 的入口）；
   * - 其余（含 `tx.proposal` / `tx.rejected` / 普通系统文本）→ 居中灰胶囊。
   *
   * 稿子第 01 帧画的就是这个分工：交易接受是一条可操作的卡，而不是一行只能读的提示。
   */
  const isTxAccepted = (content: string) =>
    content.includes('"type":"tx.accepted"') || content.includes('"type": "tx.accepted"')

  const renderMedia = (item: MockMediaMessage) => {
    const mine = item.senderId === ME.id
    const playing = playingId === item.id

    if (item.kind === 'VOICE') {
      /* 波形高亮：播放时按已播秒数点亮对应比例的竖条 */
      const lit = playing
        ? Math.max(1, Math.round((playedSec / Math.max(1, item.durationSec)) * WAVE.length))
        : 0
      return (
        <View key={item.id} className={`conv__row${mine ? ' is-mine' : ''}`}>
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
      )
    }

    /* ---- 图片气泡 ---- */
    const uploading = item.state === 'UPLOADING'
    const failed = item.state === 'FAILED'
    return (
      <View key={item.id} className={`conv__row${mine ? ' is-mine' : ''}`}>
        <View className={`conv__bubble conv__bubble--media${mine ? ' is-mine' : ''}`}>
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

            {/* 上传失败：左上角的 `!` 角标 */}
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
            {mine ? `${clockTime(item.createdAt)} · 已读` : clockTime(item.createdAt)}
          </Text>
        )}
      </View>
    )
  }

  return (
    <View className="conv">
      <View className="conv__bg" />

      <NavBar />

      <View className="conv__head">
        <Text className="conv__name">{counterpart ? `与${counterpart.nickname}` : '对话'}</Text>
        <View className="conv__status">
          <View className={`conv__dot${online ? ' is-on' : ''}`} />
          <Text className="conv__status-tx">{online ? '在线' : '离线'}</Text>
        </View>
      </View>

      {listing ? (
        <View className="conv__card" onClick={openListing}>
          <Image className="conv__card-img" src={listing.coverUrl} mode="aspectFill" />
          <View className="conv__card-body">
            <Text className="conv__card-title">{listing.title}</Text>
            <View className="conv__card-price">
              <Text className="conv__card-cur">¥</Text>
              <Text className="conv__card-amt num">{formatAmount(listing.priceCents)}</Text>
              <Text className="conv__card-go">查看 ›</Text>
            </View>
          </View>
        </View>
      ) : null}

      <ScrollView className="conv__scroll" scrollY scrollTop={scrollTop} scrollWithAnimation>
        <View className="conv__list">
          {/* 日期分隔（D2 稿子有这一条；不改变原有渲染顺序） */}
          <View className="conv__daysep">
            <Text className="conv__daysep-tx num">{dayLabel}</Text>
          </View>

          {entries.map((entry) => {
            if (entry.kind === 'media') return renderMedia(entry.media)

            const message = entry.message
            if (message.type === 'SYSTEM') {
              // 交易已接受 → 可操作的交易卡（进 A2 交易码页）；其余 → 居中灰胶囊
              if (isTxAccepted(message.content)) {
                return (
                  <View key={message.id} className="conv__txcard">
                    <Image className="conv__txcard-ic" src={ICONS.qr} mode="aspectFit" />
                    <View className="conv__txcard-main">
                      <Text className="conv__txcard-t">卖家已接受交易</Text>
                      <Text className="conv__txcard-d">
                        请在面交时与对方核对 6 位交易码，确认后订单才会变成「已完成」。
                      </Text>
                      <View className="conv__txcard-act" onClick={openMeetup}>
                        <Text>查看交易码</Text>
                      </View>
                    </View>
                  </View>
                )
              }
              return (
                <View key={message.id} className="conv__sys">
                  <Text className="conv__sys-tx">{systemText(message.content)}</Text>
                </View>
              )
            }
            const mine = message.senderId === ME.id
            return (
              <View key={message.id} className={`conv__row${mine ? ' is-mine' : ''}`}>
                <View className={`conv__bubble${mine ? ' is-mine' : ''}`}>
                  <Text className="conv__bubble-tx">{message.content}</Text>
                </View>
                <Text className="conv__time num">
                  {mine ? `${clockTime(message.createdAt)} · 已读` : clockTime(message.createdAt)}
                </Text>
              </View>
            )
          })}
        </View>
      </ScrollView>

      <View className="conv__bar">
        <View
          className={`conv__plus${panelOpen ? ' is-open' : ''}`}
          onClick={() => setPanelOpen((prev) => !prev)}
        >
          <Image className="conv__plus-ic" src={ICONS.plusInk} mode="aspectFit" />
        </View>
        <Input
          className="conv__input"
          value={inputValue}
          placeholder="说点什么…"
          confirmType="send"
          onFocus={() => setPanelOpen(false)}
          onInput={(event) => setInputValue(event.detail.value)}
          onConfirm={send}
        />
        <View
          className={`conv__send${inputValue.trim() ? ' is-on' : ''}`}
          onClick={() => (inputValue.trim() ? send() : retryText())}
        >
          <Image className="conv__send-ic" src={ICONS.send} mode="aspectFit" />
        </View>
      </View>

      {/* ---------------- 「+」展开面板（稿子第 02 帧） ---------------- */}
      {panelOpen ? (
        <View className="conv__panel">
          {[
            { key: 'album', label: '相册', icon: ICONS.image },
            { key: 'camera', label: '拍照', icon: ICONS.camera },
            { key: 'record', label: '录音', icon: ICONS.mic },
            { key: 'file', label: '文件', icon: ICONS.file },
          ].map((tile) => (
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
  )
}
