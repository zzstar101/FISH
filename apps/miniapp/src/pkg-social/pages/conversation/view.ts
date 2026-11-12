import type { ConversationDto, MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import type { UserPresence } from '@fish/contracts/users/schema'
import { currentTxOf } from '@/features/chat/capsule'
import type { AllowedImageMime } from '@/features/upload/mime'

/**
 * 会话页的展示逻辑（#89：从 fixture 改为真实历史 / 发送 / 已读）。
 *
 * 与 `pages/chat/list-view.ts` 同一手法：把「界面上写什么」抽成纯函数，
 * 组件只负责渲染。这里锁的是三类曾经靠人眼复审的判定：
 * 交易 SYSTEM 事件的中文化、时间文案、以及发送失败态。
 */

/**
 * 交易 SYSTEM 事件（`transactions/schema.ts` 的 `tx.*` 协议）。
 *
 * `transactionId` 只有 `tx.accepted` 带（契约 `transactionSystemEventSchema`）：它是
 * 会话里唯一指向交易行的线索，交易码页少它就只会落「找不到这笔交易」（#521）。
 */
export type TxEvent = { type: string; transactionId?: string }

/**
 * 解析交易 SYSTEM 事件的 JSON；非 JSON（普通文本系统消息）返回 null。
 * 与消息列表页的预览降级口径一致：解析不了就按原文渲染。
 */
export function parseTxEvent(content: string): TxEvent | null {
  try {
    const event: unknown = JSON.parse(content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (typeof type === 'string') {
        // 只保留契约里确实有的字段：脏数据里的 transactionId 不是字符串就当没有，
        // 不能让一个 `[object Object]` 拼进跳转地址。
        const transactionId = (event as { transactionId?: unknown }).transactionId
        return typeof transactionId === 'string' && transactionId.length > 0
          ? { type, transactionId }
          : { type }
      }
    }
  } catch {
    // 非 JSON：当普通文本
  }
  return null
}

/**
 * 会话里最后一条 `tx.accepted` 带的交易 id（`null` = 这条会话还没被接受过）。
 *
 * 用途只有一个：交易详情没取回来时（接口失败 / 列表被截断）仍然留一个能点的入口。
 * 那个入口进的面交页会按 id 自己查状态，所以不会把「已完成」误报成「待面交」；
 * 反过来，把入口整个抹掉才是用户不可恢复的损失（#521 的一半就是入口丢了 id）。
 */
export function lastTxAcceptedId(messages: readonly MessageDto[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'SYSTEM') continue
    const event = parseTxEvent(message.content)
    if (event?.type === 'tx.accepted' && event.transactionId) return event.transactionId
  }
  return null
}

/**
 * 不属于专门卡片的 SYSTEM 消息的胶囊文案。
 *
 * `tx.proposal` / `tx.rejected` / `tx.accepted` 翻成中文，其余（含普通文本系统消息）
 * 按原文。
 *
 * 这三档文案就是 Owner 2026-11-04 定下的**阶段胶囊**本身的措辞（#613）：胶囊由这条消息
 * 承载，会话区末尾那块进度块只在「没有系统消息可承载」的终态（成交 / 评价完成 / 取消）
 * 才补一颗 —— 同一句话不在会话里说两遍。
 *
 * `role` **必填**、且只影响提案态：`tx.proposal` 说的是「买家拍下了」，卖家看到的应该是
 * 「商品被拍下，前往确认」，而不是站在买家视角的「待对方同意」。必填是刻意的 ——
 * 缺省回落到买家口径会让卖家静默看到别人的提示语，这种错没人会发现。
 *
 * 与 #522 的关系（Owner 定案时明确接受这一点，别按 #522 改回去）：这条胶囊说的是
 * **这条消息发生过什么**，不是「这笔交易现在在哪一步」—— 实时状态仍由页头状态条按交易行
 * 渲染、终态仍由会话区末尾的进度块渲染。成交之后历史里那句「已接受交易，待面交」读起来
 * 就是一条日志（当时接受了、接着去面交），**不能**拿它当当前状态；页头若照抄这条消息，
 * 才会重演 #522 的「成交后一直停在待面交」。
 */
export function systemPillText(content: string, role: 'buyer' | 'seller'): string {
  const event = parseTxEvent(content)
  if (!event) return content
  if (event.type === 'tx.proposal') {
    return role === 'seller' ? '商品被拍下，前往确认' : '待对方同意'
  }
  if (event.type === 'tx.accepted') return '已接受交易，待面交'
  if (event.type === 'tx.rejected') return '交易被拒绝'
  return content
}

/**
 * 顶部「商品交易状态条」的视图模型（#551）。
 *
 * 这一块原来是商品摘要条（白卡 + 固定「查看」）。现在它并入交易状态：图 / 名 / 价不动，
 * 价格后面那段状态词跟着交易走，右侧动作区按「现在等我做什么」换按钮。#521 / #522
 * 曾用一张吸附在输入栏上方的进度卡承载同一份进度，Owner 定版后那张卡撤掉
 * （`tx-card.tsx` 已删除）—— 状态只在这里说一次，所以**失败降级与终态文案也必须由
 * 这条状态条表达**，不能再指望某张卡兜底。
 *
 * 状态机（与 `features/chat/capsule.ts` 的会话行胶囊同源，别分叉第三套判据）：
 *
 * | 场景 | 状态词 | 右侧动作 |
 * | --- | --- | --- |
 * | 没有交易、也没有提案 | 商品状态（在售 / 已售出…） | 「查看」→ 商品详情 |
 * | 提案待卖家点头 | 卖家「买家已申请面交」／买家「待卖家确认」 | 卖家「待确认」（二次确认后接受）／买家无按钮 |
 * | `PENDING_MEETUP` | 「待面交」；我已确认则「待对方确认」 | 卖家「打开交易码」→ 面交页；买家「开启扫码」→ 扫码页 |
 * | `COMPLETED` 且我还没评价（`reviewed === false`） | 「已完成交易」 | 「评价」→ 面交页（端上唯一评价入口） |
 * | `COMPLETED` 已评价（`reviewed === true`） | 「已完成交易」 | 「查看」→ 商品详情 |
 * | `COMPLETED` 评价态**没查到**（`reviewed === null`） | 「已完成交易」 | 「查看交易」→ 面交页（中性措辞，不替用户断言他没评过，也不与「查看」撞名） |
 * | `CANCELLED` | 「交易已取消」 | 「查看」→ 商品详情 |
 * | 交易查询失败（有交易证据） | 「交易状态待更新」 | 「重新加载」 |
 * | 交易查询失败、缓存仍 `PENDING_MEETUP` | 沿用成交前状态词（「待面交」／「待对方确认」） | 「重新加载」 |
 *
 * 几个被验收钉住的取舍：
 * - **已取消不给交易码入口**（#522）：面交页标题仍是「交易码」，即便它渲的是取消结果卡，
 *   入口语义也与验收冲突 —— 顶部只陈述终态。
 * - **评价态是严格三态**（`reviewed: boolean | null`）：只有 404 `REVIEW_NOT_FOUND` 才落
 *   `false`（= 待评价），成功落 `true`；`null` 是「还没查 / 查不到」，**不能**当成
 *   「已确认未评价」写「评价」—— 那是在替用户断言一件没查清的事。但入口也不丢：按钮文案
 *   退回中性的「查看交易」，去向仍是那一笔的面交页（端上唯一评价入口，且该页自己按服务端
 *   现状渲染评价块），所以未知态既不说谎，也不会让用户无处可评。
 * - **失败不信任旧终态**：只有仍在 `PENDING_MEETUP` 的缓存可以继续用（它不是终态，
 *   文案本来就是成交前口径），其余一律「交易状态待更新 + 重新加载」；而 `PENDING_MEETUP`
 *   那一档即便沿用成交前状态词，**主钮也必须切回「重新加载」**—— 否则查询失败会被静默
 *   吞掉（main 的 `txCardView` 就是 `failed ? '重新加载' : '查看交易码'`）。
 * - **入参 `role` 与 `tx.role` 必须一致**（同一笔交易 ⟷ 同一条会话的商品，真实数据里不会
 *   不一致）。但两者在类型上各自可选、互不校验，所以这里**明确分工**，别当成冗余去合并：
 *   「待对方确认」这一档读的是**交易行那一侧**的确认时间戳，因此 `myConfirmedAt` 取
 *   `currentTx.role`（确认时间戳属于交易行，算错一侧就会把我方已确认读成对方已确认）；
 *   主钮文案「打开交易码 / 开启扫码」读的是**会话侧**的入参 `role`。取 `tx.role` 不是
 *   笔误，`tests/conversation-view.test.ts` 里有一条用例把这份约定（以及不一致时的实际
 *   表现）钉死，改动这一行会让它变红。
 */
export type TxBarTone = 'is-plain' | 'is-warn' | 'is-pending' | 'is-ok'

/** 动作区的语义：点它到底做什么。组件按 `kind` 分流，纯函数不碰 Taro。 */
export type TxBarAction =
  | { kind: 'listing' }
  | { kind: 'confirm'; amountCents: number | null }
  /** 卖家拒绝买家的面交申请（只写一条 `tx.rejected` 消息，商品仍在售） */
  | { kind: 'reject' }
  | { kind: 'wait' }
  | { kind: 'code'; transactionId: string }
  | { kind: 'scan' }
  | { kind: 'review'; transactionId: string }
  /** 评价已完成 → 「我的评价」页的交易评价段（#613） */
  | { kind: 'reviews' }
  | { kind: 'retry' }

export type TxBarView = {
  /** 与列表行胶囊同名同义：黄=待我动手，蓝=等对方 / 提案，绿=完成，灰=终态 / 默认 */
  tone: TxBarTone
  /** 价格后面那一段状态词 */
  status: string
  /** 动作区文案；`wait` 时没有按钮（买家等卖家确认，状态词已经把话说完了） */
  label: string
  action: TxBarAction
  /**
   * 并列的次要动作（目前只有卖家提案态的「拒绝」）：与主按钮并排，靠描边弱化。
   * 买家没有拒绝入口 —— 提案由买家发起，撤回不在本 Issue 范围。
   */
  secondary?: { label: string; action: TxBarAction }
}

/** 提案态的输入：消息流里最后一个 `tx.*` 事件（宽松口径，见 `features/transaction/tx-signal.ts`） */
export type TxBarEvent = { type: string; amountCents?: number }

export function txBarView(input: {
  /** 我在这条会话里的角色：决定「打开交易码」还是「开启扫码」，以及提案的措辞 */
  role: 'buyer' | 'seller'
  /** 商品状态：没有交易时它就是状态词（与「我的发布」同一口径） */
  listingStatus: string | undefined
  tx: TransactionDto | null
  /**
   * 消息流里最后一个交易事件。提案态（交易行还没建出来）与**提案金额**都只能从这里读：
   * 提案不落表（`packages/contracts/src/transactions/schema.ts` 的冻结取舍），而接受接口
   * 要求把金额原样带回（`features/transaction/api.ts` 的 `acceptTransaction`）。
   */
  lastEvent: TxBarEvent | null
  /** 消息里最后一条 `tx.accepted` 的交易 id：交易行查不到时的兜底入口 */
  fallbackTxId: string | null
  /** 交易查询是否失败（调用方只在「有交易证据」时置真，见页面 `txFailed`） */
  failed: boolean
  /** 我在这笔交易下有没有评价；`null` = 还没查 / 查不到 */
  reviewed: boolean | null
}): TxBarView {
  const { role, tx, lastEvent, failed, reviewed } = input
  const proposal = lastEvent?.type === 'tx.proposal' ? lastEvent : null
  /**
   * 取这一会话当前作数的那笔交易行：取消后买家又提了新案时，被提案盖过的旧行不作数
   * —— 此刻更该回答「现在等我做什么」的是提案，不是那笔已取消的行。否则顶部写着
   * 「交易已取消」，同一会话的列表胶囊却写着「待接受」，两处自相矛盾。
   *
   * **判据只有一份**：`features/chat/capsule.ts` 的 `currentTxOf`（列表胶囊、
   * `txBarView`、`txStageView` 共用），多笔历史交易的边界也记在那里。
   */
  const currentTx = currentTxOf(tx, lastEvent?.type)

  /**
   * 失败降级的第一档：终态 / 没有缓存 / 别的交易的缓存都不算数，一律「交易状态待更新」。
   * 仍是 `PENDING_MEETUP` 的缓存例外 —— 它不是终态，按要求退回成交前状态词并给重试，
   * 所以这里放它过去，由下面 PENDING 分支的 `failed` 判断换钮。
   */
  if (failed && currentTx?.status !== 'PENDING_MEETUP') {
    return {
      tone: 'is-warn',
      status: '交易状态待更新',
      label: '重新加载',
      action: { kind: 'retry' },
    }
  }

  if (!currentTx) {
    if (proposal) {
      /**
       * 提案只由买家发起（`capsule.ts` 第 20 行的冻结口径）：卖家看到的是「等我点头」，
       * 买家看到的是「等人点头」。卖家那颗钮点了要二次确认再由页面调 `acceptTransaction`。
       *
       * 但商品已不是 ACTIVE 时，这条提案必然被服务端拒（409 `LISTING_NOT_ACTIVE`）：
       * `tx.proposal` 是不可变历史，商品却可能已被别的买家成交 / 被卖家下架。这时候再摆
       * 一颗「待确认」就是给用户一个必然失败的按钮 —— 如实说商品现状，动作退回查看。
       */
      if (input.listingStatus !== 'ACTIVE') {
        return {
          tone: 'is-warn',
          status: listingStatusText(input.listingStatus),
          label: '查看',
          action: { kind: 'listing' },
        }
      }
      const amountCents = typeof proposal.amountCents === 'number' ? proposal.amountCents : null
      if (role === 'seller') {
        return {
          tone: 'is-pending',
          status: '买家已申请面交',
          label: '待确认',
          action: { kind: 'confirm', amountCents },
          /**
           * 卖家必须能就地拒绝（#551 Owner 追加）：只有「待确认」一颗钮时，卖家不想卖这笔
           * 只能装作没看见 —— 买家那边就一直停在「待卖家确认」。拒绝与接受共用同一个出口，
           * 差别是拒绝**不落表**、商品仍在售（`features/transaction/api.ts` 的冻接口径）。
           */
          secondary: { label: '拒绝', action: { kind: 'reject' } },
        }
      }
      return { tone: 'is-pending', status: '待卖家确认', label: '', action: { kind: 'wait' } }
    }
    if (input.fallbackTxId) {
      /** 消息里有 `tx.accepted`、交易行却没取回来：状态如实说取不到，入口照留 */
      return {
        tone: 'is-warn',
        status: '交易状态待更新',
        label: '查看交易码',
        action: { kind: 'code', transactionId: input.fallbackTxId },
      }
    }
    return {
      tone: 'is-plain',
      status: listingStatusText(input.listingStatus),
      label: '查看',
      action: { kind: 'listing' },
    }
  }

  const transactionId = currentTx.id
  if (currentTx.status === 'COMPLETED') {
    /**
     * 终态文案替换掉原来那句「我们正在聊这件」（Owner 定版）：成交之后还写着正在聊这件，
     * 等于把已完成说成进行中。
     *
     * 「待评价」只认 `reviewed === false`（404 `REVIEW_NOT_FOUND` 才落到这个值）。`null`
     * 是**没查到**（首帧还没查回来 / 网络失败），不是「未评价」—— 写成「评价」就是替用户
     * 断言他没评过。未知态退回中性的「查看交易」，去向仍是那一笔的面交页：页面上只有那里
     * 有评价入口，且面交页会按服务端现状渲染，所以既不说谎也不会让用户无处可评。
     *
     * 为什么不是「查看」：上面两档（无交易 / 已评价）的「查看」都去商品详情，这里去向是
     * 面交页 —— 同一个字两种去向，用户没法预判。带宾语的「查看交易」把去向说清楚。
     */
    if (reviewed === true) {
      return { tone: 'is-ok', status: '已完成交易', label: '查看', action: { kind: 'listing' } }
    }
    if (reviewed === false) {
      return {
        tone: 'is-ok',
        status: '已完成交易',
        label: '评价',
        action: { kind: 'review', transactionId },
      }
    }
    return {
      tone: 'is-ok',
      status: '已完成交易',
      label: '查看交易',
      action: { kind: 'review', transactionId },
    }
  }
  if (currentTx.status === 'CANCELLED') {
    return { tone: 'is-plain', status: '交易已取消', label: '查看', action: { kind: 'listing' } }
  }

  // PENDING_MEETUP：契约里「双方各点一次确认」，只看得到自己那一侧的时间戳
  const myConfirmedAt =
    currentTx.role === 'buyer' ? currentTx.buyerConfirmedAt : currentTx.sellerConfirmedAt
  const pendingStatus = myConfirmedAt === null ? '待面交' : '待对方确认'
  /**
   * 查询失败、但缓存仍停在 `PENDING_MEETUP`：状态词照旧用成交前口径（缓存不是终态，
   * 没被判死），主钮则必须切回「重新加载」—— 与 main 的 `txCardView`
   * （`actionLabel: failed ? '重新加载' : '查看交易码'`）对齐。删掉吸底卡之后这条状态条
   * 是唯一的表达位，若这一档还把「开启扫码 / 打开交易码」摆着，查询失败就被静默吞掉
   * （#551 改动三第 3 点）。只换钮、不给状态词加「· 待更新」后缀：状态词与价格、长标题
   * 同排在一条渐变头上，加字会挤掉标题省略号的位置，而「重新加载」本身已经说明状态没取到
   * —— 也就不必为此新增第三套状态词。
   */
  if (failed) {
    return { tone: 'is-warn', status: pendingStatus, label: '重新加载', action: { kind: 'retry' } }
  }
  return {
    tone: myConfirmedAt === null ? 'is-warn' : 'is-pending',
    status: pendingStatus,
    label: role === 'seller' ? '打开交易码' : '开启扫码',
    action: role === 'seller' ? { kind: 'code', transactionId } : { kind: 'scan' },
  }
}

/**
 * 消息流末尾的「交易进度」块（#613）：胶囊 + 气泡。
 *
 * 这是 Owner 2026-11-04 定的**第二处状态位** —— #551 当时的口径是「顶部独家承载」，
 * 现在改为**双通道**：顶部负责随时可查可操作，会话区负责把进度放进聊天流里，并且
 * 把「确认 / 拒绝」这两颗钮再放一份到气泡里（两重保障，点哪边都生效）。
 *
 * 判据来源与 `txBarView` **同一份**，别分叉第三套：
 * - 交易行（`TransactionDto`）回答「现在在哪一步」：`PENDING_MEETUP` / `COMPLETED` / `CANCELLED`；
 * - 「取消后又被新提案盖过」由 `features/chat/capsule.ts` 的 `currentTxOf` 判定
 *   （列表胶囊 / `txBarView` / 本函数共用同一份，不在这里再抄一遍）；
 * - 消息流里最后一条 `tx.*` SYSTEM 事件回答「还没有交易行的提案态」（`tx.proposal`）
 *   与「卖家拒绝了」（`tx.rejected`）——契约刻意不为终态写 SYSTEM 消息
 *   （`packages/contracts/src/transactions/schema.ts:102-105`），所以终态的胶囊由交易行派生；
 * - `reviewed` 是严格三态（`features/chat` 与 `txBarView` 同一口径）：`false` = 待评价、
 *   `true` = 已评价、`null` = 没查到 —— `null` **不能**说成「没评价」。
 *
 * 与 `txBarView` 的差别只在**表达位置与文案**：顶部那条是「商品 + 状态词 + 一颗钮」，
 * 这里是「一句阶段陈述（胶囊）+ 一张居中卡（气泡）」。动作语义共用 `TxBarAction`，
 * 页面用同一套分发执行（`runTxBarAction`），不复制 `confirmProposal` / `declineProposal`。
 */

/** 气泡里的一颗按钮：文案显式给（同一动作在不同阶段叫法不同），语义复用 `TxBarAction` */
export type TxStageAction = {
  label: string
  /** `primary` = 品牌蓝实心；`ghost` = 描边弱化（与顶部「拒绝」同一视觉语言） */
  variant: 'primary' | 'ghost'
  action: TxBarAction
}

/** 进度气泡：居中等宽卡，商品图 + 成交价 + 当前阶段动作 */
export type TxStageBubble = {
  /**
   * 大标题：一句话说清「现在到哪一步 / 该我做什么」。
   *
   * 可空：这一档要说的东西已经由胶囊或按钮说清楚了就别再写一遍（Owner 口述的待面交档
   * 就只有「商品图 + 价钱 + 打开交易码」，没有大标题；成交态评价未知时的「查看交易」
   * 同理）。同一句话不在同一块里说两遍。
   */
  title: string | null
  /** 商品名（标题下方一行，超长省略） */
  listingTitle: string
  coverUrl: string | null
  /**
   * 成交价（分），不是挂价：提案态取 `tx.proposal.amountCents`，成交后取交易行的
   * `amountCents`。`null` = 提案没带金额（脏数据）——气泡照画，但不凭空造一个价格。
   */
  amountCents: number | null
  /** 右侧动作区（竖排）；空数组 = 只陈述、没有可点的东西 */
  actions: TxStageAction[]
}

export type TxStageView = {
  /**
   * 胶囊：贴在气泡上方的一句阶段陈述。
   *
   * **可空**，而且 ①②③ 三档刻意给 `null` —— 那三档的说法已经由消息流里的 SYSTEM 灰胶囊
   * （`systemPillText`）说过了：灰胶囊就是 Owner 要的「胶囊」，这里再摆一颗就是同一句话
   * 上下说两遍。只有**没有系统消息可承载**的成交档（交易成功 / 交易全流程完成）才由这块
   * 补一颗；已取消档连胶囊都不出（顶部状态条独占，见下面 CANCELLED 分支）。
   */
  capsule: {
    label: string
    /**
     * 胶囊视觉档，复用顶部状态条的四档 `TxBarTone`（不另造色值）：成交档目前唯一会出
     * 胶囊，两档都是 `is-ok`（绿）。页面按它上类名，配色仍走 `--ok-weak` / `--ok-ink`。
     */
    tone: TxBarTone
  } | null
  /** 气泡；`null` = 这一档没有卡片可画（已取消） */
  bubble: TxStageBubble | null
}

export function txStageView(input: {
  /** 我在这条会话里的角色：决定提案态措辞与「打开交易码 / 扫码」的分派 */
  role: 'buyer' | 'seller'
  /** 商品状态：提案还在、商品却不是 ACTIVE 时这说明提案必然被拒（与 `txBarView` 同判据） */
  listingStatus: string | undefined
  /** 会话侧的商品摘要（气泡里的图与名） */
  listing: { title: string; coverUrl: string | null }
  tx: TransactionDto | null
  /** 消息流里最后一个交易事件（提案态与提案金额只能从这里读） */
  lastEvent: TxBarEvent | null
  /** 我在这笔交易下有没有评价；`null` = 还没查 / 查不到 */
  reviewed: boolean | null
  /** 交易查询是否失败（调用方只在「有交易证据」时置真） */
  failed: boolean
}): TxStageView | null {
  const { role, tx, lastEvent, listing } = input
  /**
   * 查询失败：**整块不出**。顶部状态条已经如实说「交易状态待更新 · 重新加载」，
   * 这里再摆一条「交易状态待更新」就是同一句话说两遍，而且气泡里的动作也无从判断
   * （失败时 `tx` 可能是别的交易的缓存）。历史 SYSTEM 灰胶囊不受影响 —— 它们是事实。
   */
  if (input.failed) return null

  const proposal = lastEvent?.type === 'tx.proposal' ? lastEvent : null
  /** 取消后买家又提了新案：判据见 `currentTxOf`（与 `txBarView` / 列表胶囊同一份，唯一一处） */
  const currentTx = currentTxOf(tx, lastEvent?.type)
  const goods = { listingTitle: listing.title, coverUrl: listing.coverUrl }

  if (!currentTx) {
    if (proposal) {
      /**
       * 商品已不是在售（被别的买家订走 / 下架）：这条提案必然 409 `LISTING_NOT_ACTIVE`，
       * 摆一颗「确认」就是给用户一个必然失败的按钮（`txBarView` 同一档也是退回「查看」）。
       */
      if (input.listingStatus !== 'ACTIVE') return null
      const amountCents = typeof proposal.amountCents === 'number' ? proposal.amountCents : null
      if (role === 'seller') {
        return {
          /**
           * 胶囊留空：这条提案自己就是一条 SYSTEM 消息，会话里已经有灰胶囊写着
           * 「商品被拍下，前往确认」（`systemPillText` 按角色出），这块只补气泡。
           */
          capsule: null,
          bubble: {
            /**
             * 卖家视角不能写「我已拍下」——拍下的是买家。同构只换人称（Owner 2026-11-04
             * 口述「卖家这边是同样的信息」，主语按视角改）。
             */
            title: '买家已拍下，待我确认',
            ...goods,
            amountCents,
            actions: [
              { label: '确认', variant: 'primary', action: { kind: 'confirm', amountCents } },
              { label: '拒绝', variant: 'ghost', action: { kind: 'reject' } },
            ],
          },
        }
      }
      return {
        capsule: null,
        bubble: { title: '我已拍下，待卖家确认', ...goods, amountCents, actions: [] },
      }
    }
    if (lastEvent?.type === 'tx.rejected') {
      /**
       * 拒绝不落表、商品仍在售：只陈述一句，不给任何动作（重新发起由买家决定）。
       * 这句由那条 `tx.rejected` 的 SYSTEM 灰胶囊说（双方同一句「交易被拒绝」），
       * 所以整块不出 —— 气泡、胶囊都没有可画的东西。
       */
      return null
    }
    return null
  }

  const transactionId = currentTx.id
  if (currentTx.status === 'COMPLETED') {
    /**
     * 完成态三档（与 `txBarView` 的 `reviewed` 三态同源）：
     * - `false` 待评价 → 气泡主钮「前往评价」，去向仍是面交页（端上唯一评价入口）；
     * - `true` 已评价 → 主钮「前往查看评价」进「我的评价」的交易评价段，胶囊进最终档；
     * - `null` 没查到 → **不替用户断言没评过**，主钮退回中性的「查看交易」，胶囊仍是「交易成功」。
     */
    if (input.reviewed === true) {
      return {
        capsule: { label: '交易全流程完成', tone: 'is-ok' },
        bubble: {
          title: '评价已完成',
          ...goods,
          amountCents: currentTx.amountCents,
          actions: [{ label: '前往查看评价', variant: 'primary', action: { kind: 'reviews' } }],
        },
      }
    }
    return {
      capsule: { label: '交易成功', tone: 'is-ok' },
      bubble: {
        /**
         * `false` 待评价 → 标题就是那句行动号召；`null` 没查到评价态 → **没有标题**：
         * 胶囊已经说了「交易成功」，再写一句「交易已完成」就是同一句话两遍。
         */
        title: input.reviewed === false ? '给对方评价' : null,
        ...goods,
        amountCents: currentTx.amountCents,
        actions: [
          {
            label: input.reviewed === false ? '前往评价' : '查看交易',
            variant: 'primary',
            action: { kind: 'review', transactionId },
          },
        ],
      },
    }
  }
  if (currentTx.status === 'CANCELLED') {
    /**
     * 已取消：**整块不出**。顶部状态条这一档本来就写着「交易已取消」，会话流末尾再摆
     * 一颗同字胶囊就是同一句话在同一屏说两遍；而这一档没有任何可以点的东西（交易已经
     * 终止、商品回到在售，重新发起由买家决定），也就没有气泡可画。
     */
    return null
  }

  // PENDING_MEETUP：还没面交，买卖两侧同一句话、同一颗钮
  return {
    /** 胶囊留空：`tx.accepted` 那条 SYSTEM 灰胶囊已经在说「已接受交易，待面交」 */
    capsule: null,
    bubble: {
      /**
       * 没有大标题：这一档要说的「待面交」上一行灰胶囊已经说了，Owner 口述的待面交档
       * 也只要求「商品图 + 价钱 + 右侧打开交易码」。顶部状态条在「我已确认、等对方确认」
       * 时会写「待对方确认」（谁该动作），与这里的阶段陈述不是一回事，不冲突。
       */
      title: null,
      ...goods,
      amountCents: currentTx.amountCents,
      actions: [
        {
          /**
           * 文案按 Owner 口述「双方内容一样」统一写「打开交易码」；**动作**仍按角色分派
           * ——卖家在面交页出示码（`code`），买家进扫码页（`scan`），与顶部同一套分派。
           */
          label: '打开交易码',
          variant: 'primary',
          action: role === 'seller' ? { kind: 'code', transactionId } : { kind: 'scan' },
        },
      ],
    },
  }
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

/**
 * 实时推送的 `conversation.read` 落地：与 `applyReadPoll` 同一套判据，只是事件里
 * 没有整份详情、只有推进到的时刻。取「更晚的那份」的原因不变 —— 读位在服务端单调
 * 只前进，但推送与 20s 轮询可以乱序到达，先发的旧值不许把新读位打回去。
 *
 * 调用方先按 `readerId !== 我` 过滤（本人这次读操作不该被当成「对方已读」，
 * 见 `chat/schema.ts` 的 `conversation.read` 注释），这里只管落地。
 */
export function applyReadEvent(conversation: ConversationDto, readAt: string): ConversationDto {
  const merged = laterReadMarker(conversation.counterpartLastReadAt, readAt)
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
      /**
       * 本次发送要引用的消息（#518）：快照自 `replyTarget`，重试时原样带回；
       * 与服务端 `replyToId` 对应，媒体气泡也要能显示引用。
       */
      replyTo?: { id: MessageDto['id']; excerpt: string }
    }
  | {
      kind: 'VOICE'
      clientRequestId: string
      /** 本地临时文件路径（本地试听 + 上传源） */
      path: string
      /** 录音时长（毫秒）：只用于气泡文案，服务端按字节重解析并覆盖 */
      durationMs: number
      /** 同图片分支：媒体发送的引用快照（#518） */
      replyTo?: { id: MessageDto['id']; excerpt: string }
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
  const index = previous.findIndex((item) => item.id === media.id)
  if (index === -1) return sortMessages([...previous, media])
  const existing = previous[index]
  if (existing === undefined) return previous
  /**
   * 与 `mergePushedMessage` 同一道「撤回必须前进」的闸（第二轮审查）：
   * `media.new` 不只会推新消息 —— 服务端的媒体创建幂等重放（`media-service.ts` 的
   * 快速路径）会拿**已撤回的那一行**重建 DTO 再推一次，那条带着 `recalledAt`。
   * 只按 id 去重会把这次撤回态丢掉（虽然 `message.recalled` 通常会先到，但那是
   * 两条独立事件，不构成保证）。
   */
  if (media.recalledAt === null || existing.recalledAt !== null) return previous
  const next = [...previous]
  next[index] = media
  return next
}

/**
 * 把一条**实时推送**的消息并入消息流（与 `mergePushedMedia` 同一手法，文本侧）。
 *
 * 去重的两个来源（#89 就埋了这条注释：服务端「先落库、再推送、再回 HTTP」）：
 * - 自己这条的 HTTP 响应与实时推送赛跑，谁先到都只落一次；
 * - 推送本身不保证不重。
 *
 * **撤回必须前进**：同 id 已在流里、而推送这条带着 `recalledAt`（对方撤回了）时，
 * 不能按「同 id 保留本地」丢掉 —— 那会让撤回碑永远不出现（本页没有别的刷新路径会
 * 修好它：20s 详情轮询只补读位与在线态，不刷消息流）。其余情况返回原数组本身，
 * 让 React 省掉一次白重渲染。
 */
export function mergePushedMessage(previous: MessageDto[], message: MessageDto): MessageDto[] {
  const index = previous.findIndex((item) => item.id === message.id)
  if (index === -1) return sortMessages([...previous, message])
  const existing = previous[index]
  if (existing === undefined) return previous
  // 本地已是撤回碑 / 推送也没带撤回：无新信息，保持原引用
  if (message.recalledAt === null || existing.recalledAt !== null) return previous
  const next = [...previous]
  next[index] = message
  return next
}

/**
 * 撤回落到**媒体**那条流（`message.recalled` 推送的媒体侧对应物）。
 *
 * 媒体与文本是两条独立的流（独立端点、独立游标、独立事件），而服务端撤回端点对
 * TEXT / MEDIA 用的是同一张 `messages` 表、没有类型过滤（`messages/store.ts` 的
 * `recall`），推送也只带 `messageId` —— 不落到这里的话，对方撤回一张图 / 一段语音时
 * 小程序端的气泡纹丝不动（`applyRecalled` 只扫 `messages`），而且**刷新也修不回来**：
 * 媒体渲染分支此前不看 `recalledAt`，服务端下发的空 url 仍会被画成占位块。
 *
 * 与服务端读侧同口径地清掉 `url`（撤回后不下发字节，客户端不该再去下载）；其余字段
 * 留着不影响渲染 —— 撤回碑只读 `recalledAt` / `senderId`。
 */
export function applyMediaRecalled(
  items: MediaMessageDto[],
  messageId: string,
  recalledAt: string,
): MediaMessageDto[] {
  // 没有命中的条目时返回原引用：文本消息的撤回也会走到这里（撤回端点不分类型），
  // 每次白建一个新数组会让依赖 `media` 的自动下载 effect 白跑一轮。
  if (!items.some((item) => item.id === messageId && item.recalledAt === null)) return items
  return items.map((item) => (item.id === messageId ? { ...item, url: '', recalledAt } : item))
}

/**
 * 被引用的那条撤回后，把其它消息/媒体/待发条目上的引用摘引同步改成「已撤回」。
 *
 * 服务端在每次读 `replyTo` 时都会按目标当前状态重算（`reply.ts` 的 `toReply`），
 * 但客户端不重新拉取就不会更新；撤回是本地立即落碑的，引用条也不能落后到下次刷新。
 * 没有命中时返回原引用，避免白触发一轮渲染。
 */
export function applyReplyRecalled<T extends { replyTo?: { id: string; excerpt: string } | null }>(
  items: T[],
  messageId: string,
): T[] {
  if (!items.some((item) => item.replyTo?.id === messageId)) return items
  return items.map((item) =>
    item.replyTo?.id === messageId
      ? { ...item, replyTo: { ...item.replyTo, excerpt: '[消息已撤回]' } }
      : item,
  )
}

/**
 * 撤回不可回退：快照里「还没撤回」的那条不能把本地刚落地的媒体撤回碑写回正文
 * （`keepRecalledTombstones` 的媒体侧对应物）。
 *
 * 服务端的 `recalled_at` 同样是单调的（`UPDATE … SET recalled_at = COALESCE(...)`），
 * 所以「本地已落碑、快照说没撤回」只可能是快照拍得更早。只保留 `recalledAt` 与空 url，
 * 其余字段仍取快照那份（尺寸 / 时长等服务端权威值）。
 */
export function keepRecalledMediaTombstones(
  previous: readonly MediaMessageDto[],
  incoming: readonly MediaMessageDto[],
): MediaMessageDto[] {
  const recalled = new Map<string, MediaMessageDto>()
  for (const item of previous) {
    if (item.recalledAt !== null) recalled.set(item.id, item)
  }
  if (recalled.size === 0) return [...incoming]
  return incoming.map((item) => {
    if (item.recalledAt !== null) return item
    const local = recalled.get(item.id)
    if (!local) return item
    return { ...item, url: '', recalledAt: local.recalledAt }
  })
}

/**
 * 刷新落地时把媒体快照合并回已有媒体流。
 *
 * 与 `mergeRefreshedMessages` 同一理由（见上方长注释）：媒体列表的响应同样可能
 * 早于「本次刷新期间才上传成功 / 才推送进来的那条媒体」，无条件覆盖会把刚发出去的照片抹掉。
 */
export function mergeRefreshedMedia(
  previous: MediaMessageDto[],
  incoming: MediaMessageDto[],
  baseIds: ReadonlySet<string>,
): MediaMessageDto[] {
  const seen = new Set(incoming.map((item) => item.id))
  const oldest = oldestOf(incoming)
  const carried: MediaMessageDto[] = []
  for (const item of previous) {
    if (seen.has(item.id)) continue
    if (isBeforeSnapshotWindow(item, oldest)) {
      seen.add(item.id)
      carried.push(item)
      continue
    }
    if (baseIds.has(item.id)) continue
    seen.add(item.id)
    carried.push(item)
  }
  return sortMessages([...incoming, ...carried])
}

/** 与 `sortMessages` 同口径的先后比较：`(createdAt, id)` */
function isOlderThan(
  item: { id: string; createdAt: string },
  other: { id: string; createdAt: string },
): boolean {
  const at = Date.parse(item.createdAt)
  const bt = Date.parse(other.createdAt)
  if (at !== bt) return at < bt
  return item.id < other.id
}

/** 快照里最旧的那一条；空快照返回 `null`（当作「没有窗口」，不据此保留历史） */
function oldestOf<T extends { id: string; createdAt: string }>(items: readonly T[]): T | null {
  let oldest: T | null = null
  for (const item of items) {
    if (oldest === null || isOlderThan(item, oldest)) oldest = item
  }
  return oldest
}

/**
 * 条目是否落在快照窗口**之外（更早一侧）**，从而必须在刷新合并时保留（#610）。
 *
 * 边界只能用 DTO 的 `createdAt`：服务端按**微秒**排序，序列化成 ISO 字符串后只剩
 * **毫秒**。快照最旧那条与更早页尾部同毫秒时，客户端只能退化成 id 字典序，而 UUIDv7
 * 同毫秒尾部是随机的，可能把仍属更早页的条目判进窗口内。**单条消息不做硬删**（服务端
 * 只更新 `recalled_at`；整会话随商品删除时由 `messages → conversations` 的级联外键物理
 * 删除，那时页面整体失效），所以「同毫秒但不在快照里」的条目只可能来自更早页 —— 一律
 * 按保留处理。窗口内被撤回的条目仍会由服务端快照返回，由 `seen` 取快照版本覆盖。
 *
 * **保留区不参与后续快照校正**：刷新只拉第一页，保留下来的更早页不会再被 `load()` 校正
 * —— 其中的「对方撤回」只能靠实时通道（`message.recalled` 走 `applyRecalled`，按 id
 * 命中、不区分条目来自哪一页）收回来；实时断线期间发生的撤回要等用户离开重进本页才会
 * 消失。改合并语义前先确认「单条消息不做硬删」这条还成立。
 */
function isBeforeSnapshotWindow(
  item: { id: string; createdAt: string },
  oldest: { id: string; createdAt: string } | null,
): boolean {
  if (oldest === null) return false
  return Date.parse(item.createdAt) <= Date.parse(oldest.createdAt)
}

/**
 * 这次刷新落地后，是否应**沿用现有分页游标**（#610）。
 *
 * 组件据此决定能不能用快照的游标顶掉现有游标。返回 `true` 的条件是「快照与已加载窗口
 * 有交集，且保留了比快照更早的条目」：此时现有游标仍指向「我们最旧那条之前」，顶掉就会
 * 退回第一页游标、下次上翻重拉同一页。其余情况返回 `false`：
 * - 空快照（没有窗口，照旧按 `baseIds` 清）；
 * - 没有更早条目（列表最旧就是快照最旧）；
 * - 快照与已加载窗口**无交集**（原因见下）。
 */
export function keepsEarlierPages(
  previous: readonly { id: string; createdAt: string }[],
  incoming: readonly { id: string; createdAt: string }[],
): boolean {
  const oldest = oldestOf(incoming)
  if (oldest === null) return false
  const incomingIds = new Set(incoming.map((item) => item.id))
  /**
   * 快照与已加载窗口**没有交集**：刷新期间新增的消息超过一页（断线重连 / 长时间后台），
   * 两者之间隔着一段没加载过的空洞。旧游标只能继续往更早翻，补不到空洞；此时必须让
   * 快照游标接管（它指向快照最旧一条之前），用户下次上翻时由 `mergeEarlierMessages`
   * 去重后逐页把空洞补齐。
   */
  if (!previous.some((item) => incomingIds.has(item.id))) return false
  return previous.some((item) => !incomingIds.has(item.id) && isBeforeSnapshotWindow(item, oldest))
}

/**
 * 刷新落地后要写入的分页游标（#610）。
 *
 * 抽成可执行函数而不是在页面里写 `if`：判据层只能证明「该不该守」，这里把**写入的值**
 * 也钉进单测（沿用现有游标 / 采用快照游标两种结果），避免守卫写在不可达分支里也能
 * 通过文本断言。
 */
export function cursorAfterRefresh(
  current: string | null,
  previous: readonly { id: string; createdAt: string }[],
  incoming: readonly { id: string; createdAt: string }[],
  snapshot: string | null,
): string | null {
  return keepsEarlierPages(previous, incoming) ? current : snapshot
}

/**
 * 刷新落地时把新快照合并回已有消息流（#186 P2-1；#89 起 silent 与整页重拉共用一条）。
 *
 * 刷新的快照**可能早于本次刷新期间才落地的消息** —— HTTP 响应顺序无法保证：
 * `POST /messages` 先落库并 resolve，补刷新的请求后到，手里却是发送之前的快照；
 * 实时推送送来的对方消息同理。此时无条件 `setMessages(page.items)`
 * 会把那条已经确认的消息抹掉，用户看到自己刚发出去的话消失，下一次刷新又冒出来。
 *
 * 合并规则（`baseIds` = 本次刷新**发起时**消息流里的 id 快照）：
 * - 以服务端快照为准：它可能包含对方刚发来的新消息，也可能修正本地顺序；
 * - **比快照最旧一条更早**的旧条目一律保留（#610）—— 快照只含第一页，永远不会带回
 *   用户已经翻过的更早页；同毫秒按保留处理，理由见 `isBeforeSnapshotWindow`；
 * - 额外保留 `baseIds` 之外、且不在快照里的消息 —— 那些是刷新发起**之后**才确认
 *   落地的（本地乐观气泡被服务端返回替换的那一刻）；
 * - 落在快照窗口内、又在 `baseIds` 里的旧条目仍以快照为准（服务端不再返回 = 已删除）；
 * - 按 id 去重后交给 `sortMessages` 定序，实时推送送来的同一条不会重复。
 */
export function mergeRefreshedMessages(
  previous: MessageDto[],
  incoming: MessageDto[],
  baseIds: ReadonlySet<string>,
): MessageDto[] {
  const seen = new Set(incoming.map((item) => item.id))
  const oldest = oldestOf(incoming)
  const carried: MessageDto[] = []
  for (const item of previous) {
    if (seen.has(item.id)) continue
    if (isBeforeSnapshotWindow(item, oldest)) {
      seen.add(item.id)
      carried.push(item)
      continue
    }
    if (baseIds.has(item.id)) continue
    seen.add(item.id)
    carried.push(item)
  }
  return sortMessages([...incoming, ...carried])
}

/**
 * 把「更早一页」并入消息流（`loadEarlier` 的落地口径）。
 *
 * 抽成纯函数是为了让「同一页被取回两次会不会重复」有用例守着：分页与整页刷新**共用同一个
 * epoch**，所以刷新在途期间翻的一页不会被判过期 —— 那一页先落地、刷新随后把 `nextCursor`
 * 写回首屏游标，用户再翻取回的就是同一个游标，同一条消息会第二次进流。
 * 媒体那一侧一直走 `mergeRefreshedMedia`（本来就是并集），文本这一侧此前是裸拼接。
 */
export function mergeEarlierMessages(previous: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const seen = new Set(incoming.map((item) => item.id))
  const carried = previous.filter((item) => !seen.has(item.id))
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
 * silent 补刷）都可能带着撤回前的快照回来 —— 合并落地时正文会被写回去，
 * 用户看到「撤回成功了、一刷新又回来了」。
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
 *
 * **在线态本身也可能更旧**（第二轮审查）：`presence.changed` 推送会在两跳轮询之间
 * 把「刚刚活跃」的时刻往前推，而那一跳的响应可能是在推送**之前**拍的快照 ——
 * 照单全收会让刚点亮的绿点灭回去（要等下一跳才纠正）。所以这里再比一次
 * `lastActiveAt`：快照比屏幕上那份**更早**就丢弃（相等仍采信，那是 TTL 过期后
 * 「在线 → 离线」的正常落点）。
 */
export function applyPresencePoll(
  previous: ConversationDto,
  incoming: ConversationDto,
): ConversationDto {
  if (isOlderPresence(incoming.counterpartPresence, previous.counterpartPresence)) return previous
  return { ...previous, counterpartPresence: incoming.counterpartPresence }
}

/** 候选的在线态是否比现有的更旧（只看 `lastActiveAt`，解析不了时不当「更旧」） */
function isOlderPresence(candidate: UserPresence, current: UserPresence): boolean {
  if (candidate.lastActiveAt === null || current.lastActiveAt === null) return false
  const next = Date.parse(candidate.lastActiveAt)
  const now = Date.parse(current.lastActiveAt)
  if (Number.isNaN(next) || Number.isNaN(now)) return false
  return next < now
}

/**
 * 实时推送的 `presence.changed` 落地：只写**命中对方**的那次，其余字段不动
 * （与 `applyPresencePoll` 的限定同一理由 —— 推送里没有整份详情，本来也写不了）。
 *
 * 不命中（别的用户上线，比如对方之外的会话对象）返回原引用，不白重渲染。
 * 服务端只推「离线→在线」的转变；「在线→离线」由 20s 详情轮询按同一个 TTL
 * （`PRESENCE_ONLINE_TTL_MS`）在本地过期 —— 两条路径缺一不可。
 */
export function applyPresenceEvent(
  conversation: ConversationDto,
  userId: string,
  presence: UserPresence,
): ConversationDto {
  if (conversation.counterpart.id !== userId) return conversation
  return { ...conversation, counterpartPresence: presence }
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
 * 页面重新显示时的动作（#608）。
 *
 * `'refresh-silent'` 是**后台刷新**，不是首屏加载：返回本页时屏幕上已经有完整内容，
 * 把 `convState` / `msgState` 打回 `loading` 会让渲染层在 `convState !== 'ok'` 处早退，
 * 整页（顶栏、商品条、消息流、输入栏）被替换成「正在加载会话…」再重建 —— 用户看到的是
 * 闪一下、滚动位置被拽回最新一条、输入栏与键盘状态被重置。详情 / 交易进度 / 消息与媒体
 * 合并 / 已读上报在 silent 分支里一件不少，所以这里**一律走后台刷新**。
 *
 * 三态而不是布尔，是因为取值本身就规定了组件该怎么调 `load()`：
 * - `'none'`：首次显示（让渡给登录态 effect，冷启动不双发）或登录态未就绪，什么都不做；
 * - `'defer'`：有在途发送（文本 sending / 媒体 uploading），此刻重拉会把 `epoch` +1、
 *   在途响应被判过期，乐观气泡永远停在「发送中」——只记待刷新，落定后补（见 `DeferredReload`）；
 * - `'refresh-silent'`：其余情况，`load({ silent: true })`。
 */
export type ShowReloadAction = 'none' | 'defer' | 'refresh-silent'

export function showReloadAction(input: {
  loadedOnce: boolean
  authed: boolean
  hasUserId: boolean
  sending: boolean
}): ShowReloadAction {
  if (input.sending) return 'defer'
  return shouldReloadOnShow(input) ? 'refresh-silent' : 'none'
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
 * 而「会话真的没了」这条不以「没读到」为例外 —— 见下面的 `missing` 分支（#608 审查第 1 条）。
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
  /**
   * `missing` 是**服务端权威结论**（404 `CONVERSATION_NOT_FOUND`：会话已删 / 我已不是参与者，
   * 服务端刻意不区分），不是「没读到」，所以它照常落地 —— 否则后台刷新每确认一次删除都被
   * 当成噪声吞掉，一条已经结束的会话能一直留在屏幕上可用（#608 审查第 1 条）。
   *
   * 只有 `failed`（没读到）才走下面这条「只做确认、不做降级」。
   */
  if (!silent || detail === 'ok' || detail === 'missing') return detail
  return prev === 'ok' ? 'ok' : detail
}

/** 消息流的页面态（`loading` 是页面自己的在途态；其余两个来自 `loadMessagePage`） */
export type MsgState = 'loading' | 'ok' | 'failed'

/**
 * 消息区如何落态：与 `resolveConvState` 同一条「silent 失败只做确认、不做降级」，
 * 但**不能无条件保留原值**。
 *
 * 页面没正常显示过（`loading` / `failed`）时如实落 `failed`：那一次的 `loading` 属于更早
 * 那次首屏请求，而一次 silent 刷新会把 `epoch` +1 让它的响应判过期 —— 响应永远不再落地，
 * 状态就卡在 `loading`，而 `loading` 分支（`index.tsx` 的「正在加载消息…」）**没有重试入口**，
 * 用户只能退页重进（#608 审查第 3 条）。屏幕上已有消息（`ok`）才保留，别把整屏换成错误卡。
 */
export function resolveMsgState(prev: MsgState, pageFailed: boolean, silent: boolean): MsgState {
  if (silent && pageFailed) return prev === 'ok' ? 'ok' : 'failed'
  return pageFailed ? 'failed' : 'ok'
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
 * 可被引用/撤回的两条服务端 DTO 流（#518）：文本消息与媒体消息。
 * 两者都带 `id` / `senderId` / `recalledAt` / `createdAt`，菜单判据才能复用。
 */
export type ReplyTarget = MessageDto | MediaMessageDto

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
  message: Readonly<{
    senderId: string | null
    recalledAt: string | null
    createdAt: string
  }>,
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

/**
 * 媒体消息的长按菜单（#518）：图片/语音没有可复制的正文，未撤回时只给「引用」，
 * 自己的且仍在窗口内再给「撤回」。判据复用 `canRecallMessage`，不另写一套。
 */
export function mediaActions(
  media: MediaMessageDto,
  meId: string | null,
  nowMs: number,
  windowMs: number,
): MessageAction[] {
  if (media.recalledAt !== null) return []
  const actions: MessageAction[] = ['reply']
  if (canRecallMessage(media, meId, nowMs, windowMs)) actions.push('recall')
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
 * 已撤回 `[消息已撤回]`、媒体 `[媒体]`、商品卡 `[商品]`、空文本 `[消息]`、
 * 超长截断到 120 字含省略号。本地这份**只影响观感**：发送成功后气泡会换成
 * 服务端回的那条（含权威 `replyTo`）。
 */
export function localReplyExcerpt(message: ReplyTarget): string {
  if (message.recalledAt !== null) return '[消息已撤回]'
  // 媒体 DTO 没有 content/type：按 kind 区分，避免读 undefined.trim()。
  if ('kind' in message) return '[媒体]'
  if (message.type === 'LISTING') return '[商品]'
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

/**
 * 「贴底」判定的容差（设备 px，与 `ScrollView.onScroll` 的刻度同口径）。
 *
 * 留一点余量：`autoHeight` 输入框长高、语音/键盘两态输入栏高度差、iOS 的取整都会让
 * 底部差上几个 px，这一档必须仍算贴底 —— 否则用户明明看着最新一条，面板一开合却不跟着
 * 重指尾行（#561 的「跳回顶部」）。
 *
 * **这只是常驻基线**：多行输入能造成几十 px 的视口缩量（≥ 本值），但那部分要由调用方按
 * 「自己刚刚造成的几何变化」临时放宽（见 `isNearBottom` 的 `slack` 参数）。不能把基线
 * 本身抬高 —— 抬高等于「翻历史翻到近底也算贴底」，会把人拽回底部。
 */
export const BOTTOM_SLACK_PX = 24

/**
 * 「+」面板自身内容的几何（rpx，#597 追加任务）。
 *
 * 面板高度**不再等于键盘高度**：三格图标的实际内容只有这么高，按「上次键盘高」撑开会把
 * 下方一大片留成空白（Owner 在演示截图里提的「展开后下方位置太空了」）。面板高度改为
 * 「内容自己多高就多高」，与键盘彻底解耦 —— 代价是键盘 ↔ 面板切换时底部底座会**一次**
 * 变高/变矮（差一个「键盘高 − 面板高」）。这是有意的取舍：宁可让消息流一次性让位，
 * 也不要留一片空面板。
 *
 * 四个数是 `index.scss` 的真源，改 scss 必须同步改这里（单测钉住两边一致）：
 * - `PANEL_PADDING_RPX`：`.conv__panel` 的 `padding: 24px 28px calc(24px + env(...))` 上下两段
 * - `PANEL_DISC_RPX`：`.conv__ptile-disc` 的 `width/height: 104px`
 * - `PANEL_TILE_GAP_RPX`：`.conv__ptile` 的 `gap: 12px`（圆钮与文字之间）
 * - `PANEL_LABEL_RPX`：`.conv__ptile-label` 的**行盒**高度，即 `line-height: 30px`
 *   （字号 22px 配 1.36 倍行距）。这一条**必须由 scss 写死**：不写 `line-height` 时行盒落在
 *   `normal` 上，实际高度取决于端上字体（iOS 苹方 / 安卓各一套），1.36 倍只是个估值 ——
 *   那这里算出来的就不是「面板真实高度」，让位带上方那条 16px 缝隙剩多少全看机型。
 */
export const PANEL_PADDING_RPX = 48
export const PANEL_DISC_RPX = 104
export const PANEL_TILE_GAP_RPX = 12
export const PANEL_LABEL_RPX = 30

/** 「+」面板的内容高度（rpx）= 上下内边距 + 圆钮 + 间隙 + 一行文字 */
export const PANEL_CONTENT_RPX =
  PANEL_PADDING_RPX + PANEL_DISC_RPX + PANEL_TILE_GAP_RPX + PANEL_LABEL_RPX

/**
 * 面板该给自己留多高（设备 px，#597 追加任务）：内容高度（rpx 换算）+ 底部安全区。
 *
 * `designWidth = 750`，所以 scss 里的 `1px` 就是 `1rpx`，rpx → 设备 px 只差一个
 * `windowWidth / 750`（375 宽的屏上 194rpx ≈ 97px）。
 *
 * 为什么把安全区加进来：`.conv__panel` 自己的 `padding-bottom` 里带
 * `env(safe-area-inset-bottom)`，面板真的会比「纯内容」高出一条安全区。底座让给它的
 * 高度必须把这条算进去，否则面板会盖到输入行上。
 */
export function resolvePanelHeightPx(input: {
  windowWidth: number
  safeAreaBottom: number
}): number {
  const { windowWidth, safeAreaBottom } = input
  // 量不到窗口宽度时按 375 宽（750 的一半）估，别让 rpx 换算退化成 0
  const scale = windowWidth > 0 ? windowWidth / 750 : 0.5
  return Math.round(PANEL_CONTENT_RPX * scale) + Math.max(0, Math.round(safeAreaBottom))
}

/**
 * 底部底座用什么高度（设备 px，#597）—— 键盘与「+」面板**互斥**，谁在场就用谁的。
 *
 * 面板展开时**不看** `keyboardHeight`：那一刻键盘正在收起（平台事件一路单调递减），
 * 用它的中间值会把底部底座连着改好几次，消息流就跟着抖好几次。面板高度在渲染当拍就是
 * 终值（`resolvePanelHeightPx` 从内容算出来，见上），所以底部高度**一次**到位、之后不再变。
 *
 * 收起面板时回到 `keyboardHeight`：键盘本来就没开就是 0（内联样式整段不写 ——
 * `resolveBottomReserveStyles` 那一路让 `.conv__bottom` 自己的 `env(safe-area-inset-bottom)`
 * 生效，安全区在收起态只由底座算这一次）。
 */
export function resolveBottomInset(input: {
  panelOpen: boolean
  keyboardHeight: number
  panelHeight: number
}): number {
  const { panelOpen, keyboardHeight, panelHeight } = input
  if (!panelOpen) return Math.max(0, keyboardHeight)
  return Math.max(0, panelHeight)
}

/**
 * 输入行上下基础间距（rpx，#577）。
 *
 * 与 `index.scss` 里的 `$bar-gap-px` **必须是同一个数**（有单测钉住两边相等）：
 * 样式表拿它写输入栏收起态的内边距，这里拿它拼占用态的内联 `calc()`，两边不一致就是
 * 「键盘开着和收起时输入行上下的留白不一样」。
 */
export const BAR_GAP_RPX = 16

/**
 * 底部底座让高的样式（#577）：底部保留量只由**一个占用者**决定，安全区只算一次。
 *
 * 收起态返回 `undefined`，让样式表里 `.conv__bottom` 的 `env(safe-area-inset-bottom)` 生效
 * —— **不能**返回 `'0px'`，那等于把安全区清零，iOS 上控件直接坐进 home indicator。
 * #577 明确要保留必要手势区，不为「三端视觉等距」把它抹掉。
 *
 * 占用态（键盘 / 「+」面板）要同时做两件事：
 * - **底座的内边距清零**：占用者自己已经把屏幕底部那块高度占了（键盘高度本身就覆盖了
 *   home indicator 区），底座再留一份安全区就是第二次计数 —— 端上表现为「输入栏离键盘上沿
 *   还空一条」，正是 #577 第 5 条要消的空白；
 * - **输入栏下内边距 = 占位高度 + 基础间距**。占位高度是运行期量到的设备 px，只能内联
 *   （内联不过 pxtransform，先例见 `components/back-top/index.tsx`）；基础间距按 rpx 写，
 *   与样式表的 `$bar-gap-px` 同源。
 *
 * 这个函数只认「占位高度」这一个入参，**不关心谁在占用**：键盘态与面板态给出的是同一种
 * 字符串形态（只是数值不同）。#597 追加任务之后面板高不再等于键盘高（面板按内容撑开），
 * 两种占用态之间切换时底座会**一次**变高/变矮（差一个「键盘高 − 面板高」）—— 那是 #597 的
 * 有意取舍，这里不掺和，也不在样式层补第二个补偿。
 */
export interface BottomReserveStyles {
  /** 底部底座（`.conv__bottom`）的内联样式：占用态把安全区内衬让出来 */
  bottom: { paddingBottom: string } | undefined
  /** 输入栏（`.conv__bar`）的内联样式：占用态的下内边距 */
  bar: { paddingBottom: string } | undefined
}

export function resolveBottomReserveStyles(bottomInset: number): BottomReserveStyles {
  if (!(bottomInset > 0)) return { bottom: undefined, bar: undefined }
  return {
    bottom: { paddingBottom: '0px' },
    bar: { paddingBottom: `calc(${bottomInset}px + ${BAR_GAP_RPX}rpx)` },
  }
}

/**
 * 这一帧键盘上报是不是「新占用者到了」——**面板 → 键盘**的交接判据（#597）。
 *
 * 面板展开时点输入框，底部那块高度在换占用者：面板让位、键盘接上。但新占用者要等**真落地
 * 那一帧**才认，否则底座会先塌空一次（`resolveBottomInset` 那一刻只能拿到还没落地的键盘高度）。
 *
 * 三条缺一不可：
 * - 面板开着：没面板就没有交接；
 * - 这一帧不是**收键盘动画**（`closing`）：动画里每帧高度都 `> 0`，可那是**旧占用者在退场**。
 *   把它当成新键盘到了，就会出现「键盘开着点『+』，面板约 40ms 就自己消失」—— 点「+」当拍
 *   走过 `collapseKeyboard()`，平台接着把收键盘拆成若干递减帧（#560 的既有前提）；
 * - 高度 `> 0`：真落地了。
 *
 * `closing` 由 `nextKeyboardInset` 维护（意图闩 + 尾巴窗口），这里只做判据，不自己维护第二条
 * 状态链 —— 判据必须在纯函数里，否则「回滚这一行」在源码钉桩之外没人能测出来。
 */
export function shouldHandOffToKeyboard(input: {
  panelOpen: boolean
  closing: boolean
  inset: number
}): boolean {
  const { panelOpen, closing, inset } = input
  if (!panelOpen) return false
  if (closing) return false
  return inset > 0
}

/** 点击与拖动的分界（设备 px）：松手时位移超出它就算「用户在滚动」，不算点击 */
export const PANEL_DISMISS_TAP_SLOP_PX = 8

/**
 * 一次松手算不算「点了一下消息区」（设备 px）。
 *
 * 面板展开时靠消息流的触摸收起它（#541/#597），但收起**不能挂在触摸开始上**：手指一落下
 * 就是滚动的第一帧，那一刻收面板等于「面板展开期间滑不动」—— 底座从面板高缩回 0，消息流
 * 在手指还没动起来时被撑高一条面板，正是 #597 现象二与现象一叠在一起。所以判据落在**松手**
 * 那一拍：位移在容差内才算点击（收起），拖动就交给 ScrollView 照常滚动。
 *
 * 容差按单轴给：一次点击的抖动是两个方向各几 px，取两轴都不过阈值就够了，不必算欧氏距离
 * （斜着拖 6+6 也正是「有意图的拖动」）。取不到坐标（老基础库 / 事件被吞）时一律返回 `false`
 * —— 拿不到起点就不许收，宁可这一次点空白没反应，也不能把滚动误判成点击。
 */
export function isPanelDismissTap(
  start: { x: number; y: number } | null,
  end: { x: number; y: number } | null,
): boolean {
  if (!start || !end) return false
  // NaN（取不到触点）参与比较恒为 false，这里要的是「不许据此收面板」，正好一致
  return (
    Math.abs(end.x - start.x) <= PANEL_DISMISS_TAP_SLOP_PX &&
    Math.abs(end.y - start.y) <= PANEL_DISMISS_TAP_SLOP_PX
  )
}

/**
 * 消息流此刻是不是贴着底部（#561）。
 *
 * `onScroll` 的 `detail` 只有 `scrollTop` / `scrollHeight`，**不含视口高度**，所以视口要
 * 自己量一次再传进来；判据就是「视口下沿离内容下沿还差多少」。
 *
 * `slack` 由调用方给：几何刚变过（键盘升降、面板开合、输入框长高等）时，视口缩量还没和
 * 滚动事件对齐，事件里可能读到「旧 scrollTop + 新 scrollHeight」这类中间态，底部差会临时
 * 偏大 —— 那段偏差是本页自己造成的，必须容忍；否则一次多行切换就把「贴底」判成「翻历史」，
 * 之后再也不会重锚（#560 说的「多行输入后再切更明显」）。
 *
 * 视口还没量到（`0`）时按贴底处理：页面本来就是打开即贴底，此时量测通常只差一帧；
 * 而误判成「没贴底」的代价是把 #561 原样还回去（偏移丢了没人重指），误判成「贴底」
 * 最多是多滚一次「本来就在底部」的底。取舍偏向后者。
 */
export function isNearBottom(
  input: {
    scrollTop: number
    scrollHeight: number
    viewportHeight: number
  },
  slack: number = BOTTOM_SLACK_PX,
): boolean {
  const { scrollTop, scrollHeight, viewportHeight } = input
  if (viewportHeight <= 0) return true
  // 内容不足一屏：没有可滚的，恒贴底
  if (scrollHeight <= viewportHeight) return true
  return scrollHeight - scrollTop - viewportHeight <= slack
}

/**
 * `onScroll` 之后「用户是不是还贴着底」—— 与 `isNearBottom` 的结果**恒等**（#561）。
 *
 * 这层直白的转发是有意留下的：贴底标志决定「几何变化时要不要重指尾行」，取值反过来就是
 * 把翻历史的人拽回底部、同时让贴底的人再也回不去 —— 两种错在端上都只表现为「有时候跳
 * 一下」，审阅与演示都很难稳定复现。抽成具名纯函数后，「取反」这类改动必然踩红表驱动
 * 单测，而不是安静地生效。
 */
export function stickAfterScroll(nearBottom: boolean): boolean {
  return nearBottom
}

/**
 * 几何变了、回读出来的偏移掉回了顶部：这一跳该怎么补（#561）。
 *
 * 返回的是**动作**而不是动作名：`restore` 要把哪个值写回去也在里面，页面只负责执行副作用
 * —— 决策留在组件里，「算出来的值用错了」这类改动谁都看不见（`top` 与 `prevTop` 写反，
 * 复位就变成一次空操作）。
 *
 * - `none`：偏移没丢（或丢的那次是原生层按**新**几何做的正常截断）→ 什么都不做；
 * - `anchor`：贴底态 → 换一个同位锚点再指一次尾行；
 * - `restore`：翻历史态 → 把几何变化前的 `scrollTop` 原值写回去。
 *
 * 只有「原本不在顶部、现在掉到顶部」算丢失：视口变矮 / 内容变短都会让 `scrollTop` 变小，
 * 那是原生层的正常截断，硬写回旧值反而会把页面按到越界位置。
 *
 * `prevTop <= 容差` 但**贴底**时仍按丢失处理：进页面就停在底部、一次没手动滚过的用户，
 * `scrollTopRef` 一直是初值 0，若按「原本在顶部」放过，回读补偿对这些人一次都不执行 ——
 * 而他们恰恰是「跟着最新消息」的常态用户。翻历史的人必然滚过，`prevTop` 不会停在 0。
 */
export type ScrollFix = { kind: 'none' } | { kind: 'anchor' } | { kind: 'restore'; top: number }

export function planScrollFix(input: { prevTop: number; top: number; stick: boolean }): ScrollFix {
  const { prevTop, top, stick } = input
  // 量不到就是 `undefined`，但也可能是 `NaN`（`typeof NaN === 'number'`，光判类型挡不住）
  if (!Number.isFinite(top)) return { kind: 'none' }
  // 偏移还在顶部之外：没丢
  if (top > BOTTOM_SLACK_PX) return { kind: 'none' }
  // 原本在中部 / 底部、现在掉到顶部 = 原生层把偏移丢了
  if (prevTop > BOTTOM_SLACK_PX) {
    return stick ? { kind: 'anchor' } : { kind: 'restore', top: prevTop }
  }
  // 观测量不可用（进页面就在底部 / 刚翻完锚点还没回写）：贴底态掉回顶部只可能是丢了
  return stick ? { kind: 'anchor' } : { kind: 'none' }
}

/**
 * 输入行变高时该给贴底判据留多少余量（#560/#561）。
 *
 * **累加**，不覆盖：原生层那次截断滚动反映的是相对**单行基线**的累计缩量，而打字是一行
 * 一行涨的（每行只报 30 来 px）。只留最后一次增量的话，两行以上就被判成「用户在翻历史」
 * —— 之后切态 / 开面板的重锚全被贴底守卫挡掉，最新一条压在视口外回不来（#561 原症状）。
 *
 * 缩回去（删行、`autoHeight` 回落）要**收**：余量只增不减就再也降不下来，用户上翻的距离
 * 不到余量那么多时仍被判成贴底，随后的重锚会把他从历史里拽回底部（#561 验收第一条）。
 * 收到 0 为止；`prevInputPx <= 0` 表示还没量到或刚清空，此时的 `nextInputPx` 是单行基线，
 * 不是让出的高度，不动。
 */
export function growBottomAllowance(input: {
  allowance: number
  prevInputPx: number
  nextInputPx: number
}): number {
  const { allowance, prevInputPx, nextInputPx } = input
  if (!(prevInputPx > 0) || !(nextInputPx > 0)) return allowance
  const grownBy = nextInputPx - prevInputPx
  if (grownBy === 0) return allowance
  return Math.max(0, allowance + grownBy)
}

/**
 * 把几何量测到的视口缩量并进余量（#560/#561）：**取大**，不覆盖。
 *
 * 与 `growBottomAllowance` 的累加互补 —— 量测是事后的一帧，布局没落定时可能报 0；
 * 直接覆盖会把 `onLineChange` 刚记下的增量清零，而原生那次滚动事件正好在这之后到达。
 * 首次量测（`prevViewport <= 0`）没有可比对象，算出来会是整个视口高，等于一次放到最松。
 *
 * **面板开合那一次不记账**（`panelTransition`，#597）：那是用户主动切换底部底座，
 * 不是内容长高。把它记进容差等于把「贴底」判据一次性放宽到面板那么高 —— 用户明明在
 * 翻历史，下一次开面板却被判成贴底，尾行锚点一翻就把他拽到底（#597 现象三）。
 * 归零而不是「保持原值」：切换这一刻几何是全新的，判据应当回到最严格的那一档。
 */
export function mergeViewportShrink(input: {
  allowance: number
  prevViewport: number
  nextViewport: number
  /** 这次量测是不是「面板开合」引起的几何变化 */
  panelTransition?: boolean
}): number {
  const { allowance, prevViewport, nextViewport, panelTransition } = input
  if (panelTransition) return 0
  if (!(prevViewport > 0) || !(nextViewport > 0)) return allowance
  const shrunkBy = prevViewport - nextViewport
  if (shrunkBy <= 0) return allowance
  return Math.max(allowance, shrunkBy)
}

/**
 * 收尾尾巴的迟滞窗口（ms，R3）：部分机型报完 `0` 之后还会补一帧动画尾巴（一个非 0 的小高度）。
 * 零迟滞照收就是「先上提、再回落」原样复发，所以收完之后的短窗口内、比收完时更矮的值一律丢弃。
 * 只在这个窗口内生效（不是永久忽略），窗口外照收 —— 用户真的又开键盘必须跟得上。
 */
export const KEYBOARD_TAIL_WINDOW_MS = 400

/** 键盘高度阶梯的完整状态（`nextKeyboardInset` 的输入与输出同构，逐字段回写即可） */
export type KeyboardInsetState = {
  /** 已经落地的键盘高度（设备 px，0 = 收起） */
  inset: number
  /** 是否处在「本页要求收起、等平台收完」的过程中（意图闩） */
  closing: boolean
  /** 这次收起是从多高开始的（0 = 没记，判「键盘又被开回来」用） */
  closingFrom: number
  /** 上一次收完时的高度基准（0 = 没记，判收尾尾巴用） */
  closedFrom: number
  /** 上一次收完的时刻（ms，0 = 没记） */
  closedAt: number
  /** 收起途中连续有几帧报到了 `>= closingFrom`（要连两帧才认作「键盘真被开回来」） */
  aboveFrom: number
  /**
   * 被丢弃但**值得留着**的候选高度（0 = 没有）。
   *
   * 两帧制会丢掉第一帧越过 `closingFrom` 的上报，而安卓上「终值只报一次」是常见形态
   * （`[200, 340]` 之后平台就不再上报）：那一帧就是真高度，扔了就只能停在 200，而真键盘在
   * 340 —— 输入栏被盖住 140px，且整个编辑会话都停在那儿（重开键盘不会重报同一高度）。
   * 所以丢弃时把值记在 `pending` 里，下一次落地或哨兵兜底时取 `Math.max(pending, next)`。
   */
  pending: number
  /** 这次上报是否要求页面落地新高度（false = 丢弃 / 无变化，页面既不改布局也不重指尾行） */
  changed: boolean
}

/**
 * 键盘高度阶梯：把平台报来的高度压成**单调向下**的一串（#560，安卓真机复验）。
 *
 * 输入栏是 100vh 弹性列的最后一个流内块，下内边距直接由键盘高度派生 —— 每写一次高度就是
 * 一次布局变化。安卓上 `hideKeyboard()` 之后系统要动画收键盘，动画期间平台会连着报若干次
 * 递减的中间值（收的过程中还可能再抬一下）。把中间值逐个当终值写进布局，等于用自己的布局
 * 动作去和系统动画拼速度，真机上看到的就是「先上提、再回落」。
 *
 * 关键：**「在收」是意图，不是从高度符号反推的**。安卓上「键盘没关、只是变矮」是常态
 * （切输入法、候选栏展开/收起、手写板），如果拿 `next < prev` 当「开始收起」，一次变矮就会
 * 把闩置上、之后所有变高都被丢弃 —— 内边距停在小值、那把更高的键盘把输入栏整条盖住，且
 * 只能靠彻底收键盘自愈。所以闩只在两个地方置位：页面调 `Taro.hideKeyboard()` 的地方
 * （`closing = true` + 记下当时的 `closingFrom`）。
 *
 * 规则：
 * - 非有限值（`NaN` 之类）：一律不动，交给下一次事件；
 * - `next <= 0`：收完了 —— 唯一能把高度落到 0 的路径（切态、开面板都不许自己归零），闩释放
 *   并记下尾巴窗口起点；
 * - 没有意图闩：跟随平台（开键盘 / 换输入法 / 候选栏伸缩都在这儿），并清掉窗口状态；
 *   唯一的例外是**收尾尾巴**：刚收完的短窗口内报来一个「只有动画残值量级」的值，丢弃；
 * - 意图闩在、但高度 `>= closingFrom`：键盘又被开回来了 —— 要**连续两帧**都成立才认
 *   （`aboveFrom`），单帧越过 `closingFrom` 还可能只是动画抖动；认下来之后闩失效、跟随；
 * - 意图闩在、`next < prev`：跟随（贴着键盘走，只会往下）；
 * - 意图闩在、`next >= prev`：丢弃 —— 同一个动画里不许「先变小又变大」。
 *
 * `changed` 单独给出来，页面用 `if (!step.changed) return` 决定要不要落地：判据在函数里、
 * 页面只执行，就不存在「页面里换个比较对象把阶梯整个废掉」的改法。被丢弃的上报若比当前值
 * 更高，值会留在 `pending` 里，等下一帧落地或哨兵兜底时取用 —— 丢弃的是「立刻落地这个动作」，
 * 不是「这个高度」。
 */
export function nextKeyboardInset(input: {
  prev: number
  next: number
  closing: boolean
  closingFrom: number
  closedFrom: number
  closedAt: number
  aboveFrom: number
  pending: number
  now: number
  tailWindowMs?: number
}): KeyboardInsetState {
  const { prev, next, closing, closingFrom, closedFrom, closedAt, aboveFrom, pending, now } = input
  const tailWindowMs = input.tailWindowMs ?? KEYBOARD_TAIL_WINDOW_MS
  if (!Number.isFinite(next))
    return {
      inset: prev,
      changed: false,
      closing,
      closingFrom,
      closedFrom,
      closedAt,
      aboveFrom,
      pending,
    }
  if (next <= 0) {
    return {
      inset: 0,
      changed: prev !== 0,
      closing: false,
      closingFrom: 0,
      // 收完时的高度基准：本页要求收起的那次用起点，用户自己收的（闩没置上）用上一帧
      closedFrom: closing ? closingFrom : prev,
      closedAt: now,
      aboveFrom: 0,
      pending: 0,
    }
  }
  /**
   * 收尾尾巴（R3，`223b6a68` + 本轮量级修正）：刚收完的短窗口内、报来一个比收完时更矮的值。
   *
   * 光比「更矮」不够 —— 用户收完键盘又点开一把**更矮**的键盘（切输入法、候选栏收起）也是
   * 「更矮」，那是要跟随的真实高度，吞掉它输入栏就被那把键盘盖住。动画残值只可能是**量级上
   * 差得远**的值（几百 px 的键盘只残值几十 px），所以再加一条 `next * 2 < closedFrom`。
   */
  if (!closing && closedAt > 0 && now - closedAt <= tailWindowMs && next * 2 < closedFrom) {
    return {
      inset: prev,
      changed: false,
      closing: false,
      closingFrom: 0,
      closedFrom,
      closedAt,
      aboveFrom: 0,
      pending: 0,
    }
  }
  if (!closing) {
    const landed = Math.max(next, pending)
    return {
      inset: landed,
      changed: landed !== prev,
      closing: false,
      closingFrom: 0,
      closedFrom: 0,
      closedAt: 0,
      aboveFrom: 0,
      pending: 0,
    }
  }
  if (next >= closingFrom) {
    /**
     * 连两帧才认作「键盘真被开回来」（本轮修正）：真重开时平台会把同一高度连着报两次
     * （336→336），端上无感；而收起动画里偶发一帧越过 `closingFrom` 的抖动过不去，
     * 否则那一帧会让输入栏回抬一次。
     *
     * 丢掉的这一帧不扔值：记进 `pending`（见 `KeyboardInsetState.pending` 的注释）。
     */
    const bumped = aboveFrom + 1
    if (bumped < 2) {
      return {
        inset: prev,
        changed: false,
        closing: true,
        closingFrom,
        closedFrom,
        closedAt,
        aboveFrom: bumped,
        pending: Math.max(pending, next),
      }
    }
    const landed = Math.max(pending, next)
    return {
      inset: landed,
      changed: landed !== prev,
      closing: false,
      closingFrom: 0,
      closedFrom: 0,
      closedAt: 0,
      aboveFrom: 0,
      pending: 0,
    }
  }
  if (next < prev)
    return {
      inset: next,
      changed: true,
      closing: true,
      closingFrom,
      closedFrom,
      closedAt,
      aboveFrom: 0,
      pending: 0,
    }
  return {
    inset: prev,
    changed: false,
    closing: true,
    closingFrom,
    closedFrom,
    closedAt,
    aboveFrom: 0,
    pending: Math.max(pending, next),
  }
}

/** 哨兵到点之后要做什么（`resolveSentinel` 的结论） */
export type SentinelPlan = {
  /** 是否要释放「正在收起」的意图闩（到点就无条件释放，闩不能烂在定时器里） */
  releaseLatch: boolean
  /** 要不要落地的键盘高度（= 当前高度表示不动） */
  inset: number
  /** 重新武装的次数（递增表示「这一拍不下结论，再来一个周期」） */
  rearms: number
}

/**
 * 活性哨兵的判定（#560）：`collapseKeyboard()` 之后平台可能一个事件都不给（安卓上收键盘被
 * 打断、或系统根本不报），内边距就会停在键盘还开着的高度上、输入栏被顶到半空。
 *
 * 判据只用**事实 + 意图**，不猜方向：
 * - `focused`（用户此刻仍在输入框里）说明键盘大概率是真开着的 —— 绝不写 0，宁可留个 gap
 *   也不能把输入栏埋到键盘后面；落 `max(seen, pending)`＝平台这一轮报过的最高真实值；
 * - `!focused` 说明用户已经离开输入框、键盘就该走 —— 才可以归零；
 * - 既没上报过、又仍聚焦：这一拍下不了结论，让页面重发一次 `hideKeyboard()` 再一个周期
 *   （`rearms`），最多一次，第二轮到点就接受现状（保持当前高度、释放闩）。
 */
export function resolveSentinel(input: {
  closing: boolean
  seen: number
  pending: number
  height: number
  focused: boolean
  rearms: number
}): SentinelPlan {
  const { closing, seen, pending, height, focused, rearms } = input
  if (!closing) return { releaseLatch: false, inset: height, rearms }
  if (!focused) return { releaseLatch: true, inset: 0, rearms: 0 }
  const reported = Math.max(seen, pending, 0)
  if (reported > 0) return { releaseLatch: true, inset: reported, rearms: 0 }
  if (rearms < 1) return { releaseLatch: true, inset: height, rearms: rearms + 1 }
  return { releaseLatch: true, inset: height, rearms }
}
