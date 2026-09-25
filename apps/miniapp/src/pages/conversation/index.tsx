import type { ConversationDto, MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
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
  sendMessage,
} from '@/features/chat/api'
import { MEDIA_IMAGE_PICK_LIMIT, voiceDurationLabel } from '@/features/chat/media'
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
  type VoiceRecording,
  voiceError,
} from '@/features/chat/media-api'
import { subscribeRealtime, subscribeReconnect } from '@/features/chat/realtime'
import { recoverGapsOnReconnect } from '@/features/chat/realtime-recovery'
import { loadConversation, loadMessagePage } from '@/features/fetchers'
import { formatAmount } from '@/lib/money'
import { readNavMetrics } from '@/lib/nav-metrics'
import { clockTime, dayLabelOf } from '@/lib/time'
import { newClientRequestId } from '@/lib/uuid'
import {
  beginSend,
  type ChatEntry,
  canRetry,
  canRetryMedia,
  clearDeferredReload,
  type DeferredReload,
  deferReload,
  initialDeferredReload,
  isLatestPageLoad,
  listingStatusText,
  mergePushedMedia,
  mergePushedMessage,
  mergeRefreshedMedia,
  mergeRefreshedMessages,
  mergeTimeline,
  type PendingMedia,
  type PendingMediaDraft,
  type PendingMessage,
  parseTxEvent,
  resetDeferredReload,
  resolveConvState,
  settleSend,
  shouldFlushDeferredReload,
  shouldReloadOnShow,
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
 *    发送 `POST /conversations/:id/messages`、已读 `POST /conversations/:id/read`
 *    （**只在详情与首屏历史都成功之后才发**，见 `load` 内的说明）；
 * 2. 历史按契约的 `before` 游标「加载更早的消息」，不再假设一次能拿全；
 * 3. 发送是**真实落库**：本地乐观气泡在成功后被服务端返回的那条替换（按 id 去重，
 *    实时推送送来的同一条不会重复），失败留在原地给重试 —— 不再有「假装成功」的态；
 * 4. 删除契约里不存在的展示件：认证徽章（`conversationUserSchema` 无 `authStatus`）、
 *    每条消息的「已读」标记（实时契约没有已读回执，见 #149）、`tx.completed` 评价卡
 *    （交易域没有这个事件）、以及媒体消息与上传/播放的本地模拟（#67 的范围）。
 *
 * 页头商品卡的状态、SYSTEM 事件的中文化、时间文案都走 `./view` 的纯函数（有用例）。
 *
 * **账号作用域（#170）**：`conversation` / `messages` / `pending` / `inputValue` 等
 * 都是「当前登录用户」视角下的状态。换账号时在**渲染期同步**清场并自增 epoch，
 * 让上一个账号的在途响应全部判过期（否则 A 的「发消息」可能在 B 的会话里落地）；
 * 从子页（商品详情 / 交易码页）返回时由 `useDidShow` 重拉详情 + 历史，覆盖那边
 * 可能发生的写操作。详见 `prevUserId` 与 `useDidShow` 处的注释。
 */

/** 「+」面板（1版稿 3 格）：图片 / 拍照走真实媒体链路；商品卡片仍是后续 Issue */
const PANEL_TILES = [
  { key: 'image', label: '图片', icon: ICONS.image },
  { key: 'camera', label: '拍照', icon: ICONS.camera },
  { key: 'product', label: '商品', icon: ICONS.cart },
] as const

/**
 * 语音气泡的波形竖条：1版稿的固定高度序列（不解析真实音频包络）。
 * 播放进度只靠「点亮到第几根」（`.conv__wave-bar.is-on`）表达。
 */
const WAVE_BARS = [14, 24, 36, 20, 40, 28, 16, 32, 22, 12, 26, 18].map((height, index) => ({
  id: `wave-${index}`,
  height,
}))

/**
 * 空 id 集合常量：`mergeRefreshedMessages` 的 `baseIds` 传它表示「不做额外保留」，
 * 只按 id 求并集再定序（重连补齐用）。
 */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/**
 * 一次重连内最多补几轮断档（#67 N5）。
 *
 * 一轮最多翻 `backfillMessageGap` 的 `maxPages` 页；多轮是为了「一轮没接上」时继续往下
 * 翻。轮数是硬上限，避免服务端游标异常时把补齐变成无限翻页 —— 没翻完的位置留在
 * `gapResumeCursorsRef` 里，下一次重连接着来。
 */
const GAP_MAX_PASSES = 3

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
  /** 服务端媒体（图片 / 语音）历史：与 `messages` 是两条流，渲染时按 `(createdAt,id)` 合并 */
  const [media, setMedia] = useState<MediaMessageDto[]>([])
  /** 更早一页媒体的游标；null = 已到最早 */
  const [mediaCursor, setMediaCursor] = useState<string | null>(null)
  /** 本地乐观媒体（上传中 / 上传失败），与 `pending` 一样永远排在服务端消息之后 */
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([])
  /**
   * 服务端媒体 → 本地临时路径（渲染用投影）。
   *
   * 路径本体只有一份：`media-api` 的模块级 LRU 缓存，`downloadChatMedia` 与
   * `cachedMediaPath` 共用它。这里存的是 React 侧的那份映射，落定时用 `rememberPath`
   * 增量写一条 —— 不把模块级 Map 当状态，也不会因为整批下载完而重算全表。
   */
  const [localPaths, setLocalPaths] = useState<ReadonlyMap<string, string>>(() => new Map())
  /** 记下一条「媒体 id → 本地文件」：同时写模块级缓存（再进这个会话不用重新下载） */
  const rememberPath = useCallback((id: string, path: string) => {
    cacheMediaPath(id, path)
    setLocalPaths((prev) => new Map(prev).set(id, path))
  }, [])
  /** 正在播放的语音（服务端 mediaId 或本地临时 id） */
  const [playingId, setPlayingId] = useState<string | null>(null)
  /** 正在录音（按住说话期间为 true） */
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
  /** 媒体流 id 快照来源（与 `messagesRef` 同理：silent 合并要用发起时的 id 集） */
  const mediaRef = useRef<MediaMessageDto[]>([])
  /** 在途发送的媒体：didShow 的「有在途发送」判定要把它们一起算上 */
  const pendingMediaRef = useRef<PendingMedia[]>([])
  /** 当前这次录音（按住说话）；null = 没在录 */
  const recordingRef = useRef<VoiceRecording | null>(null)
  /** 正在播放的 innerAudioContext（同一时刻只允许一个） */
  const audioRef = useRef<ReturnType<typeof Taro.createInnerAudioContext> | null>(null)
  /** 正在下载的 mediaId：避免同一条媒体被并发下载两次 */
  const downloadingRef = useRef<Set<string>>(new Set())

  /**
   * 还没补上的位置（#67 N5 / 复查 #221），新 → 旧。
   *
   * `backfillGapUntilConnected` 一轮最多翻 `maxPages` 页，中途取页失败或预算耗尽时会交出
   * `resumeCursor`。留在这里而不是丢掉：下一次连接建立时从这一段继续往回翻，否则断线期间
   * 超过预算的消息会在中间留下一段永远补不上的空洞。
   *
   * 用数组而不是单个游标：往回翻一碰到本地已有的消息就停，一个补不上的位置会挡住它下面
   * 更早的每一页；本次重连的新缺口与历史欠账各占一段，必须分别记（见
   * `recoverGapsOnReconnect`）。空数组 = 没有欠账。换账号时清空，见下面的身份清场。
   */
  const gapResumeCursorsRef = useRef<readonly string[]>([])

  /**
   * 媒体流自己的断档续拉位置（#67 N5）：媒体与消息是两条独立分页流，游标互不相干。
   * 共用一个 ref 会让先接上的那条把另一条的欠账清掉。
   */
  const mediaGapResumeRef = useRef<string | null>(null)

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
    // 上一个账号留下的断档续拉位置对新账号没有意义（游标属于那场会话的历史）
    gapResumeCursorsRef.current = []
    mediaGapResumeRef.current = null
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
    setMedia([])
    setMediaCursor(null)
    setPendingMedia([])
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
    clearMediaCache()
    setLocalPaths(new Map())
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
             */
            setMessages((prev) =>
              baseIds === null ? page.items : mergeRefreshedMessages(prev, page.items, baseIds),
            )
            setNextCursor(page.nextCursor)
            setMsgState(page.failed ? 'failed' : 'ok')
          }

          /**
           * 媒体历史是**独立一条流**（契约 `GET /conversations/:id/media`，游标参数叫
           * `cursor` 而不是 `before`）。它失败不连坐消息区：文字照常显示，媒体半边留空
           * 等下一次 load 重试，绝不把 `msgState` 打回 failed —— 那会把已经读到的整屏
           * 文字换成错误卡。`baseIds` 的处理与消息一致（silent 走并集，不替换）。
           */
          if (!(silent && mediaPage.failed)) {
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
     * 切后台就放弃这次录音：`RecorderManager` 在后台可能被系统掐掉，`onStop` 不一定
     * 回来；留着 `recordingRef` 会让回到前台后按不下去（判定里它非空）。
     */
    recordingRef.current?.abort()
    recordingRef.current = null
    setRecording(false)
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
    }
  }, [])

  /**
   * 把服务端媒体的字节拉到本地临时文件（验收⑤：不能拼公开对象存储地址，
   * `<Image>` / `innerAudioContext` 也带不了 Cookie，只能走带 header 的 `downloadFile`）。
   *
   * 依赖只有 `media`：下载结果进的是 `localPaths` 与 `media-api` 的模块级缓存，
   * 而 `rememberPath` 是稳定引用，所以这里不会被「自己写 state」反复触发。
   * `downloadingRef` 兜住同一批里重复的 id（推送与 HTTP 可能同时把一条媒体放进 `media`）。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null || !conversationId) return
    for (const item of media) {
      if (cachedMediaPath(item.id) || downloadingRef.current.has(item.id)) continue
      downloadingRef.current.add(item.id)
      void downloadChatMedia(conversationId, item.id)
        .then((path) => {
          if (userIdRef.current !== userId) return
          rememberPath(item.id, path)
        })
        .catch((error) => {
          console.warn('[miniapp] 媒体下载失败', error)
        })
        .finally(() => {
          downloadingRef.current.delete(item.id)
        })
    }
  }, [authStatus, userId, conversationId, media, rememberPath])

  /**
   * 实时推送（#67 第三步）：只认本会话的 `message.new` / `media.new`，按服务端 id 去重后
   * 并入对应的流。
   *
   * 媒体在服务端走**独立事件**（`mediaRealtimeEventSchema`，刻意不并进
   * `realtimeServerEventSchema`），所以这里必须分别处理：媒体事件只更新 `media`，
   * 不往 `messages` 里塞一条类型不属于它的行。
   *
   * 推送与 HTTP 补拉是两条独立来源，同一条可能先由发送响应落到本地、再被推一次
   * （契约明写「推送不保证不重不漏」），所以去重判据只能是服务端 id。
   *
   * `userIdRef` 那道判断不是多余的：换账号时本页在**渲染期**就把两条流都清空了，而
   * effect 的退订要等 commit 之后才跑 —— 这一小段窗口里旧账号的推送仍会打到旧监听器上，
   * 只按 `conversationId` 过滤会让 A 的消息落进已经属于 B 的空列表。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null || !conversationId) return
    return subscribeRealtime((event) => {
      if (event.type !== 'message.new' && event.type !== 'media.new') return
      if (event.conversationId !== conversationId) return
      if (userIdRef.current !== userId) return
      if (event.type === 'message.new') {
        setMessages((prev) => mergePushedMessage(prev, event.message))
        return
      }
      setMedia((prev) => mergePushedMedia(prev, event.media))
    })
  }, [authStatus, userId, conversationId])

  /**
   * 补齐断档（#67 第三步 / N5 / 复查 #221）：`最新消息 → 本地前沿` 与历史欠账各补一遍。
   *
   * 历史欠账的游标**不能**当成本轮的起点 —— 那样只会补上旧缺口，本次断线新增的消息一条
   * 都不取（详见 `recoverGapsOnReconnect` 的说明）。所以这里交给它去分两笔账：先从最新
   * 一页往回翻接上本地前沿，再逐个欠账位置接着翻。
   *
   * 落地前过代次与身份守卫：期间可能发生整页重拉或换账号。
   * 补齐结果走 `mergeRefreshedMessages`（`baseIds` 传空集 = 只做按 id 并集 + 定序）：
   * 本地可能有补齐窗口之外的内容（刚确认落地的发送、更早分页拉下来的历史），
   * 直接替换会把它们抹掉。
   */
  const recoverMessageGap = useCallback(
    async (current: number, ownerId: string, known: ReadonlySet<string>) => {
      const result = await recoverGapsOnReconnect(
        (before) => loadMessagePage(conversationId, before),
        known,
        { maxPasses: GAP_MAX_PASSES, resumeCursors: gapResumeCursorsRef.current },
      )
      if (current !== epoch.current || userIdRef.current !== ownerId) return
      // 两笔账一次结清：还欠着的位置留着，下一次重连接着翻
      gapResumeCursorsRef.current = result.resumeCursors
      if (result.items.length === 0) return
      setMessages((prev) => mergeRefreshedMessages(prev, result.items, EMPTY_IDS))
    },
    [conversationId],
  )

  /**
   * 补齐媒体流断档：媒体与消息是两条独立的分页流，用同一套算法（`backfillMessageGap`
   * 已泛型化），但**续拉位置必须分开记** —— 两条流的游标互不相干，共用一个 ref 会让
   * 先接上的那条把另一条的欠账清掉。
   */
  const recoverMediaGap = useCallback(
    async (current: number, ownerId: string, known: ReadonlySet<string>) => {
      const result = await backfillGapUntilConnected(
        (before) => loadMediaPage(conversationId, before),
        known,
        { maxPasses: GAP_MAX_PASSES, startBefore: mediaGapResumeRef.current ?? undefined },
      )
      if (current !== epoch.current || userIdRef.current !== ownerId) return
      mediaGapResumeRef.current = result.complete ? null : result.resumeCursor
      if (result.items.length === 0) return
      setMedia((prev) => mergeRefreshedMedia(prev, result.items, EMPTY_IDS))
    },
    [conversationId],
  )

  /**
   * 重连补齐断档（#67 第三步 / N5）：每次连接建立（含重连）都补一次，直到接上本地已有的
   * 消息为止 —— 断线期间错过的消息可能超过一页，只重取最新一页会留下一段永远补不上的
   * 空洞（见 `backfillGapUntilConnected`）。媒体是另一条独立分页流，并列补一遍。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null || !conversationId) return
    return subscribeReconnect(() => {
      if (userIdRef.current !== userId) return
      const current = epoch.current
      const known = new Set(messagesRef.current.map((item) => item.id))
      void recoverMessageGap(current, userId, known).catch((error) => {
        console.warn('[miniapp] 重连补齐消息失败', error)
      })

      const knownMedia = new Set(mediaRef.current.map((item) => item.id))
      void recoverMediaGap(current, userId, knownMedia).catch((error) => {
        console.warn('[miniapp] 重连补齐媒体失败', error)
      })
    })
  }, [authStatus, userId, conversationId, recoverMessageGap, recoverMediaGap])

  /** 「加载更早的消息」：契约的 `before` 游标原样回传，拼接在已有消息之前 */
  const loadEarlier = () => {
    if (!nextCursor || loadingEarlier) return
    setLoadingEarlier(true)
    setEarlierFailed(false)
    const current = epoch.current
    void loadMessagePage(conversationId, nextCursor)
      .then((page) => {
        if (!isLatestPageLoad(current, epoch.current)) return
        if (page.failed) {
          setEarlierFailed(true)
          return
        }
        setMessages((prev) => sortMessages([...page.items, ...prev]))
        setNextCursor(page.nextCursor)
      })
      .finally(() => {
        /**
         * 还锁也要过同一个守卫（#186 P2-2）：这一批已经属于上一代时锁已被 `load`
         * 收回、甚至已被新账号的分页重新拿起，无条件 `setLoadingEarlier(false)`
         * 会把新账号在途的那次分页放掉，同一个游标被并发消费两次。
         */
        if (!isLatestPageLoad(current, epoch.current)) return
        setLoadingEarlier(false)
      })

    /**
     * 媒体历史跟着一起往前翻（它有自己的游标）。失败只记日志：媒体翻页失败不该让
     * 消息区显示「更早的消息没加载出来」。
     */
    if (!mediaCursor) return
    void loadMediaPage(conversationId, mediaCursor)
      .then((page) => {
        if (!isLatestPageLoad(current, epoch.current)) return
        if (page.failed) return
        setMedia((prev) => mergeRefreshedMedia(prev, page.items, EMPTY_IDS))
        setMediaCursor(page.nextCursor)
      })
      .catch((error) => {
        console.warn('[miniapp] 加载更早的媒体失败', error)
      })
  }

  /**
   * 发一条文本消息。`existing` 存在时是「重试同一颗失败气泡」，不新增气泡。
   *
   * **幂等键（#67 第一步）**：每次「新发送」生成一个 `clientRequestId`，重试沿用同一个。
   * 服务端以 (sender, conversation, clientRequestId) 建唯一约束，重复请求返回**已经创建
   * 的那条消息**而不是再写一条 —— 客户端丢掉发送响应后重试因此不会产生第二条消息。
   *
   * 响应落地前要过 epoch 守卫：A 在飞的发送可能在换到 B 之后才 resolve，
   * 若不判过期，A 的消息会写进 B 的 `messages`（`pending` 已随身份清空，
   * 但 `setMessages` 会把 A 的气泡追加到 B 的会话流）。
   *
   * `finally` 里补「发送中返回」被延后的那次刷新（`DeferredReload` 状态机，见 `./view`）：
   * 落定先过 `settleSend`（陈旧 epoch 的落定原样返回，不会污染当前 epoch 的计数），
   * 再由 `shouldFlushDeferredReload` 判「是否该补且真的能发」。补的那一次走
   * `load({ silent: true })`：后台刷新不闪骨架，失败也不盖掉失败气泡与它的重试。
   */
  const doSend = (text: string, existing?: PendingMessage) => {
    // 新气泡才需要新序号；重试沿用原来的临时 id（赋值不能塞进表达式，见 noAssignInExpressions）
    let id = existing?.id
    if (!id) {
      localSeq.current += 1
      id = `local-${localSeq.current}`
    }
    // 重试必须沿用**同一个**幂等键，否则服务端会当成一次新发送再写一条
    const clientRequestId = existing?.clientRequestId ?? newClientRequestId()
    const current = epoch.current
    deferredRef.current = beginSend(deferredRef.current, current)
    setPending((prev) =>
      existing
        ? prev.map((item) => (item.id === id ? { ...item, status: 'sending' } : item))
        : [...prev, { id, content: text, clientRequestId, status: 'sending' }],
    )
    void sendMessage(conversationId, text, clientRequestId)
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
        setPending((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status: 'failed' } : item)),
        )
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
    doSend(text)
  }

  const retry = (item: PendingMessage) => {
    if (!canRetry(item)) return
    doSend(item.content, item)
  }

  /**
   * 媒体发送：直传 → create 两段。
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
    deferredRef.current = beginSend(deferredRef.current, current)
    void (async () => {
      let uploaded = draft.uploaded
      if (!uploaded) {
        uploaded =
          draft.kind === 'IMAGE'
            ? await uploadChatImage(conversationId, {
                path: draft.path,
                mime: draft.image.mime,
                width: draft.image.width,
                height: draft.image.height,
                sizeBytes: draft.image.sizeBytes,
              })
            : await uploadChatVoice(conversationId, {
                path: draft.path,
                durationMs: draft.durationMs,
              })
        if (current === epoch.current) {
          setPendingMedia((prev) =>
            prev.map((item) => (item.id === draft.id ? { ...item, uploaded } : item)),
          )
        }
      }
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
        if (current !== epoch.current) return
        // 自己刚发出去的这张图 / 这段音就在本地，直接记下来：不重新下载，也不闪一下空白
        rememberPath(created.id, draft.path)
        setPendingMedia((prev) => prev.filter((item) => item.id !== draft.id))
        setMedia((prev) => mergePushedMedia(prev, created))
      })
      .catch((error) => {
        if (current !== epoch.current) return
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

  /** 「图片 / 拍照」：选图 → 逐张发送（多选时每张各自一条消息，互不阻塞） */
  const pickAndSendImages = async () => {
    if (!canSend) {
      void Taro.showToast({ title: '消息还没加载完，稍后再试', icon: 'none' })
      return
    }
    let picked: Awaited<ReturnType<typeof pickChatImages>>
    try {
      picked = await pickChatImages(MEDIA_IMAGE_PICK_LIMIT)
    } catch (error) {
      void Taro.showToast({
        title: error instanceof Error ? error.message : '无法选择图片',
        icon: 'none',
      })
      return
    }
    if (picked.rejected) {
      void Taro.showToast({ title: picked.rejected, icon: 'none' })
    }
    for (const image of picked.images) {
      sendMedia({
        kind: 'IMAGE',
        clientRequestId: newClientRequestId(),
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

  /** 按住说话：开始录音。失败（无权限 / 设备忙）只提示，不留下半截状态 */
  const startVoice = () => {
    if (!canSend || recordingRef.current) return
    try {
      recordingRef.current = startVoiceRecording()
      setRecording(true)
    } catch (error) {
      recordingRef.current = null
      void Taro.showToast({ title: voiceError(error).message, icon: 'none' })
    }
  }

  /** 松手：结束录音并发送（`cancelled` = 手指移开/取消，放弃这一段） */
  const finishVoice = (cancelled: boolean) => {
    const session = recordingRef.current
    if (!session) return
    recordingRef.current = null
    setRecording(false)
    if (cancelled) {
      session.abort()
      return
    }
    const current = epoch.current
    void session
      .stop()
      .then((recorded) => {
        // 录音期间可能已经换号 / 换会话：那段音频不该带着新身份的 Cookie 发出去
        if (current !== epoch.current) return
        sendMedia({
          kind: 'VOICE',
          clientRequestId: newClientRequestId(),
          path: recorded.path,
          durationMs: recorded.durationMs,
        })
      })
      .catch((error) => {
        void Taro.showToast({ title: voiceError(error).message, icon: 'none' })
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
   */
  const openVoice = (item: MediaMessageDto) => {
    if (playingId === item.id) {
      stopAudio()
      return
    }
    const local = cachedMediaPath(item.id)
    if (local) {
      playVoice(item.id, local)
      return
    }
    void downloadChatMedia(conversationId, item.id)
      .then((path) => {
        rememberPath(item.id, path)
        playVoice(item.id, path)
      })
      .catch((error) => {
        console.warn('[miniapp] 语音下载失败', error)
        void Taro.showToast({ title: '语音加载失败，请重试', icon: 'none' })
      })
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

  /**
   * 「+」面板的三格：图片 / 拍照都走真实的媒体链路（相册 / 相机由 `Taro.chooseMedia` 决定，
   * 两者只是 `sourceType` 的差别，对发送流程没有区别）；商品卡片是另一件事，文案不能混为一谈。
   */
  const panelAction = (key: (typeof PANEL_TILES)[number]['key']) => {
    setPanelOpen(false)
    if (key === 'product') {
      void Taro.showToast({ title: '商品卡片待接入', icon: 'none' })
      return
    }
    void pickAndSendImages()
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
  /** 日期分隔条看**已加载的第一条**（分页后它会跟着变早），没有消息时退回会话的最后活跃时间 */
  const firstEntry = entries.length > 0 ? entries[0] : undefined
  const firstCreatedAt =
    firstEntry?.kind === 'media'
      ? firstEntry.media.createdAt
      : firstEntry?.kind === 'message'
        ? firstEntry.message.createdAt
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
                  const playing = playingId === entry.keyId
                  // 图片必须用本地临时文件渲染：契约里的 url 是 Web 形态（带 /api 前缀），
                  // 小程序没有同源代理、<Image> 也带不了 Cookie（见 media-api.ts）
                  const local = item.kind === 'IMAGE' ? localPaths.get(item.id) : undefined
                  return (
                    <View
                      key={entry.keyId}
                      id={`e-${entry.keyId}`}
                      className={`conv__row${mine ? ' is-mine' : ''}`}
                    >
                      {renderAvatar(mine)}
                      <View className="conv__col">
                        {item.kind === 'VOICE' ? (
                          <View
                            className={`conv__bubble conv__bubble--voice${mine ? ' is-mine' : ''}`}
                            onClick={() => openVoice(item)}
                          >
                            <View
                              className={`conv__play${mine ? ' is-mine' : ''}${playing ? ' is-pause' : ''}`}
                            >
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
                              {voiceDurationLabel(item.durationMs)}
                            </Text>
                          </View>
                        ) : (
                          <View className="conv__bubble conv__bubble--media">
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
                  const playing = playingId === entry.keyId
                  return (
                    <View key={entry.keyId} id={`e-${entry.keyId}`} className="conv__row is-mine">
                      {renderAvatar(true)}
                      <View className="conv__col">
                        {item.kind === 'VOICE' ? (
                          // 本地录音文件直接播，不下载：自己刚录的这段就在本地
                          <View
                            className="conv__bubble conv__bubble--voice is-mine"
                            onClick={() => playVoice(entry.keyId, item.path)}
                          >
                            <View className={`conv__play is-mine${playing ? ' is-pause' : ''}`}>
                              <View className="conv__play-glyph" />
                            </View>
                            <View className="conv__wave">
                              {WAVE_BARS.map((bar) => (
                                <View
                                  key={bar.id}
                                  className={`conv__wave-bar is-mine${playing ? ' is-on' : ''}`}
                                  style={{ height: `${bar.height}rpx` }}
                                />
                              ))}
                            </View>
                            <Text className="conv__dur num is-mine">
                              {voiceDurationLabel(item.durationMs)}
                            </Text>
                          </View>
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
                          <View className="conv__retry" onClick={() => runMediaSend(item)}>
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

          {/*
            按住说话：`onTouchStart` 起录、`onTouchEnd` 松开就发、`onTouchCancel` 手指滑出即放弃。
            微信的 `RecorderManager` 只有「停」没有「撤销」，取消只能靠不把这段音频交给上传。
          */}
          {voiceMode ? (
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
