import { type DisputeType, MAX_DISPUTE_DETAIL_LENGTH } from '@fish/contracts/disputes/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Text, Textarea, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { createDispute } from '@/features/disputes/api'
import {
  DISPUTE_TYPE_META,
  DISPUTE_TYPE_ORDER,
  disputeFailureText,
  TRANSACTION_STATUS_LABEL,
} from '@/features/disputes/meta'
import { disputeNotFoundCopy, disputeWindowClosed } from '@/features/disputes/view'
import { fetchTransaction } from '@/features/transaction/api'
import { formatYuan } from '@/lib/money'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * 发起交易争议（#497）。
 *
 * ## 入口与去向
 *
 * 从订单详情（`transaction-meetup`）的争议入口进来，带 `transactionId`。提交成功后
 * **`redirectTo` 到争议详情**：发起页没有回去的价值，返回键应回到订单页；若服务端返回
 * `created:false`（同交易已有未决争议），也直接进详情 —— 用户看到的是同一条争议。
 *
 * ## 窗口
 *
 * 终态交易从完成/取消起 30 天内可发起（`PENDING_MEETUP` 无时限）。端上先算一次只是为了
 * 提前禁掉必然 409 的提交，服务端仍会再判（`DISPUTE_WINDOW_CLOSED`）。
 *
 * ## 「其他」必填
 *
 * 契约 `DisputeCreateInputSchema` 对 `OTHER` 要求 `detailText` 非空（trim 后 1..1000 字），
 * 端上同口径校验后再发，避免一次必然 422 的往返。
 */
type LoadState = 'loading' | 'ok' | 'notFound' | 'failed'

export default function DisputeCreatePage() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const router = useRouter<{ transactionId?: string }>()
  const transactionId = router.params.transactionId ?? ''

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [tx, setTx] = useState<TransactionDto | null>(null)
  const [type, setType] = useState<DisputeType | null>(null)
  const [detailText, setDetailText] = useState('')
  const [typeError, setTypeError] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [focused, setFocused] = useState(false)

  const loadEpoch = useRef(0)

  const read = useCallback(async () => {
    if (transactionId === '') {
      setLoadState('notFound')
      return
    }
    const epoch = ++loadEpoch.current
    setLoadState('loading')
    try {
      const dto = await fetchTransaction(transactionId)
      if (epoch !== loadEpoch.current) return
      setTx(dto)
      setLoadState('ok')
    } catch (error) {
      if (epoch !== loadEpoch.current) return
      if (isApiError(error) && error.status === 404) {
        setLoadState('notFound')
        return
      }
      setLoadState('failed')
    }
  }, [transactionId])

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void read()
  }, [authStatus, userId, read])

  const nowMs = Date.now()
  const windowClosed = tx !== null && disputeWindowClosed(tx, nowMs)
  const chosenMeta = type === null ? null : DISPUTE_TYPE_META[type]
  const detailLength = detailText.trim().length

  const submit = () => {
    if (tx === null || submitting) return
    if (windowClosed) {
      setSubmitError(disputeFailureText('DISPUTE_WINDOW_CLOSED'))
      return
    }
    const chosen = type
    if (chosen === null) {
      setTypeError(true)
      return
    }
    const trimmed = detailText.trim()
    if (chosen === 'OTHER' && trimmed === '') {
      setDetailError('类型选「其他」时必须填写说明')
      return
    }
    setDetailError(null)
    setSubmitError(null)
    setSubmitting(true)
    void (async () => {
      try {
        const result = await createDispute({
          transactionId: tx.id,
          type: chosen,
          detailText: trimmed === '' ? undefined : trimmed,
        })
        if (!result.created) {
          void Taro.showToast({ title: '你已发起过这条争议', icon: 'none' })
        }
        void Taro.redirectTo({
          url: `/pkg-trade/pages/dispute-detail/index?id=${encodeURIComponent(result.dispute.id)}`,
        })
      } catch (error) {
        setSubmitError(
          isApiError(error) ? disputeFailureText(error.code) : disputeFailureText(null),
        )
        // 窗口/交易状态可能在填表期间变了：重新拉一次订单，让页面与最新状态一致
        if (isApiError(error) && (error.status === 409 || error.status === 404)) void read()
      } finally {
        setSubmitting(false)
      }
    })()
  }

  if (authStatus !== 'authed') {
    return <AuthRequired restoring={authStatus === 'unknown'} />
  }

  const notFound = disputeNotFoundCopy('create')

  return (
    <View className="dsc">
      <View className="dsc__bg" />
      <TopBar variant="glass" spacer back title="发起" titleEm="争议" />

      <View className="dsc__body">
        {loadState === 'loading' ? (
          <Text className="dsc__loading">正在读取订单…</Text>
        ) : loadState === 'notFound' ? (
          <View className="dsc__emptypad">
            <EmptyState
              title={notFound.title}
              text={notFound.text}
              icon={ICONS.shieldLine}
              actionText="返回"
              onAction={() => {
                void Taro.navigateBack()
              }}
            />
          </View>
        ) : loadState === 'failed' ? (
          <LoadError
            title="订单读取失败"
            text="网络似乎不太顺畅，稍后再试试"
            onRetry={() => {
              void read()
            }}
          />
        ) : tx === null ? (
          <LoadError
            title="订单读取失败"
            text="请稍后重试"
            onRetry={() => {
              void read()
            }}
          />
        ) : (
          <View className="dsc__content">
            {/* 交易摘要：只读，由订单带入 */}
            <View className="dsc__card">
              <Text className="dsc__card-h">这笔交易</Text>
              <Text className="dsc__title">{tx.listing?.title ?? '（未带出商品标题）'}</Text>
              <View className="dsc__sub">
                <Text className="num">{formatYuan(tx.amountCents)}</Text>
                <Text className="dsc__sep">·</Text>
                <Text>{`${tx.role === 'buyer' ? '卖家' : '买家'} ${tx.counterpart.nickname}`}</Text>
                <Text className="dsc__sep">·</Text>
                <Text>{TRANSACTION_STATUS_LABEL[tx.status]}</Text>
              </View>
            </View>

            {windowClosed ? (
              <View className="dsc__warn">
                <Text className="dsc__warn-t">{`交易结束已超过 30 天，不能再发起争议。`}</Text>
                <Text className="dsc__warn-s">
                  争议需要管理员介入处理，超窗口的交易无法再补充核查依据。
                </Text>
              </View>
            ) : (
              <>
                <View className={`dsc__card${typeError ? ' is-err' : ''}`}>
                  <View className="dsc__card-head">
                    <Text className="dsc__card-h">争议类型</Text>
                    <Text className="dsc__req">*</Text>
                  </View>
                  <Text className="dsc__card-sub">选择最接近的一项，平台会按类型核查。</Text>
                  <View className="dsc__opts">
                    {DISPUTE_TYPE_ORDER.map((key) => {
                      const meta = DISPUTE_TYPE_META[key]
                      const on = type === key
                      return (
                        <View
                          key={key}
                          className={`dsc__opt${on ? ' is-on' : ''}`}
                          onClick={() => {
                            setType(key)
                            setTypeError(false)
                            setDetailError(null)
                          }}
                        >
                          <View className={`dsc__radio${on ? ' is-on' : ''}`} />
                          <View className="dsc__opt-main">
                            <Text className="dsc__opt-label">{meta.label}</Text>
                            <Text className="dsc__opt-hint">{meta.hint}</Text>
                          </View>
                        </View>
                      )
                    })}
                  </View>
                  {typeError ? (
                    <View className="dsc__err">
                      <Text>请先选择争议类型</Text>
                    </View>
                  ) : null}
                </View>

                <View className="dsc__card">
                  <View className="dsc__card-head">
                    <Text className="dsc__card-h">详细说明</Text>
                    <Text className="dsc__opt-label">
                      {type === 'OTHER' ? '必填' : '选填'}
                      {` · 最多 ${MAX_DISPUTE_DETAIL_LENGTH} 字`}
                    </Text>
                  </View>
                  <Text className="dsc__card-sub">
                    {chosenMeta?.hint ?? '选一个类型后，这里会提示该写哪些细节。'}
                  </Text>
                  <View className={`dsc__field${focused ? ' is-focus' : ''}`}>
                    <Textarea
                      className="dsc__ta"
                      value={detailText}
                      maxlength={MAX_DISPUTE_DETAIL_LENGTH}
                      placeholder={chosenMeta?.placeholder ?? '写下发生了什么、你的诉求是什么。'}
                      onInput={(event) => {
                        setDetailText(event.detail.value)
                        setDetailError(null)
                      }}
                      onFocus={() => setFocused(true)}
                      onBlur={() => setFocused(false)}
                    />
                    <View className="dsc__fieldfoot">
                      <Text className="dsc__kb">{`${detailLength} / ${MAX_DISPUTE_DETAIL_LENGTH}`}</Text>
                    </View>
                  </View>
                  {detailError !== null ? (
                    <View className="dsc__err">
                      <Text>{detailError}</Text>
                    </View>
                  ) : null}
                </View>

                <View className="dsc__note">
                  <Text className="dsc__note-t">
                    提交后管理员会核查双方材料，结论以「我的争议」里的处理结果为准；同一交易同方向只会有一条未决争议。
                  </Text>
                </View>

                {submitError !== null ? (
                  <View className="dsc__err dsc__err--block">
                    <Text>{submitError}</Text>
                  </View>
                ) : null}

                <View
                  className={`dsc__submit${type !== null && !submitting ? '' : ' is-off'}`}
                  onClick={submit}
                >
                  <Text>{submitting ? '提交中…' : '提交争议'}</Text>
                </View>
              </>
            )}
          </View>
        )}
      </View>
    </View>
  )
}
