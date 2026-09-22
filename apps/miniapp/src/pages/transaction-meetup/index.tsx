import type { MeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import type { MeetupTokenResponse, TransactionDto } from '@fish/contracts/transactions/schema'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import {
  confirmTransaction,
  fetchMeetupTokenStatus,
  fetchTransaction,
  issueMeetupToken,
  redeemMeetupToken,
  verifyMeetupCode,
} from '@/features/transaction/api'
import { qrDataUrl } from '@/features/transaction/qr'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * A2 交易码 / 面交确认（设计稿 `小程序1版transaction-meetup.html`）—— #70 × #114 真实接线。
 *
 * 入口参数（两种，可同时出现）：
 * - `?id=<transactionId>`：从「我的订单」进入。卖家 = 出示方：进页即取码
 *   （#176 起 `POST /meetup-token` 是幂等「确保并读取」——同一笔交易恒为**同一枚**码，
 *   重复取码不换码、不改 `issuedAt`，只清零失败计数与锁定），
 *   展示 6 位码 + 二维码；买家 = 核销方：在本页手动输入对方的 6 位码（6 位码只在
 *   已知 transactionId 的本页输入，全局扫码页不提供无上下文输入），或点「扫码验证」
 *   进扫码页。
 * - `?code=<QR 原文>`：扫码页交付的鱼小应交易码原文，自带 transactionId
 *   （契约 `meetup-qr`），可独立定位交易。扫码页已做形状 gate，此处再解析一次，
 *   解析失败（不该发生）按「无效码」展示。
 *
 * 两个视角（稿 ①）：买家页只有 6 位输入格；卖家页只有 6 位码 + 二维码 + 「请对方用
 * 微信扫码」，没有输入。商品摘要卡两个视角都有，只把对方称谓按视角对调；顶栏标题也
 * 按视角给「输入交易码」/「交易码」。
 *
 * 消费语义（后端 #70 冻结契约）：核销成功 = 买家侧凭证消费 + 卖家面交确认被盖上，
 * 响应 `nextAction: 'CONFIRM_DELIVERY'` —— 本页随后调 confirm；双侧确认齐 →
 * COMPLETED + 商品 SOLD（幂等，重复提交不会重复成交）。
 *
 * 核验态（稿 ③）：点确认后页面进入**只有一个转圈**的核验态，圈里不放任何字。
 * **不照抄稿的 `VERIFY_MS = 1800` 定时器**：真实核验时长 = 网络请求时长。这里由
 * 「请求在飞」驱动，另配一个最短展示时长（`VERIFY_MIN_MS`）避免秒回时闪一下。
 *
 * 恢复口径（审查 P1-2 / 第三轮）：confirm 网络失败后杀进程/离开再进，服务端停在
 * 「sellerConfirmedAt 已盖、buyerConfirmedAt 未盖、token CONSUMED」。注意
 * sellerConfirmedAt 不能单独作为核销证明（Web 端普通 confirm 也会盖它）——
 * 必须再查 GET meetup-token 的 status === CONSUMED 才恢复确认入口；
 * 非 CONSUMED 一律仍要求扫码 / 手输核销。
 *
 * 错误口径逐一对齐后端错误码：INVALID（码不正确）/
 * CONSUMED（已被使用）/ LOCKED（错误次数过多）/ NOT_FOUND（对方还没出码）/
 * NOT_ALLOWED（不能核销自己出示的码）。
 */

/** 核验态最短展示时长：秒回时不闪一下（见文件头「核验态」） */
const VERIFY_MIN_MS = 420

function formatAmount(cents: number): string {
  const yuan = cents / 100
  const text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 「订单创建 3 小时前」式的相对时间（列表行口径，同 fetchers.ts）。 */
function relativeLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const hours = Math.max(0, (now - at) / 3600000)
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 6 位码的显示槽位 / 输入格子：两处都是「位置即身份」，
 * 在模块级生成一次稳定 id，避免拿渲染下标当 key（`noArrayIndexKey`）。
 */
const CODE_SLOTS = [0, 1, 2, 3, 4, 5].map((index) => ({ id: `meetup-digit-${index}`, index }))
const INPUT_CELLS = [0, 1, 2, 3, 4, 5].map((index) => ({ id: `meetup-cell-${index}`, index }))

/** 完成动效的 26 颗粒子：几何全在 SCSS 的 `@for` 里，这里只要稳定 key 与顺序 */
const FX_PARTICLES = Array.from({ length: 26 }, (_, index) => `meetup-fx-p-${index}`)

/** 卖家视角下凭证的渲染态（NONE/CONSUMED 不落在本页：进页即取码） */
type TokenView =
  | { state: 'issuing' }
  | { state: 'ready'; token: MeetupTokenResponse }
  /** 凭证暂不在本页展示（如卖家误扫自己的码收到 NOT_ALLOWED）。
   * #176 起取码幂等、**码值不变**：重新进入本页即可取回同一枚码，
   * 不存在「旧码被换掉」这回事；本页不自动重取，免得把一次核销失败静默变成展示动作。 */
  | { state: 'unavailable' }

/** 完成动效的挂载开关：只在「刚完成」那一刻播一次，静态进入终态不重播 */
type FxPhase = 'off' | 'on'

export default function TransactionMeetup() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  /** 身份驱动 bootstrap（#89 审查收口）：冷启动 `unknown` 时绝不发请求 */
  const userId = user?.id ?? null
  const router = useRouter<{ id?: string; code?: string }>()
  const routeTxId = router.params.id ?? ''
  const routeCode = router.params.code ?? ''

  const [tx, setTx] = useState<TransactionDto | null>(null)
  /** 交易加载失败：notFound = 不存在或非参与者（404，不泄漏）；failed = 网络/服务器 */
  const [loadError, setLoadError] = useState<'notFound' | 'failed' | null>(null)
  const [token, setToken] = useState<TokenView | null>(null)
  const [scannedInvalid, setScannedInvalid] = useState(false)
  /** 手动输入：6 位数字的字符数组，索引即格子位置 */
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  /** 手动输入的错误提示（码错误 / 过期 / 已被使用 / 次数过多），空串表示无错误 */
  const [inputError, setInputError] = useState('')
  /** 提交中锁：防重复核销 */
  const [submitting, setSubmitting] = useState(false)
  /**
   * 核验态（稿 ③）：买家提交交易码后的「只有一个转圈」阶段。
   * **只覆盖核销那一段**，不覆盖 `confirmPending` 的「确认完成面交」重试 ——
   * 后者有自己的按钮与文案（审查 P1-2 的分支），不该被转圈顶掉。
   */
  const [verifying, setVerifying] = useState(false)
  /** 核销成功但 confirm 尚未落定（可重试确认） */
  const [confirmPending, setConfirmPending] = useState(false)
  /** 完成动效只播一次（本会话内刚完成），见 FxPhase */
  const [fxPhase, setFxPhase] = useState<FxPhase>('off')
  /** 扫到的 QR 凭证在 useLoad 里解释一次，命令式流程经 scanRef 读取 */
  const scanRef = useRef<MeetupQrPayload | null>(null)
  /** bootstrap 代次：身份切换 / 重试后，旧账号或旧一轮的迟到响应一律作废 */
  const bootEpoch = useRef(0)

  /**
   * 代次守卫（#168 审查 P1）：只有 `bootstrap` 自己判代次还不够 —— 它通过后启动的
   * 取码 / 核销 / confirm 同样是异步的，换账号后迟到返回会把上一账号的 token、
   * 交易、`confirmPending`、完成动效写回新账号页面；`finally` 里的 loading 复位更
   * 隐蔽：旧请求会把新账号正在进行的操作直接「停止转圈」。
   *
   * 约定：操作链开始时取一次 `epoch = bootEpoch.current` 一路透传，
   * **每个 await 之后、任何 setState 之前**（含 finally）先过这里。
   */
  const isStale = (epoch: number) => epoch !== bootEpoch.current

  /* ------------------------------------------------------------------ 加载 */

  useLoad(() => {
    if (routeCode) {
      const parsed = parseMeetupQrPayload(routeCode)
      if (parsed) {
        scanRef.current = parsed
      } else {
        // 扫码页已做形状 gate，这里理论不可达；防御性按无效码展示
        setScannedInvalid(true)
      }
    }
  })

  /**
   * 定位交易：扫码 QR 自带的 transactionId **优先**于 URL id —— 凭证是当面出示的
   * 那一枚；买家从订单 A 进入却扫了订单 B 的码时，核销必须落在 B（且 participant
   * 校验会拦下与本单无关的人）。再按角色进入出示/核销分支。
   *
   * 由**登录态与身份驱动**（下方 effect），不在 `useLoad` 里抢跑：冷启动
   * `authStatus` 还是 `unknown` 时就发 `fetchTransaction`，会先以未登录身份失败
   * （401），随后恢复 `authed` 也不会自动重试 —— 页面停在「加载失败」且没有出口。
   * `authed` 后才发，`unknown → authed` 自然触发首次定位。
   */
  const bootstrap = async (epoch: number) => {
    const qrTxId = scanRef.current?.transactionId ?? ''
    const targetId = qrTxId || routeTxId
    if (!targetId) {
      setLoadError('notFound') // 无任何上下文（不该发生：入口都带 id）
      return
    }
    try {
      const dto = await fetchTransaction(targetId)
      // 迟到的响应（重试期间又换了账号 / 又点了一次）不能写回页面
      if (epoch !== bootEpoch.current) return
      setTx(dto)
      setLoadError(null)
      if (dto.status !== 'PENDING_MEETUP') return // 终态直接渲染对应状态卡
      if (dto.role === 'buyer') {
        // 恢复口径（审查第三轮 P1）：sellerConfirmedAt **不能**等同「凭证已核销」
        // ——卖家可能从 Web 订单页走了普通 confirm。必须查凭证真实状态：
        // 仅 status === CONSUMED（确经本页凭证核销、上次会话 confirm 失败）才恢复
        // 确认入口；NONE/ISSUED 一律仍要求扫码 / 手输核销。
        if (dto.sellerConfirmedAt !== null && dto.buyerConfirmedAt === null) {
          const tokenStatus = await fetchMeetupTokenStatus(targetId).catch(() => null)
          if (epoch !== bootEpoch.current) return
          if (tokenStatus?.status === 'CONSUMED') {
            setConfirmPending(true)
            return
          }
        }
      }
      // 扫码路由优先（审查 P1-1 补充）：带 ?code= 进入时按扫码语义让后端裁决
      // （卖家扫自己的码会如实收到 403 NOT_ALLOWED，而不是被静默换成一次展示）；
      // 无扫码产物时，卖家进页才自动取码（#176 幂等：同一笔交易恒为同一枚码）。
      if (scanRef.current) {
        void consumeQr(scanRef.current.transactionId, scanRef.current.token, epoch)
      } else if (dto.role === 'seller') {
        void ensureToken(dto.id, epoch)
      }
    } catch (error) {
      if (epoch !== bootEpoch.current) return
      setLoadError(isApiError(error) && error.status === 404 ? 'notFound' : 'failed')
    }
  }

  /** bootstrap 的触发与身份切换清场（#89 审查收口）： */
  const identityRef = useRef<string | null>(null)
  if (identityRef.current !== userId) {
    identityRef.current = userId
    // 渲染期同步自增代次：上一个账号在飞的响应在微任务窗口里就被判过期
    bootEpoch.current += 1
    // 换账号回到这页时，上一账号的交易、凭证、输入与错误全部作废
    setTx(null)
    setToken(null)
    setLoadError(null)
    setConfirmPending(false)
    setDigits(['', '', '', '', '', ''])
    setInputError('')
    // 上面自增代次后，上一账号在飞的操作链连 `finally` 都不会再落地 ——
    // 这些 loading / 动效开关必须在这里一并清掉：否则新账号页面会停在核验态
    // 的全屏转圈上，或替上一账号重播一次完成动效。
    setVerifying(false)
    setSubmitting(false)
    setFxPhase('off')
  }

  /**
   * `authed` 且身份已知才定位交易；`unknown → authed` 自动补跑，失败后重试也走这里。
   *
   * `bootstrap` 不进依赖表：它是每次渲染重建的普通函数，读的只有路由参数（页面参数
   * 不会在存活期变化）与 ref，把它加进依赖等于每次渲染都重跑 effect —— 这不是触发
   * 口径想要的（触发只由登录态与身份决定），stale closure 在这里并不成立。
   */
  const bootstrapRef = useRef(bootstrap)
  bootstrapRef.current = bootstrap
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    const epoch = bootEpoch.current
    void bootstrapRef.current(epoch)
  }, [authStatus, userId])

  /* --------------------------------------- 卖家：取码（幂等 ensure/read） */

  const ensureToken = async (txId: string, epoch: number) => {
    // 参数化 transactionId（审查 P1-1）：bootstrap 里 setTx 后闭包的 tx 仍是 null，
    // 自动取码绝不能读 React state，否则首次进入直接 no-op、页面卡在「加载中…」。
    // 语义（#176）：这是「确保并读取」而非签发 —— 同一笔交易恒返回同一枚码，
    // 重复取码不换码、不改 issuedAt，只清零失败计数与锁定（卖家专属解锁路径）。
    setToken({ state: 'issuing' })
    setInputError('')
    try {
      const next = await issueMeetupToken(txId)
      if (isStale(epoch)) return
      setToken({ state: 'ready', token: next })
    } catch (error) {
      if (isStale(epoch)) return
      setToken(null)
      if (isApiError(error)) {
        if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
          // 终态（已取消/已完成）：刷新交易视图让页面落到对应状态卡
          const dto = await fetchTransaction(txId).catch(() => null)
          if (isStale(epoch)) return
          if (dto) setTx(dto)
          return
        }
        if (error.status === 404) {
          setLoadError('notFound')
          return
        }
      }
      void Taro.showToast({ title: '交易码加载失败，请重试', icon: 'none' })
    }
  }

  /* ------------------------------------------------- 买家：核销 */

  const consumeQr = async (targetId: string, qrToken: string, epoch: number) => {
    await verify(targetId, () => redeemMeetupToken(targetId, qrToken), epoch)
  }

  const consumeCode = async (targetId: string, code: string, epoch: number) => {
    await verify(targetId, () => verifyMeetupCode(targetId, code), epoch)
  }

  /**
   * 核销统一入口：先消费凭证，成功后按 nextAction 调 confirm（幂等）。
   * 双侧确认齐时交易直接 COMPLETED + listing SOLD；confirm 网络失败时保留
   * 「确认完成」重试按钮，不假装已完成。
   *
   * 核验态的时长 = 请求在飞（`submitting`），另配最短展示 `VERIFY_MIN_MS`：
   * 请求秒回时也把转圈留够一瞬，避免闪一下。
   */
  const verify = async (targetId: string, consume: () => Promise<unknown>, epoch: number) => {
    if (submitting) return
    setSubmitting(true)
    setInputError('')
    // 核验态：核销请求在飞期间页面只显示一个转圈（稿 ③）
    setVerifying(true)
    const startedAt = Date.now()
    /** 请求结束后补齐最短展示时长；只在「还没完成」时等，避免拖慢完成页 */
    const settle = async () => {
      const rest = VERIFY_MIN_MS - (Date.now() - startedAt)
      if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest))
    }
    try {
      await consume()
      if (isStale(epoch)) return
      try {
        const dto = await confirmTransaction(targetId)
        if (isStale(epoch)) return
        await settle()
        if (isStale(epoch)) return
        setTx(dto)
        setConfirmPending(dto.status !== 'COMPLETED')
        if (dto.status === 'COMPLETED') setFxPhase('on')
      } catch {
        if (isStale(epoch)) return
        await settle()
        if (isStale(epoch)) return
        setConfirmPending(true)
      }
    } catch (error) {
      if (isStale(epoch)) return
      await settle()
      if (isStale(epoch)) return
      if (isApiError(error)) {
        const map: Record<string, string> = {
          MEETUP_TOKEN_INVALID: '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。',
          MEETUP_TOKEN_CONSUMED: '这个交易码已被使用，不能重复核销。',
          MEETUP_TOKEN_LOCKED:
            '错误次数过多，已临时锁定。请让对方重新打开一次「交易码」页面，再试同一枚码。',
          MEETUP_TOKEN_NOT_FOUND: '对方还没有出示本单的交易码。',
        }
        if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
          // 已取消 / 已完成：刷新交易视图落到对应状态卡
          const dto = await fetchTransaction(targetId).catch(() => null)
          if (isStale(epoch)) return
          if (dto) setTx(dto)
          return
        }
        if (error.code === 'MEETUP_TOKEN_NOT_ALLOWED') {
          // 只有出示方（卖家）会拿到 403：扫码语义已如实到达后端。
          // 不顺手自动重取（#176 取码幂等、码值不变，重取不会作废任何东西）——
          // 静默把一次核销失败变成展示动作会掩盖失败本身；落到「暂不展示」态，
          // 卖家重新进入本页即可取回同一枚码。
          setToken({ state: 'unavailable' })
          return
        }
        const message = map[error.code]
        if (message) {
          setInputError(message)
          return
        }
      }
      setInputError('核销失败，请检查网络后重试。')
    } finally {
      // 换账号后旧链的收尾不能落地：它会把新账号正在进行的核销 loading 关掉
      if (!isStale(epoch)) {
        setVerifying(false)
        setSubmitting(false)
      }
    }
  }

  /** 核销成功但 confirm 尚未落定（网络失败）时的重试入口 */
  const retryConfirm = async (epoch: number) => {
    if (!tx || submitting) return
    setSubmitting(true)
    try {
      const dto = await confirmTransaction(tx.id)
      if (isStale(epoch)) return
      setTx(dto)
      setConfirmPending(dto.status !== 'COMPLETED')
      if (dto.status === 'COMPLETED') setFxPhase('on')
    } catch (error) {
      if (isStale(epoch)) return
      if (isApiError(error) && error.code === 'TRANSACTION_NOT_IN_PENDING') {
        // 等待期间交易被取消/完成：落到对应状态卡，确认入口随之消失
        const dto = await fetchTransaction(tx.id).catch(() => null)
        if (isStale(epoch)) return
        if (dto) setTx(dto)
        setConfirmPending(false)
        return
      }
      void Taro.showToast({ title: '确认失败，请稍后重试', icon: 'none' })
    } finally {
      if (!isStale(epoch)) setSubmitting(false)
    }
  }

  const goHome = () => {
    void Taro.switchTab({ url: '/pages/home/index' })
  }

  /**
   * 「返回我的订单」：订单页拆成了「我买到的 / 我卖出的」两页，按**本单里我的角色**
   * 回到对应那页。`tx` 还没加载出来时退到「我买到的」—— 那页至少有「去首页看看」的出口。
   */
  const goOrders = () => {
    const url = tx?.role === 'seller' ? '/pages/orders-sell/index' : '/pages/orders-buy/index'
    void Taro.navigateTo({ url })
  }

  const openScanner = () => {
    void Taro.navigateTo({ url: '/pages/scan/index' })
  }

  /**
   * 手动输入 6 格。
   *
   * 支持整串粘贴：输入框 maxlength=6，一次粘进来的多位会在 `onInput` 里逐格分配，
   * 与设计稿「6 个独立格子」的观感一致，又不必依赖六个真实输入框。
   */
  const onDigitsInput = (raw: string) => {
    const clean = raw.replace(/\D/g, '').slice(0, 6)
    const next = ['', '', '', '', '', '']
    clean.split('').forEach((ch, i) => {
      next[i] = ch
    })
    setDigits(next)
    setInputError('')
  }

  const joined = digits.join('')
  const canSubmit = joined.length === 6 && !submitting

  const submit = () => {
    if (!canSubmit || !tx) return
    void consumeCode(tx.id, joined, bootEpoch.current)
  }

  /* ------------------------------------------------- 派生视图状态 */

  const isSeller = tx?.role === 'seller'
  const done = tx?.status === 'COMPLETED'
  const cancelled = tx?.status === 'CANCELLED'
  const unavailable = token?.state === 'unavailable'
  const readyToken = token?.state === 'ready' ? token.token : null
  const qrImage = readyToken ? qrDataUrl(readyToken.qrPayload) : ''

  /** 核验态只在买家侧出现（卖家不提交交易码） */
  const showVerify = verifying && !isSeller && !done && !cancelled

  const statusPill = done
    ? { label: '已完成', cls: 'is-done', note: '本单已归档 · 交易码已失效' }
    : cancelled
      ? { label: '已取消', cls: 'is-cancel', note: '本单已取消 · 交易码已失效' }
      : {
          label: '待面交',
          cls: 'is-pending',
          // 稿的 mono 备注行：买家「扫码进入本单」/ 卖家「本单一次性凭证 · 面交后失效」
          note: isSeller ? '本单一次性凭证 · 面交后失效' : '扫码进入本单',
        }

  /** 完成页文案按视角分（稿 ⑤：双方同构，只有文字不同） */
  const doneText = isSeller
    ? '本次面交已确认，对方已确认收到本单商品，本单已归档。感谢你在鱼小应完成当面交易。'
    : '本次面交已确认，你已收到本单商品，本单已归档。感谢你在鱼小应完成当面交易。'

  /**
   * 完成动效的光爆原点：必须量 `.meetup__suc-stage`（不带动画的定位盒），
   * 不能量徽章本身 —— 徽章正在跑 `meetup-burst-flip`（0% 就是 rotateY(-720deg)
   * scale(.12)），量它等于量一个正在缩放的盒子。
   *
   * **量到之前不挂特效层**（渲染处判 `fxTop > 0`）：这个 effect 与「首次挂载
   * `.meetup__suc-stage`」是同一次提交，而 Taro 的 `setData` 是异步刷的
   * （`@tarojs/runtime` 的 `scheduleTask` 走 `setTimeout`）。若照常挂层，原点在
   * 量到之前是 0，闪光与冲击环会先从**屏幕顶边**炸开再瞬移到徽章。
   */
  const [fxTop, setFxTop] = useState(0)

  useEffect(() => {
    if (fxPhase !== 'on') return
    let cancelled = false

    const measure = () => {
      Taro.nextTick(() => {
        Taro.createSelectorQuery()
          .select('.meetup__suc-stage')
          .boundingClientRect()
          .exec((res) => {
            if (cancelled) return
            const rect = res?.[0] as { top?: number; height?: number } | undefined
            if (typeof rect?.top === 'number' && typeof rect.height === 'number') {
              // 光爆层是 `position: fixed` 铺满视口，原点直接用视口坐标即可
              setFxTop(Math.round(rect.top + rect.height / 2))
              return
            }
            // 量不到（节点还没上屏）：按布局算一遍兜底 —— 完成后徽章中心 =
            // 168(页头) + 24 + 46(状态行) + 252(成功区上留白) + 82(徽章半径) = 572rpx，
            // rpx → px 用 windowWidth / 750 换算（不能用 statusBarHeight 相加，
            // 那 168rpx 里已经含了状态栏）。绝不把原点留在 0。
            try {
              const info = Taro.getWindowInfo()
              const width = info.windowWidth || 390
              setFxTop(Math.round((572 * width) / 750))
            } catch {
              setFxTop(280)
            }
          })
      })
    }

    // 先在页首（稿也是先回页首再播）。pageScrollTo 是异步的，必须等它落定再量，
    // 否则读到的可能是滚动前的坐标。失败也要继续量，不能把动效卡掉。
    Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).then(
      () => {
        if (!cancelled) measure()
      },
      () => {
        if (!cancelled) measure()
      },
    )

    return () => {
      cancelled = true
    }
  }, [fxPhase])

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页全部数据来自真实 API，不拦的话跳转落地前会先画一帧空数据。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  const dealCard = tx ? (
    <View className="meetup__deal">
      <View className="meetup__deal-thumb">
        <Image className="meetup__deal-img" src={tx.listing.coverUrl ?? ''} mode="aspectFill" />
      </View>
      <View className="meetup__deal-info">
        <Text className="meetup__deal-title">{tx.listing.title}</Text>
        <Text className="meetup__deal-sub num">
          {`${tx.role === 'buyer' ? '卖家' : '买家'} ${tx.counterpart.nickname} · 订单创建 ${relativeLabel(tx.createdAt)}`}
        </Text>
      </View>
      <Text className="meetup__deal-amount num">¥{formatAmount(tx.amountCents)}</Text>
    </View>
  ) : null

  return (
    <View className="meetup">
      <View className="meetup__bg" />

      {/* 顶栏标题按视角不同（稿 ①）：买家「输入交易码」/ 卖家「交易码」。
          交易还没读回来时**不给标题** —— 按 `isSeller` 猜会把卖家的页面临时显示成
          「输入交易码」（isSeller 在 tx 为 null 时是 false）；报错态也不该有标题。 */}
      <NavBar
        title={tx ? (isSeller ? '交易码' : '输入交易码') : undefined}
        titleAlign="center"
        glass
      />

      {/* 完成动效的全屏特效层：铺满视口、按屏缘裁切（稿 `.fx` 挂在 `.screen` 直下）。
          必须等原点量到再挂（`fxTop > 0`），否则闪光/冲击环会先从屏幕顶边炸开再瞬移。 */}
      {fxPhase === 'on' && done && fxTop > 0 ? (
        <View className="meetup__fx">
          <View className="meetup__fx-flash" />
          <View className="meetup__fx-origin" style={{ top: `${fxTop}px` }}>
            <View className="meetup__fx-glow" />
            <View className="meetup__fx-wave" />
            <View className="meetup__fx-wave meetup__fx-wave--2" />
            <View className="meetup__fx-wave meetup__fx-wave--3" />
            <View className="meetup__fx-particles">
              {FX_PARTICLES.map((id) => (
                <View key={id} className="meetup__fx-p" />
              ))}
            </View>
          </View>
        </View>
      ) : null}

      <View className="meetup__head">
        <View className="meetup__statusrow">
          {tx ? <Text className={`meetup__st ${statusPill.cls}`}>{statusPill.label}</Text> : null}
          {tx ? <Text className="meetup__statusnote num">{statusPill.note}</Text> : null}
        </View>
        {/* 完成页由摘要卡承担商品信息，其余状态都挂商品卡（稿：完成态摘掉页头商品卡） */}
        {done ? null : dealCard}
      </View>

      {/* ---------- 交易不存在 / 非参与者：404 不泄漏存在性 ---------- */}
      {loadError === 'notFound' ? (
        <View className="meetup__varcard">
          <View className="meetup__vdisc meetup__vdisc--danger">
            <Image className="meetup__vdisc-ic" src={ICONS.warnInk} mode="aspectFit" />
          </View>
          <Text className="meetup__varcard-title">找不到这笔交易</Text>
          <Text className="meetup__varcard-text">
            交易码仅本单的买家与卖家本人可查看或输入，请从自己的「我的订单」进入本单。
          </Text>
          <View className="meetup__varcard-acts">
            <View className="meetup__btn meetup__btn--sec" onClick={goOrders}>
              <Text>返回我的订单</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ---------- 加载失败（网络 / 服务器） ---------- */}
      {loadError === 'failed' ? (
        <View className="meetup__varcard">
          <View className="meetup__vdisc meetup__vdisc--warn">
            <Image className="meetup__vdisc-ic" src={ICONS.warn} mode="aspectFit" />
          </View>
          <Text className="meetup__varcard-title">加载失败</Text>
          <Text className="meetup__varcard-text">网络不给力，请稍后重试。</Text>
          <View className="meetup__varcard-acts">
            {/* 冷启动认证恢复后的那次定位也可能撞上网络失败 —— 没有「重试」的话
                页面就停在死局（#168 审查阻塞点 2）。重试与首次定位同走 bootstrap。 */}
            <View
              className="meetup__btn meetup__btn--sec"
              onClick={() => void bootstrap(bootEpoch.current)}
            >
              <Text>重试</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ---------- 扫到的不是本应用的交易码 ---------- */}
      {scannedInvalid ? (
        <View className="meetup__varcard">
          <View className="meetup__vdisc meetup__vdisc--danger">
            <Image className="meetup__vdisc-ic" src={ICONS.warnInk} mode="aspectFit" />
          </View>
          <Text className="meetup__varcard-title">这不是鱼小应的交易码</Text>
          <Text className="meetup__varcard-text">
            请扫对方「交易码」页面上的二维码，或输入对方展示的 6 位数字。
          </Text>
        </View>
      ) : null}

      {/* ---------- 核验态（稿 ③）：只有一个转圈，圈里不放任何字 ---------- */}
      {showVerify ? (
        <View className="meetup__verify">
          <View className="meetup__vspin">
            <View className="meetup__vspin-ring" />
          </View>
        </View>
      ) : null}

      {/* ---------- 已完成 / 已取消：终态卡 ---------- */}
      {tx && (done || cancelled) ? (
        done ? (
          <>
            {/*
              震屏只包内容，**不能包吸底操作栏**：`.meetup__hit` 的
              `animation: meetup-hit … both` 会永久保留末帧的 `transform`，
              而「保留的 transform（哪怕单位矩阵）会让该元素成为 position:fixed
              后代的包含块」—— 包住的话吸底栏就不再相对视口定位，会跟着内容滚走。
              稿里 `is-hit` 也只挂在 `.content` 上、`.actionbar` 是兄弟节点。
            */}
            <View className={fxPhase === 'on' ? 'meetup__hit' : undefined}>
              <View className="meetup__success">
                <View className="meetup__suc-stage">
                  <View className="meetup__suc-halo" />
                  <View className="meetup__suc-ring" />
                  <View className="meetup__suc-ring meetup__suc-ring--2" />
                  <View className="meetup__suc-ring meetup__suc-ring--3" />
                  <View className="meetup__suc-disc">
                    {/* 对勾自绘：`<View>` + 两条边框（稿要求内联 path 才能做 dash，
                        小程序无内联 SVG，改用量出尺寸的 CSS 勾，见 index.scss） */}
                    <View className="meetup__suc-check" />
                  </View>
                </View>
                <Text className="meetup__suc-title">交易已完成</Text>
                <Text className="meetup__suc-text">{doneText}</Text>
              </View>

              <View className="meetup__sumcard">
                <View className="meetup__sum-thumb">
                  <Image
                    className="meetup__sum-img"
                    src={tx.listing.coverUrl ?? ''}
                    mode="aspectFill"
                  />
                </View>
                <View className="meetup__sum-info">
                  <Text className="meetup__sum-title">{tx.listing.title}</Text>
                  {/* 完成页摘要卡的称谓按视角对调（稿 ⑤） */}
                  <Text className="meetup__sum-sub num">
                    {`与 ${tx.role === 'buyer' ? '卖家' : '买家'} ${tx.counterpart.nickname} · 已完成面交`}
                  </Text>
                </View>
                <Text className="meetup__sum-amount num">¥{formatAmount(tx.amountCents)}</Text>
              </View>

              {/* 终态后凭证行已随交易同事务删除（#147），取码接口也只会拿到 409：
                  这里如实展示「已失效」。明文只由卖家的取码响应给出，买家侧没有任何接口能回显数字。 */}
              <Text className="meetup__dead num">
                本单交易码 <Text className="meetup__dead-code">已失效</Text>
              </Text>
            </View>

            {/* 吸底栏在震屏包裹层**之外**：见上面关于 `position: fixed` 包含块的说明 */}
            <View className={`meetup__bar${fxPhase === 'on' ? ' is-enter' : ''}`}>
              <View className="meetup__bar-btn meetup__btn--sec" onClick={goHome}>
                <Image className="meetup__bar-ic" src={ICONS.tabHome} mode="aspectFit" />
                <Text>返回主页</Text>
              </View>
              {/* 主按钮（品牌渐变底 + 白字）不带图标：图标库是固定色 PNG，
                  没有白色的首页/订单图标，灰色图标压在蓝底上是缺陷（稿里的 SVG
                  继承 currentColor 才有白图标）。 */}
              <View className="meetup__bar-btn meetup__btn--main" onClick={goOrders}>
                <Text>查看订单</Text>
              </View>
            </View>
          </>
        ) : (
          <View className="meetup__varcard">
            <View className="meetup__vdisc meetup__vdisc--warn">
              <Image className="meetup__vdisc-ic" src={ICONS.warn} mode="aspectFit" />
            </View>
            <Text className="meetup__varcard-title">交易已取消</Text>
            <Text className="meetup__varcard-text">本单已被取消，交易码随之失效。</Text>
            <View className="meetup__varcard-acts">
              <View className="meetup__btn meetup__btn--sec" onClick={goOrders}>
                <Text>返回我的订单</Text>
              </View>
            </View>
          </View>
        )
      ) : null}

      {/* ---------- 待面交：卖家出示 / 买家核销 ---------- */}
      {tx && !done && !cancelled && !showVerify ? (
        isSeller ? (
          <>
            <View className="meetup__sec">
              <Text className="meetup__sec-title">我的交易码</Text>
              <Text className="meetup__sec-note num">6 位数字</Text>
            </View>

            {unavailable ? (
              <View className="meetup__varcard">
                <View className="meetup__vdisc meetup__vdisc--warn">
                  <Image className="meetup__vdisc-ic" src={ICONS.warn} mode="aspectFit" />
                </View>
                <Text className="meetup__varcard-title">这是你出示的交易码</Text>
                <Text className="meetup__varcard-text">
                  交易码不能由你本人核销。点「重新取码」即可取回本单的同一枚码 ——
                  交易码不会变，也不存在「旧码作废」。
                </Text>
                <View className="meetup__varcard-acts">
                  {/* #176 起取码幂等（确保并读取）：这里重新取到的是**同一枚**码，
                      既不会换码、也不会作废对方手里的那枚；取码同时清零失败计数与锁定。 */}
                  <View
                    className="meetup__btn meetup__btn--sec"
                    onClick={() => void ensureToken(tx.id, bootEpoch.current)}
                  >
                    <Text>重新取码</Text>
                  </View>
                </View>
              </View>
            ) : readyToken ? (
              <>
                <View className="meetup__codecard">
                  <View className="meetup__digits">
                    {CODE_SLOTS.map((slot) => (
                      <Text key={slot.id} className="meetup__digit num">
                        {readyToken.code[slot.index] ?? ''}
                      </Text>
                    ))}
                  </View>
                  <Text className="meetup__code-ttl num">本单交易码 · 面交完成后自动失效</Text>

                  <View className="meetup__hair" />

                  <View className="meetup__qr">
                    <View className="meetup__qr-box">
                      <Image className="meetup__qr-ic" src={qrImage} mode="aspectFit" />
                    </View>
                    <Text className="meetup__qr-cap">请对方用微信扫码</Text>
                  </View>
                </View>

                <View className="meetup__notice">
                  <Image className="meetup__notice-ic" src={ICONS.lock} mode="aspectFit" />
                  <Text className="meetup__notice-tx">
                    交易码一次性有效，面交完成后自动失效；请勿截图或转发，仅当面出示。
                  </Text>
                </View>

                {/* 卖家等待条：稿 ④ 的双机联动在小程序里无数据来源，改成如实语义 */}
                <View className="meetup__waitline">
                  <View className="meetup__wait-dot" />
                  <Text>等待对方扫码或输入交易码</Text>
                </View>
              </>
            ) : (
              <View className="meetup__codecard">
                <View className="meetup__digits">
                  {CODE_SLOTS.map((slot) => (
                    <Text key={slot.id} className="meetup__digit num">
                      ·
                    </Text>
                  ))}
                </View>
                <Text className="meetup__code-ttl num">交易码加载中…</Text>
              </View>
            )}
          </>
        ) : confirmPending ? (
          <>
            {/* 凭证已核销（含跨页面/重启后从服务端状态恢复，审查 P1-2）：
                一次性 token 已 CONSUMED，再输入只会得到 CONSUMED —— 只给确认出口。 */}
            <Text className="meetup__hint">
              交易码已核销成功，面交确认还差最后一步：确认完成本次面交。
            </Text>
            <Text className="meetup__flash">等待你确认完成面交。</Text>
            <View className="meetup__bar">
              <View
                className={`meetup__bar-btn meetup__btn--main${submitting ? ' is-off' : ''}`}
                onClick={() => void retryConfirm(bootEpoch.current)}
              >
                {submitting ? <View className="meetup__spin" /> : null}
                <Text>{submitting ? '确认中…' : '确认完成面交'}</Text>
              </View>
            </View>
          </>
        ) : (
          <>
            <View className="meetup__sec">
              <Text className="meetup__sec-title">输入对方的交易码</Text>
              <Text className="meetup__sec-note num">6 位数字</Text>
            </View>
            <Text className="meetup__hint">
              请对方在 TA 的「交易码」页面出示二维码或 6 位数字，扫码或输入后即可完成核销。
            </Text>

            {/*
                六个格子视觉上是独立的，但只挂一个透明输入框：
                六个真实 Input 在小程序里会各自弹键盘、光标乱跳，且整串粘贴无法分配。
                这里用一个覆盖整行、字号透明的 Input 承接输入与粘贴，下面画格子。
              */}
            <View className="meetup__cells">
              {INPUT_CELLS.map((cell) => {
                const ch = digits[cell.index] ?? ''
                return (
                  <View
                    key={cell.id}
                    className={`meetup__cell${ch ? ' is-filled' : ''}${
                      inputError && ch ? ' is-bad' : ''
                    }${cell.index === joined.length && !inputError ? ' is-focus' : ''}`}
                  >
                    <Text className="meetup__cell-tx num">{ch}</Text>
                  </View>
                )
              })}
              <Input
                className="meetup__cells-input"
                type="number"
                maxlength={6}
                value={joined}
                onInput={(event) => onDigitsInput(event.detail.value)}
              />
            </View>

            {inputError ? (
              <View className="meetup__errbox">
                <Image className="meetup__err-ic" src={ICONS.warn} mode="aspectFit" />
                <Text className="meetup__err-tx">{inputError}</Text>
              </View>
            ) : null}

            <View className="meetup__bar">
              <View className="meetup__bar-btn meetup__btn--sec" onClick={openScanner}>
                <Image className="meetup__bar-ic" src={ICONS.qr} mode="aspectFit" />
                <Text>扫码验证</Text>
              </View>
              <View
                className={`meetup__bar-btn meetup__btn--main${canSubmit ? '' : ' is-off'}`}
                onClick={submit}
              >
                <Text>确认</Text>
              </View>
            </View>

            <View className="meetup__notice">
              <Image className="meetup__notice-ic" src={ICONS.lock} mode="aspectFit" />
              <Text className="meetup__notice-tx">
                交易码一次性有效，核销成功即完成面交确认；重复提交不会重复成交。
              </Text>
            </View>
          </>
        )
      ) : null}
    </View>
  )
}
