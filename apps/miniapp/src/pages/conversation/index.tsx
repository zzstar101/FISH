import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import { Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { markConversationRead, sendMessage } from '@/features/chat/api'
import { loadConversation, loadMessagePage } from '@/features/fetchers'
import { formatAmount } from '@/lib/money'
import { readNavMetrics } from '@/lib/nav-metrics'
import { clockTime, dayLabelOf } from '@/lib/time'
import {
  canRetry,
  listingStatusText,
  type PendingMessage,
  parseTxEvent,
  sortMessages,
  systemPillText,
} from './view'
import './index.scss'

/**
 * 会话详情页（#89：历史 / 发送 / 已读全部接真实接口）。
 *
 * 页头与气泡布局沿用 1版稿（见 `index.scss`），本页改的是**数据来源与状态机**：
 *
 * 1. 会话详情 `GET /conversations/:id`、历史 `GET /conversations/:id/messages`、
 *    发送 `POST /conversations/:id/messages`、已读 `POST /conversations/:id/read`；
 * 2. 历史按契约的 `before` 游标「加载更早的消息」，不再假设一次能拿全；
 * 3. 发送是**真实落库**：本地乐观气泡在成功后被服务端返回的那条替换（按 id 去重，
 *    实时推送送来的同一条不会重复），失败留在原地给重试 —— 不再有「假装成功」的态；
 * 4. 删除契约里不存在的展示件：认证徽章（`conversationUserSchema` 无 `authStatus`）、
 *    每条消息的「已读」标记（实时契约没有已读回执，见 #149）、`tx.completed` 评价卡
 *    （交易域没有这个事件）、以及媒体消息与上传/播放的本地模拟（#67 的范围）。
 *
 * 页头商品卡的状态、SYSTEM 事件的中文化、时间文案都走 `./view` 的纯函数（有用例）。
 */

/** 「+」面板（1版稿 3 格）：图片 / 拍照 / 语音都属于 #67，本轮只给明确提示 */
const PANEL_TILES = [
  { key: 'image', label: '图片', icon: ICONS.image },
  { key: 'camera', label: '拍照', icon: ICONS.camera },
  { key: 'product', label: '商品', icon: ICONS.cart },
] as const

/** 媒体能力的统一提示（#67 未落地前，任何「发图 / 发语音」入口都只说这一句） */
const MEDIA_PENDING_TIP = '图片 / 语音消息待接入（#67）'

export default function Conversation() {
  const authStatus = useAuthGuard()
  const { user: me } = useAuth()
  const router = useRouter<{ id?: string }>()
  const conversationId = router.params.id ?? ''

  const [conversation, setConversation] = useState<ConversationDto | null>(null)
  /** 详情状态：`missing`（真的没这条会话）与 `failed`（没读到）必须分开渲染 */
  const [convState, setConvState] = useState<'loading' | 'ok' | 'missing' | 'failed'>('loading')
  const [messages, setMessages] = useState<MessageDto[]>([])
  const [msgState, setMsgState] = useState<'loading' | 'ok' | 'failed'>('loading')
  /** 更早一页的游标；null = 已到最早 */
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  /** 加载更早失败：只在顶部显示一条重试，不能把已经看到的消息整屏换成错误态 */
  const [earlierFailed, setEarlierFailed] = useState(false)
  const [inputValue, setInputValue] = useState('')
  /** 本地乐观消息（发送中 / 发送失败），永远排在服务端消息之后 */
  const [pending, setPending] = useState<PendingMessage[]>([])
  /** 「+」面板展开态（与语音模式互斥：开面板回键盘态，开语音收面板） */
  const [panelOpen, setPanelOpen] = useState(false)
  /** 语音输入态：输入框换成「按住 说话」 */
  const [voiceMode, setVoiceMode] = useState(false)

  /** 加载代次：换会话 / 连点重试时只有最后一次的响应落地 */
  const epoch = useRef(0)
  /** 本地乐观消息的自增序号（只用于渲染 key 与重试定位） */
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

  /**
   * 详情 + 首屏历史一起加载。两者共用一个代次：任何一个重试都作废在途的那一批，
   * 避免「重试后详情是新会话、消息还是上一个会话的」这种半新半旧。
   */
  const load = useCallback(() => {
    if (!conversationId) {
      setConvState('missing')
      setMsgState('ok')
      return
    }
    const current = ++epoch.current
    setConvState('loading')
    setMsgState('loading')
    setEarlierFailed(false)
    void Promise.all([loadConversation(conversationId), loadMessagePage(conversationId)])
      .then(([detail, page]) => {
        if (current !== epoch.current) return
        if (detail.status === 'ok') setConversation(detail.conversation)
        setConvState(detail.status)
        setMessages(page.items)
        setNextCursor(page.nextCursor)
        setMsgState(page.failed ? 'failed' : 'ok')
      })
      .catch((error) => {
        // 两个 loader 自己都吞了接口失败，这里兜的是更外层（例如动态 import fixture 也失败）
        console.warn('[miniapp] 会话页加载异常', error)
        if (current !== epoch.current) return
        setConvState('failed')
        setMsgState('failed')
      })
  }, [conversationId])

  useEffect(() => {
    if (authStatus !== 'authed') return
    load()
  }, [authStatus, load])

  /**
   * 进会话即已读：真实推进服务端读位（幂等）。失败只记日志 —— 本地没有「已读视角」
   * 可以回滚，返回列表时那边 `useDidShow` 会重拉，如实显示服务端还记着的未读。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !conversationId) return
    void markConversationRead(conversationId).catch((error) =>
      console.warn('[miniapp] 标记会话已读失败', error),
    )
  }, [authStatus, conversationId])

  /** 「加载更早的消息」：契约的 `before` 游标原样回传，拼接在已有消息之前 */
  const loadEarlier = () => {
    if (!nextCursor || loadingEarlier) return
    setLoadingEarlier(true)
    setEarlierFailed(false)
    const current = epoch.current
    void loadMessagePage(conversationId, nextCursor)
      .then((page) => {
        if (current !== epoch.current) return
        if (page.failed) {
          setEarlierFailed(true)
          return
        }
        setMessages((prev) => sortMessages([...page.items, ...prev]))
        setNextCursor(page.nextCursor)
      })
      .finally(() => setLoadingEarlier(false))
  }

  /**
   * 发一条文本消息。`pendingId` 存在时是「重试同一颗失败气泡」，不新增气泡。
   */
  const doSend = (text: string, pendingId?: string) => {
    // 新气泡才需要新序号；重试沿用原来的临时 id（赋值不能塞进表达式，见 noAssignInExpressions）
    let id = pendingId
    if (!id) {
      localSeq.current += 1
      id = `local-${localSeq.current}`
    }
    setPending((prev) =>
      pendingId
        ? prev.map((item) => (item.id === id ? { ...item, status: 'sending' } : item))
        : [...prev, { id, content: text, status: 'sending' }],
    )
    void sendMessage(conversationId, text)
      .then((message) => {
        setPending((prev) => prev.filter((item) => item.id !== id))
        // 服务端「先落库、再推送、再回 HTTP」：实时推送可能先到，这里按 id 去重；
        // 再按 `(createdAt, id)` 重排 —— 连发两条时响应可能乱序回来
        setMessages((prev) =>
          sortMessages(prev.some((item) => item.id === message.id) ? prev : [...prev, message]),
        )
      })
      .catch((error) => {
        console.warn('[miniapp] 发送消息失败', error)
        setPending((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status: 'failed' } : item)),
        )
      })
  }

  /**
   * 能不能发送：详情与历史**都**就绪才行。
   *
   * 历史没加载出来时那个分支整屏是错误卡，乐观气泡与「重试」都渲染不出来 ——
   * 此时允许发送会变成「POST 真的落库了、界面上却什么都不出现」，用户等不到任何反馈。
   */
  const canSend = convState === 'ok' && msgState === 'ok'

  const send = () => {
    const text = inputValue.trim()
    if (!text || !canSend) return
    setInputValue('')
    doSend(text)
  }

  const retry = (item: PendingMessage) => {
    if (!canRetry(item)) return
    doSend(item.content, item.id)
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
    if (!conversation) return
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${conversation.listing.id}` })
  }

  const openMeetup = () => {
    // 交易码页需要交易 id；会话里只做入口，不在这里推断是哪一笔（那是 A1/A2 的事）
    void Taro.navigateTo({ url: '/pages/transaction-meetup/index' })
  }

  /** 「+」面板的三格：图片 / 拍照属于 #67；商品卡片是另一件事，文案不能混为一谈 */
  const panelAction = (key: (typeof PANEL_TILES)[number]['key']) => {
    setPanelOpen(false)
    void Taro.showToast({
      title: key === 'product' ? '商品卡片待接入' : MEDIA_PENDING_TIP,
      icon: 'none',
    })
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

  /** 会话流：服务端消息按契约顺序在前，本地待发消息永远最后（必然最新） */
  const entries = useMemo(
    () => [
      ...messages.map((message) => ({ kind: 'message' as const, keyId: message.id, message })),
      ...pending.map((item) => ({ kind: 'pending' as const, keyId: item.id, pending: item })),
    ],
    [messages, pending],
  )

  /**
   * 「打开即看最新」：会话流挂在 ScrollView 的 `scrollIntoView` 上，指向最后一条
   * 消息的 DOM id。内容追加时 id 必然变化 → 小程序必然重新滚动，不存在
   * `scroll-top` 先置 0 再置大值那套舞蹈在真机上的竞态（实测会停在顶部）。
   * 尾行高度小于容器，scroll-into-view 被最大滚动距离截住，效果就是贴底。
   */
  // 不用 `entries.at(-1)`：那是 ES2022 运行时 API，#113 的 ES5 检查只管语法不管
  // polyfill，旧 JSCore 上会直接 `is not a function`（review #117 第 2 条）
  const tail = entries.length > 0 ? entries[entries.length - 1] : undefined
  const tailId = tail ? `e-${tail.keyId}` : ''

  /**
   * DOM 那一次**只给预览（h5）用**：预览桩把 scrollIntoView 透传成普通属性、
   * 不会真的滚动，截图验收要在「已滚到底」的状态下看最后一屏。
   *
   * ⚠️ 小程序运行时没有 `HTMLElement`（#64 Done 第 3 条：不依赖 Web DOM / Browser-only API），
   * 所以这一支必须按环境整段跳过 —— 否则每次进页面都会抛一次 ReferenceError。
   */
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

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   *
   * 必须放在「会话不存在」分支**之前**：未登录带一个非法 id 进来会先命中空态，
   * 于是跳转被绕过一帧（守卫的 effect 与渲染在同一轮里，早返回的分支先出图）。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /* 取不到会话（不存在 / 不是参与者 / 没读到）：三种态各自渲染，不留白屏 */
  if (convState !== 'ok' || !conversation) {
    return (
      <View className="conv">
        <View className="conv__bg" />
        <View className="conv__emptypad">
          {convState === 'loading' ? (
            <View className="conv__empty">
              <Text className="conv__empty-title">正在加载会话…</Text>
            </View>
          ) : convState === 'failed' ? (
            <LoadError title="会话加载失败" text="检查网络后重试" onRetry={load} />
          ) : (
            <EmptyState
              title="会话不存在或已结束"
              text="这条对话可能已被删除，回消息列表看看其它同学的消息吧"
              actionText="返回消息"
              onAction={() => void Taro.switchTab({ url: '/pages/chat/index' })}
            />
          )}
        </View>
      </View>
    )
  }

  const counterpart = conversation.counterpart
  const listing = conversation.listing
  const now = Date.now()
  /** 日期分隔条看**已加载的第一条**（分页后它会跟着变早），没有消息时退回会话的最后活跃时间 */
  const firstEntry = entries.length > 0 ? entries[0] : undefined
  const dayLabel = dayLabelOf(
    firstEntry?.kind === 'message' ? firstEntry.message.createdAt : conversation.lastMessageAt,
    now,
  )

  /** 30pt 圆头像：真实 avatarUrl 优先，无图回退首字（同消息列表行的降级） */
  const renderAvatar = (mine: boolean) => {
    const url = mine ? (me?.avatarUrl ?? '') : (counterpart.avatarUrl ?? '')
    const initial = mine ? (me?.nickname[0] ?? '我') : (counterpart.nickname[0] ?? '同')
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

  /**
   * SYSTEM 消息按 1版稿口径渲染：
   * - `tx.accepted` → 灰胶囊「已接受交易，待面交」+ 交易码卡（进 A2 的入口，CTA 在右）；
   * - 其余（`tx.proposal` / `tx.rejected` / 普通系统文本）→ 居中灰胶囊。
   */
  const renderSystem = (message: MessageDto) => {
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

    return (
      <View key={message.id} id={`e-${message.id}`} className="conv__sys">
        <Text className="conv__sys-tx">{systemPillText(message.content)}</Text>
      </View>
    )
  }

  const statusLabel = listingStatusText(listing.status)

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
              <Text className="conv__title-nm">{counterpart.nickname}</Text>
            </View>
          </View>
        </View>

        {/* 商品摘要条：本页唯一的吸顶锚点，点它进商品详情 */}
        <View className="conv__pcard" onClick={openListing}>
          <View className="conv__pcard-thumb">
            {listing.coverUrl ? (
              <Image className="conv__pcard-img" src={listing.coverUrl} mode="aspectFill" />
            ) : (
              <Image className="conv__pcard-ph" src={ICONS.imageMuted} mode="aspectFit" />
            )}
          </View>
          <View className="conv__pcard-main">
            <Text className="conv__pcard-title">{listing.title}</Text>
            <Text className="conv__pcard-meta num">
              {'¥'}
              <Text className="conv__pcard-price">{formatAmount(listing.priceCents)}</Text>
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
          {/* 更早一页（契约的 before 游标） */}
          {nextCursor || earlierFailed ? (
            <View className="conv__earlier">
              {earlierFailed ? (
                <View className="conv__retry" onClick={loadEarlier}>
                  <Image className="conv__retry-ic" src={ICONS.refresh} mode="aspectFit" />
                  <Text>更早的消息没加载出来 · 重试</Text>
                </View>
              ) : (
                <View className="conv__earlier-btn" onClick={loadEarlier}>
                  <Text>{loadingEarlier ? '正在加载更早的消息…' : '加载更早的消息'}</Text>
                </View>
              )}
            </View>
          ) : null}

          <View className="conv__daysep">
            <Text className="conv__daysep-tx num">{dayLabel}</Text>
          </View>

          {msgState === 'loading' ? (
            <View className="conv__empty">
              <Text className="conv__empty-title">正在加载消息…</Text>
            </View>
          ) : msgState === 'failed' ? (
            /* 历史没读到：明确给错误与重试，不伪装成「还没有消息」 */
            <LoadError title="消息加载失败" text="检查网络后重试" onRetry={load} />
          ) : (
            <>
              {entries.map((entry) => {
                if (entry.kind === 'pending') {
                  const failed = entry.pending.status === 'failed'
                  return (
                    <View key={entry.keyId} id={`e-${entry.keyId}`} className="conv__row is-mine">
                      {renderAvatar(true)}
                      <View className="conv__col">
                        <View className={`conv__bubble is-mine${failed ? ' is-failed' : ''}`}>
                          <Text className="conv__bubble-tx">{entry.pending.content}</Text>
                        </View>
                        {failed ? (
                          <View className="conv__retry" onClick={() => retry(entry.pending)}>
                            <Image
                              className="conv__retry-ic"
                              src={ICONS.refresh}
                              mode="aspectFit"
                            />
                            <Text>发送失败 · 重试</Text>
                          </View>
                        ) : (
                          <Text className="conv__time num">发送中…</Text>
                        )}
                      </View>
                    </View>
                  )
                }

                const message = entry.message
                if (message.type === 'SYSTEM') return renderSystem(message)

                const mine = message.senderId === me?.id
                return (
                  <View
                    key={message.id}
                    id={`e-${message.id}`}
                    className={`conv__row${mine ? ' is-mine' : ''}`}
                  >
                    {renderAvatar(mine)}
                    <View className="conv__col">
                      <View className={`conv__bubble${mine ? ' is-mine' : ''}`}>
                        <Text className="conv__bubble-tx">{message.content}</Text>
                      </View>
                      <Text className="conv__time num">{clockTime(message.createdAt)}</Text>
                    </View>
                  </View>
                )
              })}

              {entries.length === 0 ? (
                <View className="conv__empty">
                  <Text className="conv__empty-title">还没有消息</Text>
                  <Text className="conv__empty-text">在下面打个招呼吧</Text>
                </View>
              ) : null}
            </>
          )}
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
              onClick={() => void Taro.showToast({ title: MEDIA_PENDING_TIP, icon: 'none' })}
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

          {/* 历史没读出来时也置灰：那时乐观气泡渲染不出来，发了也看不到反馈 */}
          <View
            className={`conv__send${inputValue.trim() && canSend ? '' : ' is-off'}`}
            onClick={send}
          >
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
