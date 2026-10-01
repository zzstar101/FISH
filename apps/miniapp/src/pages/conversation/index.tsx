import {
  type ConversationDto,
  MESSAGE_RECALL_WINDOW_MS,
  type MediaMessageDto,
  type MessageDto,
} from '@fish/contracts/chat/schema'
import { Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import {
  createImageMessage,
  createVoiceMessage,
  markConversationRead,
  recallMessage,
  sendMessage,
} from '@/features/chat/api'
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
  startVoiceRecording,
  uploadChatImage,
  uploadChatVoice,
  VoicePermissionError,
  type VoiceRecording,
  voiceError,
} from '@/features/chat/media-api'
import { loadConversation, loadMessagePage } from '@/features/fetchers'
import { presenceView } from '@/features/presence/view'
import { formatAmount } from '@/lib/money'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { sessionCookieHeader } from '@/lib/session'
import { clockTime, dayLabelOf } from '@/lib/time'
import { randomUuidV4 } from '@/lib/uuid'
import {
  applyPresencePoll,
  applyReadPoll,
  applyRecalled,
  beginSend,
  type ChatEntry,
  canRetry,
  canRetryMedia,
  clearDeferredReload,
  type DeferredReload,
  deferReload,
  hasEarlierPage,
  initialDeferredReload,
  isCurrentPlayRequest,
  isLatestPageLoad,
  isLatestPresencePoll,
  isStaleMediaIdentity,
  isStaleMediaTask,
  keepRecalledTombstones,
  listingStatusText,
  localReplyExcerpt,
  MESSAGE_ACTION_LABEL,
  type MediaTaskBinding,
  type MediaTaskIdentity,
  type MessageAction,
  mergePushedMedia,
  mergeRefreshedMedia,
  mergeRefreshedMessages,
  mergeTimeline,
  messageActions,
  messageReadLabel,
  type PendingMedia,
  type PendingMediaDraft,
  type PendingMessage,
  parseTxEvent,
  planMediaLoad,
  REPLY_DROPPED_TIP,
  recallFailureText,
  resetDeferredReload,
  resolveConvState,
  settleSend,
  shouldDropReplyOnSendFailure,
  shouldFlushDeferredReload,
  shouldReloadOnShow,
  sortMessages,
  startMediaRetry,
  systemPillText,
} from './view'
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
 *    `messageReadLabel`，只标我发出的气泡。读位由进页 / 从子页返回 / 点重试，以及本页的
 *    **详情轮询**（`DETAIL_POLL_MS`，只补读位与在线态、不 bump epoch、不重发已读）刷新；
 *    `conversation.read` 的实时接收仍要等小程序实时客户端合入（#213→#220 链）。
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
  { key: 'image', label: '图片', icon: ICONS.image },
  { key: 'camera', label: '拍照', icon: ICONS.camera },
  { key: 'product', label: '商品', icon: ICONS.cart },
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
   * 正在引用的消息（#359 3c）：非 null 时输入栏上方显示引用栏，发出的消息带摘引。
   * 存整条 DTO 而不是只存 id：引用栏要显示摘引文案，而服务端的 `replyTo` 投射只挂在
   * 「已发出的那条消息」上，被引用的原消息本身没有这个字段。
   */
  const [replyTarget, setReplyTarget] = useState<MessageDto | null>(null)
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
  /** 语音播放器（切歌 / 离页 / 换账号都要先停掉） */
  const audioRef = useRef<ReturnType<typeof Taro.createInnerAudioContext> | null>(null)
  /** 正在下载的媒体 id：兜住「推送与 HTTP 同时把一条媒体放进流」造成的重复下载 */
  const downloadingRef = useRef<Set<string>>(new Set())
  /** 语音播放请求令牌：每次点击 +1，迟到的下载回来据此判「已经不是当前这次」 */
  const playSeqRef = useRef(0)
  /**
   * 正在重试的媒体 id（#364 审查）：`canRetryMedia` 读的是**渲染态**，同一帧连点两次
   * 两次看到的都还是 `failed`，于是起两条链。必须有一把同步锁，在 `runMediaSend` 的
   * 落定处释放。
   */
  const retryingMediaRef = useRef<Set<string>>(new Set())

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
    localSeq.current = 0
    // 待刷新标记与在途计数一起归到新 epoch：否则上个账号留下的陈旧标记会被
    // 新账号后续某次发送落定消费掉，闪一次无来由的整页加载。
    deferredRef.current = resetDeferredReload(epoch.current)
    setConversation(null)
    setConvState('loading')
    setMessages([])
    setMsgState('loading')
    setNextCursor(null)
    setLoadingEarlier(false)
    setEarlierFailed(false)
    setInputValue('')
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
       * silent 刷新要先记下**发起时**的消息 id 快照：落地时用它把本次刷新期间才确认
       * 落地的消息挑出来补回（见 `mergeRefreshedMessages`）。非 silent 是整页重拉，
       * 以服务端快照为准即可。
       */
      const baseIds = silent ? new Set(messagesRef.current.map((item) => item.id)) : null
      /** 媒体半边同理（见下）：silent 合并要按**发起时**的媒体 id 集做并集 */
      const mediaBaseIds = silent ? new Set(mediaRef.current.map((item) => item.id)) : null
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
          if (detail.status === 'ok') setConversation(detail.conversation)
          /**
           * 后台刷新（silent）**只做确认、不做降级**（判据见 `./view` 的 `resolveConvState`）。
           *
           * `prev` 走 `setState` 的函数式更新：`load` 的 `useCallback` 依赖只有
           * `[conversationId]`，直接读闭包里的 `convState` 会永远拿到首帧的 `loading`。
           */
          setConvState((prev) => resolveConvState(prev, detail.status, silent))
          if (!(silent && page.failed)) {
            /**
             * silent 刷新**合并**而不是替换（#186 P2-1）：它带回来的快照可能早于
             * 本次刷新期间才发送成功的那条消息，无条件 `setMessages(page.items)`
             * 会把那条刚确认的消息抹掉。非 silent 是整页重拉，直接替换。
             *
             * 两条路径都要过 `keepRecalledTombstones`（#359 3c 审查回合）：撤回在途
             * 15s 内任何一次 `load()` 都可能带着「撤回前」的快照回来，把刚落地的
             * 撤回碑写回正文。判据与理由见 `./view`。
             */
            setMessages((prev) =>
              keepRecalledTombstones(
                prev,
                baseIds === null ? page.items : mergeRefreshedMessages(prev, page.items, baseIds),
              ),
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
           * 的是「消息凭空少了」且无从重试（#359 3b 审查）。成功时 silent 仍走并集合并，
           * 不一刀切替换。
           */
          if (!mediaPage.failed) {
            setMedia((prev) =>
              mediaBaseIds === null
                ? mediaPage.items
                : mergeRefreshedMedia(prev, mediaPage.items, mediaBaseIds),
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
           */
          if (current === epoch.current && detail.status === 'ok' && !page.failed) {
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
    [conversationId],
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
  authedRef.current = authStatus === 'authed'
  userIdRef.current = userId
  loadRef.current = load
  pendingRef.current = pending
  messagesRef.current = messages
  mediaRef.current = media
  pendingMediaRef.current = pendingMedia
  useDidShow(() => {
    visibleRef.current = true
    // 回到本页：把在线态的轮询表续上（隐藏时真的停掉了，见 useDidHide）
    detailPollRef.current?.start()
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
    // 页面被盖住：在线态已经不显示了，把轮询停掉（不再让定时器在后台空转每一跳）
    detailPollRef.current?.stop()
    /**
     * 切后台就放弃这次录音：`RecorderManager` 在后台可能被系统掐掉，`onStop` 不一定
     * 回来；留着 `recordingRef` 会让回到前台后按不下去（判定里它非空）。
     */
    recordingRef.current?.abort()
    recordingRef.current = null
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
      audioRef.current?.destroy()
      audioRef.current = null
      // 在途的语音下载到此失效（与身份清场同理）：离页后回来不许出声
      playSeqRef.current += 1
    }
  }, [])

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
   * 为什么必须有：端上没有「实时」——小程序没有实时客户端（#213→#220 链未合入 main），
   * `conversation.read` 与 `presence.changed` 两条帧都没人接；而 `load()` 的触发点只有
   * 进页 / 从子页返回 / 点重试。用户盯着屏幕时读位与在线态永远不会更新，红「未读」一直
   * 红到离开再回来、绿点也一直挂着，看起来就是坏的。
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
   *
   * 有了实时客户端之后这里应当整块换成事件订阅；在那之前，它是「读位推进」与「断线后
   * 转为离线」在端上唯一能被看见的路径（服务端按 TTL 判定，最迟 `DETAIL_POLL_MS` 一跳内
   * 体现）。
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
  }, [authStatus, userId, convState, conversationId])

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
          })
        : await createVoiceMessage(conversationId, {
            objectKey: uploaded.objectKey,
            contentType: uploaded.contentType,
            sizeBytes: uploaded.sizeBytes,
            durationMs: uploaded.durationMs,
            clientRequestId: draft.clientRequestId,
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
        void Taro.showToast({
          title: error instanceof Error ? error.message : '发送失败，请重试',
          icon: 'none',
        })
        setPendingMedia((prev) =>
          prev.map((item) => (item.id === draft.id ? { ...item, status: 'failed' } : item)),
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
  const sendMedia = (draft: PendingMediaDraft) => {
    localSeq.current += 1
    const item: PendingMedia = {
      ...draft,
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
    for (const image of picked.images) {
      sendMedia({
        kind: 'IMAGE',
        clientRequestId: randomUuidV4(),
        path: image.path,
        image: {
          mime: image.mime,
          width: image.width,
          height: image.height,
          sizeBytes: image.sizeBytes,
        },
      })
    }
  }

  /**
   * 录音失败的统一出口（#364 审查）。两个入口共用：
   * - `startVoiceRecording` 的 `onError` —— 录音**还在进行中**（用户手指还按着）；
   * - `finishVoice` 的 `.catch` —— 松手之后才失败。
   *
   * 无论从哪来，`recording` 都必须先复位：不复位的话按钮还写着「松开 发送」，
   * 用户以为在录、其实什么都没录。
   *
   * 权限被拒要给「去设置」入口，用的是与扫码页（`pages/scan` / `pages/scan-pr`）同一范式：
   * `Taro.getSetting` 先确认这个 scope 真的是被用户拒的，再 `Taro.openSetting` 把人送进
   * 设置页。不是被拒（例如麦克风被别的应用占着）就别拉设置页，那会让用户白跑一趟。
   */
  const handleVoiceFailure = (error: unknown) => {
    recordingRef.current = null
    setRecording(false)
    const failure = voiceError(error)
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

  /** 按住说话：开始录音。失败（无权限 / 设备忙）立刻提示，不留下半截状态 */
  const startVoice = () => {
    if (!canSend || recordingRef.current) return
    try {
      // `onError` 不等松手：录音期间失败（权限被拒最常见）时按钮不该继续谎报「松开 发送」
      recordingRef.current = startVoiceRecording(handleVoiceFailure)
      setRecording(true)
    } catch (error) {
      recordingRef.current = null
      handleVoiceFailure(error)
    }
  }

  /** 松手：结束录音并发送（`cancelled` = 手指移开 / 取消，放弃这一段） */
  const finishVoice = (cancelled: boolean) => {
    const session = recordingRef.current
    if (!session) return
    recordingRef.current = null
    setRecording(false)
    if (cancelled) {
      session.abort()
      return
    }
    /**
     * 同 `pickAndSendImages`：记**身份**而不是代次（#364 审查）。录音同样要好几秒，
     * 期间一次 `load()` 推进的只是 epoch —— 那段录音还是当前账号录的，不该被丢掉。
     */
    const identity: MediaTaskIdentity = {
      cookie: sessionCookieHeader() ?? '',
      userId: userIdRef.current,
    }
    void session
      .stop()
      .then((recorded) => {
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
      })
      .catch((error) => {
        handleVoiceFailure(error)
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
   */
  const renderVoiceBubble = (
    keyId: string,
    durationMs: number | null | undefined,
    mine: boolean,
    onPress: () => void,
    failed = false,
  ) => {
    const playing = playingId === keyId
    return (
      <View
        className={`conv__bubble conv__bubble--voice${mine ? ' is-mine' : ''}`}
        onClick={onPress}
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
    session.abort()
  }

  /** 语音/键盘切换：进语音态时收起面板（两态不并存，与稿子一致） */
  const toggleVoiceMode = () => {
    if (!voiceMode) setPanelOpen(false)
    else abortRecording()
    setVoiceMode(!voiceMode)
  }

  /**
   * 长按气泡（#359 3c）：按 `messageActions` 给出可用动作，用微信原生 `showActionSheet`
   * 呈现（与「我的发布」重命名/下架同一入口，不另造自绘弹层）。
   *
   * 取消（点遮罩 / 取消）会让 `showActionSheet` reject —— 那不是错误，静默收场。
   */
  const onLongPressMessage = async (message: MessageDto) => {
    const actions = messageActions(message, userId, Date.now(), MESSAGE_RECALL_WINDOW_MS)
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
   * 也会推 `message.recalled`，但实时客户端还没接（在未合入的 #213→#220 链上），
   * 所以这里以 HTTP 204 为准落地，保证「点了就变」。
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
  const doRecall = async (message: MessageDto) => {
    if (recallingId) return
    setRecallingId(message.id)
    try {
      await recallMessage(conversationId, message.id)
      setMessages((prev) => applyRecalled(prev, message.id, new Date().toISOString()))
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
    if (!messages.some((item) => item.id === messageId)) {
      void Taro.showToast({ title: '引用的消息在更早的记录里', icon: 'none' })
      return
    }
    setJumpTo({ id: `e-${messageId}`, tail: tailId })
  }

  /** 「+」开合面板：开面板时退回键盘态 */
  const togglePanel = () => {
    if (!panelOpen) {
      abortRecording()
      setVoiceMode(false)
    }
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

  /**
   * 「+」面板的三格：商品卡进发送选择页（#359）；图片走相册、拍照走相机
   * （两者只是 `Taro.chooseMedia` 的 `sourceType` 差别，对发送流程没有区别）。
   */
  const panelAction = (key: (typeof PANEL_TILES)[number]['key']) => {
    setPanelOpen(false)
    if (key === 'product') {
      if (!conversationId) return
      void Taro.navigateTo({ url: `/pages/send-listing/index?id=${conversationId}` })
      return
    }
    void pickAndSendImages(key === 'camera' ? 'camera' : 'album')
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
   * 新消息落地就放弃「跳去看摘引」的目标，回到跟随最新。
   *
   * 不做成 `useEffect(() => setJumpTo(''), [tailId])`：那样要先渲染一帧旧目标再纠正，
   * 且 biome 的 `useExhaustiveDependencies` 会把 `tailId` 判成多余依赖（`setJumpTo` 是
   * 稳定引用）。这里把「跳转目标」与「设它时的 tailId」绑成一个值，渲染期直接比对 ——
   * tail 一变，目标自动失效，无需任何副作用。
   */
  const scrollTarget = jumpTo && jumpTo.tail === tailId ? jumpTo.id : tailId

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
          {card ? (
            <View
              className="conv__lcard"
              onClick={
                canOpen
                  ? () => void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${card.id}` })
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
            <View className="conv__bubble">
              <Text className="conv__bubble-tx">[商品]</Text>
            </View>
          )}
          <Text className="conv__time num">{clockTime(message.createdAt)}</Text>
        </View>
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

      {/* 消息流：打开即停在最新（底部）；点摘引时临时改跳到被引用那条 */}
      <ScrollView
        className="conv__scroll"
        scrollY
        scrollIntoView={scrollTarget}
        scrollWithAnimation
      >
        <View className="conv__list">
          {/* 更早一页：文本与媒体两条流各有游标，任一还有更早就给入口（#67 N3） */}
          {hasEarlierPage(nextCursor, mediaCursor) || earlierFailed ? (
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

                if (entry.kind === 'media') {
                  const item = entry.media
                  const mine = item.senderId === me?.id
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
                        {item.kind === 'VOICE' ? (
                          renderVoiceBubble(item.id, item.durationMs, mine, () => openVoice(item))
                        ) : (
                          <View
                            className="conv__bubble conv__bubble--media"
                            onClick={() => openImage(item)}
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
                          onLongPress={() => void onLongPressMessage(message)}
                        >
                          {/* 摘引（#359 3c）：点它定位到被引用的原消息 */}
                          {message.replyTo ? (
                            <View
                              className={`conv__quote${mine ? ' is-mine' : ''}`}
                              onClick={() => locateMessage(message.replyTo?.id ?? '')}
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
      </ScrollView>

      {/*
        输入栏（稿子 .composer）：语音/键盘切换 + 自动长高输入框 + 「+」+ 发送。
        空内容时「发送」置灰（稿子 .send.is-off）。
      */}
      <View className="conv__bar">
        {/* 引用栏（#359 3c）：显示被引用消息的摘引与取消；发送后自动收起 */}
        {replyTarget ? (
          <View className="conv__replybar">
            <View className="conv__replybar-main">
              <Text className="conv__replybar-tx">{localReplyExcerpt(replyTarget)}</Text>
            </View>
            <View className="conv__replybar-cancel" onClick={() => setReplyTarget(null)}>
              <Image className="conv__replybar-ic" src={ICONS.closeInk} mode="aspectFit" />
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
              src={voiceMode ? ICONS.keyboard : ICONS.mic}
              mode="aspectFit"
            />
          </View>

          {voiceMode ? (
            /*
              按住说话：`onTouchStart` 起录、`onTouchEnd` 松开就发、`onTouchCancel`
              手指滑出即放弃。微信的 `RecorderManager` 只有「停」没有「撤销」，
              取消只能靠不把这段音频交给上传。
            */
            <View
              className={`conv__hold${recording ? ' is-on' : ''}`}
              onTouchStart={startVoice}
              onTouchEnd={() => finishVoice(false)}
              onTouchCancel={() => finishVoice(true)}
            >
              <Text className="conv__hold-tx">{recording ? '松开 发送' : '按住 说话'}</Text>
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
