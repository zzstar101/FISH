import {
  type ConversationDto,
  MESSAGE_RECALL_WINDOW_MS,
  type MediaMessageDto,
  type MessageDto,
} from '@fish/contracts/chat/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import type { ScrollViewProps } from '@tarojs/components/types/ScrollView'
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import { SCAN_CODE_PAGE } from '@/components/scan-tabs/tabs'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import {
  createImageMessage,
  createVoiceMessage,
  markConversationRead,
  recallMessage,
  sendMessage,
} from '@/features/chat/api'
import { lastEventOfMessages } from '@/features/chat/capsule'
import {
  MEDIA_IMAGE_PICK_LIMIT,
  MediaAbortedError,
  voiceDurationLabel,
} from '@/features/chat/media'
import {
  cachedMediaPath,
  cacheMediaPath,
  clearMediaCache,
  downloadChatMedia,
  loadMediaPage,
  pickChatImages,
  type RecordedVoice,
  startVoiceRecording,
  uploadChatImage,
  uploadChatVoice,
  VoicePermissionError,
  VoicePrivacyError,
  type VoiceRecording,
  voiceError,
} from '@/features/chat/media-api'
import { ChatRealtime, type ChatRealtimeEvent } from '@/features/chat/realtime'
import { loadConversation, loadMessagePage } from '@/features/fetchers'
import { presenceView } from '@/features/presence/view'
import { requestSubscribe } from '@/features/subscribe/request'
import {
  acceptTransaction,
  fetchMyTransactionReview,
  fetchTransaction,
  rejectProposal,
} from '@/features/transaction/api'
import { fetchConversationTransaction } from '@/features/transaction/conversation'
import { meetupUrlById } from '@/features/transaction/order-links'
import { formatAmount } from '@/lib/money'
import { backButtonGeometry, readNavMetrics } from '@/lib/nav-metrics'
import {
  canEnterVoiceMode,
  getPrivacyAuthorizationState,
  requestPrivacyAuthorize,
} from '@/lib/privacy'
import { isApiError } from '@/lib/request'
import { sessionCookieHeader, sessionEpoch } from '@/lib/session'
import { clockTime, dayLabelOf } from '@/lib/time'
import { randomUuidV4 } from '@/lib/uuid'
import {
  applyMediaRecalled,
  applyPresenceEvent,
  applyPresencePoll,
  applyReadEvent,
  applyReadPoll,
  applyRecalled,
  applyReplyRecalled,
  BOTTOM_SLACK_PX,
  beginSend,
  type ChatEntry,
  canRetry,
  canRetryMedia,
  clearDeferredReload,
  type DeferredReload,
  deferReload,
  growBottomAllowance,
  hasEarlierPage,
  initialDeferredReload,
  isCurrentPlayRequest,
  isLatestPageLoad,
  isLatestPresencePoll,
  isNearBottom,
  isStaleMediaIdentity,
  isStaleMediaTask,
  keepRecalledMediaTombstones,
  keepRecalledTombstones,
  lastTxAcceptedId,
  listingStatusText,
  localReplyExcerpt,
  MESSAGE_ACTION_LABEL,
  type MediaTaskBinding,
  type MediaTaskIdentity,
  type MessageAction,
  mediaActions,
  mergePushedMedia,
  mergePushedMessage,
  mergeRefreshedMedia,
  mergeRefreshedMessages,
  mergeTimeline,
  mergeViewportShrink,
  messageActions,
  messageReadLabel,
  nextKeyboardInset,
  type PendingMedia,
  type PendingMediaDraft,
  type PendingMessage,
  parseTxEvent,
  planMediaLoad,
  planScrollFix,
  REPLY_DROPPED_TIP,
  type ReplyTarget,
  recallFailureText,
  resetDeferredReload,
  resolveBottomInset,
  resolveBottomReserveStyles,
  resolveConvState,
  resolvePanelHeightPx,
  resolveSentinel,
  settleSend,
  shouldDropReplyOnSendFailure,
  shouldFlushDeferredReload,
  shouldHandOffToKeyboard,
  shouldReloadOnShow,
  sortMessages,
  startMediaRetry,
  stickAfterScroll,
  systemPillText,
  type TxBarAction,
  txBarView,
} from './view'
import VoiceRecordPanel from './voice-record-panel'
import { applyVoiceAutoStop, applyVoiceRelease, isVoiceCancelArmed } from './voice-recording-view'

import './index.scss'

/**
 * 会话详情页（#89：历史 / 发送 / 已读全部接真实接口；#359 3b：接上媒体）。
 *
 * 页头与气泡布局沿用 1版稿（见 `index.scss`），本页改的是**数据来源与状态机**：
 *
 * 1. 会话详情 `GET /conversations/:id`、历史 `GET /conversations/:id/messages`、
 *    发送 `POST /conversations/:id/messages`、已读 `POST /conversations/:id/read`
 *    （**只在详情与首屏历史都成功之后才发**，见 `load` 内的说明）；
 * 2. 历史按契约的 `before` 游标「加载更早的消息」，不再假设一次能拿全；
 * 3. 发送是**真实落库**：本地乐观气泡在成功后被服务端返回的那条替换（按 id 去重，
 *    实时推送送来的同一条不会重复），失败留在原地给重试 —— 不再有「假装成功」的态；
 * 4. 删除契约里不存在的展示件：认证徽章（`conversationUserSchema` 无 `authStatus`）、
 *    `tx.completed` 评价卡（交易域没有这个事件）、以及媒体消息与上传/播放的本地模拟
 *    （#67 的范围）。其中「每条消息的已读标记」当年是照 #149 未合入删掉的（理由已过期），
 *    #359 四 用契约的 `counterpartLastReadAt` 把它接回来 —— 判据见 `./view` 的
 *    `messageReadLabel`，只标我发出的气泡。读位由进页 / 从子页返回 / 点重试、本页的
 *    **详情轮询**（`DETAIL_POLL_MS`，只补读位与在线态、不 bump epoch、不重发已读），
 *    以及 `conversation.read` 的**实时推送**（`features/chat/realtime`）刷新；
 *    原先注释把「发送落定后的静默补刷」当常规刷新时机是错的：那条路径只在「发送未落定
 *    就离开本页、再回来」时才发生（见 `./view` 的 `shouldFlushDeferredReload`）。
 * 5. **媒体（#359 3b）**：图片 / 拍照 / 语音走 `features/chat/media-api` 的真实链路
 *    （`presign → 直传 PUT → create`），与文本合成**一条**时间线。
 *
 * 页头商品卡的状态、SYSTEM 事件的中文化、时间文案都走 `./view` 的纯函数（有用例）。
 *
 * **账号作用域（#170）**：`conversation` / `messages` / `media` / `pending` / `inputValue`
 * 等都是「当前登录用户」视角下的状态。换账号时在**渲染期同步**清场并自增 epoch，
 * 让上一个账号的在途响应全部判过期（否则 A 的「发消息」可能在 B 的会话里落地）；
 * 从子页（商品详情 / 交易码页）返回时由 `useDidShow` 重拉详情 + 历史，覆盖那边
 * 可能发生的写操作。详见 `prevUserId` 与 `useDidShow` 处的注释。
 */

/**
 * 「+」面板（1版稿 3 格）：图片 / 拍照都走真实媒体链路（相册 / 相机由
 * `Taro.chooseMedia` 的 `sourceType` 决定，对发送流程没有区别）；商品卡是另一件事。
 */
const PANEL_TILES = [
  { key: 'image', label: '图片', icon: ICONS.imageMuted },
  { key: 'camera', label: '拍照', icon: ICONS.cameraMuted },
  { key: 'product', label: '商品', icon: ICONS.cartFg },
] as const

/**
 * 媒体语音气泡上的波形条（与 1版稿 `.wave i` 的 12 根同形）。
 *
 * 高度写死不用 `Math.random()`：随机高度会让每次重渲染都变一副面孔，且同一段语音
 * 在两次进页面时长得不一样（真机上尤其明显）。
 */
const WAVE_BARS = [14, 24, 36, 20, 40, 28, 16, 32, 22, 12, 26, 18].map((height, index) => ({
  id: `bar-${index}`,
  height,
}))

/**
 * 空 id 集：给「只做按 id 并集 + 定序、不保留任何本地项」的合并调用（加载更早的媒体）。
 * 抽成常量而不是每处 `new Set()`：语义是「没有需要特殊保留的 id」。
 */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/**
 * 详情轮询周期（#359 四 的读位 + #359 第五点 的在线态）。
 *
 * 取 20s：这是「对方读没读」「对方在不在线」这类状态的合理粒度（用户不会盯着一个标签
 * 等秒级精确），又与 `GET /conversations/:id` 的既有刷新节奏同量级 —— 一次详情请求，
 * 成本可忽略。20s 也与服务的在线窗口（`PRESENCE_ONLINE_TTL_MS = 60s`）成比例：最坏
 * 情况下「对方断线」要等 TTL + 一跳才在端上体现（约 80s）。
 *
 * **两个字段共用一条**（#376 收口，Owner 决策）：它们同源（同一份会话详情）、同周期、
 * 同守卫，拆成两条 20s 轮询只会让同一端点每 20s 被请求两次，且两条的守卫还不一致。
 */
const DETAIL_POLL_MS = 20_000

/**
 * 收键盘活性哨兵的超时（#560 R2）。
 *
 * 安卓收键盘动画通常 200~300ms，取 500ms 留余量：到点闩还在，说明平台没报 0（或闩被误置），
 * 强落 0 并重指尾行。只在页面刚叫过 `Taro.hideKeyboard()` 之后武装，不是常驻轮询。
 */
const KEYBOARD_SENTINEL_MS = 500

/** 取第一个触点的 clientY（拿不到就给 NaN，调用方按「不知道手指在哪」处理） */
function touchClientY(event: unknown): number {
  const touch = (event as { touches?: Array<{ clientY?: number }> } | null)?.touches?.[0]
  return typeof touch?.clientY === 'number' ? touch.clientY : Number.NaN
}

export default function Conversation() {
  const authStatus = useAuthGuard()
  const { user: me } = useAuth()
  const router = useRouter<{ id?: string }>()
  const conversationId = router.params.id ?? ''
  /** 当前账号身份：账号作用域 state 的清场与加载门禁都要用它（见下） */
  const userId = me?.id ?? null

  const [conversation, setConversation] = useState<ConversationDto | null>(null)
  /** 详情状态：`missing`（真的没这条会话）与 `failed`（没读到）必须分开渲染 */
  const [convState, setConvState] = useState<'loading' | 'ok' | 'missing' | 'failed'>('loading')
  const [messages, setMessages] = useState<MessageDto[]>([])
  const [msgState, setMsgState] = useState<'loading' | 'ok' | 'failed'>('loading')
  /**
   * 这条会话**当前**那笔交易（#522）。终态（COMPLETED / CANCELLED）按契约不产生
   * SYSTEM 消息，所以顶部那一条只能由交易域驱动；`failed` 时保留上一次的值，绝不拿
   * 「没查到」当「已完成」，也不清空已有入口（`view.ts` 的 `txBarView` 会在
   * 完全取不到时退回消息里的 `tx.accepted` id）。
   */
  const [txLoad, setTxLoad] = useState<{
    status: 'idle' | 'ok' | 'failed'
    tx: TransactionDto | null
  }>({ status: 'idle', tx: null })
  /**
   * 交易查询的 latest-wins 序号：进页 load / 20s 轮询 / 失败重试三条路径都会查，
   * 只有**最后发出**的那次能落状态 —— 否则先发后到的旧 PENDING 快照会把已经拿到的
   * COMPLETED 覆盖回「待面交」（#522 第 1/4/6 条）。
   */
  const txSeqRef = useRef(0)
  /**
   * 当前会话里「我」的角色：轮询重试交易列表时需要它决定查 buyer 还是 seller 视角。
   * 用 ref 而不是把 `conversation` 塞进轮询 effect 依赖 —— 后者每跳都被 presence 更新，
   * 会让定时器反复重建。
   */
  const txRoleRef = useRef<TransactionDto['role']>('buyer')
  /** 交易查询成功：状态条与页头商品摘要一起换（成交后 listing 会变 SOLD，不能只换状态词） */
  const applyTx = useCallback((tx: TransactionDto | null) => {
    setTxLoad({ status: 'ok', tx })
    if (!tx) return
    setConversation((prev) =>
      prev !== null && prev.id === tx.conversationId && prev.listing.id === tx.listing.id
        ? { ...prev, listing: { ...prev.listing, status: tx.listing.status } }
        : prev,
    )
  }, [])
  /**
   * 我在这笔交易下有没有评价（#551 的「评价」档）。交易域没有评价字段
   * （`transactionDtoSchema` 不含），端上要判「待评价」只能另查一次评价边 ——
   * 判据是 404 `REVIEW_NOT_FOUND` = 还没评；其余失败**不当成未评价**（不猜）。
   */
  const [txReview, setTxReview] = useState<{ txId: string; reviewed: boolean } | null>(null)
  /**
   * 评价边的重查信号：`completedTxId` 只在交易 id 变化时才变，而「去面交页写完评价再
   * 返回本页」时 id 一个字都没变 —— 只靠 id 做依赖，顶栏会一直停在「评价」。所以每次
   * 回到本页都 ++，把它并进 effect 依赖里重查一次。
   */
  const [txReviewTick, setTxReviewTick] = useState(0)
  /**
   * 提案动作的共用锁（`待确认` / `拒绝` 都走它）：两颗钮都会写服务端，连点两次没有意义。
   */
  const acceptBusyRef = useRef(false)

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
  /**
   * 键盘占据的**设备 px**（0 = 收起），全页唯一的键盘高度真源（#560/#561）：
   * 输入栏的下内边距、消息流还剩多高都从它派生；平台不再按 `adjustPosition` 推页面。
   *
   * **只有 `onKeyboardHeightChange` 那一处写它**，且写进去的是 `nextKeyboardInset` 压出来
   * 的单调阶梯：安卓收键盘动画期间平台会连报若干递减中间值，逐帧跟着写就等于用自己的布局
   * 去和系统动画拼速度（真机上的「先上提、再回落」）。切态 / 开面板那些路径一律只
   * `Taro.hideKeyboard()`，高度由平台事件收到 0，本页不自己归零。
   */
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  /**
   * 尾行锚点的交替位（#561）：`scrollIntoView` 的值不变时原生层不会重滚，几何一变
   * （键盘升降、面板开合）就得换一个**同位**锚点再指一次，见 `tailAnchorId`。
   */
  const [tailAnchorFlip, setTailAnchorFlip] = useState(false)
  /**
   * 输入行**实测**高度（设备 px，0 = 还没量到）。
   *
   * 它已经不是布局来源了（#560 安卓真机的根因修掉之后）：输入框在两态之间**常驻**，语音态
   * 只是把它 `opacity: 0` 藏起来，`bar` 的高度自始至终由这一个输入框决定，不需要再拿实测
   * 高度去给「按住说话」顶 `minHeight`。现在它的用途只剩记账：`onLineChange` 拿它算
   * 「这次长高了多少」，交给贴底判据（`growBottomAllowance`），所以仍要跟着事件更新。
   *
   * 来源两处：`onLineChange`（行数一变就报高度，打字时最及时）与几何量测（进页面 / 切态
   * 后各量一次，兜住「一进页面就带多行草稿」这种没有行数变化事件的情况）。
   */
  const [inputRowPx, setInputRowPx] = useState(0)
  /**
   * 「把滚动偏移写回去」的复位指令（#561）。
   *
   * 原生层在几何突变时可能把滚动偏移整个丢掉（复现里就是掉成 0），而 `scrollTop` 属性只
   * 认「值有变化」——所以带一个自增 `tick`，让同一位置也能再下发一次（`0.5px` 的交替在端上
   * 看不出来，但足以让属性真的变一次）。只在**非贴底**时才用：贴底态直接重指尾行锚点更稳。
   *
   * 值**用过不撤**：撤掉等于让属性回到默认的 0，那正是本票要修的「偏移掉成 0」形态；而属性
   * 值不变时不会重新应用，所以长期绑着也不会压住后续滚动（换身份时才清场，见 `:580`）。
   */
  const [scrollRestore, setScrollRestore] = useState<{ top: number; tick: number } | null>(null)
  /**
   * 正在引用的消息（#359 3c）：非 null 时输入栏上方显示引用栏，发出的消息带摘引。
   * 存整条 DTO 而不是只存 id：引用栏要显示摘引文案，而服务端的 `replyTo` 投射只挂在
   * 「已发出的那条消息」上，被引用的原消息本身没有这个字段。
   */
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)
  /** 撤回在途的消息 id：一条一把锁，防止连点重复 POST（服务端虽幂等，但没必要发两次） */
  const [recallingId, setRecallingId] = useState<string | null>(null)
  /**
   * 「点摘引跳过去」的目标 DOM id（null = 跟随最新）。
   *
   * 与「打开即看最新」的 `tailId` 共用 ScrollView 的 `scrollIntoView`。`tail` 记下**设它时**
   * 的尾行 id：新消息一落地尾行就变，比对不上时目标自动失效、回到跟随最新（否则页面会
   * 永久停在被引用那条上，之后的消息看起来像「没进来」）。
   */
  const [jumpTo, setJumpTo] = useState<{ id: string; tail: string } | null>(null)
  /**
   * 媒体历史（#67 第四步）：与文本是**两条独立分页流**（独立 DTO / 独立端点 / 独立
   * 实时事件），渲染前要按 `(createdAt, id)` 合成一条时间线。
   */
  const [media, setMedia] = useState<MediaMessageDto[]>([])
  /** 媒体那条流的游标（契约参数叫 `cursor` 而不是 `before`）；null = 已到最早 */
  const [mediaCursor, setMediaCursor] = useState<string | null>(null)
  /** 本地乐观媒体（上传中 / 上传失败），永远排在服务端内容之后 */
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([])
  /**
   * 已下载到本地的媒体路径，按 `mediaId` 索引（**不是**消息 id：鉴权代理端点收的是
   * `mediaId`，`media-api` 的模块级缓存同样按它索引，键不统一则缓存永远命不中）。
   *
   * 为什么要有页面级这一份：模块缓存活过页面重建，而渲染读的是这里 —— 退出会话再进来
   * 时页面状态是空的，缓存里的路径必须回填进来，否则图片退化成占位块且永不重新下载。
   */
  const [localPaths, setLocalPaths] = useState<ReadonlyMap<string, string>>(() => new Map())

  /**
   * 记下一条媒体在本地的临时路径（按 `mediaId`）。
   *
   * 同时写**模块级缓存**：再进这个会话时不用重新下载（`cacheMediaPath` 的注释里
   * 「自己刚发出的媒体」就是指这条路径 —— 自己发的图 / 音就在本地，没必要回服务端取）。
   *
   * 幂等：同一个 `mediaId` 同一个 `path` 时**返回原 Map**（不是新 Map），否则这个
   * 稳定引用的回调会在自动下载的 effect 里被自己的 `setState` 反复触发。
   */
  const rememberPath = useCallback((mediaId: string, path: string) => {
    cacheMediaPath(mediaId, path)
    setLocalPaths((prev) => {
      if (prev.get(mediaId) === path) return prev
      const next = new Map(prev)
      next.set(mediaId, path)
      return next
    })
  }, [])
  /** 正在播放的语音（气泡的 `keyId`，与 `localPaths` 的 `mediaId` 是两个空间） */
  const [playingId, setPlayingId] = useState<string | null>(null)
  /** 正在录音（按住说话期间为真，用于切换按钮文案与高亮） */
  const [recording, setRecording] = useState(false)

  /** 加载代次：换会话 / 换账号 / 连点重试时只有最后一次的响应落地 */
  const epoch = useRef(0)
  /** 本地乐观消息的自增序号（只用于渲染 key 与重试定位） */
  const localSeq = useRef(0)
  /**
   * #462：本次进入会话是否已经问过 CHAT 订阅授权。用 ref 而不是 state：
   * 它不参与渲染，而 `doSend` 的闭包里必须读到**当前**值（连点两次不应该弹两次）。
   */
  const subscribeAsked = useRef(false)
  /**
   * 「已经发起过一次加载」标记：useDidShow 据此让渡首次触发给登录态 effect，
   * 不双发。声明在 `load` 之前是因为 `load` 的 useCallback 体内要引用它
   * （TDZ：const 在声明前访问会抛错）。
   */
  const loadedOnceRef = useRef(false)
  /**
   * 「发送中返回」延后刷新的状态（标记 + 当前 epoch 的在途发送数）。
   *
   * 计数必须**归属 epoch**，不能是裸的实例级计数器：A 的发送可能在换到 B 之后才落定，
   * 裸计数会让 A 的落定把 B 的计数也减掉（B 的补刷新被永久压制，或留下陈旧标记被
   * B 后续落定消费）。迁移只走 `./view` 的状态机函数，不变式由单测锁住。
   */
  const deferredRef = useRef<DeferredReload>(initialDeferredReload(0))
  /** 页面是否可见：不可见时不补刷新（回到本页时 didShow 会正常重拉） */
  const visibleRef = useRef(true)
  /** 组件是否还活着：卸载后不再补刷新（Taro 的 didHide 不覆盖卸载这一路径） */
  const aliveRef = useRef(true)
  /** 消息流视口高度（设备 px）：`onScroll` 的 detail 不带它，只能量一次 */
  const scrollViewportRef = useRef(0)
  /**
   * 消息流此刻是不是贴着底部（#561）。几何一变（键盘升降、面板开合）就据此决定要不要
   * 重指尾行：贴底就继续贴底，翻历史翻到一半就原地不动。
   */
  const stickBottomRef = useRef(true)
  /**
   * 最近一次滚动事件里的 `scrollTop`（#561）：几何变化前后拿它做「偏移有没有被原生层丢掉」
   * 的比对依据，也是非贴底时写回去的原值。
   */
  const scrollTopRef = useRef(0)
  /**
   * 本页自己造成的视口缩量（设备 px）：消息流刚矮了多少，就允许底部差临时大多少。
   *
   * 多行输入能把输入栏顶高几十 px（远超 `BOTTOM_SLACK_PX`），而滚动事件里可能是「旧
   * scrollTop + 新 scrollHeight」的中间态 —— 不给这段余量，一次多行切换就会把「贴底」
   * 判成「翻历史」，而后面的重锚全被守卫挡掉（#560 的「多行输入后再切更明显」）。
   *
   * 生命周期只有「几何变化 → 回读判完」这一小段：`keepTailAnchored` 的回读回调判完 `fix`
   * 就把它清零，`onScroll` 判到真贴底也清零。**不许只增不减** —— 余量长期留在高水位，用户
   * 上翻不到那么多时仍会被判成贴底，随后的重锚会把他从历史里拽回底部（#561 验收第一条）。
   */
  const bottomGapAllowanceRef = useRef(0)
  /**
   * `inputRowPx` 的同步镜像（#560/#561）：`onLineChange` 里要立刻算出「这次长高了多少」，
   * 等一轮渲染再读 state 就已经晚了（原生层的截断滚动事件可能先到）。
   */
  const inputRowPxRef = useRef(0)
  /**
   * `keyboardHeight` 的同步镜像与「正在收起」闩（#560）：键盘事件是常驻订阅，回调里读 state
   * 只会拿到订阅那一刻的旧值，阶梯判定必须看上一帧真正落地的高度（见 `nextKeyboardInset`）。
   */
  const keyboardHeightRef = useRef(0)
  const keyboardClosingRef = useRef(false)
  /**
   * 面板展开态的同步镜像（#597）：键盘事件是常驻订阅，回调里读 `panelOpen` 只会拿到订阅
   * 那一刻的旧值。面板展开期间底部高度由面板占，键盘事件的升降**不产生布局变化**，
   * 那几帧不许再重指尾行（否则收键盘动画的每一档都翻一次尾行锚点）。
   */
  const panelOpenRef = useRef(false)
  /**
   * 「面板刚刚换过态、下一次几何量测是被它引起的」（#597）：那一次量测的视口缩量
   * **不记进贴底容差**（判据见 `mergeViewportShrink` 的 `panelTransition`）。由
   * `panelOpen` 变化的那条 effect 置位，量测 effect 的当拍取走并清掉。
   */
  const panelGeomRef = useRef(false)
  /**
   * 展开面板那一刻用户是不是贴着底部（#597 追加任务）：面板几何落地后据此决定要不要
   * **再**指一次尾行。`true` 表示「落地后再锚一次」，由量测 effect 取走并清掉；
   * 展开时没贴底的人保持 `false`，落地后不会被拽回底部。
   */
  const panelOpenStickRef = useRef(false)
  /**
   * 意图闩的起点高度与「收尾尾巴」记录（#560 R1/R3）：`closing` 是**页面要求收起**的意图，
   * 不是从高度符号反推的 —— 安卓上切输入法 / 候选栏伸缩会让键盘「没关、只是变矮」，拿
   * 「变矮」当「开始收起」就会把闩误置、之后所有变高都被丢弃，内边距停在小值、更高的那把
   * 键盘把输入栏整条盖住。判据全在 `view.ts` 的 `nextKeyboardInset()` 里。
   */
  const keyboardClosingFromRef = useRef(0)
  const keyboardClosedFromRef = useRef(0)
  const keyboardClosedAtRef = useRef(0)
  /** 收起途中连续报到 `>= closingFrom` 的帧数（#560：连两帧才认作「键盘真被开回来」） */
  const keyboardAboveFromRef = useRef(0)
  /**
   * 「平台不报 0」的活性哨兵（#560 R2）：`hideKeyboard()` 之后平台若始终不报 `0`（或闩被误置），
   * 内边距会永久停在抬高位置。到点**先无条件解闩**，再按 `resolveSentinel()` 的结论决定落哪个
   * 高度 —— 这是**卡死兜底**，不是动画补偿：条件触发、`inset === 0` / 页面被盖住 / 卸载三处清理。
   */
  const keyboardSentinelRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 这一轮哨兵期内平台报过的最高高度（#560）：到点用它算「报过多少」，而不是拿「值有没有变」猜。
   * 拿「与快照是否相等」判断在原理上无解 —— 「报过且等于快照」（切回同一把键盘，最常见）会被
   * 判成「没报过」→ 强落 0 把输入栏埋进键盘；「报了中间值然后静默」（真该归零的兜底场景）会被
   * 判成「报过」→ 永久停在中间值。
   */
  const keyboardSentinelMaxRef = useRef(0)
  /** 阶梯里被丢弃的候选高度镜像（#560：终值只报一次时，哨兵兜底要优先落它，见 `pending`） */
  const keyboardPendingRef = useRef(0)
  /** 哨兵重新武装的次数（#560：这一拍下不了结论时最多再给一个周期，不无限重发 `hideKeyboard()`） */
  const keyboardSentinelRearmsRef = useRef(0)
  /**
   * 输入框此刻是否聚焦（#560）：哨兵到点唯一可信的**意图**信号 —— 还在输入框里就说明键盘大概
   * 率真开着，绝不猜 0；失焦才说明键盘该走。
   */
  const inputFocusedRef = useRef(false)
  /**
   * 重锚并发序号（#560 R5）：收键盘期间每接受一档高度都会 `keepTailAnchored()`，异步回读
   * 可能乱序落地 —— 旧那道的 `restore` 分支会把过期 `top` 写回去（`scrollWithAnimation`
   * 为假时是硬跳）。回调首行比对这个序号，过期的直接退出。
   */
  const anchorSeqRef = useRef(0)
  /**
   * 当前消息流的 id 快照来源（#186 P2-1）：silent 刷新发起时记下当时的 id 集合，
   * 落地时据此把「刷新期间才确认落地」的消息补回来。`load` 的 `useCallback` 依赖
   * 只有 `[conversationId]`，直接闭包读 `messages` 会永远拿到首帧的空数组。
   */
  const messagesRef = useRef<MessageDto[]>([])
  /**
   * 在线态轮询的启停把手（#376 审查回合，P3）：`useDidHide` 要能**真的**把表停掉 ——
   * 只在 tick 里判 `visibleRef` 是空转（定时器照常每 20s 走一圈），页面被盖住期间白烧唤醒。
   * effect 建立 / 收回把手，`useDidShow` / `useDidHide` 与卸载都从同一个把手进出。
   */
  const detailPollRef = useRef<{ start: () => void; stop: () => void } | null>(null)
  /**
   * 在线态轮询的请求序号（#376 审查回合，P3）：每跳自增，落地时只认最新一次。
   * 判据见 `./view` 的 `isLatestPresencePoll`（`applyPresencePoll` 是 last-write-wins，
   * 不设序号时先发的旧快照会盖掉后发的新结论）。
   */
  const presenceSeq = useRef(0)
  /** 媒体那条流的 id 快照来源（silent 合并要用，同 `messagesRef` 的理由） */
  const mediaRef = useRef<MediaMessageDto[]>([])
  /** 在途媒体（`useDidShow` 判「有在途发送」时要把上传中的媒体也算上） */
  const pendingMediaRef = useRef<PendingMedia[]>([])
  /** 当前这次录音的句柄（`null` = 没在录） */
  const recordingRef = useRef<VoiceRecording | null>(null)
  /* ---------------- 录音期反馈（#535）：上滑取消 ---------------- */
  /** 是否已滑到「松开取消」区（只驱动渲染，松手判定读 ref） */
  const [cancelArmed, setCancelArmed] = useState(false)
  const recordOriginYRef = useRef(Number.NaN)
  const cancelArmedRef = useRef(false)
  /**
   * 这次录音属于哪个身份（#364 审查的判据，复审指出重构后退化成恒假）：
   * 必须**起录时**拍，才能守住「松手 → 拿到音频」这段窗口里换号的情况。
   */
  const voiceIdentityRef = useRef<MediaTaskIdentity>({ cookie: '', userId: null })

  /**
   * 收掉录音期的显示态（取消态）。
   *
   * 计时器与秒数在 `VoiceRecordPanel` 内部（审查 medium：放页面会让整页消息流每秒重渲染），
   * 面板随 `recording` 卸载时自己清 interval —— 所以这里只需复位取消态。
   * 所有「录音结束」路径都必须过这里。
   */
  const resetRecordingUi = useCallback(() => {
    recordOriginYRef.current = Number.NaN
    cancelArmedRef.current = false
    setCancelArmed(false)
  }, [])
  /** 隐私授权弹窗在途：连点麦克风按钮时只弹一次，避免重复弹窗 */
  const privacyPendingRef = useRef(false)
  /** 语音授权在途的代次：await 回来时用户可能已经开了面板/离开页面，旧结果不许落地 */
  const voiceGateSeqRef = useRef(0)
  /** 语音播放器（切歌 / 离页 / 换账号都要先停掉） */
  const audioRef = useRef<ReturnType<typeof Taro.createInnerAudioContext> | null>(null)
  /** 正在下载的媒体 id：兜住「推送与 HTTP 同时把一条媒体放进流」造成的重复下载 */
  const downloadingRef = useRef<Set<string>>(new Set())
  /** 语音播放请求令牌：每次点击 +1，迟到的下载回来据此判「已经不是当前这次」 */
  const playSeqRef = useRef(0)
  /** 正在下载、还没出声的语音消息 id：撤回时要让这次下载失效，别再播出来。 */
  const loadingVoiceIdRef = useRef<string | null>(null)
  /**
   * 正在重试的媒体 id（#364 审查）：`canRetryMedia` 读的是**渲染态**，同一帧连点两次
   * 两次看到的都还是 `failed`，于是起两条链。必须有一把同步锁，在 `runMediaSend` 的
   * 落定处释放。
   */
  const retryingMediaRef = useRef<Set<string>>(new Set())
  /**
   * 长按气泡后同一次手势还会补一个 tap：不吞掉的话语音会播放、图片会预览、
   * 商品卡会跳详情（#518）。用布尔标志而不是时间窗（与 product-card 同一手法）；
   * onTouchStart 复位，避免 showActionSheet 被取消时把标志留到下一次正常点击。
   */
  const swallowBubbleTapRef = useRef(false)
  const beginBubbleLongPress = () => {
    swallowBubbleTapRef.current = true
  }
  const resetBubbleTapGuard = () => {
    swallowBubbleTapRef.current = false
  }
  const consumeBubbleTap = () => {
    if (!swallowBubbleTapRef.current) return false
    swallowBubbleTapRef.current = false
    return true
  }

  /**
   * 本页数据**属于哪个账号**。渲染期就能拿到上一帧的 `userId`，所以在**同一帧内**
   * 把账号作用域状态清干净，不会出现「B 的身份已经渲染、画的却是 A 的会话」。
   * 换成 `useEffect(() => setMessages([]), [userId])` 不行：effect 在 commit 之后才跑，
   * 泄漏帧照样存在（详见 chat / mylist / match 页同一写法的注释）。
   *
   * 同步 +1 `epoch`：让 A 在途的详情 / 历史 / 发消息响应落地前就被判过期，
   * 否则会写进刚清空的 state（C 判据）。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    // 身份清场 +1：作废 A 在途的所有响应。下面登录态 effect 紧接着会再 +1 占位
    // 本次 load —— 两者语义独立但共用计数器，判过期只看「是否相等」，不区分语义。
    epoch.current += 1
    // 语音授权是异步的：在途结果回来时若 seq 没变，会把新账号重新拉进语音态。
    voiceGateSeqRef.current += 1
    localSeq.current = 0
    // 待刷新标记与在途计数一起归到新 epoch：否则上个账号留下的陈旧标记会被
    // 新账号后续某次发送落定消费掉，闪一次无来由的整页加载。
    deferredRef.current = resetDeferredReload(epoch.current)
    setConversation(null)
    setConvState('loading')
    setMessages([])
    setMsgState('loading')
    setTxLoad({ status: 'idle', tx: null })
    setNextCursor(null)
    setLoadingEarlier(false)
    setEarlierFailed(false)
    setInputValue('')
    // 与 `send()` 同一条理由（#560）：换身份也把输入框清空了，输入行高度真源必须一起回落，
    // 否则下一个身份首个「切语音」还用着上一个身份草稿的多行高度
    setInputRowPx(0)
    inputRowPxRef.current = 0
    /*
     * 滚动状态也属于上一个身份（第五轮复审 N4）：`scrollRestore` 用过不撤，是本页唯一不再
     * 自动回落的滚动状态 —— 不清的话，新身份第一次复位会沿用上个账号的偏移；`scrollTopRef`
     * 是回读判据的基准，`bottomGapAllowanceRef` 是上个身份的容差余量，一并归位。
     */
    scrollTopRef.current = 0
    stickBottomRef.current = true
    bottomGapAllowanceRef.current = 0
    setScrollRestore(null)
    setPending([])
    setPanelOpen(false)
    setVoiceMode(false)
    setReplyTarget(null)
    setRecallingId(null)
    setMedia([])
    setMediaCursor(null)
    setPendingMedia([])
    setLocalPaths(new Map())
    setPlayingId(null)
    setRecording(false)
    /*
     * 录音 / 播放 / 已下载的临时文件都是「属于上一个身份」的副作用，必须在这里掐掉：
     * 换号后停下的那段录音会带着**新账号**的 Cookie 发出去，而缓存里是上一个身份的
     * 私有媒体临时文件，下一个身份不该复用（验收④的媒体侧对应物）。
     */
    recordingRef.current?.abort()
    recordingRef.current = null
    resetRecordingUi()
    audioRef.current?.destroy()
    audioRef.current = null
    downloadingRef.current.clear()
    /*
     * 在途的媒体重试锁同样属于上一个身份（#364 审查回合二）：`localSeq` 上面刚归零，
     * 新账号的第一条媒体会拿到与旧账号相同的 `local-N` 临时 id —— 不清锁的话，B 点重试
     * 会被 A 那条仍在飞的链的锁挡掉（`retryMedia` 静默 return，无提示、无状态变化）。
     */
    retryingMediaRef.current.clear()
    // 在途的语音下载到此失效：回来时不许再写缓存、更不许出声
    playSeqRef.current += 1
    clearMediaCache()
  }

  const metrics = useMemo(() => readNavMetrics(), [])
  const backGeo = backButtonGeometry(metrics.capsuleHeight)

  /**
   * 裸箭头（稿 `.mp-back`，无圆底；形态按 2026-10-02 拍板保留）：箭头是唯一视觉
   * 主体，比例沿用原 60px 热区配 24px 箭头的 0.4，随「热区 = 胶囊高」等比缩放。
   */
  const bareChevronStyle = useMemo(() => {
    const chevron = Math.round(backGeo.size * 0.4)
    return {
      width: `${chevron}px`,
      height: `${chevron}px`,
      borderLeftWidth: `${Math.max(2, Math.round(backGeo.size * (5 / 60)))}px`,
      borderBottomWidth: `${Math.max(2, Math.round(backGeo.size * (5 / 60)))}px`,
      borderRadius: '1px',
      transform: `translateX(${Math.round((chevron / 6) * 2) / 2}px) rotate(45deg)`,
    }
  }, [backGeo.size])

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
   *
   * `silent`：**后台刷新**（「发送中返回」被延后到发送落定后补的那一次）。与用户主动
   * 进页 / 点重试不同，它发生在用户没有请求刷新的时刻，所以：
   * - 不把界面推进 `loading`（不闪骨架）；
   * - 失败时**只做确认、不做降级**：历史半边失败保留当前消息流与失败气泡，详情半边
   *   失败也不把已经 `ok` 的 `convState` 打回 `failed` —— 否则「发送失败 + 弱网下补刷新
   *   也失败」会把失败气泡和它的「重试」一起盖掉（发送失败本就要留在原地给重试）。
   *
   * 注意这是**一次性 best-effort**：补刷新的标记在发起前就清掉了，这一次失败不会有
   * 自动重试，也不会再次补。silent 失败**不产生可见的错误入口**（`convState`/`msgState`
   * 都保持原值，页面上不会有 `LoadError`）—— 重新同步只发生在下一次用户主动进页、
   * 下一次从子页返回，或历史半边失败时消息区那个重试钮。
   */
  const load = useCallback(
    (options?: { silent?: boolean }) => {
      if (!conversationId) {
        setConvState('missing')
        setMsgState('ok')
        return
      }
      const silent = options?.silent === true
      const current = ++epoch.current
      /**
       * 刷新要先记下**发起时**的消息 id 快照：落地时用它把本次刷新期间才确认落地的
       * 消息挑出来补回（见 `mergeRefreshedMessages`）。
       *
       * 这条**不再只属于 silent**（#89 实时通道）：推送随时可能落在一次非 silent 重拉的
       * 在途期（最典型的是 `useDidShow` 从子页返回时的重拉），而历史快照可能拍在那条消息
       * commit 之前 —— 整份替换会把它抹掉，且 20s 详情轮询不刷消息流，用户要等到下一次
       * 重拉才看得见。`mergeRefreshedMessages` 的规则不变：基准集之内的旧条目仍以服务端
       * 快照为准（翻过的更早一页照旧被丢弃），只有「发起之后才出现」的才补回。
       */
      const baseIds = new Set(messagesRef.current.map((item) => item.id))
      /** 媒体半边同理（见下）：silent 合并要按**发起时**的媒体 id 集做并集 */
      const mediaBaseIds = new Set(mediaRef.current.map((item) => item.id))
      /**
       * 上面刚把 epoch 推进，任何在途的「更早一页」就此判过期（它的守卫会挡住写入，
       * `finally` 也不会还锁 —— 见 `isLatestPageLoad`）。锁必须在这里主动收回，
       * 否则那个游标的分页永久锁死。
       *
       * `setEarlierFailed(false)` 仍只在非 silent 时清：silent 不重拉首屏，顺手清掉
       * 会把用户刚看到的失败提示降级成普通按钮（同 `resolveConvState` 的理由）。
       */
      setLoadingEarlier(false)
      // 标记「已经发起过一次加载」：didShow 据此让渡首次给登录态 effect，不双发
      loadedOnceRef.current = true
      if (!silent) {
        setConvState('loading')
        setMsgState('loading')
        // 「更早一页没加载出来」的重试提示只属于会重拉首屏的那几次；silent 不重拉首屏，
        // 在这里清掉会把用户刚看到的失败提示降级成普通按钮（见 `resolveConvState` 同理）。
        setEarlierFailed(false)
      }
      void Promise.all([
        loadConversation(conversationId),
        loadMessagePage(conversationId),
        loadMediaPage(conversationId),
      ])
        .then(([detail, page, mediaPage]) => {
          if (current !== epoch.current) return
          if (detail.status === 'ok') {
            setConversation(detail.conversation)
            txRoleRef.current = detail.conversation.role
            /**
             * 交易进度单独查（#522）：聊天记录里的 `tx.accepted` 是不可变事件，成交 /
             * 取消都不再写 SYSTEM 消息，只看消息流会永远停在「待面交」。所以每次
             * load（进页、从子页返回、断线补刷）都顺带查一次交易域。
             *
             * 首屏历史里如果有 `tx.accepted`，就带上它的 id 走精确查询 —— 列表接口
             * 最多翻 `MAX_PAGES × PAGE_SIZE` 条，老用户的目标交易可能被截断。
             *
             * 失败**不降级成任何终态**：`failed` 交给 `txBarView` 渲染成「交易状态待更新」
             * （有消息里的 id 就给面交页入口，没有就给重试钮），绝不复用上一次的
             * `tx` 冒充当前状态。下一次 load / 手动重试都会再查。
             */
            const txSeq = ++txSeqRef.current
            void fetchConversationTransaction(
              conversationId,
              detail.conversation.role,
              lastTxAcceptedId(page.items),
            )
              .then((tx) => {
                if (current !== epoch.current || txSeq !== txSeqRef.current) return
                applyTx(tx)
              })
              .catch((error) => {
                console.warn('[miniapp] 会话交易进度加载失败', error)
                if (current !== epoch.current || txSeq !== txSeqRef.current) return
                setTxLoad((prev) => ({ status: 'failed', tx: prev.tx }))
              })
          }
          /**
           * 后台刷新（silent）**只做确认、不做降级**（判据见 `./view` 的 `resolveConvState`）。
           *
           * `prev` 走 `setState` 的函数式更新：`load` 的 `useCallback` 依赖只有
           * `[conversationId, applyTx]`（`applyTx` 自身稳定），直接读闭包里的 `convState`
           * 会永远拿到首帧的 `loading`。
           */
          setConvState((prev) => resolveConvState(prev, detail.status, silent))
          if (!(silent && page.failed)) {
            /**
             * 刷新**合并**而不是替换（#186 P2-1，实时通道后扩到非 silent）：它带回来的
             * 快照可能早于本次刷新期间才落地的消息（发送确认、或实时推送进来的对方消息），
             * 无条件 `setMessages(page.items)` 会把那条抹掉。
             *
             * 两条路径都要过 `keepRecalledTombstones`（#359 3c 审查回合）：撤回在途
             * 15s 内任何一次 `load()` 都可能带着「撤回前」的快照回来，把刚落地的
             * 撤回碑写回正文。判据与理由见 `./view`。
             */
            setMessages((prev) =>
              keepRecalledTombstones(prev, mergeRefreshedMessages(prev, page.items, baseIds)),
            )
            setNextCursor(page.nextCursor)
            setMsgState(page.failed ? 'failed' : 'ok')
          }

          /**
           * 媒体历史是**独立一条流**（契约 `GET /conversations/:id/media`，游标参数叫
           * `cursor` 而不是 `before`）。它失败**不连坐消息区**：文字照常显示，媒体半边
           * 保留现状等下一次 load 重试，绝不把 `msgState` 打回 failed —— 那会把已经读到
           * 的整屏文字换成错误卡。
           *
           * **失败一律不落地**（不只是 silent）：失败时 `loadMediaPage` 回的是
           * `{ items: [], nextCursor: null, failed: true }`，照常写入会把屏幕上已有的
           * 图片 / 语音**整批抹掉**、游标也一起清空 —— 而媒体没有自己的错误态，用户看到
           * 的是「消息凭空少了」且无从重试（#359 3b 审查）。成功时走并集合并（与消息流
           * 同理，非 silent 也要合并：推送可能在本次重拉在途期落进 `media`）。
           */
          if (!mediaPage.failed) {
            setMedia((prev) =>
              keepRecalledMediaTombstones(
                prev,
                mergeRefreshedMedia(prev, mediaPage.items, mediaBaseIds),
              ),
            )
            setMediaCursor(mediaPage.nextCursor)
          }

          /**
           * 已读放在**详情与首屏历史都真的拿到了**之后，而不是一进页面就发。
           *
           * 否则「消息没加载出来」（还没 loading 完、或详情成功而历史失败）也会把服务端
           * 读位推掉：用户屏幕上一条消息都没看到，未读却已经清零，返回列表红点不亮 ——
           * 等于把消息吞了。幂等：重试成功后再发一次，读位只前进，无害。
           *
           * 必须再过一次 epoch 守卫：本 load 发起后、响应落地前若发生换账号，
           * 这里不能拿新账号的 cookie 去推旧账号会话的读位（跨账号副作用）。
           *
           * **页面不可见时不推**（#89 实时通道补的闸）：实时客户端在 `useDidHide` 后
           * 仍然活着，断线重连的补刷（`onOpen` → 本函数）会在页面被盖住时跑一次，
           * 无条件上报会把用户**根本没看到**的新消息清成已读。与 web-pc 的
           * `read-receipt.ts` 同一口径：隐藏期的未读留给回到本页时的那次重拉（didShow）。
           */
          if (
            current === epoch.current &&
            detail.status === 'ok' &&
            !page.failed &&
            visibleRef.current
          ) {
            void markConversationRead(conversationId).catch((error) =>
              console.warn('[miniapp] 标记会话已读失败', error),
            )
          }
        })
        .catch((error) => {
          // 两个 loader 自己都吞了接口失败，这里兜的是更外层（例如动态 import fixture 也失败）
          console.warn('[miniapp] 会话页加载异常', error)
          if (current !== epoch.current) return
          // 后台刷新失败不改动已在屏幕上的消息流（见上）
          if (silent) return
          setConvState('failed')
          setMsgState('failed')
        })
    },
    [conversationId, applyTx],
  )

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    load()
  }, [authStatus, userId, load])

  /**
   * 从子页返回（商品详情 / 交易码页）时重拉：那边可能改了商品 / 交易状态，
   * 本页的会话详情与历史都是账号作用域的快照，回来就过期。
   *
   * 首次加载由登录态 effect（上方）负责，不在 didShow 里重复触发。判定「已加载
   * 过一次」用 `loadedOnceRef`：它在 `load` 把请求真正发出后才置 true（见 `load`
   * 函数体），早于任何后续 `useDidShow` 的触发时机 —— 这样即使冷启动时
   * `authStatus === 'unknown'`（首次 didShow 早于 effect 跑），恢复登录后那一次
   * didShow 也会正确让渡给 effect，**不会**双发。
   *
   * `authStatus` / `userId` / `load` / `pending` 都走 ref 读最新值：`useDidShow`
   * 的回调注册一次，直接闭包会读到旧状态。
   *
   * 重拉会重新推一次已读：读位只前进，幂等。
   *
   * **有在途发送时不是「跳过」，是「延后」**：用户在子页跳转前发了消息、HTTP 响应
   * 还没回来，此时重载会把 `epoch` +1，在途的 `doSend` 响应被判过期丢弃 —— 乐观
   * 气泡永远停在「发送中」。所以这里只 `deferReload` 记一个标记，等当前 epoch 的所有
   * 发送落定后由 `doSend` 的 finally 补一次刷新（判据见 `view.ts` 的 `DeferredReload`
   * 状态机）。不置位而直接丢弃的话，这一次返回的详情 / 历史 / 已读同步就永远不发生了。
   */
  const authedRef = useRef(false)
  const userIdRef = useRef<string | null>(null)
  const loadRef = useRef(load)
  const pendingRef = useRef<PendingMessage[]>([])
  /** 实时补刷的门禁要读「当前详情态」：handler 每次渲染重建，读 ref 拿最新值 */
  const convStateRef = useRef(convState)
  /** 详情轮询要读「当前交易态」：判断是否还在 PENDING_MEETUP（决定要不要刷进度） */
  const txLoadRef = useRef(txLoad)
  authedRef.current = authStatus === 'authed'
  userIdRef.current = userId
  loadRef.current = load
  pendingRef.current = pending
  messagesRef.current = messages
  mediaRef.current = media
  pendingMediaRef.current = pendingMedia
  convStateRef.current = convState
  txLoadRef.current = txLoad
  useDidShow(() => {
    visibleRef.current = true
    // 回到本页：把在线态的轮询表续上（隐藏时真的停掉了，见 useDidHide）
    detailPollRef.current?.start()
    // 从面交页写完评价回来时交易 id 不变，靠这个信号让「评价 / 查看」重新判一次
    setTxReviewTick((tick) => tick + 1)
    /**
     * 「有在途发送」把媒体也算上：上传中的媒体与发送中的文本是同一个危害 ——
     * 此刻重拉会把 `epoch` +1，在途的直传 / create 响应被判过期，乐观气泡永远停在
     * 「上传中」。所以这里同样只记待刷新标记，等落定后由 `runMediaSend` 的 finally 补。
     */
    const sending =
      pendingRef.current.some((item) => item.status === 'sending') ||
      pendingMediaRef.current.some((item) => item.status === 'uploading')
    if (
      !shouldReloadOnShow({
        loadedOnce: loadedOnceRef.current,
        authed: authedRef.current,
        hasUserId: userIdRef.current !== null,
        sending,
      })
    ) {
      // 有在途发送时记下待刷新；其余情况（首次显示 / 未登录）不需要补
      if (sending) deferredRef.current = deferReload(deferredRef.current)
      return
    }
    deferredRef.current = clearDeferredReload(deferredRef.current)
    loadRef.current()
  })
  useDidHide(() => {
    visibleRef.current = false
    /**
     * 页面被盖住，键盘也随之收起：真源跟着归零，回来时输入栏不会挂在原来的键盘高度上。
     *
     * 同步镜像和「正在收起」闩要一起清 —— 否则下一次事件的高度等于镜像里的旧值，阶梯会
     * 判定「没变化」直接丢掉，输入栏就一直贴在那条看不见的键盘高度上。
     */
    keyboardClosingRef.current = false
    keyboardClosingFromRef.current = 0
    keyboardClosedFromRef.current = 0
    keyboardClosedAtRef.current = 0
    keyboardAboveFromRef.current = 0
    keyboardHeightRef.current = 0
    // 页面被盖住，输入框必然失焦；重新武装的预算也一起作废（R2 清理点之三）
    inputFocusedRef.current = false
    keyboardSentinelRearmsRef.current = 0
    // 哨兵也收掉（R2 清理点之三）：页面都被盖住了，500ms 后再跑一次重锚没有意义
    clearKeyboardSentinel()
    setKeyboardHeight(0)
    // 页面被盖住：在线态已经不显示了，把轮询停掉（不再让定时器在后台空转每一跳）
    detailPollRef.current?.stop()
    /**
     * 切后台就放弃这次录音：`RecorderManager` 在后台可能被系统掐掉，`onStop` 不一定
     * 回来；留着 `recordingRef` 会让回到前台后按不下去（判定里它非空）。
     */
    recordingRef.current?.abort()
    recordingRef.current = null
    resetRecordingUi()
    setRecording(false)
    /**
     * 语音播放也要停（#364 审查）：`navigateTo` 子页（商品详情 / 交易码页）只 hide
     * 不卸载，本页的 `InnerAudioContext` 会一直响下去 —— 用户已经在子页里了，
     * 声音却还从上一个页面出来。卸载那条路径由下面的 effect 负责，这里补上 hide。
     */
    stopAudio()
  })
  /** 卸载后不再补刷新（didHide 不覆盖卸载这一路径），同时回收录音与播放器 */
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      recordingRef.current?.abort()
      recordingRef.current = null
      // 卸载不一定会走 useDidHide：这里必须把录音期显示态收掉，
      // 否则计时面板的 interval 会随页面一起变成孤儿（#535 审查 medium）
      resetRecordingUi()
      audioRef.current?.destroy()
      audioRef.current = null
      // 在途的语音下载到此失效（与身份清场同理）：离页后回来不许出声
      playSeqRef.current += 1
    }
  }, [resetRecordingUi])

  /**
  /**
   * 把服务端媒体的字节拉到本地临时文件（验收⑤：不能拼公开对象存储地址，
   * `<Image>` / `innerAudioContext` 也带不了 Cookie，只能走带 header 的 `downloadFile`）。
   *
   * 依赖只有 `media`：下载结果进的是 `localPaths` 与 `media-api` 的模块级缓存，
   * 而 `rememberPath` 是稳定引用且幂等，所以这里不会被「自己写 state」反复触发。
   * `downloadingRef` 兜住同一批里重复的 id（推送与 HTTP 可能同时把一条媒体放进 `media`）。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null || !conversationId) return
    /**
     * 这一批下载属于**哪个身份**（#67 复查 #222）。`downloadChatMedia` 会在写模块缓存前
     * 再问一次 —— 下载是异步的，回来时可能已经换号 / 离页，那份字节属于上一个身份，
     * 写进模块缓存就会被下一个身份复用（私有媒体的临时文件不该跨身份）。
     */
    const task: MediaTaskBinding = { epoch: epoch.current, cookie: sessionCookieHeader() ?? '' }
    const isActive = () =>
      aliveRef.current &&
      userIdRef.current === userId &&
      !isStaleMediaTask(task, { epoch: epoch.current, cookie: sessionCookieHeader() ?? '' })
    for (const item of media) {
      /**
       * 撤回碑没有字节可下（服务端撤回后 `url` 就是空的）：下载只会白跑一趟，
       * 而渲染分支只画「撤回了一条消息」、不读 `localPaths`。
       */
      if (item.recalledAt !== null) continue
      // N1：媒体的身份是 `mediaId` —— 契约里 `id` 是**消息** id，鉴权代理端点收的也是
      // `mediaId`。缓存键同样用 `mediaId`，否则 `media-api` 的模块级 LRU 永远命不中，
      // 每次进页面都会把同一条媒体重新下载一遍。
      const plan = planMediaLoad({
        cached: cachedMediaPath(item.mediaId),
        downloading: downloadingRef.current.has(item.mediaId),
      })
      if (plan.kind === 'reuse') {
        /*
         * 模块级缓存命中也必须回填**本页**的路径映射（#67 复查 #222）。
         * `localPaths` 是页面级 state，退出会话再进来时它是空的，而渲染只读它 ——
         * 修复前这里直接 `continue`，于是缓存还在、页面状态没了，图片退化成占位块
         * 且永远不会重新下载（缓存命中把下载也挡住了）。`rememberPath` 幂等，不会白渲染。
         */
        rememberPath(item.mediaId, plan.path)
        continue
      }
      if (plan.kind === 'skip') continue
      downloadingRef.current.add(item.mediaId)
      void downloadChatMedia(conversationId, item.mediaId, isActive)
        .then((path) => {
          if (!isActive()) return
          rememberPath(item.mediaId, path)
        })
        .catch((error) => {
          // 换号 / 离页导致的中止是预期路径，不当失败打日志
          if (error instanceof MediaAbortedError) return
          console.warn('[miniapp] 媒体下载失败', error)
        })
        .finally(() => {
          downloadingRef.current.delete(item.mediaId)
        })
    }
  }, [authStatus, userId, conversationId, media, rememberPath])

  /**
   * 详情轮询（#359 四 的读位 + #359 第五点 的在线态，Owner 决策合并成一条）。
   *
   * 实时客户端（下方 effect）接走 `conversation.read` / `presence.changed` 的推送之后，
   * 这条轮询从「唯一路径」降级为**兜底**，但仍然不可删：
   * - 服务端只推「离线→在线」的转变，「在线→离线」没有事件（TTL 到期的瞬间没有任何
   *   请求），离线过期要靠这条轮询重拉详情、按同一个 `PRESENCE_ONLINE_TTL_MS` 体现；
   * - WS 断开 / 重连的窗口里（推送不保证不漏），读位与在线态仍由它按 20s 收敛。
   *
   * 只做一件事：拉一次详情、只把 `counterpartLastReadAt` 与 `counterpartPresence` 写回
   * —— 不碰消息流与分页游标、不 bump epoch（否则在途发送的响应会被判过期丢弃）、不重发
   * 已读上报（那是「用户真的看到了首屏」才该做的副作用）。
   *
   * 判据：只在「已登录 + 详情已就绪」时挂表；每跳还要过三道守卫 —— 页面可见性 / 存活
   * （`aliveRef`）、加载代次（换会话 / 换账号 / 整页重拉都 +1）、以及本跳的**请求序号**
   * （同一代次内乱序回来的旧快照不许盖掉新结论，见 `isLatestPresencePoll`）。读位另有
   * 一道数值兜底（`applyReadPoll` 只取更晚的那份）。
   *
   * 页面被盖住（`useDidHide`）时**真的把表停掉**，不是让定时器空转着每跳判一次可见性；
   * 回到本页（`useDidShow`）再续上（#376 审查回合，P3）。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null || convState !== 'ok') return
    /** 本轮的定时器；`null` 表示表停着（页面隐藏 / effect 已收回） */
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const start = () => {
      if (timer !== null) return
      timer = setInterval(() => {
        if (!visibleRef.current || !aliveRef.current) return
        const current = epoch.current
        /**
         * 进度卡实时性（#522）：契约没有交易推送，成交 / 取消也不写 SYSTEM 消息 ——
         * 对方在我停留期间确认或取消时，本页只能靠自己轮询。进展中只多打一个按 id
         * 的详情请求（进终态后这一跳自然停掉），不重拉交易列表。
         */
        const txState = txLoadRef.current
        if (txState.status === 'failed') {
          /**
           * 上一次查询失败：每一跳重试一次列表 —— 顶部状态条那一档会摆「重新加载」，
           * 但用户不点也不该被永久卡住；普通聊天没有交易证据时顶部只显示商品状态，
           * 恢复后交易会话的「待面交 / 待对方确认」会自己回来。
           */
          const txSeq = ++txSeqRef.current
          void fetchConversationTransaction(
            conversationId,
            txRoleRef.current,
            lastTxAcceptedId(messagesRef.current),
          )
            .then((tx) => {
              if (current !== epoch.current || txSeq !== txSeqRef.current || !visibleRef.current)
                return
              applyTx(tx)
            })
            .catch((error) => {
              console.warn('[miniapp] 会话交易进度轮询重试失败', error)
              if (current !== epoch.current || txSeq !== txSeqRef.current || !visibleRef.current)
                return
              setTxLoad((prev) => ({ status: 'failed', tx: prev.tx }))
            })
        } else if (txState.tx?.status === 'PENDING_MEETUP') {
          const txSeq = ++txSeqRef.current
          void fetchTransaction(txState.tx.id)
            .then((tx) => {
              if (current !== epoch.current || txSeq !== txSeqRef.current || !visibleRef.current)
                return
              applyTx(tx)
            })
            .catch((error) => {
              console.warn('[miniapp] 会话交易进度轮询失败', error)
              if (current !== epoch.current || txSeq !== txSeqRef.current || !visibleRef.current)
                return
              /** 失败记进状态：下一次渲染至少知道「这一跳没读到」，不把缓存当最新 */
              setTxLoad((prev) => ({ status: 'failed', tx: prev.tx }))
            })
        }
        presenceSeq.current += 1
        const seq = presenceSeq.current
        void loadConversation(conversationId).then((detail) => {
          if (detail.status !== 'ok') return
          if (
            !isLatestPresencePoll({
              seq,
              epoch: current,
              latestSeq: presenceSeq.current,
              latestEpoch: epoch.current,
            })
          ) {
            return
          }
          setConversation((prev) =>
            prev === null
              ? prev
              : applyPresencePoll(applyReadPoll(prev, detail.conversation), detail.conversation),
          )
        })
      }, DETAIL_POLL_MS)
    }
    detailPollRef.current = { start, stop }
    /**
     * 依赖变化会让 effect 重跑，但**页面被盖住时它仍是挂着的**：这时不许把表重新走起来，
     * 否则「隐藏即停表」会被一次无关的状态变化作废。启动交给 didShow。
     */
    if (visibleRef.current) start()
    return () => {
      stop()
      detailPollRef.current = null
    }
  }, [authStatus, userId, convState, conversationId, applyTx])

  /**
   * 实时收到**对方**消息时补一次已读上报（#89 实时通道）。
   *
   * 缺了这一步会出现「用户明明正看着，返回列表却还是红点」：本页的已读上报只在
   * `load()` 里发，而详情轮询刻意不重发已读（那是「用户真的看到了首屏」的副作用），
   * 实时推送本身又不会推进读位。判据与 web-pc 一致（`conversation-page.tsx` 的
   * `onIncomingMessage`）：只对**别人发的**消息、且**页面可见**时上报 —— 页面被盖住
   * （`useDidHide` 跳去了子页）时不许清未读，那些消息用户一条都没看到。
   *
   * 幂等：读位只前进，连发多条时多报几次无害；服务端会把 `conversation.read` 推给
   * 双方，本页按 `readerId === 我` 过滤掉自己的回声。
   */
  const markIncomingRead = (senderId: string | null) => {
    if (senderId === null || senderId === userIdRef.current) return
    if (!visibleRef.current || !aliveRef.current) return
    if (convStateRef.current !== 'ok') return
    void markConversationRead(conversationId).catch((error) =>
      console.warn('[miniapp] 实时消息标记已读失败', error),
    )
  }

  /**
   * 实时事件（`features/chat/realtime`）的落地。除 `presence.changed` 按用户推送外，
   * 其余事件覆盖「我参与的全部会话」，本页只消费当前打开的这一条 —— 其它会话的
   * 红点仍由 `features/chat/unread.ts` 的端点快照驱动，不在本页职责内（要做
   * 「挂着会话页时别的会话亮红点」得先给未读 store 加事件源，另起一批）。
   *
   * 各事件复用发送/轮询路径已经锁过的合并语义（都有用例）：
   * - `message.new` / `media.new` → `mergePushedMessage` / `mergePushedMedia`：
   *   按 id 去重 + `(createdAt, id)` 定序。服务端「先落库、再推送、再回 HTTP」，
   *   推送与自己发送的 HTTP 响应会赛跑，谁先到都只落一次；对方发来的还要补一次
   *   已读上报（`markIncomingRead`）；
   * - `conversation.read` → `applyReadEvent`：只推进对方的读位（`readerId` 是自己
   *   的那次是本人在另一台设备的读回声，不碰本页的「已读」标签）；
   * - `presence.changed` → `applyPresenceEvent`：只写命中对方的那次（其余字段不动，
   *   推送里也没有整份详情可写）。下线仍由详情轮询按 TTL 过期，见上；
   * - `message.recalled` → `applyRecalled` + `applyMediaRecalled`：与 `doRecall` 的
   *   成功落地同一形态，幂等 —— 自己撤回时本地已先落碑，服务端的权威 `recalledAt`
   *   再落一次无害；正在引用的那条被撤回时收起引用栏（与 `doRecall` 同一步）。
   *   两条流都要落：撤回端点对 TEXT / MEDIA 没有类型过滤。
   */
  /**
   * 「silent 补刷一次会话」的稳定引用：断线重连与「对方刚接受交易」（#522）共用。
   * 声明提前是因为事件处理闭包要用它；实现体在下面（依赖 pending / deferred 等 ref）。
   */
  const realtimeOpenRef = useRef<() => void>(() => {})
  const realtimeEventRef = useRef<(event: ChatRealtimeEvent) => void>(() => {})
  realtimeEventRef.current = (event) => {
    // pong 在客户端内部就被心跳消费掉（`handleMessage`），这里到不了；
    // 类型层也要先排除它 —— 它没有 `conversationId`，不过闸没法比。
    if (event.type === 'pong') return
    // presence.changed 是**按用户**推的（没有会话 id）：命中对方就写，别的用户上线不关本页事
    if (event.type === 'presence.changed') {
      setConversation((prev) =>
        prev === null ? prev : applyPresenceEvent(prev, event.userId, event.presence),
      )
      return
    }
    // 其余四类都带会话 id：推送覆盖「我参与的全部会话」，本页只消费当前打开的这一条
    if (event.conversationId !== conversationId) return
    switch (event.type) {
      case 'message.new': {
        setMessages((prev) => mergePushedMessage(prev, event.message))
        markIncomingRead(event.message.senderId)
        /**
         * 对方刚接受交易时补刷一次（#522）：交易行是那一刻才创建的，本页不重拉就
         * 只剩一条「已接受交易」的胶囊，顶部的交易状态要等到下次进页才更新。走 `silent`
         * 并复用「有在途发送就延后」的闸 —— 它的语义与 didShow 那次重拉完全相同。
         */
        if (
          event.message.type === 'SYSTEM' &&
          parseTxEvent(event.message.content)?.type === 'tx.accepted'
        ) {
          realtimeOpenRef.current()
        }
        break
      }
      case 'media.new':
        setMedia((prev) => mergePushedMedia(prev, event.media))
        markIncomingRead(event.media.senderId)
        break
      case 'conversation.read':
        if (event.readerId === userIdRef.current) break
        setConversation((prev) => (prev === null ? prev : applyReadEvent(prev, event.readAt)))
        break
      case 'message.recalled':
        setMessages((prev) =>
          applyReplyRecalled(
            applyRecalled(prev, event.messageId, event.recalledAt),
            event.messageId,
          ),
        )
        // 媒体走独立一条流：撤回端点对 TEXT / MEDIA 没有类型过滤，图片 / 语音的撤回碑
        // 必须同时落到 `media`（否则气泡纹丝不动，刷新也修不回来 —— 见 view 的说明）
        setMedia((prev) =>
          applyReplyRecalled(
            applyMediaRecalled(prev, event.messageId, event.recalledAt),
            event.messageId,
          ),
        )
        setPendingMedia((prev) => applyReplyRecalled(prev, event.messageId))
        stopVoiceForRecall(event.messageId)
        setReplyTarget((prev) => (prev?.id === event.messageId ? null : prev))
        break
    }
  }

  /**
   * 连接建立（含断线重连后的每一次）的补刷。推送**不保证不漏**（契约冻结语义），
   * 断线窗口里落库的消息必须用历史端点补回来，否则 WS 恢复后用户盯着屏幕、
   * 断线期间的来话永远不会出现（20s 详情轮询只补读位与在线态，不刷消息流）。
   *
   * 走 silent：不闪骨架、失败不降级。两道闸：
   * - 首屏还在 `loading` 时不补 —— 补刷会 bump epoch，把在飞的首屏 load 判过期；
   *   补刷自己是 silent（失败不降级），首屏会卡在「正在加载」没有重试钮。这个窗口
   *   由首屏自己的响应收口；真正要补的缺口（断线重连）发生在 ok 之后。
   * - 有在途发送（含媒体上传）时**只记账不补** —— 与 `useDidShow` 的延后刷新
   *   同一纪律，由落定后的 finally 补（`DeferredReload` 状态机）。
   */
  realtimeOpenRef.current = () => {
    if (convStateRef.current === 'loading') return
    const sending =
      pendingRef.current.some((item) => item.status === 'sending') ||
      pendingMediaRef.current.some((item) => item.status === 'uploading')
    if (sending) {
      deferredRef.current = deferReload(deferredRef.current)
      return
    }
    loadRef.current({ silent: true })
  }

  /**
   * 连接生命周期：页面实例挂载期间保持**一条** `/ws/chat`（不是每个会话一条），
   * 随登录态 / 账号重建 —— cookie 在建链那一刻重读，换号后旧连接必须让位
   * （服务端按会话推「该账号参与的全部会话」，旧连接推的是 A 的消息流）。
   *
   * 事件分发有一道**身份闸**：建链那一刻记下属主账号，分发时账号已变（换号清场
   * 把 state 清空、effect 清理还没跑到的窗口）就丢弃 —— 不然 A 的推送会落进
   * B 刚清空的会话里。`onOpen` 的补刷同样要过闸：那是拿 A 的会话 cookie 在发请求。
   *
   * 静默失败是刻意的：后端不在 / 未登录被 401 拒绝时，客户端指数退避重连、
   * 不弹提示 —— 页面退回「没有实时」的既有形态（详情轮询兜底），与 web-pc 同口径。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null || !conversationId) return undefined
    const owner = userId
    const client = new ChatRealtime({
      onEvent: (event) => {
        if (userIdRef.current !== owner) return
        realtimeEventRef.current(event)
      },
      onOpen: () => {
        if (userIdRef.current !== owner) return
        realtimeOpenRef.current()
      },
    })
    client.start()
    return () => client.stop()
  }, [authStatus, userId, conversationId])

  /**
   * 「加载更早的消息 / 媒体」：契约的 `before` / `cursor` 游标原样回传，拼接在已有数据之前。
   *
   * 消息与媒体是**两条独立的分页流**、各有自己的游标（#67 N3）。修复前入口用文本游标当
   * 唯一门槛（`if (!nextCursor) return`），文本翻到底而媒体还有历史时按钮消失、剩下的
   * 媒体再也拉不出来。现在只要任一条还有更早的，就翻那一条。
   */
  const loadEarlier = () => {
    if (loadingEarlier) return
    const textBefore = nextCursor
    const mediaBefore = mediaCursor
    if (!hasEarlierPage(textBefore, mediaBefore)) return
    const current = epoch.current
    setLoadingEarlier(true)
    const jobs: Promise<unknown>[] = []

    if (textBefore) {
      setEarlierFailed(false)
      jobs.push(
        loadMessagePage(conversationId, textBefore).then((page) => {
          if (!isLatestPageLoad(current, epoch.current)) return
          if (page.failed) {
            setEarlierFailed(true)
            return
          }
          setMessages((prev) => sortMessages([...page.items, ...prev]))
          setNextCursor(page.nextCursor)
        }),
      )
    }

    /**
     * 媒体历史跟着一起往前翻（它有自己的游标）。失败只记日志：媒体翻页失败不该让
     * 消息区显示「更早的消息没加载出来」。
     */
    if (mediaBefore) {
      jobs.push(
        loadMediaPage(conversationId, mediaBefore)
          .then((page) => {
            if (!isLatestPageLoad(current, epoch.current)) return
            if (page.failed) return
            setMedia((prev) => mergeRefreshedMedia(prev, page.items, EMPTY_IDS))
            setMediaCursor(page.nextCursor)
          })
          .catch((error) => {
            console.warn('[miniapp] 加载更早的媒体失败', error)
          }),
      )
    }

    void Promise.all(jobs).finally(() => {
      /**
       * 还锁也要过同一个守卫（#186 P2-2）：这一批已经属于上一代时锁已被 `load`
       * 收回、甚至已被新账号的分页重新拿起，无条件 `setLoadingEarlier(false)`
       * 会把新账号在途的那次分页放掉，同一个游标被并发消费两次。
       */
      if (!isLatestPageLoad(current, epoch.current)) return
      setLoadingEarlier(false)
    })
  }

  /**
   * 发一条文本消息。`pendingId` 存在时是「重试同一颗失败气泡」，不新增气泡。
   *
   * 响应落地前要过 epoch 守卫：A 在飞的发送可能在换到 B 之后才 resolve，
   * 若不判过期，A 的消息会写进 B 的 `messages`（`pending` 已随身份清空，
   * 但 `setMessages` 会把 A 的气泡追加到 B 的会话流）。
   *
   * `finally` 里补「发送中返回」被延后的那次刷新（`DeferredReload` 状态机，见 `./view`）：
   * 落定先过 `settleSend`（陈旧 epoch 的落定原样返回，不会污染当前 epoch 的计数），
   * 再由 `shouldFlushDeferredReload` 判「是否该补且真的能发」。补的那一次走
   * `load({ silent: true })`：后台刷新不闪骨架，失败也不盖掉失败气泡与它的重试。
   *
   * `reply`（#359 3c）是本次要引用的消息；重试时沿用失败气泡里记下的那份，
   * 而不是读当时的 `replyTarget` state —— 用户可能已经取消引用栏了。
   */
  const doSend = (
    text: string,
    pendingId?: string,
    reply?: { id: string; excerpt: string } | null,
  ) => {
    /*
      #462：进入会话后**第一次**点「发送」时请求 CHAT 订阅授权（Owner 冻结的授权入口）。

      三条约束都在这一处满足：只在点击回调里调（本函数就是点击/重试的处理器）、只在**新消息**
      时请求（重试不重复打扰）、不 `await` 不阻塞（授权被拒或失败都不影响这条消息发出去）。
      一次性订阅是"允许一次加一次额度"，所以只需要问一次；`?` 的额度用尽时端上不会自动再问
      —— 再问一次就是一次没有内容支撑的弹窗。
    */
    if (pendingId === undefined && !subscribeAsked.current) {
      subscribeAsked.current = true
      void requestSubscribe(['CHAT'])
    }
    // 新气泡才需要新序号；重试沿用原来的临时 id（赋值不能塞进表达式，见 noAssignInExpressions）
    let id = pendingId
    if (!id) {
      localSeq.current += 1
      id = `local-${localSeq.current}`
    }
    const current = epoch.current
    deferredRef.current = beginSend(deferredRef.current, current)
    setPending((prev) =>
      pendingId
        ? prev.map((item) => (item.id === id ? { ...item, status: 'sending' } : item))
        : [...prev, { id, content: text, status: 'sending', replyTo: reply ?? null }],
    )
    void sendMessage(conversationId, text, reply?.id)
      .then((message) => {
        if (current !== epoch.current) return
        setPending((prev) => prev.filter((item) => item.id !== id))
        // 服务端「先落库、再推送、再回 HTTP」：实时推送可能先到，这里按 id 去重；
        // 再按 `(createdAt, id)` 重排 —— 连发两条时响应可能乱序回来
        setMessages((prev) =>
          sortMessages(prev.some((item) => item.id === message.id) ? prev : [...prev, message]),
        )
      })
      .catch((error) => {
        if (current !== epoch.current) return
        console.warn('[miniapp] 发送消息失败', error)
        const code = isApiError(error) ? error.code : undefined
        /**
         * 引用失效（422 `MESSAGE_REPLY_INVALID`）必须把这条气泡的引用摘掉：
         * `retry` 会把 `item.replyTo` 原样传回来，不摘就是每次重试必然 422 的死循环。
         * 判据见 `./view` 的 `shouldDropReplyOnSendFailure`。
         */
        const dropReply = shouldDropReplyOnSendFailure(code)
        setPending((prev) =>
          prev.map((item) =>
            item.id === id
              ? { ...item, status: 'failed', replyTo: dropReply ? null : item.replyTo }
              : item,
          ),
        )
        if (dropReply) void Taro.showToast({ title: REPLY_DROPPED_TIP, icon: 'none' })
        if (code === 'CONVERSATION_UNAVAILABLE') {
          // 拉黑守卫（#466）：服务端中性文案直出（与媒体路径的 error.message 直显同口径），
          // 不暴露「谁拉黑了谁」；失败气泡保留可重试——解除拉黑后重试即恢复。
          void Taro.showToast({
            title:
              error instanceof Error && error.message !== ''
                ? error.message
                : '会话当前不可用，暂时无法发送消息',
            icon: 'none',
          })
        }
      })
      .finally(() => {
        deferredRef.current = settleSend(deferredRef.current, current)
        if (
          !shouldFlushDeferredReload({
            state: deferredRef.current,
            authed: authedRef.current,
            hasUserId: userIdRef.current !== null,
            visible: visibleRef.current && aliveRef.current,
          })
        ) {
          return
        }
        deferredRef.current = clearDeferredReload(deferredRef.current)
        loadRef.current({ silent: true })
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
    /*
      输入框清空回单行，「语音态沿用输入行高度」的真源必须跟着回落（#560）。
      不回落的后果：输入 3 行（≈145.6rpx）→ 发送 → 点话筒 → `.conv__hold` 拿 145.6rpx 当
      `minHeight` 把输入栏顶高 ≈39px、消息流矮一截 —— 又变回「切态时消息流跳一下」。
      置 0 让下一次量测（`inputRowPx` 变 0 会触发量测 effect）回填清空后的真实高度；
      量不到就退回 scss 的 68rpx，恰好等于单行输入框的真实高度。
    */
    setInputRowPx(0)
    // 同步镜像一起清掉：留着上一次的多行高度，下一轮「这次长高多少」会从旧值起算而算成 0。
    // 置 0 后由量测 effect 在下一帧用清空后的真实高度回填（单行 68rpx，就是 `.conv__hold` 的
    // 默认高度），中间那一帧人来不及输入。
    inputRowPxRef.current = 0
    // 引用只跟着这一条发出：发完立刻收起引用栏（下一条默认不引用，与微信一致）
    const reply = replyTarget
      ? { id: replyTarget.id, excerpt: localReplyExcerpt(replyTarget) }
      : null
    setReplyTarget(null)
    doSend(text, undefined, reply)
  }

  const retry = (item: PendingMessage) => {
    if (!canRetry(item)) return
    doSend(item.content, item.id, item.replyTo ?? null)
  }

  /**
   * 重试一条失败的媒体（与文本的 `retry` 同一道门禁）。
   *
   * 门禁不能省：`runMediaSend` 自己不看状态，重试期间（`uploading`）再点一次会起第二条
   * 链。若失败发生在**直传**阶段（`uploaded === null`），两条链各签发一个 objectKey 却
   * 共用同一个 `clientRequestId` → 一条 201、一条 409 `IDEMPOTENCY_KEY_REUSED`，外加
   * 一个没人引用的 PUT 对象 —— 正是「重试只重发 create」要躲开的那个 409。
   *
   * `canRetryMedia` 读的是**渲染态**（#364 审查）：同一帧里连点两次时，第二次拿到的
   * `item` 还是那份 `status: 'failed'` 的旧对象，门禁形同虚设。所以再加一把**同步锁**
   * （`retryingMediaRef`），落定后由 `runMediaSend` 的 finally 释放。
   */
  const retryMedia = (item: PendingMedia) => {
    if (!canRetryMedia(item)) return
    if (retryingMediaRef.current.has(item.id)) return
    retryingMediaRef.current.add(item.id)
    runMediaSend(item)
  }

  /**
   * 媒体发送：直传 → create 两段（#359 3b）。
   *
   * **重试只重发 create**：媒体创建的幂等指纹里含 `objectKey`（服务端
   * `mediaRequestHash`）。若重试时重新直传，presign 会签发一个**新的** objectKey，
   * 同一个 `clientRequestId` 配上不同的指纹 → 服务端判 `IDEMPOTENCY_KEY_REUSED`（409），
   * 而不是重放那条已经创建好的媒体。所以 `uploaded` 一旦拿到就存进 `PendingMedia`
   * 并原样复用；这也顺带省掉一次白传。
   *
   * 与 `doSend` 共用 `DeferredReload` 计数与 epoch 守卫：上传中返回上一页时的补刷新、
   * 换账号时作废在途响应，两条路径的语义完全一致。
   */
  const runMediaSend = (draft: PendingMedia) => {
    const current = epoch.current
    /**
     * 这份任务属于哪个账号的会话、以及**本页是否还在**（#67 N2 + #359 3b 审查）。
     *
     * `epoch` 挡不住「A 选了图 → 切到 B → create 才发出去」：`request.ts` 的每个请求
     * 都是**发出时**才读 `fish_session`，换号后旧任务会带着 B 的 Cookie 落库，B 的会话里
     * 凭空多出一条自己没发过的媒体。所以这里记下发起时的 Cookie，每一步网络请求前都比
     * 一次，一变就整条放弃（对象存储里的半成品不落库，旧账号的界面已被身份清场清空）。
     *
     * `aliveRef` 是另一半：**离页（navigateBack 卸载）不会推进 `epoch`**，只判代次的话
     * 用户退出会话后 presign / PUT / create 仍会照发 —— 正是上传层 `assertMediaActive`
     * 要挡的那些「没人引用的对象」。所以离页与换号在这里走同一条闸。
     */
    const task: MediaTaskBinding = { epoch: current, cookie: sessionCookieHeader() ?? '' }
    const isStale = () =>
      !aliveRef.current ||
      isStaleMediaTask(task, { epoch: epoch.current, cookie: sessionCookieHeader() ?? '' })
    deferredRef.current = beginSend(deferredRef.current, current)
    // N4：重试时先把气泡切回「上传中」，否则整段重试期间它还挂着失败态与重试按钮
    if (current === epoch.current) {
      setPendingMedia((prev) =>
        prev.map((item) => (item.id === draft.id ? startMediaRetry(item) : item)),
      )
    }
    void (async () => {
      let uploaded = draft.uploaded
      if (!uploaded) {
        /**
         * 把在途判据一路传进上传层（#67 复查 #222）：`isStale()` 只在整条链**返回之后**
         * 跑，那是写状态的守卫；而链里是「读文件 → presign → 直传 PUT」，后两步会照常发出。
         * `request.ts` 的 Cookie 是发出那一刻现取的，所以换号后 create 会带着新账号落库、
         * PUT 还会在对象存储里留下没人引用的对象。上传层每步发请求前都问一次 `isStale()`。
         */
        const isActive = () => !isStale()
        uploaded =
          draft.kind === 'IMAGE'
            ? await uploadChatImage(
                conversationId,
                {
                  path: draft.path,
                  mime: draft.image.mime,
                  width: draft.image.width,
                  height: draft.image.height,
                  sizeBytes: draft.image.sizeBytes,
                },
                isActive,
              )
            : await uploadChatVoice(
                conversationId,
                { path: draft.path, durationMs: draft.durationMs },
                isActive,
              )
        // 上传期间换了账号：这条媒体不能再以新账号的身份创建（N2）
        if (isStale()) return null
        setPendingMedia((prev) =>
          prev.map((item) => (item.id === draft.id ? { ...item, uploaded } : item)),
        )
      }
      // 直传只写对象存储，`create` 才是落库那一步 —— 落库前再确认一次身份
      if (isStale()) return null
      return uploaded.kind === 'IMAGE'
        ? await createImageMessage(conversationId, {
            objectKey: uploaded.objectKey,
            contentType: uploaded.contentType,
            sizeBytes: uploaded.sizeBytes,
            width: uploaded.width,
            height: uploaded.height,
            clientRequestId: draft.clientRequestId,
            replyToId: draft.replyTo?.id,
          })
        : await createVoiceMessage(conversationId, {
            objectKey: uploaded.objectKey,
            contentType: uploaded.contentType,
            sizeBytes: uploaded.sizeBytes,
            durationMs: uploaded.durationMs,
            clientRequestId: draft.clientRequestId,
            replyToId: draft.replyTo?.id,
          })
    })()
      .then((created) => {
        if (created === null) return
        if (isStale()) return
        // 自己刚发出去的这张图 / 这段音就在本地，直接记下来：不重新下载，也不闪一下空白。
        // 键用 `mediaId`（N1）：渲染查的 `localPaths` 与模块级缓存都按它索引
        rememberPath(created.mediaId, draft.path)
        setPendingMedia((prev) => prev.filter((item) => item.id !== draft.id))
        setMedia((prev) => mergePushedMedia(prev, created))
      })
      .catch((error) => {
        /*
         * 换号 / 离页导致的上传链中止（`MediaAbortedError`）是**预期路径**：这条媒体已经不
         * 属于当前身份，既不提示也不置失败态（身份清场已经把气泡清掉了，弹一句
         * 「发送失败」只会让新账号看到一条无来由的报错）。#67 复查 #222。
         */
        if (error instanceof MediaAbortedError || isStale()) return
        console.warn('[miniapp] 发送媒体失败', error)
        // 引用失效（422 MESSAGE_REPLY_INVALID）与文本发送同口径：把这条的引用摘掉，
        // 否则重试会把同一个失效的 replyTo 再发一遍，永远 422（#518）。
        const code = isApiError(error) ? error.code : undefined
        const dropReply = shouldDropReplyOnSendFailure(code)
        void Taro.showToast({
          title: dropReply
            ? REPLY_DROPPED_TIP
            : error instanceof Error
              ? error.message
              : '发送失败，请重试',
          icon: 'none',
        })
        setPendingMedia((prev) =>
          prev.map((item) =>
            item.id === draft.id
              ? { ...item, status: 'failed', replyTo: dropReply ? undefined : item.replyTo }
              : item,
          ),
        )
      })
      .finally(() => {
        // 还掉重试锁（#364 审查）：失败的话用户还要能再点一次
        retryingMediaRef.current.delete(draft.id)
        deferredRef.current = settleSend(deferredRef.current, current)
        if (
          !shouldFlushDeferredReload({
            state: deferredRef.current,
            authed: authedRef.current,
            hasUserId: userIdRef.current !== null,
            visible: visibleRef.current && aliveRef.current,
          })
        ) {
          return
        }
        deferredRef.current = clearDeferredReload(deferredRef.current)
        loadRef.current({ silent: true })
      })
  }

  /** 新建一条本地乐观媒体并开始上传（图片 / 语音共用） */
  const sendMedia = (
    draft: PendingMediaDraft,
    /**
     * 多选图片时由调用方显式下发：第一张拿引用，其余传 `null`。
     * 不能在这里读 `replyTarget` —— `setReplyTarget(null)` 要等下一次渲染，同步循环里
     * 每一张都会读到同一个旧值，导致整批图都带上同一条引用（#518 审查）。
     */
    replyOverride?: ReplyTarget | null,
  ) => {
    // 引用只跟着这一条发出：先快照，再收起引用栏（与文本 `send` 同一口径；#518）
    const target = replyOverride === undefined ? replyTarget : replyOverride
    const reply = target ? { id: target.id, excerpt: localReplyExcerpt(target) } : null
    setReplyTarget(null)
    localSeq.current += 1
    const item: PendingMedia = {
      ...draft,
      ...(reply ? { replyTo: reply } : {}),
      id: `local-${localSeq.current}`,
      uploaded: null,
      status: 'uploading',
    }
    setPendingMedia((prev) => [...prev, item])
    runMediaSend(item)
  }

  /**
   * 当前身份（账号 + 会话 Cookie），**不含 `epoch`**（判据见 `./view` 的
   * `isStaleMediaIdentity`）。
   *
   * 读 `userIdRef` 而不是闭包里的 `userId`：这些判据都在 `await` 之后才跑，闭包读到的
   * 是发起那一刻的旧值，而身份要按**回来时**算（换号正是发生在 await 期间）。
   */
  const currentIdentity = () => ({
    cookie: sessionCookieHeader() ?? '',
    userId: userIdRef.current,
  })

  /**
   * 「这份内容因为**换号**作废了」的提示（#364 审查）。
   *
   * 身份没变就不该丢（那只是整页重拉，不是换人）；真的换了账号就必须说一句 ——
   * 静默 return 会让用户以为「点了没反应」。离页（`aliveRef` 为假）不提示：用户已经
   * 不在这个页面上了；令牌不匹配（用户自己又点了一次）也不提示，那不是作废。
   */
  const noticeIdentityLost = (identity: MediaTaskIdentity, message: string) => {
    if (!aliveRef.current) return
    if (!isStaleMediaIdentity(identity, currentIdentity())) return
    void Taro.showToast({ title: message, icon: 'none' })
  }

  /** 「图片 / 拍照」：选图 → 逐张发送（多选时每张各自一条消息，互不阻塞） */
  const pickAndSendImages = async (source: 'album' | 'camera') => {
    if (!canSend) {
      void Taro.showToast({ title: '消息还没加载完，稍后再试', icon: 'none' })
      return
    }
    let picked: Awaited<ReturnType<typeof pickChatImages>>
    /**
     * 选图可能要好几秒（用户还要在相册里挑），期间任何一次 `load()` —— 切后台再回来、
     * 发送落定后的补刷新 —— 都会把 `epoch` +1。那是「整页重拉」不是「换人」，所以这里
     * 记的是**身份**而不是代次（#364 审查）：拿 epoch 当身份会把用户刚选好的图静默丢掉。
     */
    const identity: MediaTaskIdentity = {
      cookie: sessionCookieHeader() ?? '',
      userId: userIdRef.current,
    }
    try {
      // 相机一次只拍一张（微信 `chooseMedia` 在 `camera` 源下同样只给一张）
      picked = await pickChatImages(source === 'camera' ? 1 : MEDIA_IMAGE_PICK_LIMIT, source)
    } catch (error) {
      void Taro.showToast({
        title: error instanceof Error ? error.message : '无法选择图片',
        icon: 'none',
      })
      return
    }
    // 离页（navigateBack 卸载）：这一批已经没人接了，静默丢弃
    if (!aliveRef.current) return
    // 选图期间换了账号：这批图是上一个账号选的，不能以新身份发出去（N2）
    if (isStaleMediaIdentity(identity, currentIdentity())) {
      // 不能静默 return：用户明明选了图，什么都不发生会被当成页面坏了
      void Taro.showToast({ title: '账号已切换，请重新选择图片', icon: 'none' })
      return
    }
    if (picked.rejected) {
      void Taro.showToast({ title: picked.rejected, icon: 'none' })
    }
    // 引用是「这一条」的，不是「这一批」的：同步循环里 setState 还没生效，
    // 必须显式只给第一张（其余传 null），否则整批图都会复制同一个 replyToId（#518 审查）。
    const replyForBatch = replyTarget
    for (const [index, image] of picked.images.entries()) {
      sendMedia(
        {
          kind: 'IMAGE',
          clientRequestId: randomUuidV4(),
          path: image.path,
          image: {
            mime: image.mime,
            width: image.width,
            height: image.height,
            sizeBytes: image.sizeBytes,
          },
        },
        index === 0 ? replyForBatch : null,
      )
    }
  }

  /**
   * 录音失败的统一出口（#364 审查）。两个入口共用：
   * - `startVoiceRecording` 的 `onError` —— 录音**还在进行中**（用户手指还按着）；
   * - `finishVoice` 的 `.catch` —— 松手之后才失败。
   *
   * 通常 `recording` 必须先复位：不复位的话按钮还写着「松开 发送」，用户以为在录、其实
   * 什么都没录。但**上一段**的失败可能晚到——那时用户已经在录下一段了，复位就会把正在录的
   * 那一段打死（面板消失、按钮回到「按住 说话」，这一段从此没人收尾），所以由调用方用
   * `resetUi` 说明「现在复位是否还安全」（#535 follow-up F1）。同一条判断也决定**提不提示**：
   * 晚到的失败与用户当下的操作无关，弹出来只会让他以为刚说的话没录上（#549 审查 L3）。
   *
   * 权限被拒要给「去设置」入口，用的是与扫码页（`pages/scan` / `pages/scan-pr`）同一范式：
   * `Taro.getSetting` 先确认这个 scope 真的是被用户拒的，再 `Taro.openSetting` 把人送进
   * 设置页。不是被拒（例如麦克风被别的应用占着）就别拉设置页，那会让用户白跑一趟。
   */
  const handleVoiceFailure = (error: unknown, options: { resetUi?: boolean } = {}) => {
    console.error('[miniapp] 录音失败', error)
    const resetUi = options.resetUi ?? true
    if (resetUi) {
      recordingRef.current = null
      setRecording(false)
      resetRecordingUi()
    }
    /*
      `resetUi === false` 说明这是**上一段**晚到的失败（用户已经在录下一段）：除了不许复位
      正在录的那一段，也不许用打断式 toast / 弹窗抢注意力 —— 他既分不清这条提示说的是哪一段，
      还会以为刚说的那句话没录上。降级成上面的 `console.error`（#549 独立审查 L3）。
    */
    if (!resetUi) return
    const failure = voiceError(error)
    if (failure instanceof VoicePrivacyError) {
      // 平台在录音阶段才报 privacy：先退回键盘态，下一次点话筒会重新走授权闸；
      // 同时给一个「去授权」入口，避免只能看到同一句 toast 反复出现（#526 审查）。
      setVoiceMode(false)
      void Taro.showModal({
        title: '需要隐私授权',
        content: failure.message,
        confirmText: '去授权',
        cancelText: '取消',
      })
        .then((modal) => {
          if (!modal.confirm) return
          // 这个分支前面已经 setVoiceMode(false)；授权成功后要把用户送回语音态，
          // 否则「请按住说话」指向的是已被卸载的控件（#526 审查）。
          const gateSeq = ++voiceGateSeqRef.current
          return requestPrivacyAuthorize().then((authorized) => {
            if (!authorized) {
              void Taro.showToast({ title: '隐私授权未完成，请检查微信隐私设置', icon: 'none' })
              return
            }
            if (gateSeq !== voiceGateSeqRef.current || !aliveRef.current) return
            setPanelOpen(false)
            setVoiceMode(true)
            void Taro.showToast({ title: '已授权，请按住说话', icon: 'none' })
          })
        })
        .catch(() => undefined)
      return
    }
    if (!(failure instanceof VoicePermissionError)) {
      void Taro.showToast({ title: failure.message, icon: 'none' })
      return
    }
    void Taro.getSetting()
      .then((setting) => {
        if (setting.authSetting['scope.record'] !== false) {
          void Taro.showToast({ title: failure.message, icon: 'none' })
          return
        }
        return Taro.showModal({
          title: '需要麦克风权限',
          content: '在设置里打开「麦克风」后即可发送语音',
          confirmText: '去设置',
          cancelText: '取消',
        }).then((modal) => {
          if (!modal.confirm) return
          void Taro.openSetting({}).catch(() => undefined)
        })
      })
      .catch(() => undefined)
  }

  /**
   * 来电 / 视频通话占用了麦克风（`RecorderManager.onInterruptionBegin`，见
   * `startVoiceRecording` 的 `onInterrupted`）。
   *
   * 平台的中断语义是「录音被暂停」：暂停期间用户说的话不会被录进去，这一段的音频是截断的。
   * 所以**当场**放弃这一段（不等松手）：复位面板 + 明确提示重录 —— 等松手才提示的话，用户
   * 已经对着面板又说了半分钟。放弃之后闸门会一直关到这一段自己的收尾事件到达，这期间重按
   * 会得到「稍后再按」的提示（与取消后立刻重按同一条路径）。
   */
  const handleVoiceInterrupted = () => {
    const session = recordingRef.current
    if (!session) return
    recordingRef.current = null
    setRecording(false)
    resetRecordingUi()
    session.abort()
    // 只说「这一段已丢弃」，**不**承诺「稍后重按就能重录」：闸门要等这一段自己的终态事件
    // 才开（`onInterruptionEnd` 只尽力补发一次 `stop()`，假设 A4/A6 成立才催得回来），
    // 催不回来时下一次按下会得到「录音器没有响应，请关闭小程序后重新打开再试」——
    // 承诺「稍后」就会当场被那句话打脸（#549 Quality 审查 L2）。
    void Taro.showToast({ title: '录音已被来电打断，这一段已丢弃', icon: 'none' })
  }

  /**
   * 按住说话：开始录音。失败（无权限 / 设备忙）立刻提示，不留下半截状态。
   *
   * 这里必须是**同步**的：`onTouchStart → onTouchEnd` 是一段不可打断的触摸序列。隐私授权
   * 若放在这里 await，弹窗期间用户松手会让 `finishVoice` 看不到 `recordingRef` 而直接
   * return，授权完成后反而在没有手指按着时开始录音（#526 审查）。
   *
   * `event` 只为取「按下的起点 Y」（#535 上滑取消的基准），不做任何异步阻塞。
   */
  const startVoice = (event?: unknown) => {
    if (!canSend || recordingRef.current) return
    try {
      // `onError` 不等松手：录音期间失败（权限被拒最常见）时按钮不该继续谎报「松开 发送」
      // 第二个回调管「录音器自己停了」（时长上限）：不接的话面板会继续计时且无提示
      // 第三个回调管「被来电 / 视频通话打断」：那一段音频是截断的，当场放弃并提示重录
      voiceIdentityRef.current = currentIdentity()
      recordingRef.current = startVoiceRecording(
        handleVoiceFailure,
        handleVoiceAutoStop,
        handleVoiceInterrupted,
      )
      recordOriginYRef.current = touchClientY(event)
      cancelArmedRef.current = false
      setCancelArmed(false)
      setRecording(true)
    } catch (error) {
      recordingRef.current = null
      handleVoiceFailure(error)
    }
  }

  /**
   * 手指移动：上滑超过阈值进入「松开取消」（#535）。
   * `onTouchMove` 高频触发，只在取消态翻转时 setState，避免每帧重渲染整页。
   */
  const moveVoice = (event: unknown) => {
    if (!recordingRef.current) return
    const originY = recordOriginYRef.current
    const currentY = touchClientY(event)
    if (!Number.isFinite(originY) || !Number.isFinite(currentY)) return
    const armed = isVoiceCancelArmed(currentY - originY)
    if (armed === cancelArmedRef.current) return
    cancelArmedRef.current = armed
    setCancelArmed(armed)
  }

  /** 松手：取消态已武装就丢弃这一段，否则发送（判定读 ref，不吃 setState 的延迟） */
  const endVoice = () => finishVoice(cancelArmedRef.current)

  /**
   * 把录好的语音交去发送（松手发送 / 达到时长上限自动停 两条路径共用）。
   *
   * 同 `pickAndSendImages`：记**身份**而不是代次（#364 审查）。录音同样要好几秒，
   * 期间一次 `load()` 推进的只是 epoch —— 那段录音还是当前账号录的，不该被丢掉。
   *
   * `identity` 是**参数**而不是在这里读 `voiceIdentityRef`（#535 follow-up F3）：发送是
   * 异步的（`stop()` 回来才走到这里），背靠背两段录音时页面级 ref 可能已经被下一段覆盖 ——
   * 那样第一段就拿着第二段的身份去过 `isStaleMediaIdentity`。两个调用点都在同步点，
   * 各自把「这一刻」的快照传进来。
   */
  const sendRecordedVoice = (recorded: RecordedVoice, identity: MediaTaskIdentity) => {
    // 离页（卸载）：这段录音已经没人接了，静默丢弃
    if (!aliveRef.current) return
    if (isStaleMediaIdentity(identity, currentIdentity())) {
      // 录了音却什么都没发生会被当成页面坏了，必须说清楚
      void Taro.showToast({ title: '账号已切换，请重新录制语音', icon: 'none' })
      return
    }
    sendMedia({
      kind: 'VOICE',
      clientRequestId: randomUuidV4(),
      path: recorded.path,
      durationMs: recorded.durationMs,
    })
  }

  /**
   * 录音达到时长上限（录音器自己停了，见 `startVoiceRecording` 的 `onAutoStop`）。
   *
   * 以前这条路径没人接：面板会继续计时、按钮还写着「松开 发送」，实际上已经不在录了 ——
   * 用户松手时才把这段当正常录音发出去（或更早被丢弃）。现在：复位 + 明确提示 + 直接发送
   * 这一段（与微信「到时自动发送」一致，也避免用户刚录满的一分钟凭空消失）。
   *
   * 「取消 / 被打断 / 录满」的取舍收在 `applyVoiceAutoStop` 里（#535 复审）：那是有行为
   * 用例的纯逻辑，页面只负责把取消态与是否录满交过去、接上提示与发送。
   */
  const handleVoiceAutoStop = (recorded: RecordedVoice, capped: boolean) => {
    const cancelled = cancelArmedRef.current
    /** 自停是同步回调（页面还握着这一段），这里的快照就是**这一段**的身份 */
    const identity = voiceIdentityRef.current
    recordingRef.current = null
    setRecording(false)
    resetRecordingUi()
    applyVoiceAutoStop(
      { cancelled, capped },
      {
        toast: (title) => void Taro.showToast({ title, icon: 'none' }),
        send: () => sendRecordedVoice(recorded, identity),
      },
    )
  }

  /** 松手：结束录音并发送（`cancelled` = 手指移开 / 取消，放弃这一段） */
  const finishVoice = (cancelled: boolean) => {
    const session = recordingRef.current
    if (!session) return
    /** 同上：松手这一刻页面还握着这一段，先把身份快照取下来再放异步链 */
    const identity = voiceIdentityRef.current
    /*
      松手这一刻录音是否仍处于中断态（来电 / 视频通话把录音暂停了，还没结束）。
      必须是**此刻**的快照：「中断发生过」不算数，中断结束之后这一段仍应照常发送（#549）。
    */
    const interrupted = session.wasInterrupted()
    recordingRef.current = null
    setRecording(false)
    resetRecordingUi()
    if (cancelled) {
      session.abort()
      return
    }
    void session
      .stop()
      .then((recorded) =>
        // 中断态下这段音频是截断的：丢掉并让用户重录，而不是静默发半句（判定见纯逻辑用例）
        applyVoiceRelease(
          { interrupted },
          {
            toast: (title) => void Taro.showToast({ title, icon: 'none' }),
            send: () => sendRecordedVoice(recorded, identity),
          },
        ),
      )
      .catch((error) => {
        /*
          这一段失败时用户可能已经又按下了下一段（`recordingRef` 换成新的那段，`stop()` 的
          失败晚于下一次 `startVoice`）：那时只提示，**不许**把正在录的那一段的界面复位 ——
          否则面板消失、按钮回到「按住 说话」，而麦克风还在录（#535 follow-up F1）。
         */
        handleVoiceFailure(error, { resetUi: recordingRef.current === null })
      })
  }

  /** 停掉当前播放（切歌 / 离开页面 / 换账号都要先停） */
  const stopAudio = () => {
    const audio = audioRef.current
    audioRef.current = null
    setPlayingId(null)
    if (!audio) return
    try {
      audio.stop()
      audio.destroy()
    } catch (error) {
      console.warn('[miniapp] 停止语音播放失败', error)
    }
  }

  /**
   * 撤回一条语音时收口播放：正在放就停掉；还在下载就推进令牌，让回来的字节不再出声。
   * 只处理这一条，别误伤用户同时点开的另一段语音。
   */
  const stopVoiceForRecall = (messageId: string) => {
    if (playingId === messageId) stopAudio()
    if (loadingVoiceIdRef.current === messageId) {
      playSeqRef.current += 1
      loadingVoiceIdRef.current = null
    }
  }

  /** 播放一段语音（`src` 必须是本地临时文件，见 `downloadChatMedia`） */
  const playVoice = (keyId: string, src: string) => {
    stopAudio()
    const audio = Taro.createInnerAudioContext()
    audioRef.current = audio
    audio.src = src
    audio.onEnded(() => {
      if (audioRef.current === audio) stopAudio()
    })
    audio.onError(() => {
      if (audioRef.current === audio) stopAudio()
      void Taro.showToast({ title: '语音播放失败', icon: 'none' })
    })
    setPlayingId(keyId)
    audio.play()
  }

  /**
   * 点服务端语音气泡：有本地路径就直接放，否则先下载再放。
   *
   * 下载失败**不吞**（与自动下载的 best-effort 不同：这是用户明确点了一下，
   * 没有任何反馈会被当成「点了没反应」）。
   *
   * 迟到的下载不许落地（#67 复查 #222）：`playSeqRef` 令牌 + `isCurrentPlayRequest` 一起
   * 看住「换号 / 离页 / 用户又点了别的」—— 修复前 `.then` 无条件 `rememberPath` +
   * `playVoice`，早就离页的下载回来照样出声，还把上一个身份的私有媒体写进模块缓存。
   * 同一个判据也传给 `downloadChatMedia`，守住它写缓存的那一步。
   *
   * 判据里**不含 `epoch`**（#364 审查）：`epoch` 会被任何一次整页重拉推进，但那是
   * 「重拉」不是「换人」—— 拿它当身份会让用户在下载中途赶上一次补刷新时，点了语音
   * 既不预览也不提示（见 `./view` 的 `isCurrentPlayRequest`）。
   */
  const openVoice = (item: MediaMessageDto) => {
    // 播放态按**气泡**（消息 id / 本地临时 id）记，与 `entry.keyId` 同一空间；
    // 而下载与缓存按 `mediaId`（N1）。两者是不同的身份，别混用。
    if (playingId === item.id) {
      stopAudio()
      return
    }
    const local = cachedMediaPath(item.mediaId)
    if (local) {
      playVoice(item.id, local)
      return
    }
    playSeqRef.current += 1
    loadingVoiceIdRef.current = item.id
    const task: MediaTaskIdentity = {
      cookie: sessionCookieHeader() ?? '',
      userId: userIdRef.current,
    }
    const request = { token: playSeqRef.current, task }
    const isCurrent = () =>
      isCurrentPlayRequest(request, {
        ...currentIdentity(),
        token: playSeqRef.current,
        alive: aliveRef.current,
      })
    void downloadChatMedia(conversationId, item.mediaId, isCurrent)
      .then((path) => {
        if (loadingVoiceIdRef.current === item.id) loadingVoiceIdRef.current = null
        if (!isCurrent()) return
        rememberPath(item.mediaId, path)
        /**
         * 已经离开本页（`useDidHide`：跳去了商品详情 / 交易码页）就不许出声 ——
         * `useDidHide` 里停的是**正在播**的那一段，这条挡的是**下载刚好在离开之后
         * 才回来**的那一段（#364 审查）。字节照常回填缓存，用户回来一点就能放。
         */
        if (!visibleRef.current) return
        playVoice(item.id, path)
      })
      .catch((error) => {
        if (loadingVoiceIdRef.current === item.id) loadingVoiceIdRef.current = null
        // 换号 / 离页导致的中止是预期路径：不出声、也不当失败打日志。换号要说一句（见上）
        if (error instanceof MediaAbortedError) {
          noticeIdentityLost(task, '账号已切换，请重新打开语音')
          return
        }
        console.warn('[miniapp] 语音下载失败', error)
        void Taro.showToast({ title: '语音加载失败，请重试', icon: 'none' })
      })
  }

  /**
   * 点图片气泡：看大图。
   *
   * `Taro.previewImage` 只能收**本地路径或可公开访问的 URL**，而会话媒体是鉴权代理
   * （要带会话 Cookie），`<Image src>` 与预览都带不了 —— 所以必须先用本地临时文件。
   *
   * 与 `openVoice` 同一条兜底：自动下载是 best-effort（失败只记日志、不会自动重试），
   * 只在 `localPaths` 里查一次的话，**一次瞬时失败就会让这张图在整个停留期内点不开**
   * —— 用户明确点了却只说「稍后再试」，而「稍后」永远不会来（#359 3b 审查）。所以这里
   * 也带上下载：还没下来（或之前失败了）就现取一次，取到再预览。
   */
  const openImage = (item: MediaMessageDto) => {
    const cached = cachedMediaPath(item.mediaId)
    if (cached) {
      void Taro.previewImage({ current: cached, urls: [cached] })
      return
    }
    // 自动下载正在飞：不并发重复取，提示一句即可（它落地后就能点开）
    if (downloadingRef.current.has(item.mediaId)) {
      void Taro.showToast({ title: '图片还在加载，稍后再试', icon: 'none' })
      return
    }
    downloadingRef.current.add(item.mediaId)
    /**
     * 判据是**身份 + 离页**，不含 `epoch`（#364 审查）：下载是异步的，用户点开一张图后
     * 赶上任何一次整页重拉（切后台回来、补刷新）时，旧写法会既不预览也不提示 ——
     * 「点了没反应」。图还是当前账号的图，身份没变就该放出来。
     */
    const identity: MediaTaskIdentity = {
      cookie: sessionCookieHeader() ?? '',
      userId: userIdRef.current,
    }
    const isActive = () => aliveRef.current && !isStaleMediaIdentity(identity, currentIdentity())
    void downloadChatMedia(conversationId, item.mediaId, isActive)
      .then((path) => {
        if (!isActive()) return
        rememberPath(item.mediaId, path)
        void Taro.previewImage({ current: path, urls: [path] })
      })
      .catch((error) => {
        // 换号 / 离页导致的中止是预期路径：不当失败打日志。换号要说一句（见上）
        if (error instanceof MediaAbortedError) {
          noticeIdentityLost(identity, '账号已切换，请重新打开图片')
          return
        }
        console.warn('[miniapp] 图片下载失败', error)
        void Taro.showToast({ title: '图片加载失败，请重试', icon: 'none' })
      })
      .finally(() => {
        downloadingRef.current.delete(item.mediaId)
      })
  }

  /**
   * 语音气泡（服务端与本地乐观共用一份版式）。
   *
   * `onPress` 由调用方给：服务端那条是「下载后再放」（`openVoice`），本地那条是
   * 「直接放本地临时文件」（不下载）。播放态按 `keyId` 判 —— 与 `playingId` 同一空间。
   *
   * `failed` 只有本地乐观气泡会传（#364 审查）：失败的语音乐观气泡此前没有 `!` 角标
   * （图片分支有），用户只看得出「有颗重试按钮」，看不出**这个气泡本身**是坏的。
   *
   * `onLongPress` 只有服务端那条会传（#518）：长按走引用/撤回菜单；本地乐观气泡还在
   * 上传，没有服务端 id，给不出撤回入口。
   */
  const renderVoiceBubble = (
    keyId: string,
    durationMs: number | null | undefined,
    mine: boolean,
    onPress: () => void,
    failed = false,
    onLongPress?: () => void,
    busy = false,
  ) => {
    const playing = playingId === keyId
    return (
      <View
        className={`conv__bubble conv__bubble--voice${mine ? ' is-mine' : ''}${
          busy ? ' is-busy' : ''
        }`}
        onTouchStart={resetBubbleTapGuard}
        onLongPress={onLongPress ?? beginBubbleLongPress}
        onClick={() => {
          if (consumeBubbleTap()) return
          onPress()
        }}
      >
        <View className={`conv__play${mine ? ' is-mine' : ''}${playing ? ' is-pause' : ''}`}>
          <View className="conv__play-glyph" />
        </View>
        <View className="conv__wave">
          {WAVE_BARS.map((bar) => (
            <View
              key={bar.id}
              className={`conv__wave-bar${mine ? ' is-mine' : ''}${playing ? ' is-on' : ''}`}
              style={{ height: `${bar.height}rpx` }}
            />
          ))}
        </View>
        <Text className={`conv__dur num${mine ? ' is-mine' : ''}`}>
          {voiceDurationLabel(durationMs)}
        </Text>
        {failed ? <View className="conv__failmark">!</View> : null}
      </View>
    )
  }

  /**
   * 放弃正在进行的录音（切输入态 / 切面板前必须调）。
   *
   * 「按住说话」的结束靠那颗按钮的 `onTouchEnd` / `onTouchCancel`，而切语音态 / 开
   * 「+」面板会把整颗按钮**卸载**掉 —— 手指还按着也不会再触发任何回调。不清的话：
   * 麦克风继续录到时长上限（那一段最终被丢弃），`recording` 常亮「松开 发送」，
   * 且 `startVoice` 的 `recordingRef.current` 判定从此恒真，**本次进页面再也按不下录音**
   * （#359 3b 审查）。切走即放弃，与 `onTouchCancel` 同一语义。
   */
  const abortRecording = () => {
    const session = recordingRef.current
    if (!session) return
    recordingRef.current = null
    setRecording(false)
    resetRecordingUi()
    session.abort()
  }

  /**
   * 输入栏 / 消息流的几何要变了：贴底就换一个同位锚点重指尾行，翻历史就把位置钉住（#561）。
   *
   * 必须与造成几何变化的那次 `setState` 落在**同一批**里调用 —— 分两帧就是先跳顶再回底。
   *
   * 贴底与否只来自 `onScroll`，而「贴底」本身是程序化 `scrollIntoView` 完成的：那次滚动在
   * 真机上会不会回吐 `bindscroll` 静态无法证伪（见 `animateScroll` 的注释）。所以换锚之后
   * **直接**认定贴底 —— 我们刚亲手指到底，这是已知事实，不能交给一条可能永远不来的事件。
   *
   * 换完锚点再回读一次偏移：原生层在几何突变（视口变矮、内容变短）时可能把滚动偏移整个
   * 丢掉，而复现里就是「偏移掉成 0」之后再也回不到消息底部。丢了就补 —— 贴底的再指一次
   * 尾行，翻历史的把原值写回去。偏移没丢的机型上这段什么都不做，不存在副作用。
   *
   * 「丢没丢、怎么补」全部交给 `view.ts` 的 `planScrollFix()` 判定，这里只负责执行 ——
   * 判据留在组件里就只能靠源码片段断言，取值反了也不会红；连「该写回哪个值」都在它的返回值
   * 里，页面没有第二只手去写错。
   */
  const keepTailAnchored = useCallback(() => {
    // 收键盘期间会连着叫好几次（每接受一档高度一次），只有最后一道的结论能落地（#560 R5）
    const seq = ++anchorSeqRef.current
    const prevTop = scrollTopRef.current
    // 贴底标志也在调用时快照：回读是异步的，到回调里再读，中间可能已经被 `onScroll`
    // 改过一次 —— 拿「调用时的 prevTop」配「回调时的 stick」是两次观测混用
    const stick = stickBottomRef.current
    if (stick) {
      setTailAnchorFlip((prev) => !prev)
      stickBottomRef.current = true
    }
    void Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select('.conv__scroll')
        .scrollOffset()
        .exec((res) => {
          // 查询是异步的：回读结果落地时页面可能已经卸载（同文件别处的回调都有这道守卫）
          if (!aliveRef.current) return
          // 已经发起了更新的一道（#560 R5）：乱序落地时旧结论会把过期 top 写回去
          if (seq !== anchorSeqRef.current) return
          const offset = res?.[0] as { scrollTop?: number } | undefined
          const fix = planScrollFix({ prevTop, top: offset?.scrollTop ?? Number.NaN, stick })
          /**
           * 余量判完即废（#561）：它只护「几何变化前后那一两帧」的读数 —— 那一刻滚动事件里
           * 可能是「旧 scrollTop + 新 scrollHeight」，底部差临时变大。回读判完，几何已经
           * 落定，再留着就是把贴底判据**永久**抬高：用户上翻的距离不到余量那么多时仍被判成
           * 贴底，接着开面板 / 起键盘 / 切语音就把他从历史里拽回底部。
           */
          bottomGapAllowanceRef.current = 0
          if (fix.kind === 'anchor') {
            setTailAnchorFlip((prev) => !prev)
            return
          }
          if (fix.kind === 'restore') {
            setScrollRestore((prev) => ({ top: fix.top, tick: (prev?.tick ?? 0) + 1 }))
            // 复位指令**用后不撤**（#561）：撤掉等于让属性回到默认的 0，那正是本票要修的
            // 「偏移掉成 0」形态。同一个位置靠 `tick % 2` 的 0.5px 交替再下发一次
            // （见 `restoreScrollTop` 的注释）。
          }
        })
    })
  }, [])

  /** 收掉活性哨兵（#560 R2）：`inset === 0` / 页面被盖住 / 卸载 / 重新武装四处调用 */
  const clearKeyboardSentinel = useCallback(() => {
    const timer = keyboardSentinelRef.current
    if (timer !== null) {
      clearTimeout(timer)
      keyboardSentinelRef.current = null
    }
    // 账本跟着哨兵一起清：留着就是下一轮哨兵的假阳性（#560 B1）
    keyboardSentinelMaxRef.current = 0
    keyboardPendingRef.current = 0
  }, [])

  /**
   * 武装活性哨兵（#560 R2/B1）：页面刚叫过 `Taro.hideKeyboard()`，等平台把高度收到 0。
   *
   * 到点**先无条件解闩**（闩不能烂在定时器里），再按 `resolveSentinel()` 的结论决定落哪个高度：
   * - 用户已离开输入框（`inputFocusedRef` 为假）→ 键盘该走，归零并重指尾行；
   * - 还在输入框里 → 键盘大概率真开着，**绝不猜 0**（`adjustPosition={false}` 下没有别的补偿，
   *   猜 0 就是把输入栏埋进键盘），落「这一轮报过的最高真实值」—— 没有报过就一个周期后再判。
   *
   * 判据只用事实（报过的最大值）与意图（焦点），不猜方向：拿「高度与武装时的快照是否相等」判断
   * 在原理上无解 —— 「报过且等于快照」（切回同一把键盘，最常见）会被判成「没报过」而强落 0；
   * 「报了中间值然后静默」（真该归零的兜底场景）会被判成「报过」而永久停在中间值。
   *
   * 这是**条件触发的卡死兜底**，不是给收键盘动画做补偿（不参与任何动画时序）。
   */
  const armKeyboardSentinel = useCallback(() => {
    clearKeyboardSentinel()
    keyboardSentinelRef.current = setTimeout(() => {
      keyboardSentinelRef.current = null
      if (!aliveRef.current) return
      const plan = resolveSentinel({
        closing: keyboardClosingRef.current,
        seen: keyboardSentinelMaxRef.current,
        pending: keyboardPendingRef.current,
        height: keyboardHeightRef.current,
        focused: inputFocusedRef.current,
        rearms: keyboardSentinelRearmsRef.current,
      })
      if (plan.releaseLatch) {
        keyboardClosingRef.current = false
        keyboardClosingFromRef.current = 0
        keyboardAboveFromRef.current = 0
      }
      // 闩本来就不在：这一拍什么都不用下结论（`clearKeyboardSentinel` 已经清过账本）
      if (!plan.releaseLatch) return
      if (plan.inset !== keyboardHeightRef.current) {
        keyboardHeightRef.current = plan.inset
        setKeyboardHeight(plan.inset)
      }
      keepTailAnchored()
      keyboardSentinelMaxRef.current = 0
      keyboardPendingRef.current = 0
      if (plan.rearms > keyboardSentinelRearmsRef.current) {
        /**
         * 这一拍下不了结论（平台一个事件都没给、可用户还在输入框里）：重发一次收键盘、再给一个
         * 周期，不在第一个 500ms 就拍死。**不复用 `collapseKeyboard()`** —— 它会重置重新武装的
         * 预算，就成了无限循环。
         */
        keyboardSentinelRearmsRef.current = plan.rearms
        void Taro.hideKeyboard()
        const from = keyboardHeightRef.current
        if (from > 0) {
          keyboardClosingRef.current = true
          keyboardClosingFromRef.current = Math.max(from, keyboardClosingFromRef.current)
          armKeyboardSentinel()
        }
        return
      }
      keyboardSentinelRearmsRef.current = 0
    }, KEYBOARD_SENTINEL_MS)
  }, [clearKeyboardSentinel, keepTailAnchored])

  /**
   * 本页主动收键盘（#560）：切语音态、开面板都走这一处。
   *
   * 只叫平台收、**不自己归零高度** —— 自己归零就是拿本页布局去和系统收键盘动画抢时序
   * （真机上的「先上提、再回落」）。同时置上**意图闩**并武装活性哨兵：闩只由页面写入，
   * 不从「高度变矮」反推（安卓切输入法/候选栏伸缩会让键盘没关、只是变矮）；哨兵兜底
   * 「平台始终不报 0」（R2）。两个调用点共用一处武装，改一处不会漏另一处。
   */
  const collapseKeyboard = useCallback(() => {
    void Taro.hideKeyboard()
    /**
     * 页面主动收起 = 用户离开输入框：哨兵的**意图信号**跟着置假（重新点输入框时 `onFocus` 会置回真）。
     *
     * 不置的话这条兜底就是空的 —— 切语音态会把 `Textarea` 卸载，而 React 卸载**不合成 blur**，
     * 微信的 `hideKeyboard()` 本身也不 blur，`togglePanel` 更是明确「不 blur 输入框」。于是
     * `inputFocusedRef` 一直停在「真」，哨兵到点按「用户还在编辑、绝不猜 0」把中间值（例如收起
     * 动画里的 300）当终值落地 —— 输入栏悬在空中，又因为 `closedAt` 为 0 不会被尾巴纠正。
     */
    inputFocusedRef.current = false
    // 页面新发起的一次收起：重新给满重新武装的预算（哨兵自己重发时不走这里，见上）
    keyboardSentinelRearmsRef.current = 0
    const from = keyboardHeightRef.current
    // 键盘本来就没开：没有要收的，也不必武装哨兵（否则 500ms 后会白做一次重锚）
    if (!(from > 0)) return
    keyboardClosingRef.current = true
    // 连着调两次（切态又开面板）时，第二次读到的 `from` 只是收起动画里的**中间高度**，
    // 直接覆盖会把起点下修 → 动画尾部的回抬就能越过它、提前解闩。闩已置时保大值。
    keyboardClosingFromRef.current = Math.max(from, keyboardClosingFromRef.current)
    keyboardAboveFromRef.current = 0
    armKeyboardSentinel()
  }, [armKeyboardSentinel])

  /**
   * 语音/键盘切换：进语音态时收起面板（两态不并存，与稿子一致）。
   *
   * 隐私授权放在这里而不是 `startVoice`：这是普通点击，可以安全 await；进入语音态时
   * 就把授权走完，后面按住说话的触摸序列保持全同步。
   */
  const toggleVoiceMode = async () => {
    if (voiceMode) {
      abortRecording()
      setVoiceMode(false)
      return
    }
    /**
     * 进语音态前**同步**收键盘（#560）：点击当拍就发，不等隐私授权那趟 await。
     *
     * 收键盘走 `collapseKeyboard()`：只叫平台收、不自己把高度真源归零 —— 高度只由
     * `onKeyboardHeightChange` 那一处改写（见 `./view` 的 `nextKeyboardInset`）。自己归零
     * 等于拿本页布局去和系统收键盘的动画抢时序：安卓真机复验里，切态当拍撤掉内边距、系统的
     * 位移回落还在动画途中，输入栏就是「先上提、再回落」。交给平台事件，高度一路单调走到 0。
     */
    collapseKeyboard()
    if (privacyPendingRef.current) return
    privacyPendingRef.current = true
    const seq = ++voiceGateSeqRef.current
    let state: Awaited<ReturnType<typeof getPrivacyAuthorizationState>>
    try {
      state = await getPrivacyAuthorizationState()
    } finally {
      privacyPendingRef.current = false
    }
    // await 期间用户可能点了「+」、离开页面，或又切回了键盘态；旧结果不许覆盖新状态。
    if (!canEnterVoiceMode(state, seq, voiceGateSeqRef.current, aliveRef.current)) {
      if (seq !== voiceGateSeqRef.current || !aliveRef.current) return
      // 查询失败/超时与用户明确拒绝要分开提示：前者按「去同意」操作也不会恢复。
      void Taro.showToast({
        title:
          state === 'denied'
            ? '请先同意《用户隐私保护指引》后重试'
            : '无法确认隐私授权状态，请稍后重试或检查微信设置',
        icon: 'none',
      })
      return
    }
    /**
     * 切态这一批（#560）：收面板 + 切语音态 + 重指尾行，**同一批**落地。
     *
     * 键盘高度不在这批里 —— 它由平台事件单调收到 0，和本批没有时序耦合。输入框两态常驻
     * （语音态只 `opacity: 0`，不卸载重挂），这一批根本不改变输入栏高度，用户看到的是
     * 「按住 说话」原地换上去；键盘按自己的动画滑走。
     */
    keepTailAnchored()
    setPanelOpen(false)
    setVoiceMode(true)
  }

  /**
   * 长按气泡（#359 3c）：按 `messageActions` 给出可用动作，用微信原生 `showActionSheet`
   * 呈现（与「我的发布」重命名/下架同一入口，不另造自绘弹层）。
   *
   * 取消（点遮罩 / 取消）会让 `showActionSheet` reject —— 那不是错误，静默收场。
   */
  const onLongPressMessage = async (message: ReplyTarget) => {
    // 长按手势结束后平台还会补一次 tap：在这里统一置位，所有气泡（文本/图片/语音/商品卡）
    // 都靠各自的 onClick 首行 `consumeBubbleTap()` 吞掉，避免语音被放、图片被预览、卡片跳走。
    beginBubbleLongPress()
    const actions =
      'kind' in message
        ? mediaActions(message, userId, Date.now(), MESSAGE_RECALL_WINDOW_MS)
        : messageActions(message, userId, Date.now(), MESSAGE_RECALL_WINDOW_MS)
    if (actions.length === 0) return
    let picked: MessageAction | null = null
    try {
      const result = await Taro.showActionSheet({
        itemList: actions.map((action) => MESSAGE_ACTION_LABEL[action]),
      })
      picked = actions[result.tapIndex] ?? null
    } catch {
      return
    }
    if (picked === 'copy') {
      // 媒体 DTO 没有 content；mediaActions 也不会给 copy，这里只是收窄类型。
      if ('kind' in message) return
      void Taro.setClipboardData({ data: message.content }).catch((error) => {
        // 复制失败此前完全没有处理（unhandled rejection + 界面无反馈）。
        console.warn('[miniapp] 复制消息失败', error)
        void Taro.showToast({ title: '复制失败', icon: 'none' })
      })
      return
    }
    if (picked === 'reply') {
      setReplyTarget(message)
      return
    }
    if (picked === 'recall') await doRecall(message)
  }

  /**
   * 撤回一条自己发的消息。成功后**本地同步翻成撤回碑**（不等下一次刷新）：服务端随后
   * 推的 `message.recalled` 会再落一次（幂等），但推送是「尽力而为」，这里以 HTTP 204
   * 为准落地，保证「点了就变」。
   *
   * ⚠️ 这里**不设 epoch 守卫**（与 `doSend` 不同）。撤回的在途期最长 15s，期间任何一次
   * `load()` 都会 `epoch + 1`（从子页返回、或上一次发送落定后的补刷新），若按 epoch 判过期：
   * - 成功路径被跳过 → 服务端已撤回、屏幕上正文照旧（在途快照还会把它覆盖回来）；
   * - `finally` 里的解锁被跳过 → `recallingId` 永久停在那个 id 上，此后每次撤回都撞
   *   `if (recallingId) return`，**弹了菜单、点了撤回、什么也不发生**，只能退出页面重进。
   *
   * 不设守卫是安全的：`applyRecalled` 只按 id 改命中的那一条，换账号时 `messages` 已被
   * 清空（改不到任何行），而消息 id 全局唯一、不可能落在新账号的会话里。
   * 锁在 `finally` 里**无条件**释放 —— 单条在途由 `if (recallingId) return` 保证，
   * 不会有第二次撤回并发进来抢这个槽位。
   */
  const doRecall = async (message: ReplyTarget) => {
    if (recallingId) {
      // 撤回按钮在途时没有 loading 文案的话，用户会以为没点上；再点另一条也会被静默吞掉。
      void Taro.showToast({ title: '正在撤回，请稍候', icon: 'none' })
      return
    }
    setRecallingId(message.id)
    try {
      await recallMessage(conversationId, message.id)
      const recalledAt = new Date().toISOString()
      setMessages((prev) =>
        applyReplyRecalled(applyRecalled(prev, message.id, recalledAt), message.id),
      )
      // 媒体消息还要落到 `media` 流（#518）：只改 `messages` 的话，图片/语音要等推送
      // 或下一次 load 才翻碑，点了撤回的当下仍显示原图/原语音。
      setMedia((prev) =>
        applyReplyRecalled(applyMediaRecalled(prev, message.id, recalledAt), message.id),
      )
      setPendingMedia((prev) => applyReplyRecalled(prev, message.id))
      stopVoiceForRecall(message.id)
      // 撤回的正是正在引用的那条：引用栏里的摘引已经失效，收起它
      setReplyTarget((prev) => (prev?.id === message.id ? null : prev))
    } catch (error) {
      console.warn('[miniapp] 撤回消息失败', error)
      void Taro.showToast({
        title: recallFailureText(isApiError(error) ? error.code : undefined),
        icon: 'none',
      })
    } finally {
      setRecallingId(null)
    }
  }

  /**
   * 点气泡里的摘引：滚到被引用那条（页内定位，不重新拉取）。
   *
   * `tail` 记下此刻的尾行 id（见 `jumpTo` 的说明）：新消息一到尾行变化，目标即失效。
   *
   * 目标不在**已加载**的消息里时不能装作没事（#359 3c 审查回合）：被引用的那条可能落在
   * 更早的分页里（本页不做无限滚动，更早一页要用户自己点「加载更早的消息」），此时
   * `scrollIntoView` 拿到一个不存在的 id 会静默什么都不做 —— 用户点了没反应、也没有提示。
   */
  const locateMessage = (messageId: string) => {
    // 媒体消息不在 `messages` 里（两条流互斥），只查文本流会把「引用一张图/一段语音」
    // 误判成未加载；媒体条目的 DOM id 同样是 `e-${keyId}`（keyId = media.id）。
    const exists =
      messages.some((item) => item.id === messageId) || media.some((item) => item.id === messageId)
    if (!exists) {
      void Taro.showToast({ title: '引用的消息在更早的记录里', icon: 'none' })
      return
    }
    setJumpTo({ id: `e-${messageId}`, tail: tailId })
  }

  /**
   * 媒体气泡上方的引用摘引（#518）。
   *
   * 图片/语音本体是固定尺寸的媒体块，摘引不塞进气泡内部（会挤压 400×300 的图），
   * 单独放在气泡上方；本地待发条目只有本地临时 id，不能定位，因此不接 onClick。
   */
  const renderMediaQuote = (
    replyTo: { id: string; excerpt: string } | null | undefined,
    canLocate: boolean,
  ) => {
    if (!replyTo) return null
    return (
      <View
        className="conv__quote conv__quote--floating"
        onTouchStart={resetBubbleTapGuard}
        onClick={
          canLocate
            ? () => {
                if (consumeBubbleTap()) return
                locateMessage(replyTo.id)
              }
            : undefined
        }
      >
        <Text className="conv__quote-tx">{replyTo.excerpt}</Text>
      </View>
    )
  }

  /** 「+」开合面板：开面板时退回键盘态 */
  const togglePanel = () => {
    // 授权 await 期间用户主动开了「+」：作废这次待落地的语音态切换。
    voiceGateSeqRef.current += 1
    if (!panelOpen) {
      abortRecording()
      setVoiceMode(false)
      /**
       * 展开这一下顺手记「此刻是否贴底」（#597 追加任务）：下面那次 `keepTailAnchored` 跑在
       * `setPanelOpen` **之前**，锚的是「面板还没占位」的旧几何；面板落地后消息流又矮了一截，
       * 尾行会被输入栏截掉。等面板几何落地那一次量测（量测 effect 里的
       * `reopenTailAnchor`）再按这里记下的判据重指一次。
       *
       * 记的是**判据**不是「一定要贴底」：展开时不贴底的人，落地后也不许被拽回底部
       * （#597 现象三的原罪）。
       */
      panelOpenStickRef.current = stickBottomRef.current
    }
    /**
     * 面板是**底部底座里独立的一块**（#597）：它不再长在输入栏的文档流里，而是绝对定位贴住
     * 输入栏底边、高度由内容自己撑（`panelHeight` 只决定底座让位带多高）。改前是流内块，
     * 键盘先收一截、面板再长一截，消息流连着变矮两次，原生层把越界的偏移截断后没人推回底部，
     * 看起来就是「整页移一下 + 掉到底」（#597 现象一）。
     *
     * 三件事仍然压进同一批（收键盘 / 重指尾行 / 开面板）：`keepTailAnchored` 兜住这一下的
     * 几何变化（底部从 `env(safe-area)` 长成面板高）。键盘高度**同样不在这批里归零**：它是
     * 平台事件的产物（`nextKeyboardInset`），自己归零就是拿本页布局去和系统收键盘动画抢时序
     * —— #560 电的正是这一下。收键盘与意图闩 / 活性哨兵一起走 `collapseKeyboard()`。
     *
     * 面板落地后还要**再**锚一次（见上面的 `panelOpenStickRef` 与量测 effect）：这一批里
     * 那次锚定发生在面板占位之前，不足以保住尾行。
     */
    collapseKeyboard()
    keepTailAnchored()
    setPanelOpen(!panelOpen)
  }

  /** 收面板：点「面板与输入栏」之外的任何位置都走这里（#541/#597）—— 消息流的 `onTouchStart`、
   *  页头空白、点面板里的格子。聚焦输入框也收，但要等键盘落地（交接在键盘订阅里，见那里）。
   *  不碰已输入文字、不 blur 输入框；底部底座从面板高缩回键盘高
   *  （键盘没开就是 0），位置仍交给同一个守卫决定（贴底继续贴底，翻历史原地不动）。 */
  const dismissPanel = () => {
    keepTailAnchored()
    setPanelOpen(false)
  }

  const openListing = () => {
    if (!conversation) return
    void Taro.navigateTo({
      url: `/pkg-browse/pages/listing-detail/index?id=${conversation.listing.id}`,
    })
  }

  /** 对方主页：与商品卡卖家行/关注列表同一跳转口径（#517）。 */
  const openCounterpart = () => {
    if (!conversation) return
    void Taro.navigateTo({
      url: `/pkg-browse/pages/user/index?id=${encodeURIComponent(conversation.counterpart.id)}`,
    })
  }

  /** 自己的头像：进编辑资料页（与「我的」页同一入口，#86 B）。 */
  const openSelfProfile = () => {
    void Taro.navigateTo({ url: '/pkg-auth/pages/profile-edit/index' })
  }

  /**
   * 打开交易码页。**必须带交易 id**（#521）：面交页的 `router.params.id` 为空时
   * 直接落「找不到这笔交易」，连请求都不发。状态条只在拿得到 id 时给这颗钮，这里再兜一道
   * —— 拿不到 id 时给一句话，而不是跳过去撞错误页。
   */
  const openMeetup = (transactionId: string) => {
    if (!transactionId) {
      void Taro.showToast({ title: '交易信息已失效，请从「我的订单」进入', icon: 'none' })
      return
    }
    void Taro.navigateTo({ url: meetupUrlById(transactionId) })
  }

  /**
   * 「+」面板的三格：商品卡进发送选择页（#359）；图片走相册、拍照走相机
   * （两者只是 `Taro.chooseMedia` 的 `sourceType` 差别，对发送流程没有区别）。
   */
  const panelAction = (key: (typeof PANEL_TILES)[number]['key']) => {
    /**
     * 面板收起后底部底座整块让回去（面板高 → 键盘高 0），消息流会长高一段（#597）：
     * 与另两条收起路径同一个守卫 —— 贴底的继续贴底，翻历史的原地不动。放在跳转之前：
     * 相册/相机被取消时页面还在，位置得已经落对。
     */
    keepTailAnchored()
    setPanelOpen(false)
    if (key === 'product') {
      if (!conversationId) return
      void Taro.navigateTo({ url: `/pkg-trade/pages/send-listing/index?id=${conversationId}` })
      return
    }
    void pickAndSendImages(key === 'camera' ? 'camera' : 'album')
  }

  /**
   * 返回：有上一页就回退；页面栈为空（冷启动分享 / 扫码直入）兜底回**语义父级
   * tab** —— 消息页（2026-10-02 拍板的兜底规则，Tab 页不能 navigateBack 跨栈）。
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
   * 会话流：服务端消息与媒体按 `(createdAt,id)` 合成**一条**时间线（`mergeTimeline`）——
   * 两条流各自有序，混排后才是用户在聊天里看到的顺序。本地待发的文本与媒体永远排在
   * 服务端内容之后（它们必然最新）。
   */
  const entries = useMemo<ChatEntry[]>(
    () => [
      ...mergeTimeline(messages, media),
      ...pending.map((item) => ({ kind: 'pending' as const, keyId: item.id, pending: item })),
      ...pendingMedia.map((item) => ({
        kind: 'pending-media' as const,
        keyId: item.id,
        pending: item,
      })),
    ],
    [messages, media, pending, pendingMedia],
  )

  /**
   * 消息流里最后一条 `tx.accepted` 带的交易 id：交易接口失败时的兜底入口。
   * 必须是 hook，所以放在下面「取不到会话」的早退分支之前（hooks 不能跟在 return 后）。
   */
  const fallbackTxId = useMemo(() => lastTxAcceptedId(messages), [messages])

  /**
   * 交易完成为「待评价」时查一次我的评价（#551）。评价态是**三态**：只有 404
   * `REVIEW_NOT_FOUND` 才算「我还没评」（`reviewed: false`），成功是 `true`；其余失败
   * （网络 / 500）**不写 `false`** —— 那等于替用户断言一件没查清的事 —— 而是回到未知态
   * `null`，由 `view.ts` 的 `txBarView` 用中性文案 + 面交页入口收尾。`alive` 挡住
   * 「换了交易之后旧响应才回来」的串档。
   *
   * 依赖里除了交易 id 还有 `txReviewTick`：**评价是在面交页写的**，写完返回本页时
   * 交易 id 没变，只有每回到本页重查一次，顶栏才会从「评价」变成「查看」。
   */
  const completedTxId = txLoad.tx?.status === 'COMPLETED' ? txLoad.tx.id : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: txReviewTick 是刻意的重查信号（回到本页就 ++），不是体内读到的值
  useEffect(() => {
    if (completedTxId === null) {
      setTxReview(null)
      return
    }
    let alive = true
    void fetchMyTransactionReview(completedTxId)
      .then(() => {
        if (alive) setTxReview({ txId: completedTxId, reviewed: true })
      })
      .catch((error) => {
        if (!alive) return
        if (isApiError(error) && error.code === 'REVIEW_NOT_FOUND') {
          setTxReview({ txId: completedTxId, reviewed: false })
          return
        }
        console.warn('[miniapp] 会话交易评价状态加载失败', error)
        // 查不到 ≠ 没评过：连上一轮的结论一起作废，退回未知态（文案中性、入口仍在）
        setTxReview(null)
      })
    return () => {
      alive = false
    }
  }, [completedTxId, txReviewTick])

  /**
   * 顶部状态条的「重新加载」：只重查交易，不整页重拉 —— 不 bump `epoch`、不动消息流，
   * 失败也保持 failed（状态条内容不变，用户还能再点）。
   *
   * 与 `refreshConversationQuietly()` 的分工：这里只换交易状态、不动消息流，所以没有
   * 「判死在途发送」的风险；整页重拉（接受 / 拒绝之后要看 `listing.status`）才走那条。
   */
  const retryTx = useCallback(() => {
    if (!conversation) return
    const current = epoch.current
    const txSeq = ++txSeqRef.current
    void fetchConversationTransaction(conversationId, conversation.role, fallbackTxId)
      .then((tx) => {
        if (current !== epoch.current || txSeq !== txSeqRef.current) return
        applyTx(tx)
      })
      .catch((error) => {
        console.warn('[miniapp] 会话交易进度重试失败', error)
        if (current !== epoch.current || txSeq !== txSeqRef.current) return
        setTxLoad((prev) => ({ status: 'failed', tx: prev.tx }))
      })
  }, [applyTx, conversation, conversationId, fallbackTxId])

  /**
   * 「静默重拉本页」的统一出口（#551 审查 F1）。
   *
   * `load()` 一进来就 `++epoch.current`（`:534`），在途的文本发送 / 媒体上传回来时会被
   * 自己那句 `current !== epoch.current` 判过期丢弃 —— 乐观气泡永远停在「发送中」，而消息
   * 可能已经落库：用户既看不到确认，也没有任何恢复路径。
   *
   * 所以接受 / 拒绝提案之后（409 分支、拒绝成功、拒绝失败）宁可**晚一点**看到顶部退回
   * 「在售」，也不能拿新代次去判死那条正在飞的发送。与 `useDidShow`（`:746`）和
   * `realtimeOpenRef`（`:1092`）同一条纪律：有在途发送就只记账（`deferReload`），
   * 落定后由 `doSend` / `runMediaSend` 的 finally 补一次真正的重拉。
   *
   * 不在这里补 `convState === 'loading'` 那道闸：状态条要渲染出这两颗钮，前提就是已经拿到
   * 会话（`convState === 'ok'`），那个窗口不存在。
   */
  const refreshConversationQuietly = useCallback(() => {
    const sending =
      pendingRef.current.some((item) => item.status === 'sending') ||
      pendingMediaRef.current.some((item) => item.status === 'uploading')
    if (sending) {
      deferredRef.current = deferReload(deferredRef.current)
      return
    }
    loadRef.current({ silent: true })
  }, [])

  /**
   * 顶部状态条的「待确认」：卖家接受买家的面交申请（#551）。
   *
   * 两件事必须按顺序做对：
   * 1. **二次确认**：接受会建交易行、把商品置 RESERVED，是不可回退的写操作，先弹确认，
   *    文案里必须带提案金额（金额来自提案消息本身，提案不落库）。
   * 2. **金额原样带回**：`acceptTransaction(conversationId, amountCents)` 的第二个参数只能
   *    由调用方提供（`features/transaction/api.ts` 的注释冻结了这条）。
   *
   * 失败一律重查而不是原地留着「待确认」：409 `LISTING_NOT_ACTIVE` 按契约**不代表这次
   * 失败**（可能是响应丢了重试，或另一个买家先成交），只有服务端现状能回答顶部该写什么。
   * 重查走 `refreshConversationQuietly()`（整页静默重拉，`load()` 自己就会重查这笔交易），
   * 其余失败走 `retryTx()`（只重查交易）。别在 409 分支把两者叠着调用：那是同一笔查询打两次。
   */
  const confirmProposal = (amountCents: number | null) => {
    if (acceptBusyRef.current) return
    if (amountCents === null) {
      // 契约里 `tx.proposal.amountCents` 是必填，读到 null 只可能是脏数据 —— 不能把用户
      // 指去「我的发布」：那边按严格解析同样列不出这条脏提案，等于指进另一条死路。
      void Taro.showToast({ title: '没读到提案金额，请让对方重新发起面交申请', icon: 'none' })
      return
    }
    /**
     * #462 冻结的授权入口：**同意**提案时请求 TX 订阅（同仓 `pkg-browse/pages/mylist` 的
     * `acceptProposal` 同一处）。放在最前面：微信要求 `wx.requestSubscribeMessage` 直接由
     * 点击触发，这之前不能有任何 `await`；`requestSubscribe` 内部已吞掉错误，被拒或失败
     * 都不影响这次接受（见 `features/subscribe/request.ts`）。
     */
    void requestSubscribe(['TX'])
    /**
     * 入口就上锁（不是等点完「确认」才上锁）：两次快速点击会各起一个确认框，两次都点
     * 「确认」就是两次 accept 请求。锁到确认框与请求都落定才放开。
     *
     * `epoch` 记的是发出请求时的登录态代次：请求在途时换号/退出，回来的交易属于上一个
     * 账号，**不许**写进当前页（`applyTx` 无条件写 `txLoad`）。
     */
    const epoch = sessionEpoch()
    acceptBusyRef.current = true
    void Taro.showModal({
      title: '确认这笔面交申请？',
      content: `接受后按 ¥${formatAmount(amountCents)} 当面交易，商品会被预订、其他买家不能再拍。`,
      confirmText: '确认接受',
    })
      .then((result) => {
        if (!result.confirm) return
        return acceptTransaction(conversationId, amountCents)
          .then((tx) => {
            if (epoch !== sessionEpoch()) return
            /**
             * 先作废在途的交易查询（#551 审查 F2）：进页那次 `fetchConversationTransaction`
             * 可能还在飞（没有 preferredTxId 时是多次串行请求），它回来时若照旧 `applyTx`，
             * 会把刚建出来的交易行覆盖成 `null` —— 顶部掉回提案档，而 `listing.status` 已被
             * 置 RESERVED，PENDING 轮询也不再覆盖这一档，只能离开再回页才恢复。
             * `++txSeqRef` 让那些旧响应在各自的守卫里被判过期。
             */
            ++txSeqRef.current
            applyTx(tx)
            void Taro.showToast({ title: '已接受，去面交吧', icon: 'none' })
          })
          .catch((error) => {
            console.warn('[miniapp] 接受面交申请失败', error)
            if (epoch !== sessionEpoch()) return
            /**
             * 409 `LISTING_NOT_ACTIVE` 按契约**不代表「接受失败」**（并发买家先成交 / 商品
             * 已非在售），所以不报「接受没成功」这种口吻 —— 但它也不是「什么都没发生」：
             * 什么提示都不给，用户面对的还是一颗必然再 409 的「待确认」。于是：说一句商品
             * 现状 + 重查本页（`listing.status` 要跟着变，否则顶部不会自己退到「已预订」）。
             *
             * 口径只到「已不在售」：这个码**不区分成因**（下架 / 已被别人订走或卖掉 /
             * 上一次其实成功、这次是响应丢失后的重试），写成「已被其他买家预订」在另外两种
             * 情况下就是假消息。
             */
            if (isApiError(error) && error.code === 'LISTING_NOT_ACTIVE') {
              void Taro.showToast({ title: '这件商品已不在售，已为你刷新', icon: 'none' })
              // `load()` 内部就会重查这笔交易（含按 id 的精确查询），不再叠一次 `retryTx()`
              refreshConversationQuietly()
              return
            }
            void Taro.showToast({
              title: isApiError(error) ? error.message : '接受没成功，请重试',
              icon: 'none',
            })
            retryTx()
          })
      })
      .catch((error) => {
        // 确认框本身没弹出来（基础库 / 平台差异）：不静默，也不当作已接受
        console.warn('[miniapp] 面交确认框打开失败', error)
        void Taro.showToast({ title: '确认框没打开，请重试', icon: 'none' })
      })
      .finally(() => {
        acceptBusyRef.current = false
      })
  }

  /**
   * 顶部状态条的「拒绝」：卖家拒掉买家的面交申请（#551 Owner 追加）。
   *
   * 与接受**不同**：拒绝不建交易行、不改商品状态，`POST /transactions/proposals/reject`
   * 只往会话里写一条 `tx.rejected` SYSTEM 消息（`features/transaction/api.ts` 冻结的口径：
   * 提案阶段商品一直是 `ACTIVE`）。所以这里既不假改本地状态，也不重查交易行 —— 静默重拉
   * 本页，让那条 `tx.rejected` 消息自己把顶部推回「在售 · 查看」。
   *
   * 也不请求 TX 订阅授权（与 `pkg-browse/pages/mylist/index.tsx` 的 `declineProposal` 同一
   * 取舍，#511 审查）：拒绝之后没有交易，也就没有「订单状态更新」可推。
   */
  const declineProposal = () => {
    if (acceptBusyRef.current) return
    const epoch = sessionEpoch()
    acceptBusyRef.current = true
    void Taro.showModal({
      title: '拒绝这次面交申请？',
      content: '拒绝后这笔申请作废，商品仍在售，对方可以重新发起。',
      confirmText: '拒绝',
    })
      .then((result) => {
        if (!result.confirm) return
        return rejectProposal(conversationId)
          .then(() => {
            if (epoch !== sessionEpoch()) return
            void Taro.showToast({ title: '已拒绝 · 商品仍在售', icon: 'none' })
            refreshConversationQuietly()
          })
          .catch((error) => {
            console.warn('[miniapp] 拒绝面交申请失败', error)
            if (epoch !== sessionEpoch()) return
            void Taro.showToast({
              title: isApiError(error) ? error.message : '拒绝没成功，请重试',
              icon: 'none',
            })
            // 失败也要看服务端现状：可能对方已经撤回 / 被别处拒绝过，顶部不该停在旧提案
            refreshConversationQuietly()
          })
      })
      .catch((error) => {
        console.warn('[miniapp] 拒绝确认框打开失败', error)
        void Taro.showToast({ title: '确认框没打开，请重试', icon: 'none' })
      })
      .finally(() => {
        acceptBusyRef.current = false
      })
  }

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
   * 尾行锚点（#561）：`scrollIntoView` 的值不变时原生层不会重滚（先例
   * `pkg-browse/pages/user/index.tsx:184-195` 的「回到顶部」两颗同位锚点），所以「贴底」
   * 不能只靠一个恒定 id —— 几何一变（键盘升降、面板开合）就得换一个**同位**锚点再指一次，
   * 否则偏移被截断后没人把它推回底部。两个锚点都贴在最末一条消息之后，位置等价。
   *
   * 带上尾行的 `keyId`：内容追加时值也必然变，新消息照旧跟随到底（与改前同一条路径）。
   */
  const tailAnchorId = tail ? `conv-tail-${tail.keyId}-${tailAnchorFlip ? 'b' : 'a'}` : ''

  /**
   * 新消息落地就放弃「跳去看摘引」的目标，回到跟随最新。
   *
   * 不做成 `useEffect(() => setJumpTo(''), [tailId])`：那样要先渲染一帧旧目标再纠正，
   * 且 biome 的 `useExhaustiveDependencies` 会把 `tailId` 判成多余依赖（`setJumpTo` 是
   * 稳定引用）。这里把「跳转目标」与「设它时的 tailId」绑成一个值，渲染期直接比对 ——
   * tail 一变，目标自动失效，无需任何副作用。
   *
   * ⚠️ 已知限制（只记录，本票不改）：停在「跳去看摘引」期间，这里的值恒为 `jumpTo.id`，
   * 于是 `keepTailAnchored()` 翻的尾行锚点落不到 `scrollIntoView` 上 —— 那几秒里的重锚是
   * 空操作。它的代价只在「点摘引后、新消息到达前」这个窗口内，且 `#540` 要求那时锁住
   * 被引用的那条（不能被拽到底），两者本来就是互斥的；改法要连 `#540` 的判据一起动，
   * 不在本票范围。
   */
  const scrollTarget = jumpTo && jumpTo.tail === tailId ? jumpTo.id : tailAnchorId

  /**
   * 滚动动画只留给「点摘引跳过去」这一条路径（#540）。
   *
   * `scrollIntoView` 在首帧就会把滚动位置从 0 带到尾行，动画常开等于每次进页都把
   * 「顶部 → 底部」完整演一遍 —— 这正是本票要修的现象。判据与 `scrollTarget` 同源：
   * `jumpTo` 命中时目标是被引用的那条，需要动画交代「跳到哪儿去了」；其余时刻目标
   * 恒为尾行，瞬时贴底即可。
   *
   * 代价（验收第 2 条要求写明）：新消息追加也从「滑过去」变成「瞬移贴底」。最容易被
   * 看出来的是「用户正向上翻历史，对方发来一条」—— 改前有一次滑动交代去向，改后是硬跳。
   * 两者的落点完全一致（都强制贴底），丢的只是过渡；不在这里加 `onScroll` 首帧 settled
   * 判定还原跟随动画，是因为那依赖「程序化滚动也触发 bindscroll」这条静态无法证伪的端上
   * 行为，一旦不触发就会静默退化成「永远瞬时」，比写明取舍更难排查。
   */
  const animateScroll = jumpTo !== null && jumpTo.tail === tailId

  /**
   * 非贴底时的偏移复位指令（#561）：只有原生层把滚动偏移丢掉过才会出现这个值。
   *
   * **用后不撤**：撤掉就等于让属性回到默认的 0，那正是本票要修的「偏移掉成 0」形态。
   * 代价是属性长期绑在最后一次复位的位置上，所以靠 `tick` 的奇偶做 `0.5px` 交替 ——
   * `scrollTop` 只认「值有变化」，交替保证**同一个位置也能再下发一次**（半像素端上
   * 看不出来）；而属性值不变时不会重新应用，也就不存在「一直压着滚动位置」的副作用。
   * 已知取舍见 PR 的「已知取舍与风险」，端上要验一句（翻历史后手动滚回底部不被拉回）。
   */
  const restoreScrollTop = scrollRestore
    ? scrollRestore.top + (scrollRestore.tick % 2 === 0 ? 0 : 0.5)
    : undefined

  /**
   * 「+」面板自己要占的高度（设备 px，#597 追加任务）：内容高 + 底部安全区。
   *
   * 与键盘高度**解耦** —— 面板有三格图标，撑成一把键盘那么高只会留一片空白（Owner 在
   * 演示截图里的「展开后下方位置太空了」）。公式在 `view.ts` 的 `resolvePanelHeightPx()`
   * 里，rpx 数逐项对应 `index.scss` 的 `.conv__panel` / `.conv__ptile*`。
   *
   * 每页只算一次：窗口尺寸与安全区在页面生命周期内不变，且面板高度不参与任何滚动判定
   * （它只决定底座让位带的高度），不需要跟着渲染变。
   */
  const panelHeight = useMemo(() => {
    try {
      const info = Taro.getWindowInfo()
      // 安全区下沿 = 屏幕底 − safeArea.bottom（拿不到安全区就当 0，面板那条 env 也就不生效）
      const safeAreaBottom = info.safeArea
        ? Math.max(0, info.screenHeight - info.safeArea.bottom)
        : 0
      return resolvePanelHeightPx({ windowWidth: info.windowWidth, safeAreaBottom })
    } catch {
      // 老基础库拿不到窗口信息：按 375 宽、无安全区估，别让面板塌成 0
      return resolvePanelHeightPx({ windowWidth: 375, safeAreaBottom: 0 })
    }
  }, [])

  /**
   * 底部底座为「键盘 / 面板」让出的高度（设备 px，#597）。**唯一真源**：
   * `.conv__bar` 的下内边距取它，`.conv__panel` 自己的内容高度另由 `panelHeight` 定。
   *
   * 判据全在 `view.ts` 的 `resolveBottomInset()`：键盘态就是键盘高度；面板态取 `panelHeight`
   * （用正在收起的键盘高度会让底座跟着键盘动画连跳几档，正是 #597 现象一）。
   */
  const bottomInset = resolveBottomInset({
    panelOpen,
    keyboardHeight,
    panelHeight,
  })

  /**
   * 底部保留量的样式（#577）：**同一个占用者、同一份安全区**，只算一次。
   *
   * 收起态两项都是 `undefined` —— 内联整段不写，`.conv__bottom` 的
   * `env(safe-area-inset-bottom)` 与 `.conv__bar` 的 `$bar-gap-px` 照旧生效。
   * 占用态（键盘 / 面板）底座的安全区内衬清零、输入栏下内边距改成
   * `calc(占位高度 + $bar-gap-px)`：占用者自己已经把屏幕底部那块高度占了，
   * 再留一份安全区就是第二次计数（端上就是「输入栏离键盘上沿还空一条」）。
   * 判据在 `view.ts` 的 `resolveBottomReserveStyles()`，两条分支都有表驱动单测。
   */
  const bottomReserve = resolveBottomReserveStyles(bottomInset)

  /**
   * 记下一处输入行实测高度（#560 两态同盒模型的第二个真源）。
   *
   * `state` 供渲染（语音态 `minHeight`），`ref` 供**同步**读上一次的实测值 —— 判断「这次
   * 长高了多少」不能等一轮渲染回来。
   */
  const writeInputRowPx = useCallback((next: number) => {
    if (!(next > 0)) return
    inputRowPxRef.current = next
    setInputRowPx((prev) => (Math.abs(prev - next) < 0.5 ? prev : next))
  }, [])

  /**
   * 键盘高度订阅（#560/#561）：`onKeyboardHeightChange` 是设备级的，**只有这里能改写高度
   * 真源**。切态 / 开面板那些路径一律只 `Taro.hideKeyboard()`，高度交给平台事件收回 0。
   *
   * 平台报来的高度先过 `nextKeyboardInset` 压成单调阶梯：安卓收键盘动画期间会连报若干递减
   * 中间值，逐帧写进布局就成了用自己的布局动作去和系统动画拼速度（「先上提、再回落」）。
   *
   * 高度**真的变了**才重指尾行：键盘一升消息流就矮一截，原生层会把越界的滚动偏移截掉，
   * 不重新下一道「滚到底」的指令就回不来；同一高度的重复上报没有布局变化，不必再指一次。
   */
  useEffect(() => {
    // 基础库 < 2.7.0 没有这个 API（`undefined`）：直接调会在挂载时抛 TypeError，整页白屏
    if (typeof Taro.onKeyboardHeightChange !== 'function') return undefined
    const onHeightChange = (res: { height: number }) => {
      const step = nextKeyboardInset({
        prev: keyboardHeightRef.current,
        next: res.height,
        closing: keyboardClosingRef.current,
        closingFrom: keyboardClosingFromRef.current,
        closedFrom: keyboardClosedFromRef.current,
        closedAt: keyboardClosedAtRef.current,
        aboveFrom: keyboardAboveFromRef.current,
        pending: keyboardPendingRef.current,
        now: Date.now(),
      })
      /**
       * 阶梯状态**在纯函数里算完**，这里只回写与落地：页面里不保留第二条比较链，把「要不要
       * 落地」也交给返回值 `changed`，就不存在「换个比较对象把阶梯整个废掉」的改法。
       */
      keyboardClosingRef.current = step.closing
      keyboardClosingFromRef.current = step.closingFrom
      keyboardClosedFromRef.current = step.closedFrom
      keyboardClosedAtRef.current = step.closedAt
      keyboardAboveFromRef.current = step.aboveFrom
      /**
       * 哨兵账本（#560 B1）：`seen` 记「这一轮哨兵期内平台报过的最高值」，`pending` 接住被阶梯
       * 丢弃但值得留的候选值 —— 到点判「平台报过没有」只能看这个。**必须写在 `changed` 早退
       * 之前**：被丢弃的那一帧恰恰是最需要记账的一帧（终值只报一次的形态全是丢弃帧）。
       */
      keyboardSentinelMaxRef.current = Math.max(keyboardSentinelMaxRef.current, step.inset)
      keyboardPendingRef.current = step.pending
      // 收到 0：平台把键盘收干净了，活性哨兵不用再兜底（R2 的三个清理点之一）
      if (step.inset === 0) clearKeyboardSentinel()
      if (!step.changed) return
      keyboardHeightRef.current = step.inset
      setKeyboardHeight(step.inset)
      /**
       * **面板 → 键盘**的交接（#597）：面板展开时点输入框，**不在聚焦当拍收面板**，改在
       * 键盘真落地第一帧再收 —— 这是同一块高度在换占用者，必须等新占用者到了才让位。
       *
       * 为什么不能在聚焦当拍收：那一刻 `resolveBottomInset` 只能从「面板高」直落到
       * `keyboardHeight`，而它此刻还是 0（开面板时走过 `collapseKeyboard()`）→ 底部底座
       * 先塌空、视口放大一整把键盘，下一拍平台报高度再长回来。端上就是「输入栏先掉到屏幕
       * 底、下方空一片、再被顶上去」，是现象一的镜像，幅度比改前还大。
       *
       * 这一拍底座从「面板内容高」换成键盘高：面板不再与键盘等高（#597 追加任务），差值就是
       * 「这把键盘 − 面板内容高」，会**一次**变高 —— 这是预期行为（宁可一次让位，也不要留
       * 一片空面板）。`panelOpenRef` 直接写 false 再 setState：下面那句重指尾行在同一次回调里
       * 就按「面板已收」判，位置不会漏锚。
       *
       * 「是不是新占用者到了」全部交给 `shouldHandOffToKeyboard` 判 —— 页面里不自己写条件，
       * 否则少一条判据（尤其是 `!step.closing`）在源码钉桩之外测不出来：
       * 键盘**开着**点「+」会走 `collapseKeyboard()`，平台随后把收键盘拆成若干递减帧
       * （250/180/60…），那些帧高度都 `> 0`、`closing` 为真 —— 认成「新键盘到了」，面板
       * 就会在点「+」后约 40ms 自己消失，底座一路连降（现象一原样复发）。
       */
      if (
        shouldHandOffToKeyboard({
          panelOpen: panelOpenRef.current,
          closing: step.closing,
          inset: step.inset,
        })
      ) {
        panelOpenRef.current = false
        setPanelOpen(false)
      }
      /**
       * 只要真落地了新高度就重指尾行 —— 开键盘时视口变矮同样要重锚，不是只在收到 0 时。
       *
       * 面板展开期间例外（#597）：那一刻底部高度由面板占（`resolveBottomInset`），键盘往 0
       * 收的每一档**都不改变布局** —— 这几帧再翻尾行锚点，既会把翻历史的用户拽回底部，
       * 又会和面板那一次几何变化叠成「连着动两次」。
       */
      if (!panelOpenRef.current) keepTailAnchored()
    }
    Taro.onKeyboardHeightChange(onHeightChange)
    return () => {
      Taro.offKeyboardHeightChange(onHeightChange)
      // 卸载：哨兵的定时器不能在页面之外再跑一次 setState（R2 清理点之二）
      clearKeyboardSentinel()
    }
  }, [clearKeyboardSentinel, keepTailAnchored])

  /**
   * 面板开合 = 底部底座的**主动切换**（#597）。两件事一起落地：
   * - `panelOpenRef`：给常驻的键盘订阅读用（回调里读 state 只有订阅那一刻的旧值）；
   * - `panelGeomRef`：告诉下面那条量测 effect「这一次视口缩量是被面板引起的」。
   *
   * 必须单独一条、且声明在量测 effect **之前**：两者在同一个 commit 里按声明顺序执行，
   * 量测那一段在 effect 体里**同步**取走标志（不是等 `nextTick` 回来再判 —— 那时可能
   * 已经又跑过一轮量测了）。
   */
  useEffect(() => {
    panelOpenRef.current = panelOpen
    panelGeomRef.current = true
  }, [panelOpen])

  /**
   * 量一次几何：消息流视口高度 + 输入行高度（设备 px，0 = 量不到）。
   *
   * `onScroll` 的 detail 只有 `scrollTop` / `scrollHeight`，判断「离底部还差多少」必须知道
   * 视口多高 —— 自己量，不猜。输入行高度则是 #560 要的「两态同盒模型」：语音态拿它当
   * `minHeight`，切态时消息流不能因为输入框比「按住说话」高而变矮。
   *
   * 每次几何变化后重量一次：键盘升降、面板开合、语音/键盘切换、输入框长高、录音面板出现
   * 都会改变可视高度。量不到就沿用上一次的值（`isNearBottom` 对视口未知按贴底处理，见其注释）。
   *
   * 顺带记下「视口自己变矮了多少」（`bottomGapAllowanceRef`）：滚动事件里可能是「旧
   * scrollTop + 新 scrollHeight」的中间态，不给这段余量，一次多行输入就会把贴底误判成
   * 「用户在翻历史」，之后的重锚全被守卫挡掉（#560 的「多行输入后再切更明显」）。
   * 这里只是**兜底**：抢在滚动事件之前把缩量算出来的地方在 `onLineChange`（见其注释）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 五项都是刻意的重测信号（几何变了就重量一次），体内只写 ref 与按实测值 setState，不是渲染期读到的值
  useEffect(() => {
    let measuring = true
    /**
     * 面板刚换过态的那一次量测**不做缩量记账**（#597，判据见 `mergeViewportShrink` 的
     * `panelTransition`）：面板开合是用户主动切换底部底座，不是内容长高 —— 记进容差就等于
     * 把「贴底」一次放宽到面板那么高，翻历史的人下一次开面板会被判成贴底、拽到底。
     */
    const panelTransition = panelGeomRef.current
    panelGeomRef.current = false
    /**
     * 面板落地后要不要**再锚一次**尾行（#597 追加任务）：`togglePanel` 里那次 `keepTailAnchored`
     * 锚在面板占位**之前**的旧几何上，面板一落地消息流又矮一截，最后一条会被输入栏截掉。
     * 判据用展开当拍的贴底快照（`panelOpenStickRef`），所以展开时在翻历史的人不会被拽回底部。
     */
    const reopenTailAnchor = panelTransition && panelOpenRef.current && panelOpenStickRef.current
    if (reopenTailAnchor) panelOpenStickRef.current = false
    void Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select('.conv__scroll')
        .boundingClientRect()
        .select('.conv__input')
        .boundingClientRect()
        .exec((res) => {
          if (!measuring) return
          const viewport = res?.[0] as { height?: number } | undefined
          if (typeof viewport?.height === 'number' && viewport.height > 0) {
            // 只认「缩了多少」且**取大不覆盖**：视口变高不需要放宽；量测是事后的一帧，布局
            // 没落定时可能报 0，直接覆盖会把 `onLineChange` 刚记的增量清零（判据见
            // `mergeViewportShrink` 的注释与表驱动单测）
            bottomGapAllowanceRef.current = mergeViewportShrink({
              allowance: bottomGapAllowanceRef.current,
              prevViewport: scrollViewportRef.current,
              nextViewport: viewport.height,
              panelTransition,
            })
            scrollViewportRef.current = viewport.height
          }
          // 输入框两态常驻，语音态也量得到；量不到（首帧、老基础库）就沿用旧值，不归零
          const inputRow = res?.[1] as { height?: number } | undefined
          const inputHeight = inputRow?.height
          if (typeof inputHeight === 'number' && inputHeight > 0) writeInputRowPx(inputHeight)
          // 面板已经落地（这一帧的视口就是最终几何）：按展开当拍的贴底快照补一次尾行锚点
          if (reopenTailAnchor) keepTailAnchored()
        })
    })
    return () => {
      measuring = false
    }
  }, [keyboardHeight, panelOpen, voiceMode, inputRowPx, recording])

  /**
   * 记住用户是不是贴着底部。只写 ref：滚动事件很密，翻历史不该引起重渲染
   * （先例 `pkg-browse/pages/user/index.tsx:172-182` 的 `onScroll`）。
   *
   * `scrollTop` 另外存一份（#561）：几何变化前后拿它判断原生层有没有把偏移丢掉，非贴底时
   * 也靠它把位置写回去。
   */
  const onScroll = useCallback((event: { detail: ScrollViewProps.onScrollDetail }) => {
    const { scrollTop, scrollHeight } = event.detail
    scrollTopRef.current = scrollTop
    const nearBottom = isNearBottom(
      {
        scrollTop,
        scrollHeight,
        viewportHeight: scrollViewportRef.current,
      },
      // 本页刚造成的视口缩量算进容差；真到底了余量就该归零，免得长期放宽
      Math.max(BOTTOM_SLACK_PX, bottomGapAllowanceRef.current),
    )
    if (nearBottom) bottomGapAllowanceRef.current = 0
    stickBottomRef.current = stickAfterScroll(nearBottom)
  }, [])

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
            <LoadError title="会话加载失败" text="检查网络后重试" onRetry={() => load()} />
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
  /**
  /**
   * 对方的在线态（#359 第五点）：顶部栏昵称旁边。
   *
   * 判据走三处展示位共用的 `features/presence/view`（服务端判定 + 端上按同一 TTL 过期）；
   * 本页每 `DETAIL_POLL_MS` 重拉一次详情，所以「对方断线」会在一跳内翻成离线文案。
   */
  const counterpartPresence = presenceView(conversation.counterpartPresence, now)
  /**
   * 日期分隔条看**已加载的第一条**（分页后它会跟着变早），没有消息时退回会话的最后活跃时间。
   *
   * 第一条可能是文本也可能是媒体（两条流已合成），所以按 `kind` 取各自的 `createdAt`；
   * 本地待发条目没有服务端时间戳，不计入（它们必然最新，不影响「最早一条」）。
   */
  const firstEntry = entries.length > 0 ? entries[0] : undefined
  const firstCreatedAt =
    firstEntry?.kind === 'message'
      ? firstEntry.message.createdAt
      : firstEntry?.kind === 'media'
        ? firstEntry.media.createdAt
        : conversation.lastMessageAt
  const dayLabel = dayLabelOf(firstCreatedAt, now)

  /**
   * 30pt 圆头像：真实 avatarUrl 优先，无图回退首字（同消息列表行的降级）。
   * 头像本身是独立点击区（#517）：对方 → 他人主页，自己 → 编辑资料。
   * 消息行没有整行点击，头像与气泡是兄弟节点，所以不需要 stopPropagation。
   */
  const renderAvatar = (mine: boolean) => {
    const url = mine ? (me?.avatarUrl ?? '') : (counterpart.avatarUrl ?? '')
    const initial = mine ? (me?.nickname[0] ?? '我') : (counterpart.nickname[0] ?? '同')
    return (
      <View
        className={`conv__ava${mine ? ' is-mine' : ''}`}
        onClick={mine ? openSelfProfile : openCounterpart}
      >
        {url ? (
          <Image className="conv__ava-img" src={url} mode="aspectFill" />
        ) : (
          <Text className="conv__ava-tx">{initial}</Text>
        )}
      </View>
    )
  }

  /**
   * SYSTEM 消息一律渲染成居中灰胶囊（`tx.proposal` / `tx.rejected` / `tx.accepted` /
   * 普通系统文本）。
   *
   * `tx.accepted` 不再在消息流里画交易码卡（#522）：那张卡拍的是**事件发生那一刻**
   * 的快照，成交 / 取消之后仍然写着「待面交」，而聊天记录不可变、也没法就地更正。
   * 当前进度改由页头那条商品交易状态条（`txBarView`）按交易行渲染。
   *
   * 但**历史交易**的入口不能一起丢（#521 验收②）：同一会话可以有多笔交易（取消后
   * 重新接受会再建一笔），每条老消息里的 `transactionId` 仍要能定位到它自己那一笔。
   * 判据：消息里的 id 与当前交易行不同 ⇒ 历史交易，胶囊文案带「查看本笔」，点击走
   * `openMeetup(id)`；当前这一笔的入口在页头状态条上，胶囊只陈述事实、不重复引流。
   */
  const renderSystem = (message: MessageDto) => {
    const event = parseTxEvent(message.content)
    const txId = event?.transactionId
    /**
     * 历史交易的判据只看「消息里的 id 与当前交易行是否不同」：
     * - 查到当前交易行：与它不同的都是历史，给「查看本笔」；
     * - 没查到（接口失败 / 数据缺失）：无从判断哪一笔是当前，宁可把每条带 id 的
     *   `tx.accepted` 都当入口 —— 点进去至少落到本笔交易码页，比一条死文案有用。
     * `idle` 是首屏查询还没回来，此时不提前给入口，避免文案闪一下又变回去。
     */
    const historical =
      event?.type === 'tx.accepted' &&
      typeof txId === 'string' &&
      txLoad.status !== 'idle' &&
      (txLoad.tx === null || txId !== txLoad.tx.id)
    const historicalTxId = historical ? txId : null
    /**
     * 老数据里的 `tx.accepted` 可能没带 transactionId：这时**不能**给一个空 id 的
     * 跳转（#521 的 notFound 就是这么来的），但也不能只留一句「已接受交易」让用户
     * 无处可去 —— 明说去「我的订单」查，是唯一不会说谎的引导。
     */
    const noIdHint = event?.type === 'tx.accepted' && typeof txId !== 'string'
    /** 没有 id 可跳时，「我的订单」是唯一能自己查到这笔交易的地方：让这句引导本身可点。 */
    const ordersUrl =
      conversation.role === 'buyer'
        ? '/pkg-trade/pages/orders-buy/index'
        : '/pkg-trade/pages/orders-sell/index'
    const goOrders = () => {
      void Taro.navigateTo({ url: ordersUrl })
    }
    let label = systemPillText(message.content)
    if (historical) label = '已接受交易 · 查看本笔'
    else if (noIdHint) label = '已接受交易 · 请从「我的订单」查看'
    return (
      <View
        key={message.id}
        id={`e-${message.id}`}
        className="conv__sys"
        onClick={
          historicalTxId ? () => openMeetup(historicalTxId) : noIdHint ? goOrders : undefined
        }
      >
        <Text className="conv__sys-tx">{label}</Text>
      </View>
    )
  }

  /**
   * LISTING 消息（#359）：服务端富化的商品卡（缩略图 + 标题 + 价格），点击进商品详情。
   * `listing` 投射为 null（商品被并发删除的脏数据）时退化成灰气泡占位，不给点击——
   * 与「正文是引用不是文本」的语义一致，宁可少一个可点目标也不画一张空卡。
   *
   * 已下架的卡也不给点击入口：详情对「非商品卖家的 OFFLINE / 未过审」一律 404
   * （`listings/service.ts` 的 `loadDetail` 判的是 `sellerId !== viewerId`）。
   * 判据**不能**用「这条卡是不是我发的」：分享页两侧都能选（我的宝贝 / TA的宝贝），
   * 同一会话里买卖双方都可能发一张**别人的**卡 —— 买家把卖家商品卡发进来，商品下架后
   * 这条仍是 `isMine`，可买家并不是卖家，点进去必然 404。而投射里没有 `sellerId`
   * （`conversationListingSchema` 只有 id / title / priceCents / status / coverUrl），
   * 判不出「我是不是这件商品的卖家」，所以取保守口径：已下架一律不给入口。
   * 读侧不对 LISTING 做可见性过滤，这类卡会长期留在历史里。
   */
  const renderListing = (message: MessageDto) => {
    const mine = message.senderId === me?.id
    const card = message.listing
    const canOpen = card !== null && card !== undefined && card.status !== 'OFFLINE'
    return (
      <View
        key={message.id}
        id={`e-${message.id}`}
        className={`conv__row${mine ? ' is-mine' : ''}`}
      >
        {renderAvatar(mine)}
        <View className="conv__col">
          {message.recalledAt !== null ? (
            // 已撤回的商品卡也必须翻碑（#518）：服务端撤回后仍保留 listing 投射，
            // 不能按 card 是否为空来判断。
            <View className="conv__recalled">
              <Text className="conv__recalled-tx">
                {mine ? '你撤回了一条消息' : '对方撤回了一条消息'}
              </Text>
            </View>
          ) : card ? (
            <View
              className={`conv__lcard${recallingId === message.id ? ' is-busy' : ''}`}
              onTouchStart={resetBubbleTapGuard}
              onLongPress={() => void onLongPressMessage(message)}
              onClick={
                canOpen
                  ? () => {
                      if (consumeBubbleTap()) return
                      void Taro.navigateTo({
                        url: `/pkg-browse/pages/listing-detail/index?id=${card.id}`,
                      })
                    }
                  : undefined
              }
            >
              <View className="conv__lcard-thumb">
                {card.coverUrl ? (
                  <Image className="conv__lcard-img" src={card.coverUrl} mode="aspectFill" />
                ) : (
                  <Image className="conv__lcard-ph" src={ICONS.imageMuted} mode="aspectFit" />
                )}
              </View>
              <View className="conv__lcard-main">
                <Text className="conv__lcard-title">{card.title}</Text>
                <Text className="conv__lcard-meta num">
                  {`¥`}
                  <Text className="conv__lcard-price">{formatAmount(card.priceCents)}</Text>
                  {` · ${listingStatusText(card.status)}`}
                </Text>
              </View>
              {/* 不可点的卡不给「可以点进去」的箭头（#359 3a 审查回合） */}
              {canOpen ? (
                <Image
                  className="conv__lcard-caret"
                  src={ICONS.chevronRightMuted}
                  mode="aspectFit"
                />
              ) : null}
            </View>
          ) : (
            <View
              className="conv__bubble"
              onTouchStart={resetBubbleTapGuard}
              onLongPress={() => void onLongPressMessage(message)}
            >
              <Text className="conv__bubble-tx">[商品]</Text>
            </View>
          )}
          <Text className="conv__time num">{clockTime(message.createdAt)}</Text>
        </View>
      </View>
    )
  }

  /**
   * 顶部交易状态条（#551）：这条现在是**唯一**的交易状态位（#521 / #522 的吸底卡已按
   * Owner 决策删除，见 `view.ts` 的 `txBarView`），所以它必须一直能渲染 —— 没有交易时
   * 它就是普通商品摘要条（图 / 名 / 价 / 商品状态 +「查看」）。
   *
   * `lastEvent` 与聊天列表的胶囊同源（**从消息流取**最后一条 SYSTEM 交易事件，宽松口径）：
   * 不能只看 `conversation.lastMessage` —— 实时 `message.new` 只更新 `messages`，且
   * 取消后重新提案时中间常夹着文字消息。提案态与提案金额都只能从这里读。
   */
  const lastTxEvent = lastEventOfMessages(messages)

  /**
   * 「有交易证据」：消息流里出现过 `tx.accepted`，或上一轮查到过交易行 —— 只有这时
   * 才谈得上失败降级，否则一次网络抖动会让普通聊天也冒出交易卡。
   *
   * 失败时**不能沿用旧 tx 的终态**（可能属于上一笔交易）；上一笔仍是 PENDING_MEETUP
   * 且消息里没有更新的交易 id 时，可以继续显示成交前的两档文案（验收要求「退回成交前
   * 文案，可重试」）—— 面交页里有准确状态，入口本身不会说谎。消息里已经出现另一笔
   * 交易的 id 时，旧 PENDING 行不再可信，走「交易状态待更新」。
   */
  const txKnown = fallbackTxId !== null || txLoad.tx !== null || lastTxEvent?.type === 'tx.accepted'
  const txFailed = txLoad.status === 'failed' && txKnown
  /** 失败时缓存只在「仍是同一笔待面交」时可继续展示 —— 终态和别的交易的缓存都不算数 */
  const cachedTx =
    txLoad.status !== 'failed'
      ? txLoad.tx
      : txLoad.tx !== null && (fallbackTxId === null || fallbackTxId === txLoad.tx.id)
        ? txLoad.tx
        : null
  /**
   * 「待评价」判据只在我这笔交易的评价查询回来之后才成立；没回来 / 查失败一律 `null`。
   * `null` 不是「未评价」：`txBarView` 会用它换一句中性文案「查看交易」，去向仍是那一笔的
   * 面交页（端上唯一评价入口），既不说谎也不会让用户无处可评。
   */
  const reviewed =
    txReview !== null && txLoad.tx !== null && txReview.txId === txLoad.tx.id
      ? txReview.reviewed
      : null

  const txBar = txBarView({
    role: conversation.role,
    listingStatus: listing.status,
    tx: txFailed ? cachedTx : txLoad.tx,
    lastEvent: lastTxEvent,
    /**
     * 首屏交易查询还没回来（`idle`）时不给「查看交易码」降级：那不是「查不到」，
     * 只是还没查 —— 给了会闪一下再变回商品状态。
     */
    fallbackTxId: txLoad.status === 'idle' ? null : fallbackTxId,
    failed: txFailed,
    reviewed,
  })

  /** 卖家提案态的次要动作（`拒绝`）；没有次要动作时那颗钮整颗不渲染 */
  const secondaryTxBar = txBar.secondary ?? null

  /**
   * 顶部状态条动作区的分发：主钮传 `txBar.action`（默认取它），次要钮（`拒绝`）显式传入
   * 自己的动作。两颗钮都必须先 `stopPropagation` —— 外层整条是「点进商品详情」。
   */
  const runTxBarAction = (
    event: { stopPropagation: () => void },
    action: TxBarAction = txBar.action,
  ) => {
    event.stopPropagation()
    if (action.kind === 'listing') return openListing()
    if (action.kind === 'confirm') return confirmProposal(action.amountCents)
    if (action.kind === 'reject') return declineProposal()
    if (action.kind === 'code') return openMeetup(action.transactionId)
    if (action.kind === 'review') return openMeetup(action.transactionId)
    if (action.kind === 'scan') {
      void Taro.navigateTo({ url: SCAN_CODE_PAGE })
      return
    }
    if (action.kind === 'retry') return retryTx()
    // 'wait'：买家等卖家确认，状态词已经说完了，没有可点的动作
  }

  return (
    <View className="conv">
      {/*
        渐变圆角头（稿子 .chathead）：导航条 + 商品摘要条都在里面，不随消息滚动。
        状态栏高度用内联 px（设备相关，不走 rpx），导航行高 88rpx 与商品详情页一致。

        导航行与状态栏带落在「+」面板遮罩**之上**（遮罩顶边 = 导航行底边，返回钮不能被
        盖住），所以这两处点空白也要自己收面板（#541）。
      */}
      <View
        className="conv__head"
        style={{ paddingTop: `${metrics.statusBarHeight}px` }}
        onClick={panelOpen ? dismissPanel : undefined}
      >
        {/*
          导航行几何与 `components/top-bar` 同构（行内下发，见 index.scss）：
          返回钮在胶囊那一段里居中，与右侧原生胶囊同轴。
        */}
        <View
          className="conv__navrow"
          style={{
            height: `${metrics.totalHeight - metrics.statusBarHeight}px`,
            paddingBottom: `${metrics.totalHeight - metrics.statusBarHeight - metrics.contentHeight}px`,
          }}
        >
          <View className="conv__back" style={backGeo.btnStyle} onClick={handleBack}>
            <View className="conv__chevron" style={bareChevronStyle} />
          </View>
          {/*
            标题框与返回钮同段：bottom 收掉行高的「补下方」部分，让标题也在胶囊
            那一段（contentHeight）里居中 —— 否则标题中心比胶囊低 2px（整 44pt 行
            的中心 ≠ 胶囊段中心）。
          */}
          <View
            className="conv__title"
            style={{
              bottom: `${metrics.totalHeight - metrics.statusBarHeight - metrics.contentHeight}px`,
            }}
          >
            <View className="conv__title-in" style={{ maxWidth: `${titleMaxWidth}px` }}>
              {/* 顶部昵称与对方头像同一入口（#517）；自己头像走上方的 openSelfProfile */}
              <Text className="conv__title-nm" onClick={openCounterpart}>
                {counterpart.nickname}
              </Text>
              {/* 在线态（#359 第五点）：顶部栏用户名隔壁。绿点 + 文案；离线时说
                  「多久没上线」（`12 分钟前活跃`），拿不到在线态时整块不渲染。 */}
              {counterpartPresence ? (
                <View className={`conv__presence${counterpartPresence.online ? ' is-online' : ''}`}>
                  <View className="conv__presence-dot" />
                  <Text className="conv__presence-tx">{counterpartPresence.text}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* 商品交易状态条（#551）：不是白卡 —— 没有 surface 底、没有描边、没有卡片阴影，
            直接坐在渐变头上；只留图 / 名 / 价 / 状态，右侧动作区随交易状态换。
            点整条进商品详情，动作钮自己 stopPropagation。 */}
        <View className={`conv__pbar ${txBar.tone}`} onClick={openListing}>
          <View className="conv__pbar-thumb">
            {listing.coverUrl ? (
              <Image className="conv__pbar-img" src={listing.coverUrl} mode="aspectFill" />
            ) : (
              <Image className="conv__pbar-ph" src={ICONS.imageMuted} mode="aspectFit" />
            )}
          </View>
          <View className="conv__pbar-main">
            <Text className="conv__pbar-title">{listing.title}</Text>
            <Text className="conv__pbar-meta num">
              {'¥'}
              <Text className="conv__pbar-price">{formatAmount(listing.priceCents)}</Text>
              <Text className="conv__pbar-status">{` · ${txBar.status}`}</Text>
            </Text>
          </View>
          {txBar.action.kind === 'wait' ? null : (
            <View className="conv__pbar-acts">
              {/*
                卖家提案态并排两颗：`拒绝` 在前（次要，描边药丸），`待确认` 在后（主操作）。
                买家没有拒绝入口 —— 提案由买家发起，撤回不在本 Issue 范围。
              */}
              {secondaryTxBar ? (
                <View
                  className="conv__pbar-act conv__pbar-act--ghost"
                  onClick={(event: { stopPropagation: () => void }) =>
                    runTxBarAction(event, secondaryTxBar.action)
                  }
                >
                  <Text>{secondaryTxBar.label}</Text>
                </View>
              ) : null}
              <View className="conv__pbar-act" onClick={runTxBarAction}>
                <Text>{txBar.label}</Text>
              </View>
            </View>
          )}
        </View>
      </View>

      {/* 消息流：打开即停在最新（底部）；点摘引时临时改跳到被引用那条。
          `scrollTop` 只在原生层丢过偏移（非贴底复位）之后才有值，且**用过不撤** ——
          靠 `tick % 2` 的 0.5px 交替保证同一位置也能再下发，属性值不变则不会重新应用，
          所以它长期在场也不会盖住 `scrollIntoView` 的后续定位（两者并存的优先级只能端上验）

          面板展开时由 `onTouchStart` 收起面板（#597）：改前这里被一层透明遮罩盖住，面板
          展开期间消息流**滑不动**、长按/点图也拿不到触摸。现在遮罩没了，触摸先落到消息流
          自己身上 —— 手指一动就收面板，这一下**不**拦着滚动（滚动仍由 ScrollView 处理），
          手指不动只点一下就是「点空白收起」。
          只在展开时挂：收起态传 `undefined`，回调不出现在事件表里。 */}
      <ScrollView
        className="conv__scroll"
        scrollY
        scrollTop={restoreScrollTop}
        scrollIntoView={scrollTarget}
        scrollWithAnimation={animateScroll}
        onScroll={onScroll}
        onTouchStart={panelOpen ? dismissPanel : undefined}
      >
        <View className="conv__list">
          {/* 更早一页：文本与媒体两条流各有游标，任一还有更早就给入口（#67 N3） */}
          {hasEarlierPage(nextCursor, mediaCursor) || earlierFailed ? (
            <View className="conv__earlier">
              {earlierFailed ? (
                <View className="conv__retry" onClick={loadEarlier}>
                  <Image className="conv__retry-ic" src={ICONS.refreshBrand} mode="aspectFit" />
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
            <LoadError title="消息加载失败" text="检查网络后重试" onRetry={() => load()} />
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
                          {/* 引用摘引（#359 3c）：服务端投射回来之前先用本地那份 */}
                          {entry.pending.replyTo ? (
                            <View className="conv__quote is-mine">
                              <Text className="conv__quote-tx">
                                {entry.pending.replyTo.excerpt}
                              </Text>
                            </View>
                          ) : null}
                          <Text className="conv__bubble-tx">{entry.pending.content}</Text>
                        </View>
                        {failed ? (
                          <View className="conv__retry" onClick={() => retry(entry.pending)}>
                            <Image
                              className="conv__retry-ic"
                              src={ICONS.refreshBrand}
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

                if (entry.kind === 'media') {
                  const item = entry.media
                  const mine = item.senderId === me?.id
                  /**
                   * 撤回碑（#359 3c 审查回合二的媒体侧补齐）：服务端撤回后下发的媒体 DTO
                   * `url` 为空、尺寸/时长全 null（`media-service.ts` 的 `dto`），照常渲染会
                   * 画出一张永远转圈的空图 / 时长兜底成 `1″` 的语音气泡。
                   */
                  if (item.recalledAt !== null) {
                    return (
                      <View
                        key={entry.keyId}
                        id={`e-${entry.keyId}`}
                        className={`conv__row${mine ? ' is-mine' : ''}`}
                      >
                        {renderAvatar(mine)}
                        <View className="conv__col">
                          <View className="conv__recalled">
                            <Text className="conv__recalled-tx">
                              {mine ? '你撤回了一条消息' : '对方撤回了一条消息'}
                            </Text>
                          </View>
                          <Text className="conv__time num">{clockTime(item.createdAt)}</Text>
                        </View>
                      </View>
                    )
                  }
                  // 图片必须用本地临时文件渲染：契约里的 url 是 Web 形态（带 /api 前缀），
                  // 小程序没有同源代理、<Image> 也带不了 Cookie（见 media-api.ts）
                  const local = item.kind === 'IMAGE' ? localPaths.get(item.mediaId) : undefined
                  return (
                    <View
                      key={entry.keyId}
                      id={`e-${entry.keyId}`}
                      className={`conv__row${mine ? ' is-mine' : ''}`}
                    >
                      {renderAvatar(mine)}
                      <View className="conv__col">
                        {renderMediaQuote(item.replyTo, true)}
                        {item.kind === 'VOICE' ? (
                          renderVoiceBubble(
                            item.id,
                            item.durationMs,
                            mine,
                            () => openVoice(item),
                            false,
                            () => void onLongPressMessage(item),
                            recallingId === item.id,
                          )
                        ) : (
                          <View
                            className={`conv__bubble conv__bubble--media${
                              recallingId === item.id ? ' is-busy' : ''
                            }`}
                            onTouchStart={resetBubbleTapGuard}
                            onLongPress={() => void onLongPressMessage(item)}
                            onClick={() => {
                              if (consumeBubbleTap()) return
                              openImage(item)
                            }}
                          >
                            {/* 还没下载完就先露 `.conv__photo` 的占位底色，不塞空 src */}
                            <View className="conv__photo">
                              {local ? (
                                <Image className="conv__photo-img" src={local} mode="aspectFill" />
                              ) : null}
                            </View>
                          </View>
                        )}
                        <Text className="conv__time num">{clockTime(item.createdAt)}</Text>
                      </View>
                    </View>
                  )
                }

                if (entry.kind === 'pending-media') {
                  const item = entry.pending
                  // 与重试按钮同一口径：能重试的状态就是失败态（`./view` 的 canRetryMedia）
                  const failed = canRetryMedia(item)
                  return (
                    <View key={entry.keyId} id={`e-${entry.keyId}`} className="conv__row is-mine">
                      {renderAvatar(true)}
                      <View className="conv__col">
                        {renderMediaQuote(item.replyTo, false)}
                        {item.kind === 'VOICE' ? (
                          // 本地录音文件直接播，不下载：自己刚录的这段就在本地。
                          // 失败同样给 `!` 角标（#364 审查）：修复前只有 IMAGE 分支有，
                          // 失败的语音气泡本身看不出是坏的。
                          renderVoiceBubble(
                            entry.keyId,
                            item.durationMs,
                            true,
                            () => playVoice(entry.keyId, item.path),
                            failed,
                          )
                        ) : (
                          <View className="conv__bubble conv__bubble--media">
                            <View className="conv__photo">
                              {/* 本地临时文件就是预览源：不等上传完、不等服务端回图 */}
                              <Image
                                className="conv__photo-img"
                                src={item.path}
                                mode="aspectFill"
                              />
                              {failed ? (
                                <View className="conv__failmark">!</View>
                              ) : (
                                <View className="conv__prog">
                                  <View className="conv__ring is-spin" />
                                </View>
                              )}
                            </View>
                          </View>
                        )}
                        {failed ? (
                          <View className="conv__retry" onClick={() => retryMedia(item)}>
                            <Image
                              className="conv__retry-ic"
                              src={ICONS.refreshBrand}
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
                if (message.type === 'LISTING') return renderListing(message)

                const mine = message.senderId === me?.id
                /**
                 * 逐条读位（#359 四）：只对我发出的消息判，对方发来的为 null 不渲染。
                 * 读位来自详情的 `counterpartLastReadAt`，所以它随 `load` 一起刷新。
                 */
                const readLabel = messageReadLabel({
                  mine,
                  createdAt: message.createdAt,
                  counterpartLastReadAt: conversation.counterpartLastReadAt,
                })
                /** 撤回碑（#359 3c）：双方一致、刷新后一致 —— 正文已由服务端清空 */
                const recalled = message.recalledAt !== null
                return (
                  <View
                    key={message.id}
                    id={`e-${message.id}`}
                    className={`conv__row${mine ? ' is-mine' : ''}`}
                  >
                    {renderAvatar(mine)}
                    <View className="conv__col">
                      {recalled ? (
                        <View className="conv__recalled">
                          <Text className="conv__recalled-tx">
                            {mine ? '你撤回了一条消息' : '对方撤回了一条消息'}
                          </Text>
                        </View>
                      ) : (
                        <View
                          className={`conv__bubble${mine ? ' is-mine' : ''}${
                            recallingId === message.id ? ' is-busy' : ''
                          }`}
                          onTouchStart={resetBubbleTapGuard}
                          onLongPress={() => void onLongPressMessage(message)}
                        >
                          {/* 摘引（#359 3c）：点它定位到被引用的原消息；长按菜单后的
                              补发 tap 由守卫吞掉，避免撤回反馈被意外跳转盖掉（#518） */}
                          {message.replyTo ? (
                            <View
                              className={`conv__quote${mine ? ' is-mine' : ''}`}
                              onClick={() => {
                                if (consumeBubbleTap()) return
                                locateMessage(message.replyTo?.id ?? '')
                              }}
                            >
                              <Text className="conv__quote-tx">{message.replyTo.excerpt}</Text>
                            </View>
                          ) : null}
                          <Text className="conv__bubble-tx">{message.content}</Text>
                        </View>
                      )}
                      <Text className="conv__time num">
                        {clockTime(message.createdAt)}
                        {readLabel ? (
                          <Text className={`conv__rd${readLabel === '未读' ? ' is-unread' : ''}`}>
                            {` · ${readLabel}`}
                          </Text>
                        ) : null}
                      </Text>
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
        {/* 尾行锚点（#561）：贴在整条流的**最末**（不在 `.conv__list` 里，免得吃它的 gap /
            下内边距），零尺寸，滚到它就是滚到底；两个锚点靠 `tailAnchorFlip` 交替指 */}
        {tailAnchorId ? <View id={tailAnchorId} /> : null}
      </ScrollView>

      {/*
        底部底座（#597）：输入栏 + 「+」面板是**同一块屏幕底部区域**的两个占用者 —— 键盘开着
        时由输入栏的下内边距占，面板开着时由面板自己占，占多少由 `resolveBottomInset()` 给
        （键盘态 = 键盘高度；面板态 = 面板自己的内容高 + 安全区，见 `resolvePanelHeightPx()`）。

        面板高度**不再等于**键盘高度（#597 追加任务）：三格图标的内容撑不满一把键盘，按键盘高
        撑开会留一片空白。所以键盘 ↔ 面板的交接会让底座**一次**变高/变矮（差一个「键盘高 −
        面板高」），消息流跟着让位一次 —— 这是有意的取舍，换来面板不空、且中间不出现塌成 0
        的那一档（聚焦当拍不收面板，见键盘订阅里的交接判据 `shouldHandOffToKeyboard`）。

        结构边界（#577 已按此落地）：本容器承担「贴底 + 背景铺到窗口底边 + 底部安全区（唯一一处）
        + 给面板当定位父级」，输入栏自己的几何（内边距、68px 控件、间距）一律留在
        `.conv__bar`；安全区数值只写在 scss 的 `.conv__bottom` 上，占用态由内联清零，不在这里
        写第二份数字。
      */}
      <View className="conv__bottom" style={bottomReserve.bottom}>
        {/*
        输入栏（稿子 .composer）：语音/键盘切换 + 自动长高输入框 + 「+」+ 发送。
        空内容时「发送」置灰（稿子 .send.is-off）。

        下内边距（#577）：收起态由 scss 的 `$bar-gap-px` + `.conv__bottom` 的安全区承担，
        这里不内联；底座被占用（键盘 / 「+」面板）时才内联
        `calc(占位高度 + $bar-gap-px)` —— 占位高度是运行期量到的设备 px，只能内联
        （内联样式不过 pxtransform，先例 `components/back-top/index.tsx` 的「请直接传 rpx 字符串」），
        基础间距按 rpx 写、与 scss 同一个数。这一拍同时把底座的安全区内衬清零
        （`bottomReserve.bottom`）：占用者自己已经占了那块高度，安全区再留一次就是重复计数。
        两条分支都在 `resolveBottomReserveStyles()` 里，别再在 JSX 里现算条件。

        键盘那一路只会**一路变小**（`nextKeyboardInset` 的单调阶梯）：收键盘动画期间平台连报的
        中间值被压成一条向下的序列，输入栏不会在中途被顶回去一下（#560 安卓真机的「先上提、
        再回落」）。面板那一路是常量（`resolveBottomInset` 不看正在收缩的键盘），所以开面板
        时底座高度**一次**到位，不会跟着键盘动画连跳几档（#597 现象一）。
      */}
        <View className="conv__bar" style={bottomReserve.bar}>
          {/* 录音反馈面板（#535）：计时与波形在子组件内部，消息流不随秒数重渲染 */}
          {recording ? <VoiceRecordPanel cancelArmed={cancelArmed} /> : null}
          {/* 引用栏（#359 3c）：显示被引用消息的摘引与取消；发送后自动收起 */}
          {replyTarget ? (
            <View className="conv__replybar">
              <View className="conv__replybar-main">
                <Text className="conv__replybar-tx">{localReplyExcerpt(replyTarget)}</Text>
              </View>
              <View className="conv__replybar-cancel" onClick={() => setReplyTarget(null)}>
                <Image className="conv__replybar-ic" src={ICONS.closeFg} mode="aspectFit" />
              </View>
            </View>
          ) : null}
          <View className="conv__bar-row">
            {/*
            这颗钮是**两态开关**，图标要跟着态走：键盘态显示话筒（点了进语音），
            语音态显示键盘（点了切回输入框）。图标不变的话，进了语音态就没有「怎么切回去」
            的视觉指示 —— 输入区那边虽然换成了「按住 说话」，但那不构成返回入口。
            稿子 `1版conversation.html` 的 `syncVoice()` 正是这么切的（`#ic-mic` / `#ic-keyboard`），
            与微信自己的输入栏一致。
          */}
            <View className={`conv__cbtn${voiceMode ? ' is-on' : ''}`} onClick={toggleVoiceMode}>
              <Image
                className="conv__cbtn-ic"
                src={voiceMode ? ICONS.keyboardFg : ICONS.micFg}
                mode="aspectFit"
              />
            </View>

            {/*
            输入框**常驻不卸载**（#560 安卓真机的根因）：切语音态时把它卸载再挂回来，
            新挂载的 `<Textarea autoHeight>` 在拿到真实宽度之前会按最窄宽排版、把占位文字
            折成三行，`onLineChange` 报出 85/100 的高度，下一拍才塌回 30/48 —— 输入栏先上提
            52px 再回落，就是 Owner 说的「底部空缺」。

            保持挂载就没有这段瞬态：两态共用同一块输入行，`bar` 的高度自始至终由这一个
            输入框决定（语音态也如此，只是把它藏起来）。所以语音态不再需要拿
            `inputRowPx` 去给「按住说话」顶一个 `minHeight` —— 那条桥本身就是对
            「输入行会消失」的补偿。
          */}
            <View className="conv__rowwrap">
              {voiceMode ? (
                /*
                按住说话：`onTouchStart` 起录、`onTouchEnd` 松开就发、`onTouchCancel`
                手指滑出即放弃。微信的 `RecorderManager` 只有「停」没有「撤销」，
                取消只能靠不把这段音频交给上传。

                绝对定位盖满整行（`conv__rowwrap` 是它的定位父级）：高度跟着输入行走，
                多行草稿切到语音态时手势区也是同样的高度。
              */
                <View
                  className={`conv__hold${recording ? ' is-on' : ''}${cancelArmed ? ' is-cancel' : ''}`}
                  onTouchStart={startVoice}
                  onTouchMove={moveVoice}
                  onTouchEnd={endVoice}
                  onTouchCancel={() => finishVoice(true)}
                >
                  <Text className="conv__hold-tx">
                    {cancelArmed ? '松开 取消' : recording ? '松开 发送' : '按住 说话'}
                  </Text>
                </View>
              ) : null}
              <Textarea
                className="conv__input"
                /*
                语音态只藏不卸载：`opacity: 0` 让它不参与视觉，`pointerEvents: 'none'`
                把触摸让给上面那层 `conv__hold`。
              */
                style={voiceMode ? { opacity: 0, pointerEvents: 'none' } : undefined}
                value={inputValue}
                placeholder="发消息…"
                placeholderClass="conv__input-ph"
                autoHeight
                maxlength={2000}
                disableDefaultPadding
                /*
                `adjustPosition={false}`：键盘高度已经由本页自己补偿（见 `.conv__bar` 的
                内联下内边距，真源是 `keyboardHeight`）。再让平台按默认行为推一次页面就是
                两套补偿叠加 —— 切语音态时就是「先上提、再回落」。`cursorSpacing={0}`
                同理：光标与键盘的距离由本页的布局定，平台不要再替我们滚动。
              */
                adjustPosition={false}
                cursorSpacing={0}
                /*
                `onLineChange` 直接给设备 px 高度，比在渲染期猜行数准 —— `event.detail.height`
                就是这个输入行的实测高度。它已经不用来给语音态顶 `minHeight` 了（输入框常驻，
                高度自己就在），但仍然要记：下面第一句把它折算成「本页刚让出多少消息流高度」。

                **当场**把缩量交给贴底判据：输入框一变高，原生层会截断越界偏移并立刻抛
                `bindscroll`，而量测 effect 还要等下一帧的 `nextTick`；等它回来，这次滚动
                早被判成「用户在翻历史」，之后切态 / 开面板的重锚全被守卫挡掉，最新一条就
                压在视口外几十 px 回不来（#561 的复发路径）。
                记账口径（累加 / 边界 / `ref` 为 0 表示还没量到或刚清空）全在
                `growBottomAllowance` 里 —— 这里只管把值交过去。
              */
                onLineChange={(event) => {
                  const { height } = event.detail
                  if (!(height > 0)) return
                  bottomGapAllowanceRef.current = growBottomAllowance({
                    allowance: bottomGapAllowanceRef.current,
                    prevInputPx: inputRowPxRef.current,
                    nextInputPx: height,
                  })
                  writeInputRowPx(height)
                }}
                onFocus={() => {
                  /**
                   * 面板**不在这一拍收**（#597 F1）：点输入框、键盘被叫起来，是底部那块高度
                   * 在换占用者 —— 新占用者（键盘）还没到，先让位就会塌空一次（底座直落到 0、
                   * 视口放大一整把键盘），端上是「输入栏先掉到屏幕底、再被顶上去」。
                   * 收到键盘真落地第一帧时再收，见键盘订阅里的交接那一段。
                   * 「点输入框也算点面板外部」的可见契约不变（#541）。
                   *
                   * 唯一例外是**降级路径**（基础库 < 2.7.0 没有 `onKeyboardHeightChange`，
                   * 上面那条订阅直接返回了，见 `typeof Taro.onKeyboardHeightChange` 那一段）：
                   * 没有「键盘真落地那一帧」可等，收面板只能退回聚焦当拍，否则面板再也收不起来、
                   * #541 的契约在这条路上彻底失效。那条路上也不存在交接两拍 —— 没有键盘高度
                   * 真源，底座高度在面板开时恒为面板高、关时恒为 0，没有中间态可塌。
                   *
                   * 用户点输入框 = 明确要键盘（#560）：收尾尾巴窗口、意图闩、哨兵账本立刻作废。
                   *
                   * 否则「刚收完键盘 400ms 内又点开一把更矮的键盘」（切输入法、候选栏收起）
                   * 会被当成动画残值吞掉，输入栏停在上一次那把键盘的高度、被更矮的新键盘盖住。
                   *
                   * `inputFocusedRef` 是活性哨兵唯一可信的**意图**信号：还在输入框里就说明键盘
                   * 大概率真开着，到点绝不猜 0（见 `armKeyboardSentinel`）。
                   */
                  if (typeof Taro.onKeyboardHeightChange !== 'function') {
                    keepTailAnchored()
                    setPanelOpen(false)
                  }
                  inputFocusedRef.current = true
                  keyboardClosedAtRef.current = 0
                  keyboardClosingRef.current = false
                  keyboardClosingFromRef.current = 0
                  keyboardAboveFromRef.current = 0
                  keyboardSentinelMaxRef.current = 0
                  keyboardPendingRef.current = 0
                }}
                onBlur={() => {
                  // 失焦 = 用户离开输入框 → 键盘该走了，哨兵到点可以放心归零（#560 B1）
                  inputFocusedRef.current = false
                }}
                onInput={(event) => setInputValue(event.detail.value)}
              />
            </View>

            <View className={`conv__plus${panelOpen ? ' is-open' : ''}`} onClick={togglePanel}>
              <Image className="conv__plus-ic" src={ICONS.plusBrand} mode="aspectFit" />
            </View>

            {/* 历史没读出来时也置灰：那时乐观气泡渲染不出来，发了也看不到反馈 */}
            <View
              className={`conv__send${inputValue.trim() && canSend ? '' : ' is-off'}`}
              onClick={send}
            >
              <Text className="conv__send-tx">发送</Text>
            </View>
          </View>
        </View>

        {/*
        「+」面板（稿子 3 格）：图片 / 拍照 / 商品。**不在输入栏的文档流里**（#597）——
        它绝对定位在底部底座上、贴住屏幕底边，高度由内容自己撑开（`height: auto`），
        底座按 `panelHeight`（内容高 + 安全区）给它让位，正好填满输入栏那条下内边距。
        所以「面板出现」是一次到位的高度变化，不是键盘收起那样连跳几档。

        高度**与键盘无关**（#597 追加任务）：面板内容只有三格，按上次键盘高撑开会留一片
        空白。因此键盘 ↔ 面板切换时底座会一次变高/变矮（差一个「键盘高 − 面板高」）——
        预期行为，换来的是一点空白都没有的面板。改前它是输入栏里的流内块：键盘先收一截、
        面板再长一截，消息流连着变矮两次，原生层把越界的偏移截断后没有任何指令把它推回
        底部 —— 端上就是「整页移一下 + 掉到最底」（#597 现象一、现象三）。
      */}
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
