import { Image, Input, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useState } from 'react'
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
  type MockMessage,
  type MockUser,
  messages as messagesOf,
} from '@/mock/api'
import './index.scss'

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

export default function Conversation() {
  const router = useRouter<{ id?: string }>()
  const conversationId = router.params.id || FALLBACK_ID

  const [conversation, setConversation] = useState<MockConversation | null>(null)
  const [listing, setListing] = useState<MockListing | null>(null)
  const [counterpart, setCounterpart] = useState<MockUser | null>(null)
  const [items, setItems] = useState<MockMessage[]>([])
  const [inputValue, setInputValue] = useState('')
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

  useLoad(() => {
    const found = findConversation(conversationId)
    setConversation(found)
    setItems(messagesOf(conversationId))
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
   * 透传成普通属性、不会真的滚动，而截图验收要在「已滚到底」的状态下看最后一屏。
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

  const openListing = () => {
    if (!listing) return
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
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
          {items.map((message) => {
            if (message.type === 'SYSTEM') {
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
                <Text className="conv__time num">{clockTime(message.createdAt)}</Text>
              </View>
            )
          })}
        </View>
      </ScrollView>

      <View className="conv__bar">
        <Input
          className="conv__input"
          value={inputValue}
          placeholder="说点什么…"
          confirmType="send"
          onInput={(event) => setInputValue(event.detail.value)}
          onConfirm={send}
        />
        <View className={`conv__send${inputValue.trim() ? ' is-on' : ''}`} onClick={send}>
          <Image className="conv__send-ic" src={ICONS.send} mode="aspectFit" />
        </View>
      </View>
    </View>
  )
}
