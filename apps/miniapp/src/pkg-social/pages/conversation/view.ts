import type { ConversationDto, MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import type { AllowedImageMime } from '@/features/upload/mime'

/**
 * 会话页的展示逻辑（#89：从 fixture 改为真实历史 / 发送 / 已读）。
 *
 * 与 `pages/chat/list-view.ts` 同一手法：把「界面上写什么」抽成纯函数，
 * 组件只负责渲染。这里锁的是三类曾经靠人眼复审的判定：
 * 交易 SYSTEM 事件的中文化、时间文案、以及发送失败态。
 */

/** 交易 SYSTEM 事件（`transactions/schema.ts` 的 `tx.*` 协议） */
export type TxEvent = { type: string }

/**
 * 解析交易 SYSTEM 事件的 JSON；非 JSON（普通文本系统消息）返回 null。
 * 与消息列表页的预览降级口径一致：解析不了就按原文渲染。
 */
export function parseTxEvent(content: string): TxEvent | null {
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

/**
 * 不属于专门卡片的 SYSTEM 消息的胶囊文案。
 *
 * `tx.accepted` 不走这里（它有自己的交易码卡）；`tx.proposal` / `tx.rejected`
 * 翻成中文，其余（含普通文本系统消息）按原文。
 */
export function systemPillText(content: string): string {
  const event = parseTxEvent(content)
  if (!event) return content
  if (event.type === 'tx.proposal') return '待对方同意'
  if (event.type === 'tx.rejected') return '卖家已拒绝这次交易'
  return content
}

/** 商品摘要条的状态文案（与「我的发布」同一口径） */
const LISTING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '在售',
  RESERVED: '已预订',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

export function listingStatusText(status: string | undefined): string {
  if (!status) return '商品已下架'
  return LISTING_STATUS_LABEL[status] ?? status
}

/**
 * 逐条「已读 / 未读」的读位判据（#359 四、已读状态）。
 *
 * 契约只给**对方那一侧**的读位（`ConversationDto.counterpartLastReadAt`）：
 * `message.createdAt <= counterpartLastReadAt` 即对方已读到该条。所以这个标签只对
 * **我发出的消息**有意义 —— 对方发来的消息标的是「我」的读位，契约里没有这个字段，
 * 而且我正在看它。Owner 拍板：只标我发出的气泡（而不是只标最后一条）。
 *
 * 「标不出来」一律算 `未读`：对方从未读过（null）、或时间戳解析不了。把没把握的读回执
 * 说成「已读」是在骗用户，宁可多显示一次红字 —— 读位只前进，下一次刷新就会修正。
 *
 * 刷新时机（#359 四 审查回合修正）：进页 / 从子页返回 / 点重试，**以及本页新增的
 * 读位轮询**（`applyReadPoll`）。原先注释里写的「发送落定后的静默补刷」只在
 * 「发送未落定就离开本页、再回来」时才发生（`shouldFlushDeferredReload` 要求
 * `deferred === true`），普通发送落定后不会补刷 —— 那是过期注释。
 *
 * 与 web-pc 的 `isMessageRead`（`apps/web-pc/src/features/chat/queries.ts`）同口径，
 * 那边也是「判不出来 → 未读」。
 */
export type MessageReadLabel = '已读' | '未读'

export function messageReadLabel(input: {
  /** 这条是不是我发的；不是我的消息返回 null（不渲染标签） */
  mine: boolean
  createdAt: string
  counterpartLastReadAt: string | null
}): MessageReadLabel | null {
  if (!input.mine) return null
  if (input.counterpartLastReadAt === null) return '未读'
  const readAt = Date.parse(input.counterpartLastReadAt)
  const sentAt = Date.parse(input.createdAt)
  if (Number.isNaN(readAt) || Number.isNaN(sentAt)) return '未读'
  return sentAt <= readAt ? '已读' : '未读'
}

/**
 * 读位轮询的落地：**只**把 `counterpartLastReadAt` 写回详情（#359 四 审查回合）。
 *
 * 为什么不复用 `load()`：`load` 会 `epoch + 1`（在途发送的响应会被判过期丢弃）、
 * 会重发一次已读上报、还会整份替换详情与消息流。而这条轮询只想补一个字段。
 *
 * 为什么要取「更新的那一份」：读位在服务端**单调只前进**
 * （`conversations/store.ts` 的「只前进不后退」），但 HTTP 响应会乱序 —— 20s 间隔下
 * 两次轮询可以同时在飞，先发的后到就会把「已读」打回「未读」。web-pc 的
 * `mergeConversationReadMarker` 是同一套判据。
 */
export function applyReadPoll(
  conversation: ConversationDto,
  next: ConversationDto,
): ConversationDto {
  const merged = laterReadMarker(conversation.counterpartLastReadAt, next.counterpartLastReadAt)
  if (merged === conversation.counterpartLastReadAt) return conversation
  return { ...conversation, counterpartLastReadAt: merged }
}

/** 两个读位取更晚的那个；解析不了的一方让位给另一方（都不行则保留原值） */
function laterReadMarker(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current
  if (current === null) return candidate
  const left = Date.parse(current)
  const right = Date.parse(candidate)
  if (Number.isNaN(right)) return current
  if (Number.isNaN(left)) return candidate
  return right > left ? candidate : current
}

/**
 * 本地乐观消息（正在发送 / 发送失败）。
 *
 * 契约里没有「发送中」，这是纯客户端的临时状态：成功后被服务端返回的那条替换掉
 * （按 id 去重，实时推送送来的同一条也不会重复）。
 */
export type PendingMessage = {
  /** 本地临时 id（只用于渲染 key 与重试定位，不是服务端 id） */
  id: string
  content: string
  status: 'sending' | 'failed'
  /**
   * 本条要引用的消息（#359 3c）：被引用消息的**公开 id** + 本地摘引文案。
   * 发送成功前服务端还没给投射，气泡里的摘引只能先用本地这份画。
   */
  replyTo?: { id: string; excerpt: string } | null
}

/**
 * 发送失败后是否还能重试同一个临时条目。
 * 组件用它当重试门禁（而不是在组件里再写一遍等价判断）：这样「失败才可重试」
 * 这条规则有测试直接锁在真实调用点上。
 */
export function canRetry(message: PendingMessage): boolean {
  return message.status === 'failed'
}

/* ------------------------------------------------------------------ 媒体（#359 3b） */

/**
 * 直传成功后、`create` 还没确认的那份结果。
 *
 * 结构上与 `features/chat/media-api.ts` 的 `UploadedImage` / `UploadedVoice` 一致
 * （那边是平台层，本文件刻意不 import Taro 相关模块，所以这里重新声明一份形状）。
 */
export type PendingMediaUpload =
  | {
      kind: 'IMAGE'
      objectKey: string
      contentType: string
      sizeBytes: number
      width: number
      height: number
    }
  | {
      kind: 'VOICE'
      objectKey: string
      contentType: string
      sizeBytes: number
      durationMs: number
    }

/**
 * 本地乐观媒体（图片 / 语音正在上传、或上传失败）。
 *
 * 与 `PendingMessage` 同一性质：契约里没有「上传中」。`id` 是本地临时 id，
 * 服务端媒体返回后按 `MediaMessageDto.id` 去重，这条本地条目就被移除。
 *
 * **`uploaded` 为什么必须留着**：媒体创建（`POST /conversations/:id/media`）的幂等指纹
 * 里含 `objectKey`（服务端 `mediaRequestHash`）。重试时若重新直传，presign 会签发一个
 * **新的** objectKey，同一个 `clientRequestId` 配上不同的指纹 → 服务端判
 * `IDEMPOTENCY_KEY_REUSED`（409），而不是重放那条已经创建好的媒体。所以重试只重发
 * `create`，把 `uploaded` 原样带上；`objectKey` 没变，指纹一致，服务端才能正确重放。
 */
export type PendingMediaDraft =
  | {
      kind: 'IMAGE'
      /** 本次发送的幂等键（新发送时生成，重试沿用 —— #67 第一步） */
      clientRequestId: string
      /** 本地临时文件路径（预览 + 上传源） */
      path: string
      /** 直传与 create 都要用的声明值（mime / 尺寸 / 字节数） */
      image: { mime: AllowedImageMime; width: number; height: number; sizeBytes: number }
    }
  | {
      kind: 'VOICE'
      clientRequestId: string
      /** 本地临时文件路径（本地试听 + 上传源） */
      path: string
      /** 录音时长（毫秒）：只用于气泡文案，服务端按字节重解析并覆盖 */
      durationMs: number
    }

/**
 * 写成 `Draft & {...}` 而不是「可空字段 + 可空 kind」：`item.kind === 'IMAGE'` 之后
 * `image` 直接就是尺寸声明，编译器能挡住「图片分支里读到 null 再拿 0 兜底」那种
 * 必然 422 的写法（服务端会逐个比对 width/height）。
 */
export type PendingMedia = PendingMediaDraft & {
  /** 本地临时 id（只用于渲染 key 与重试定位） */
  id: string
  /** 已直传成功的结果（重试时只重发 create）；还没传成功为 null */
  uploaded: PendingMediaUpload | null
  status: 'uploading' | 'failed'
}

/** 上传失败的媒体才能重试（与文本的 `canRetry` 同一口径） */
export function canRetryMedia(pending: PendingMedia): boolean {
  return pending.status === 'failed'
}

/**
 * 重试一条失败的媒体：把状态切回「上传中」（#67 N4）。
 *
 * 修复前重试入口只调 `runMediaSend`，全程不改 `status`，于是整个重试期间气泡仍按
 * `canRetryMedia` 渲染成失败态、重试按钮还挂在上面 —— 用户看不出点了有没有反应。
 */
export function startMediaRetry(pending: PendingMedia): PendingMedia {
  return { ...pending, status: 'uploading' }
}

/**
 * 媒体发送任务的会话绑定（#67 N2）。
 *
 * `request.ts` 的每个请求都是**发出时**才读 `fish_session`，所以「A 选了图 → 切到 B →
 * create 才发出去」会让这条媒体以 B 的身份落库。`epoch` 只在整页重拉 / 身份清场时 +1，
 * 挡不住这种时序；把发起时的 cookie 一起记下来才能判旧。
 */
export interface MediaTaskBinding {
  readonly epoch: number
  readonly cookie: string
}

export function isStaleMediaTask(
  task: MediaTaskBinding,
  current: { epoch: number; cookie: string },
): boolean {
  return task.epoch !== current.epoch || task.cookie !== current.cookie
}

/**
 * 用户明确发起、要等好几秒的那几件事（选图 / 录音 / 点开一张图或一段语音）的**身份**
 * （#364 审查）：换账号才算旧。
 *
 * 与 `MediaTaskBinding` 的差别只有一个 `epoch`，但这个差别就是那个 bug：`epoch` 是
 * **「整页重拉」计数器** —— 切后台再回来（`useDidShow`）、发送落定后的补刷新都会把它
 * +1，可它并不代表换人。用户「选了图 → 等相册回调」的这几秒里，任何一次 `load()` 都会
 * 把 epoch 推走，拿 epoch 当身份就会把刚选好的素材**静默丢掉**（选了图 / 录了音，什么都
 * 没发生）。真正让素材作废的只有换账号：`userId` 与 `fish_session`（cookie）一起看。
 */
export interface MediaTaskIdentity {
  readonly cookie: string
  /** 未登录时是 null（与页面的 `userId` 同口径），一样参与比对 */
  readonly userId: string | null
}

export function isStaleMediaIdentity(
  task: MediaTaskIdentity,
  current: { readonly cookie: string; readonly userId: string | null },
): boolean {
  // userId 从非空变成 null（退出登录）同样判旧
  return task.cookie !== current.cookie || task.userId !== current.userId
}

/**
 * 自动下载该对一条媒体做什么（#67 复查 #222）。
 *
 * `reuse` 这一支是修复的核心：`media-api` 的模块级缓存与页面级 `localPaths` 是**两份**
 * 状态。退出会话再进来时页面状态被重建、模块缓存还在，修复前缓存命中直接 `continue`，
 * 于是图片只剩占位块、而且因为缓存命中永远不会重新下载。命中时必须把路径回填进本页。
 */
export type MediaLoadPlan =
  | { readonly kind: 'reuse'; readonly path: string }
  | { readonly kind: 'skip' }
  | { readonly kind: 'download' }

export function planMediaLoad(input: {
  readonly cached: string | null
  readonly downloading: boolean
}): MediaLoadPlan {
  if (input.cached !== null) return { kind: 'reuse', path: input.cached }
  if (input.downloading) return { kind: 'skip' }
  return { kind: 'download' }
}

/**
 * 一次语音播放请求是否还该落地（#67 复查 #222）。
 *
 * 三道闸缺一不可：
 * - `alive` —— 已经离开会话页（卸载）；回来时不该突然出声。
 * - `token` —— 用户又点了另一条语音 / 又点了一次；旧下载回来不该抢走当前播放。
 * - `MediaTaskIdentity` —— 换了账号（`userId` 或 cookie 变了）；私有媒体的字节属于上一个身份。
 *
 * **这里刻意不看 `epoch`**（#364 审查）：`epoch` 会被任何一次整页重拉推进（切后台回来、
 * 补刷新），但那是「重拉」不是「换人」—— 用户点开一段语音、下载还没回来时正好赶上一次
 * 重拉，旧实现就既不预览也不提示，点了等于没点。身份没变就允许落地。
 *
 * 为什么不能只看 `playingId`：下载是异步的，`playingId` 那套只在**点击时**比对，
 * 迟到的回调回来时 `playingId` 可能已经被别的请求占用，读它得到的是「别人的答案」。
 */
export function isCurrentPlayRequest(
  request: { readonly token: number; readonly task: MediaTaskIdentity },
  current: {
    readonly token: number
    readonly cookie: string
    readonly userId: string | null
    readonly alive: boolean
  },
): boolean {
  return (
    current.alive && current.token === request.token && !isStaleMediaIdentity(request.task, current)
  )
}

/**
 * 「加载更早」的按钮该不该在（#67 N3）。
 *
 * 消息与媒体是两条独立分页流：文本翻到底（`nextCursor === null`）而媒体还有历史时，
 * 修复前的入口用文本游标当唯一门槛，按钮消失、剩下的媒体再也拉不出来。
 */
export function hasEarlierPage(nextCursor: string | null, mediaCursor: string | null): boolean {
  return nextCursor !== null || mediaCursor !== null
}

/**
 * 按契约的 `(createdAt, id)` 升序排。
 *
 * 为什么需要：发送成功是按**响应到达顺序**追加的，连发两条时响应可能乱序回来，
 * 界面上的先后就会与服务端落库顺序（契约的排序键）相反。
 *
 * 泛型是因为**媒体消息与文本消息共用同一个排序键**（`mediaMessageDtoSchema` 与
 * `messageDtoSchema` 都有 `createdAt` / `id`），合并时间线时两者要一起定序。
 */
export function sortMessages<T extends { id: string; createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    if (at !== bt) return at - bt
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

/**
 * 把一条**实时推送**的媒体并入媒体流（#67 第四步）。
 *
 * 按服务端 id 去重（推送不保证不重：HTTP 发送成功的响应已经把同一条落进本地，
 * 服务端再推一次就会出现两个一样的气泡），并仍按契约的 `(createdAt, id)` 定序 ——
 * 推送到达顺序不保证与服务端落库顺序一致（同 `sortMessages` 的理由）。
 *
 * 重复时返回原数组本身（不是新数组）：调用方会拿到同一条推送，返回新引用会让
 * React 白重渲染一次。
 */
export function mergePushedMedia(
  previous: MediaMessageDto[],
  media: MediaMessageDto,
): MediaMessageDto[] {
  if (previous.some((item) => item.id === media.id)) return previous
  return sortMessages([...previous, media])
}

/**
 * 后台刷新（silent）落地时把媒体快照合并回已有媒体流。
 *
 * 与 `mergeRefreshedMessages` 同一理由（见上方长注释）：媒体列表的响应同样可能
 * 早于「本次刷新期间才上传成功的那条媒体」，无条件覆盖会把刚发出去的照片抹掉。
 */
export function mergeRefreshedMedia(
  previous: MediaMessageDto[],
  incoming: MediaMessageDto[],
  baseIds: ReadonlySet<string>,
): MediaMessageDto[] {
  const seen = new Set(incoming.map((item) => item.id))
  const carried: MediaMessageDto[] = []
  for (const item of previous) {
    if (baseIds.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    carried.push(item)
  }
  return sortMessages([...incoming, ...carried])
}

/**
 * 后台刷新（silent）落地时把新快照合并回已有消息流（#186 P2-1）。
 *
 * silent 刷新发起于用户没有请求刷新的时刻，**它带回来的快照可能早于本次刷新期间
 * 才发送成功的那条消息** —— HTTP 响应顺序无法保证：`POST /messages` 先落库并 resolve，
 * 补刷新的 `load({ silent: true })` 后到，手里却是发送之前的快照。此时无条件
 * `setMessages(page.items)` 会把那条已经确认的消息抹掉，用户看到自己刚发出去的话
 * 消失，下一次刷新又冒出来。
 *
 * 合并规则（`baseIds` = 本次刷新**发起时**消息流里的 id 快照）：
 * - 以服务端快照为准：它可能包含对方刚发来的新消息，也可能修正本地顺序；
 * - 额外保留 `baseIds` 之外、且不在快照里的消息 —— 那些是刷新发起**之后**才确认
 *   落地的（本地乐观气泡被服务端返回替换的那一刻）；
 * - 按 id 去重后交给 `sortMessages` 定序，实时推送送来的同一条不会重复。
 */
export function mergeRefreshedMessages(
  previous: MessageDto[],
  incoming: MessageDto[],
  baseIds: ReadonlySet<string>,
): MessageDto[] {
  const seen = new Set(incoming.map((item) => item.id))
  const carried: MessageDto[] = []
  for (const item of previous) {
    if (baseIds.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    carried.push(item)
  }
  return sortMessages([...incoming, ...carried])
}

/**
/**
 * 撤回不可回退：快照里「还没撤回」的那条不能把本地刚落地的撤回碑写回正文。
 *
 * 为什么需要这一层（#359 3c 审查回合）：`recalled_at` 在服务端是**单调**的
 * （`UPDATE … SET recalled_at = COALESCE(recalled_at, now())`，只前进、永不清空），
 * 所以「本地已经落碑、刚回来的快照却说没撤回」只可能是**快照拍得比落碑更早**。
 * 而撤回在途最长 15s，期间任何一次 `load()`（从子页返回的整页重拉、上一次发送落定后的
 * silent 补刷）都可能带着撤回前的快照回来 —— 非 silent 直接 `setMessages(page.items)`
 * 会把正文写回去，用户看到「撤回成功了、一刷新又回来了」。
 *
 * 落地口径：其余字段仍取快照那份（可能含对方刚发的新消息与顺序修正），只把
 * `content` 清空、`recalledAt` 取本地那个（服务端权威值会在下一次真实刷新时覆盖它）。
 */
export function keepRecalledTombstones(
  previous: readonly MessageDto[],
  incoming: readonly MessageDto[],
): MessageDto[] {
  const recalled = new Map<string, MessageDto>()
  for (const item of previous) {
    if (item.recalledAt !== null) recalled.set(item.id, item)
  }
  if (recalled.size === 0) return [...incoming]
  return incoming.map((item) => {
    if (item.recalledAt !== null) return item
    const local = recalled.get(item.id)
    if (!local) return item
    return { ...item, content: '', recalledAt: local.recalledAt }
  })
}

/**
 * 在线态轮询落地（#359 第五点）：**只**把对方的在线态写回，其余字段一律不动。
 *
 * 为什么必须显式限定：这一跳是「只为了在线态」的重拉，它带回来的整份详情快照可能比
 * 屏幕上的状态**更旧**（这次请求发出之后用户刚发出一条消息、或刚推进过读位）。
 * 无条件 `setConversation(next)` 会让 `lastMessage` / `unreadCount` / `lastMessageAt`
 * 一起回退 —— 与 `mergeRefreshedMessages` 防的是同一类「陈旧快照覆盖新状态」。
 */
export function applyPresencePoll(
  previous: ConversationDto,
  incoming: ConversationDto,
): ConversationDto {
  return { ...previous, counterpartPresence: incoming.counterpartPresence }
}

/**
 * 在线态轮询的落地守卫（#376 审查回合，P3）。
 *
 * `applyPresencePoll` 是 last-write-wins：谁最后落地谁说了算。而「谁最后落地」并不等于
 * 「谁最后发出」—— 同一 epoch 内相邻两跳的响应没有先后保证。正常情况下前一跳应当已经
 * 落定（每跳超时 `REQUEST_TIMEOUT_MS = 15s`、间隔 `PRESENCE_POLL_MS = 20s`），但这个
 * 先后**只是传输层的承诺**：超时由宿主兑现（小程序原生层 / H5 的 XHR），一旦它没兑现，
 * 前一跳就会在下一跳之后才 resolve，先发的旧快照把后发的新结论盖掉 —— 刚点亮的绿点又
 * 灭回去，且要等下一跳才纠正。序号守卫让「只让最新一次落地」不再依赖传输层。
 *
 * 两个条件缺一不可：
 * - `seq === latestSeq`：只有最新一次发起的轮询可以落地；
 * - `epoch === latestEpoch`：换账号 / 换会话 / 整页重拉之后，上一代的响应一律作废
 *   （与 `isLatestPageLoad` 同一道闸，只是多了序号这一维）。
 */
export function isLatestPresencePoll(input: {
  /** 本次轮询**发起时**取的序号 */
  seq: number
  /** 本次轮询发起时的加载代次 */
  epoch: number
  /** 落地时页面上的最新序号 */
  latestSeq: number
  /** 落地时页面上的最新代次 */
  latestEpoch: number
}): boolean {
  return input.seq === input.latestSeq && input.epoch === input.latestEpoch
}

/**
 * 「加载更早一页」的落定守卫（#186 P2-2）。
 * 更早一页是**账号 + 会话作用域**的快照：发起后若发生换账号、换会话或整页重拉
 * （三者都会 `epoch +1`），这批数据与 `loadingEarlier` 这把锁就都已经属于上一代。
 *
 * `then` 与 `finally` 必须用同一个守卫：前者决定「要不要写入」，后者决定
 * 「要不要还锁」。旧实现只在 `then` 里判过期，`finally` 却无条件
 * `setLoadingEarlier(false)` —— 新账号的分页请求还在飞的时候锁被上一个账号放掉，
 * 第二次点击就能再发一次，同一个 `before` 游标被并发消费两次。
 *
 * 反过来，整页重拉把在途分页判过期后必须**主动**还锁（见页面里 `load` 的
 * `setLoadingEarlier(false)`）：否则那次分页自己的 `finally` 也不会执行，锁永久拿着。
 */
export function isLatestPageLoad(epoch: number, latestEpoch: number): boolean {
  return epoch === latestEpoch
}

/**
 * 会话流里真正按顺序渲染的一条。
 * 服务端消息按 `(createdAt, id)` 升序；本地待发消息永远排在最后（它必然最新）。
 */
export type ChatEntry =
  | { kind: 'message'; keyId: string; message: MessageDto }
  | { kind: 'media'; keyId: string; media: MediaMessageDto }
  | { kind: 'pending'; keyId: string; pending: PendingMessage }
  | { kind: 'pending-media'; keyId: string; pending: PendingMedia }

/** 服务端来源的两类条目（本地待发条目不参与排序，永远追加在尾部） */
export type ServerEntry = Extract<ChatEntry, { kind: 'message' } | { kind: 'media' }>

function entrySortKey(entry: ServerEntry): { at: number; id: string } {
  const source = entry.kind === 'message' ? entry.message : entry.media
  return { at: Date.parse(source.createdAt), id: source.id }
}

/**
 * 把两条服务端消息流合并成一条升序时间线。
 *
 * 排序规则与 `sortMessages` 一致（`(createdAt, id)`）；同一时刻一条文本与一条媒体
 * 的先后由 id 决定，这与服务端两条流各自的定序口径相同，不引入新的不稳定来源。
 */
export function mergeTimeline(messages: MessageDto[], media: MediaMessageDto[]): ServerEntry[] {
  const entries: ServerEntry[] = [
    ...messages.map((message) => ({ kind: 'message' as const, keyId: message.id, message })),
    ...media.map((item) => ({ kind: 'media' as const, keyId: item.id, media: item })),
  ]
  return entries.sort((a, b) => {
    const left = entrySortKey(a)
    const right = entrySortKey(b)
    if (left.at !== right.at) return left.at - right.at
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
}

/**
 * 页面重新显示（`useDidShow`）时要不要**立刻**重拉（#170 D）。
 *
 * 四个条件缺一不可：
 * - `loadedOnce`：首次显示让渡给登录态 effect，didShow 不重复发（冷启动不双发）；
 * - `authed` / `hasUserId`：登录态未就绪 / 未登录时不发受限请求；
 * - `!sending`：有在途发送时重拉会把 epoch +1，在途的发送响应被判过期丢弃，
 *   乐观气泡永远停在「发送中」——这种情况改走延后刷新（见下）。
 *
 * 抽成纯函数是为了它能被单测锁住（页面组件本身没有渲染测试基建）；
 * **组件接线**（是否调用、传什么参数）仍靠 code review + 端上验收。
 */
export function shouldReloadOnShow(input: {
  loadedOnce: boolean
  authed: boolean
  hasUserId: boolean
  sending: boolean
}): boolean {
  return input.loadedOnce && input.authed && input.hasUserId && !input.sending
}

/**
 * 会话详情态。`loading` 是页面自己的在途态；其余三个来自 `loadConversation`
 * （`features/fetchers.ts`：ok / missing / failed）。
 */
export type ConvState = 'loading' | 'ok' | 'missing' | 'failed'
/** `loadConversation` 能返回的详情态（不含页面自己的 `loading`） */
export type ConvDetailStatus = Exclude<ConvState, 'loading'>

/**
 * 后台刷新（silent）如何落详情态：**只做确认、不做降级**。
 *
 * 为什么必须单独判：silent 补刷新发生在「发送落定」之后，而 `loadConversation` 与
 * `loadMessagePage` 是**两个独立请求** —— 弱网下（正是「发送失败」的相关场景）往往
 * 一起失败。若照常把详情态写成 `failed`，渲染会在 `convState !== 'ok'` 处短路成
 * 整页「会话加载失败」，把刚失败的乐观气泡与它的「发送失败 · 重试」一起盖掉 ——
 * 而发送失败本就该留在原地给重试。
 *
 * 但也不能无条件保留：页面**还没正常显示过**（`loading` / `failed`）时必须如实落
 * 详情结果，否则会停在一个没有重试入口的态上（`loading` 分支不渲染重试钮）。
 * 真被删掉的会话，下一次用户主动进页 / 点重试（非 silent）仍会如实反映。
 *
 * 抽成纯函数是因为这条判据是 #170 review 的修复点本身 —— 页面组件没有渲染测试
 * 基建，不抽出来就没有任何用例能在它被改坏时变红（`prev` 必须由调用方经
 * `setConvState` 的函数式更新传入：`load` 的 `useCallback` 依赖只有
 * `[conversationId]`，闭包里的 `convState` 永远停在首帧）。
 */
export function resolveConvState(
  prev: ConvState,
  detail: ConvDetailStatus,
  silent: boolean,
): ConvState {
  if (!silent || detail === 'ok') return detail
  return prev === 'ok' ? 'ok' : detail
}

/**
 * 「发送中返回」延后刷新的状态机（#170 D 的延后分支）。
 *
 * ## 为什么是一个状态而不是几个独立 ref
 *
 * 在途发送计数**必须归属 epoch**。发送是跨账号生命周期的异步操作：A 的发送可能在
 * 换到 B 之后才落定（最长等到 `REQUEST_TIMEOUT_MS`）。若计数是实例级的，A 那次落定
 * 会把 B 的计数也减掉 —— B 的补刷新要么被**永久压制**（B 自己的落定先到、计数没归零），
 * 要么被一次**无来源的陈旧落定**触发（A 的落定恰好是归零的那次），同时 `deferred`
 * 残留下来，之后被 B 任意一次发送落定消费掉，闪一次无来由的整页加载。
 *
 * 把「标记 + 计数 + 计数归属的 epoch」绑成一个状态、迁移只走下面几个函数，
 * 这条不变式就能被单测直接锁住（`inflight === 0` 一定属于当前 epoch 的最后一个发送）。
 */
export type DeferredReload = {
  /** 欠一次刷新：didShow 遇在途发送时置位 */
  deferred: boolean
  /** 当前 epoch 的在途发送数 */
  inflight: number
  /** `inflight` 归属的 epoch */
  epoch: number
}

export function initialDeferredReload(epoch: number): DeferredReload {
  return { deferred: false, inflight: 0, epoch }
}

/** 记下「欠一次刷新」（不立刻发，否则 epoch +1 会把乐观气泡卡在「发送中」） */
export function deferReload(state: DeferredReload): DeferredReload {
  return { ...state, deferred: true }
}

/**
 * 发起一次发送。传入当前 epoch：与状态里的 epoch 不同（换过账号）时，
 * 把旧 epoch 的残留计数整个丢掉、从 1 重新计。
 */
export function beginSend(state: DeferredReload, epoch: number): DeferredReload {
  if (state.epoch !== epoch) return { deferred: state.deferred, inflight: 1, epoch }
  return { ...state, inflight: state.inflight + 1 }
}

/**
 * 一次发送落定（成功 / 失败都走这里）。
 *
 * 陈旧 epoch 的落定**原样返回**：既不计入当前 epoch 的计数，也不会把当前 epoch 的
 * 「已无在途」判成真 —— 这正是「A 的 finally 不能触发 B 的刷新」那道闸。
 */
export function settleSend(state: DeferredReload, epoch: number): DeferredReload {
  if (state.epoch !== epoch) return state
  return { ...state, inflight: Math.max(0, state.inflight - 1) }
}

/** 是否到了补刷新的时刻：还欠着 + 当前 epoch 已无在途发送（多个并发只会在最后一次落定时为真） */
export function isFlushDue(state: DeferredReload): boolean {
  return state.deferred && state.inflight === 0
}

/** 补刷新已发出（或本次返回已由 didShow 正常重拉）：清标记。计数不动 */
export function clearDeferredReload(state: DeferredReload): DeferredReload {
  return { ...state, deferred: false }
}

/** 身份清场：标记与计数一起归到新 epoch，避免上个账号的标记被新账号的落定消费 */
export function resetDeferredReload(epoch: number): DeferredReload {
  return { deferred: false, inflight: 0, epoch }
}

/**
 * 到了补刷新的时刻、且补刷新真的能发：身份有效、页面可见且未卸载。
 *
 * `visible` 为假时**不补也不丢** —— 标记留着，回到本页时 `useDidShow` 会因为
 * 「已无在途发送」走正常重拉，那时一并清掉。
 */
export function shouldFlushDeferredReload(input: {
  state: DeferredReload
  authed: boolean
  hasUserId: boolean
  visible: boolean
}): boolean {
  return isFlushDue(input.state) && input.authed && input.hasUserId && input.visible
}

/* ------------------------------------------------- 长按菜单 / 引用 / 撤回（#359 3c） */

/**
 * 长按气泡能做什么。`copy` / `reply` 对双方都成立；`recall` 只对自己的消息成立。
 * 商品卡与媒体消息没有可复制文本，因此不给 `copy`（与微信一致）。
 */
export type MessageAction = 'copy' | 'reply' | 'recall'

/**
 * 这条消息此刻还能不能撤回。
 *
 * 三个条件缺一不可：**是我发的**、**还没撤回**、**在 2 分钟窗口内**。
 * SYSTEM 消息天然不满足第一条（`senderId` 为 null）。
 *
 * ⚠️ 这里的窗口判定用的是**客户端时钟**，只作「要不要显示撤回项」的 UX 门禁；
 * 权威判定在服务端（`clock_timestamp() - created_at`）。两端时钟有偏差时，可能出现
 * 「本端显示可撤回、服务端回 409」或反之 —— 前者由调用方按 `MESSAGE_RECALL_WINDOW_EXCEEDED`
 * 提示，后者只是少给了一个入口，都不影响数据正确性。
 */
export function canRecallMessage(
  message: MessageDto,
  meId: string | null,
  nowMs: number,
  windowMs: number,
): boolean {
  if (!meId || message.senderId !== meId) return false
  if (message.recalledAt !== null) return false
  const created = Date.parse(message.createdAt)
  if (Number.isNaN(created)) return false
  return nowMs - created <= windowMs
}

/** 长按菜单项（按显示顺序）。撤回是破坏性动作，排在最后。 */
export function messageActions(
  message: MessageDto,
  meId: string | null,
  nowMs: number,
  windowMs: number,
): MessageAction[] {
  if (message.type === 'SYSTEM') return []
  const actions: MessageAction[] = []
  // 已撤回的气泡只剩撤回碑，没有正文可复制、也没有可引用的内容。
  if (message.recalledAt === null) {
    if (message.type === 'TEXT') actions.push('copy')
    actions.push('reply')
  }
  if (canRecallMessage(message, meId, nowMs, windowMs)) actions.push('recall')
  return actions
}

/** 菜单项 → 中文文案（`Taro.showActionSheet` 的 itemList）。 */
export const MESSAGE_ACTION_LABEL: Record<MessageAction, string> = {
  copy: '复制',
  reply: '引用',
  recall: '撤回',
}

/** 与契约 `messageReplySchema.excerpt` 的 max 同源 */
export const REPLY_EXCERPT_MAX = 120

/**
 * 本地摘引文案：引用栏与「发送中」气泡在服务端投射回来之前先用它。
 *
 * 口径与服务端 `replyExcerpt`（`apps/api/src/modules/messages/reply.ts`）保持一致：
 * 已撤回 `[消息已撤回]`、空文本 `[消息]`、超长截断到 120 字含省略号。
 * 本地这份**只影响观感**：发送成功后气泡会换成服务端回的那条（含权威 `replyTo`）。
 */
export function localReplyExcerpt(message: MessageDto): string {
  if (message.recalledAt !== null) return '[消息已撤回]'
  const text = message.content.trim()
  if (text.length === 0) return '[消息]'
  return text.length > REPLY_EXCERPT_MAX ? `${text.slice(0, REPLY_EXCERPT_MAX - 1)}…` : text
}

/**
 * 撤回落地：把本地消息流里那一条翻成撤回碑。
 *
 * 服务端撤回后**不再下发正文**（`content` 为空串），所以本地也必须清掉 `content` ——
 * 否则「撤回后刷新」与「撤回后不刷新」会画出两种不同的气泡。保留 `id` / `senderId` /
 * `createdAt` 等身份字段：撤回碑仍要有头像与时间。
 */
export function applyRecalled(
  items: MessageDto[],
  messageId: string,
  recalledAt: string,
): MessageDto[] {
  return items.map((item) => (item.id === messageId ? { ...item, content: '', recalledAt } : item))
}

/** 撤回失败的提示文案（服务端三档错误码各有说法，其余归到通用失败） */
export function recallFailureText(code: string | undefined): string {
  if (code === 'MESSAGE_RECALL_WINDOW_EXCEEDED') return '超过 2 分钟，不能撤回了'
  if (code === 'MESSAGE_RECALL_FORBIDDEN') return '只能撤回自己发的消息'
  if (code === 'MESSAGE_NOT_FOUND') return '消息已不存在'
  return '撤回失败，请重试'
}

/**
 * 发送失败要不要把这条气泡的引用摘掉（#359 3c 审查回合）。
 *
 * 四种发送体在「被引用的消息已被撤回 / 不存在 / 跨会话 / 是 SYSTEM」时统一 422
 * `MESSAGE_REPLY_INVALID`，而 `retry` 会把 `item.replyTo` 原样传回下一次 `doSend` ——
 * 不摘掉引用，重试必然再撞同一个 422，用户看到的是一个永远点不成功的「发送失败 · 重试」。
 */
export function shouldDropReplyOnSendFailure(code: string | undefined): boolean {
  return code === 'MESSAGE_REPLY_INVALID'
}

/** 摘掉引用后的提示文案（失败气泡留在原地，用户可以再点重试） */
export const REPLY_DROPPED_TIP = '引用的消息已失效，已去掉引用'
