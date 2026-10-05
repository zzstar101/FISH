import { DELETION_CONSEQUENCES } from '@fish/contracts/account-deletion/copy'
import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '@fish/contracts/account-deletion/schema'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { usePageScroll } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import {
  fetchAccountDeletionStatus,
  requestAccountDeletion,
  withdrawAccountDeletion,
} from '@/features/auth/api'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import {
  beginDeletionTask,
  coolingOffText,
  deletionErrorMessage,
  deletionOwnerChanged,
  isConfirmPhrase,
  isDeletionTaskCurrent,
} from './view'
import './index.scss'

/**
 * 账号注销（#464）。小程序侧的「本人发起入口 + 后果说明 + 明确确认 + 可撤回」。
 *
 * 页面只有四种状态：读状态中 / 读取失败 / 未申请 / 冷静期内。状态**一律以服务端为准**
 * （`GET /me/account-deletion`），本地不记「我点过申请了」—— 用户可能在 PC 上申请、
 * 也可能被别的设备撤回，本地乐观态一旦与服务端不一致，就会给出错误的下一步。
 *
 * 申请成功后**当前会话仍然有效**（服务端只撤销其它会话），所以本页不会被守卫踢回登录页，
 * 撤回入口留在原地即可生效。
 *
 * 读取 / 申请 / 撤回都会改写「账号到底是什么状态」这个最要紧的事实，而账号可能在页面存活
 * 期间换掉（`authed(A) → authed(B)`，或退出到匿名）：三件事都走 `view.ts` 的账号作用域任务，
 * 落地前确认任务仍归当前账号所有、且没被换号或卸载作废。
 */

type Stage = 'loading' | 'error' | 'active' | 'requested'

export default function AccountDeletion() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  /** 当前登录账号的公开 ID（`usr_…`）；身份未就绪时为 null */
  const userId = user?.id ?? null

  const [stage, setStage] = useState<Stage>('loading')
  const [typed, setTyped] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [purgeAt, setPurgeAt] = useState<string | null>(null)
  const [offlined, setOfflined] = useState<number | null>(null)

  const REVEAL_AT = 40
  const [revealed, setRevealed] = useState(false)
  usePageScroll(({ scrollTop }) => setRevealed(scrollTop > REVEAL_AT))

  /**
   * 换号时**在渲染期**同步清场：effect 要等这一帧提交之后才跑，中间那一帧 B 的界面会带着
   * A 的冷静期状态、A 填了一半的确认词与 A 的倒计时。代次 +1 让 A 的在途任务全部作废。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  const epochRef = useRef(0)
  const ownerRef = useRef<string | null>(userId)
  ownerRef.current = userId

  if (deletionOwnerChanged(prevUserId, userId)) {
    setPrevUserId(userId)
    epochRef.current += 1
    setStage('loading')
    setTyped('')
    setNotice(null)
    setSubmitting(false)
    setWithdrawing(false)
    setPurgeAt(null)
    setOfflined(null)
  }

  /** 卸载：作废在途任务，免得迟到的结果在离页后 setState */
  useEffect(() => {
    return () => {
      epochRef.current += 1
    }
  }, [])

  /**
   * 读一次服务端状态。身份没就绪就**不发**（拿未知身份去问「我的注销状态」只会拿到 401，
   * 失败了也不知道该不该重试）；换号会让 `loadStatus` 重建、effect 随之重跑。
   */
  const loadStatus = useCallback(async () => {
    if (authStatus !== 'authed' || userId === null) return
    const task = beginDeletionTask(epochRef.current, userId)
    setStage('loading')
    setNotice(null)
    setOfflined(null)
    try {
      const status = await fetchAccountDeletionStatus()
      if (!isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) return
      setPurgeAt(status.purgeScheduledAt)
      setStage(status.status === 'DELETION_REQUESTED' ? 'requested' : 'active')
    } catch {
      if (!isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) return
      setStage('error')
    }
  }, [authStatus, userId])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const onSubmit = () => {
    if (submitting || userId === null || !isConfirmPhrase(typed)) return
    const task = beginDeletionTask(epochRef.current, userId)
    setSubmitting(true)
    setNotice(null)
    void (async () => {
      try {
        const result = await requestAccountDeletion()
        if (!isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) return
        setOfflined(result.offlinedListingCount)
        setPurgeAt(result.purgeScheduledAt)
        setTyped('')
        setStage('requested')
        void Taro.showToast({ title: '注销申请已提交', icon: 'none' })
      } catch (error) {
        if (!isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) return
        setNotice(deletionErrorMessage(error, '注销申请提交失败，请稍后重试'))
      } finally {
        // 锁也要按任务归属还：换号那一帧的 submitting 已由渲染期清场复位
        if (isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) setSubmitting(false)
      }
    })()
  }

  /**
   * 撤回。二次确认里必须写出「商品不会自动重新上架」—— 这是撤回后最容易产生的误解，
   * 写在确认弹窗里才是用户做决定的那一刻。
   */
  const onWithdraw = () => {
    if (withdrawing || userId === null) return
    const task = beginDeletionTask(epochRef.current, userId)
    void (async () => {
      const confirmed = await Taro.showModal({
        title: '撤回注销申请？',
        content: '撤回后账号恢复正常使用。已经下架的商品不会自动重新上架，需要你手动重新发布。',
        confirmText: '撤回申请',
        cancelText: '再想想',
      })
      // 用户看弹窗的这几秒里可能已经换了账号：这个「确认」不属于新账号，直接丢掉
      if (!confirmed.confirm || !isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) {
        return
      }
      setWithdrawing(true)
      setNotice(null)
      try {
        const status = await withdrawAccountDeletion()
        if (!isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) return
        setPurgeAt(status.purgeScheduledAt)
        setOfflined(null)
        setStage('active')
        void Taro.showToast({ title: '已撤回注销申请', icon: 'none' })
      } catch (error) {
        if (!isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) return
        setNotice(deletionErrorMessage(error, '撤回失败，请稍后重试'))
      } finally {
        if (isDeletionTaskCurrent(task, epochRef.current, ownerRef.current)) setWithdrawing(false)
      }
    })()
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  const confirmed = isConfirmPhrase(typed)

  return (
    <View className="ad">
      <View className="ad__bg" />

      <NavBar fixed glass={revealed} title={revealed ? '注销账号' : undefined} />

      <View className="ad__head">
        <Text className="ad__title">
          注销<Text className="ad__title-hl">账号</Text>
        </Text>
        <Text className="ad__meta num">提交后 7 天内可撤回 · 到期不可恢复</Text>
      </View>

      <View className="ad__content">
        {stage === 'loading' ? (
          <View className="ad__hint">
            <Text className="ad__hint-text">正在读取账号状态…</Text>
          </View>
        ) : null}

        {stage === 'error' ? (
          <View className="ad__hint">
            <Text className="ad__hint-text">
              读取账号状态失败，请重试后再决定是否注销。为了避免误操作，读取成功前不提供注销入口。
            </Text>
            <View className="ad__retry" onClick={() => void loadStatus()}>
              <Text>重新读取</Text>
            </View>
          </View>
        ) : null}

        {stage === 'active' ? (
          <>
            <View className="ad__card">
              <Text className="ad__card-title">注销前请确认</Text>
              {DELETION_CONSEQUENCES.map((item) => (
                <View className="ad__item" key={item.title}>
                  <Text className="ad__item-title">{item.title}</Text>
                  <Text className="ad__item-detail">{item.detail}</Text>
                </View>
              ))}
            </View>

            <Text className="ad__grouplabel">输入确认词</Text>
            <View className="ad__confirm">
              <Text className="ad__confirm-label">
                请输入「{ACCOUNT_DELETION_CONFIRMATION_PHRASE}」以确认这不是误触
              </Text>
              <Input
                className="ad__input"
                type="text"
                value={typed}
                placeholder={ACCOUNT_DELETION_CONFIRMATION_PHRASE}
                placeholderClass="ad__ph"
                onInput={(event) => {
                  setTyped(event.detail.value)
                  setNotice(null)
                }}
              />
            </View>

            <View className={`ad__danger-card${confirmed && !submitting ? '' : ' is-off'}`}>
              <View className="ad__danger-row" onClick={onSubmit}>
                {submitting ? (
                  <View className="ad__spin" />
                ) : (
                  <Image className="ad__danger-ic" src={ICONS.delete} mode="aspectFit" />
                )}
                <Text>{submitting ? '提交中…' : '申请注销账号'}</Text>
              </View>
            </View>
            <Text className="ad__note">
              存在未完成交易或账号处于封禁中时无法申请，页面会说明具体原因。冷静期内仍可随时撤回。
            </Text>
          </>
        ) : null}

        {stage === 'requested' ? (
          <>
            <View className="ad__state">
              <View className="ad__state-ic">
                <Image className="ad__state-ic-img" src={ICONS.warnInk} mode="aspectFit" />
              </View>
              <Text className="ad__state-title">注销申请已提交</Text>
              <Text className="ad__state-days">{coolingOffText(purgeAt, Date.now())}</Text>
              <Text className="ad__state-text">
                到期后昵称、头像、学号、校园邮箱、手机号与微信绑定会被清除，账号无法再登录。
              </Text>
              {offlined !== null && offlined > 0 ? (
                <Text className="ad__state-text">
                  {`本次已下架 ${offlined} 件在售商品；撤回申请不会自动重新上架。`}
                </Text>
              ) : null}
              <Text className="ad__state-text">
                冷静期内不能发布、留言、聊天或交易；其它设备的登录状态已失效。
              </Text>
            </View>

            <View className={`ad__danger-card${withdrawing ? ' is-off' : ''}`}>
              <View className="ad__danger-row" onClick={onWithdraw}>
                {withdrawing ? (
                  <View className="ad__spin" />
                ) : (
                  <Image className="ad__danger-ic" src={ICONS.refresh} mode="aspectFit" />
                )}
                <Text>{withdrawing ? '撤回中…' : '撤回注销申请'}</Text>
              </View>
            </View>
            <Text className="ad__note">
              撤回后账号恢复正常使用，已经下架的商品需要你手动重新发布。
            </Text>
          </>
        ) : null}

        {notice !== null ? <Text className="ad__error">{notice}</Text> : null}
      </View>
    </View>
  )
}
