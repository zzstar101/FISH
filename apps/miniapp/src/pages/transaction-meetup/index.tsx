import type { MeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import type { MeetupTokenResponse, TransactionDto } from '@fish/contracts/transactions/schema'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
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
 * A2 交易码 / 面交确认（设计稿 `设计稿_A2-transaction-meetup.html`）—— #70 × #114 真实接线。
 *
 * 入口参数（两种，可同时出现）：
 * - `?id=<transactionId>`：从「我的订单」进入。卖家 = 出示方：进页即签发/刷新面交码，
 *   展示 6 位码 + 二维码，点「刷新」重签（旧码立即作废）；
 *   买家 = 核销方：在本页手动输入对方的 6 位码（6 位码只在已知 transactionId 的
 *   本页输入，全局扫码页不提供无上下文输入），或点「扫码验证」进扫码页。
 * - `?code=<QR 原文>`：扫码页交付的鱼小应交易码原文，自带 transactionId
 *   （契约 `meetup-qr`），可独立定位交易。扫码页已做形状 gate，此处再解析一次，
 *   解析失败（不该发生）按「无效码」展示。
 *
 * 消费语义（后端 #70 冻结契约）：核销成功 = 买家侧凭证消费 + 卖家面交确认被盖上，
 * 响应 `nextAction: 'CONFIRM_DELIVERY'` —— 本页随后调 confirm；双侧确认齐 →
 * COMPLETED + 商品 SOLD（幂等，重复提交不会重复成交）。
 *
 * 恢复口径（审查 P1-2 / 第三轮）：confirm 网络失败后杀进程/离开再进，服务端停在
 * 「sellerConfirmedAt 已盖、buyerConfirmedAt 未盖、token CONSUMED」。注意
 * sellerConfirmedAt 不能单独作为核销证明（Web 端普通 confirm 也会盖它）——
 * 必须再查 GET meetup-token 的 status === CONSUMED 才恢复确认入口；
 * 非 CONSUMED 一律仍要求扫码 / 手输核销。
 *
 * 错误口径逐一对齐后端错误码：INVALID（码不正确）/ CONSUMED（已被使用）/
 * LOCKED（错误次数过多）/ NOT_FOUND（对方还没出码）/
 * NOT_ALLOWED（不能核销自己出示的码）。
 * #147 长期凭证：凭证在本单 PENDING_MEETUP 生命周期内有效（终态后端同事务销毁），
 * 没有过期路径与倒计时。
 */

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

/** 卖家视角下凭证的渲染态（NONE/CONSUMED 不落在本页：进页即签发） */
type TokenView =
  | { state: 'issuing' }
  | { state: 'ready'; token: MeetupTokenResponse }
  /** 凭证不可在本页重复展示（如卖家误扫自己的码收到 NOT_ALLOWED）：
   * 明文只存在于签发响应，本页无法重放；是否重签交用户手动决定。 */
  | { state: 'unavailable' }

export default function TransactionMeetup() {
  const authStatus = useAuthGuard()
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
  /** 手动输入的错误提示（码错误 / 已被使用 / 次数过多 / 对方未出码），空串表示无错误 */
  const [inputError, setInputError] = useState('')
  /** 提交中锁：防重复核销 */
  const [submitting, setSubmitting] = useState(false)
  /** 核销成功但 confirm 尚未落定（可重试确认） */
  const [confirmPending, setConfirmPending] = useState(false)
  /** 扫到的 QR 凭证在 useLoad 里解释一次，命令式流程经 scanRef 读取 */
  const scanRef = useRef<MeetupQrPayload | null>(null)

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
    void bootstrap()
  })

  /**
   * 定位交易：扫码 QR 自带的 transactionId **优先**于 URL id —— 凭证是当面出示的
   * 那一枚；买家从订单 A 进入却扫了订单 B 的码时，核销必须落在 B（且 participant
   * 校验会拦下与本单无关的人）。再按角色进入出示/核销分支。
   */
  const bootstrap = async () => {
    const qrTxId = scanRef.current?.transactionId ?? ''
    const targetId = qrTxId || routeTxId
    if (!targetId) {
      setLoadError('notFound') // 无任何上下文（不该发生：入口都带 id）
      return
    }
    try {
      const dto = await fetchTransaction(targetId)
      setTx(dto)
      if (dto.status !== 'PENDING_MEETUP') return // 终态直接渲染对应状态卡
      if (dto.role === 'buyer') {
        // 恢复口径（审查第三轮 P1）：sellerConfirmedAt **不能**等同「凭证已核销」
        // ——卖家可能从 Web 订单页走了普通 confirm。必须查凭证真实状态：
        // 仅 status === CONSUMED（确经本页凭证核销、上次会话 confirm 失败）才恢复
        // 确认入口；NONE/ISSUED 一律仍要求扫码 / 手输核销。
        if (dto.sellerConfirmedAt !== null && dto.buyerConfirmedAt === null) {
          const tokenStatus = await fetchMeetupTokenStatus(targetId).catch(() => null)
          if (tokenStatus?.status === 'CONSUMED') {
            setConfirmPending(true)
            return
          }
        }
      }
      // 扫码路由优先（审查 P1-1 补充）：带 ?code= 进入时按扫码语义让后端裁决
      // （卖家扫自己的码会如实收到 403 NOT_ALLOWED，而不是被静默刷新出码）；
      // 无扫码产物时，卖家进页才自动签发。
      if (scanRef.current) {
        void consumeQr(scanRef.current.transactionId, scanRef.current.token)
      } else if (dto.role === 'seller') {
        void issue(dto.id)
      }
    } catch (error) {
      setLoadError(isApiError(error) && error.status === 404 ? 'notFound' : 'failed')
    }
  }

  /* ------------------------------------------------- 卖家：签发 / 刷新 */

  const issue = async (txId: string) => {
    // 参数化 transactionId（审查 P1-1）：bootstrap 里 setTx 后闭包的 tx 仍是 null，
    // 自动签发绝不能读 React state，否则首次进入直接 no-op、页面卡在「生成中…」。
    setToken({ state: 'issuing' })
    setInputError('')
    try {
      const next = await issueMeetupToken(txId)
      // #147 长期凭证：响应只有 code + qrPayload，凭证在本单 PENDING_MEETUP
      // 生命周期内有效（终态后端同事务销毁），没有倒计时。
      setToken({ state: 'ready', token: next })
    } catch (error) {
      setToken(null)
      if (isApiError(error)) {
        if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
          // 终态（已取消/已完成）：刷新交易视图让页面落到对应状态卡
          const dto = await fetchTransaction(txId).catch(() => null)
          if (dto) setTx(dto)
          return
        }
        if (error.status === 404) {
          setLoadError('notFound')
          return
        }
      }
      void Taro.showToast({ title: '交易码生成失败，请重试', icon: 'none' })
    }
  }

  /* ------------------------------------------------- 买家：核销 */

  const consumeQr = async (targetId: string, qrToken: string) => {
    await verify(targetId, () => redeemMeetupToken(targetId, qrToken))
  }

  const consumeCode = async (targetId: string, code: string) => {
    await verify(targetId, () => verifyMeetupCode(targetId, code))
  }

  /**
   * 核销统一入口：先消费凭证，成功后按 nextAction 调 confirm（幂等）。
   * 双侧确认齐时交易直接 COMPLETED + listing SOLD；confirm 网络失败时保留
   * 「确认完成」重试按钮，不假装已完成。
   */
  const verify = async (targetId: string, consume: () => Promise<unknown>) => {
    if (submitting) return
    setSubmitting(true)
    setInputError('')
    try {
      await consume()
      try {
        const dto = await confirmTransaction(targetId)
        setTx(dto)
        setConfirmPending(dto.status !== 'COMPLETED')
      } catch {
        setConfirmPending(true)
      }
    } catch (error) {
      if (isApiError(error)) {
        const map: Record<string, string> = {
          MEETUP_TOKEN_INVALID: '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。',
          MEETUP_TOKEN_CONSUMED: '这个交易码已被使用，不能重复核销。',
          MEETUP_TOKEN_LOCKED: '错误次数过多，已临时锁定，请稍后再试。',
          MEETUP_TOKEN_NOT_FOUND: '对方还没有出示本单的交易码。',
        }
        if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
          // 已取消 / 已完成：刷新交易视图落到对应状态卡
          const dto = await fetchTransaction(targetId).catch(() => null)
          if (dto) setTx(dto)
          return
        }
        if (error.code === 'MEETUP_TOKEN_NOT_ALLOWED') {
          // 只有签发人（卖家）会拿到 403：扫码语义已如实到达后端。
          // 不顺手 rotate（审查 P2）——自动重签会立即作废对方手里的旧码；
          // 落到「不可展示」态，是否刷新由卖家在展示态手动决定。
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
      setSubmitting(false)
    }
  }

  /** 核销成功但 confirm 尚未落定（网络失败）时的重试入口 */
  const retryConfirm = async () => {
    if (!tx || submitting) return
    setSubmitting(true)
    try {
      const dto = await confirmTransaction(tx.id)
      setTx(dto)
      setConfirmPending(dto.status !== 'COMPLETED')
    } catch (error) {
      if (isApiError(error) && error.code === 'TRANSACTION_NOT_IN_PENDING') {
        // 等待期间交易被取消/完成：落到对应状态卡，确认入口随之消失
        const dto = await fetchTransaction(tx.id).catch(() => null)
        if (dto) setTx(dto)
        setConfirmPending(false)
        return
      }
      void Taro.showToast({ title: '确认失败，请稍后重试', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  const openConversation = () => {
    if (!tx) return
    // 契约 TransactionDto 自带 conversationId（#11 冻结字段），直接跳本单会话
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${tx.conversationId}` })
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
    void consumeCode(tx.id, joined)
  }

  /* ------------------------------------------------- 派生视图状态 */

  const isSeller = tx?.role === 'seller'
  const done = tx?.status === 'COMPLETED'
  const cancelled = tx?.status === 'CANCELLED'
  const unavailable = token?.state === 'unavailable'
  const readyToken = token?.state === 'ready' ? token.token : null
  const qrImage = readyToken ? qrDataUrl(readyToken.qrPayload) : ''

  const statusPill = done
    ? { label: '已完成', cls: 'is-done' }
    : cancelled
      ? { label: '已取消', cls: 'is-cancel' }
      : { label: '待面交', cls: 'is-pending' }

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

      <NavBar />

      <View className="meetup__head">
        <View className="meetup__headline">
          <Text className="meetup__title">交易码</Text>
          {tx ? <Text className={`meetup__st ${statusPill.cls}`}>{statusPill.label}</Text> : null}
        </View>
        {dealCard}
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

      {/* ---------- 已完成 / 已取消：终态卡 ---------- */}
      {tx && (done || cancelled) ? (
        done ? (
          <>
            <View className="meetup__success">
              <View className="meetup__suc-disc">
                <Image className="meetup__suc-ic" src={ICONS.checkCircleWhite} mode="aspectFit" />
              </View>
              <Text className="meetup__suc-title">交易已完成</Text>
              <Text className="meetup__suc-text">
                本次面交已确认，本单已归档。感谢你在校园里完成当面交易。
              </Text>
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
                <Text className="meetup__sum-sub num">{`与 ${tx.counterpart.nickname} · 已完成面交`}</Text>
              </View>
              <Text className="meetup__sum-amount num">¥{formatAmount(tx.amountCents)}</Text>
            </View>

            <Text className="meetup__dead num">
              本单交易码 <Text className="meetup__dead-code">已失效</Text>
            </Text>

            <View className="meetup__bar">
              <View className="meetup__bar-btn meetup__btn--sec" onClick={openConversation}>
                <Image className="meetup__bar-ic" src={ICONS.chatInk} mode="aspectFit" />
                <Text>查看会话</Text>
              </View>
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
      {tx && !done && !cancelled ? (
        isSeller ? (
          <>
            <View className="meetup__sec">
              <Text className="meetup__sec-title">我的交易码</Text>
              <View className="meetup__refresh" onClick={() => tx && void issue(tx.id)}>
                <Image className="meetup__refresh-ic" src={ICONS.refresh} mode="aspectFit" />
                <Text>刷新</Text>
              </View>
            </View>

            {unavailable ? (
              <View className="meetup__varcard">
                <View className="meetup__vdisc meetup__vdisc--warn">
                  <Image className="meetup__vdisc-ic" src={ICONS.warn} mode="aspectFit" />
                </View>
                <Text className="meetup__varcard-title">这是你出示的交易码</Text>
                <Text className="meetup__varcard-text">
                  交易码不能由你本人核销。出于安全，本页不重复展示已签发的码；
                  如需重新出示给对方，点「刷新」生成新的 6 位码（旧码作废）。
                </Text>
                <View className="meetup__varcard-acts">
                  <View
                    className="meetup__btn meetup__btn--pri"
                    onClick={() => tx && void issue(tx.id)}
                  >
                    <Text>刷新交易码</Text>
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
                    交易码在本单面交完成前一直有效、一次性使用；请勿截图或转发，仅当面出示。
                  </Text>
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
                <Text className="meetup__code-ttl num">交易码生成中…</Text>
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
                onClick={() => void retryConfirm()}
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

            <View className="meetup__bar">
              <View className="meetup__bar-btn meetup__btn--sec" onClick={openScanner}>
                <Image className="meetup__bar-ic" src={ICONS.qr} mode="aspectFit" />
                <Text>扫码验证</Text>
              </View>
            </View>

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
                      inputError ? ' is-bad' : ''
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
              <View
                className={`meetup__bar-btn meetup__btn--main${canSubmit ? '' : ' is-off'}`}
                onClick={submit}
              >
                {submitting ? <View className="meetup__spin" /> : null}
                <Text>{submitting ? '核销中…' : '确认'}</Text>
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
