import type {
  MeetupTokenResponse,
  MeetupTokenStatus,
  TransactionDto,
} from '@fish/contracts/transactions/schema'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Input } from '@fish/ui/input'
import { Loader2, QrCode, RefreshCw, ShieldCheck, Ticket } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatRelativeTimeAt } from '../../lib/format'
import {
  classifyRedeemInput,
  meetupIssueFailure,
  meetupRedeemFailure,
  meetupStatusLabel,
  redeemInputMessage,
} from './meetup-view'
import { qrDataUrl } from './qr'
import { useIssueMeetupToken, useMeetupTokenStatus, useRedeemMeetupToken } from './queries'

type Notice = { tone: 'warn' | 'success'; text: string }

export type MeetupPanelViewProps = {
  role: TransactionDto['role']
  status: MeetupTokenStatus | null
  consumedAt: string | null
  token: MeetupTokenResponse | null
  /** 由明文载荷编码出的 data URL；无码时为 null。 */
  qrSrc: string | null
  draft: string
  notice: Notice | null
  issuing: boolean
  redeeming: boolean
  onTakeToken: () => void
  onDraftChange: (value: string) => void
  onRedeem: () => void
}

/**
 * 面交交易码面板的展示层（props 驱动，不碰 hooks —— web-pc 的组件测试惯例）。
 *
 * 两端看到的**不是同一套控件**，这是凭证语义决定的：
 * - 卖家是**出示方**：取码、展示 6 位码与二维码；重新取码是幂等「确保并读取」，不会换码。
 * - 买家是**核销方**：输入 6 位码，或粘贴对方转来的 `fish://meetup/redeem?...` 载荷
 *   （PC 没有摄像头，真机扫码在小程序侧）。
 */
export function MeetupPanelView({
  role,
  status,
  consumedAt,
  token,
  qrSrc,
  draft,
  notice,
  issuing,
  redeeming,
  onTakeToken,
  onDraftChange,
  onRedeem,
}: MeetupPanelViewProps) {
  const isSeller = role === 'seller'
  const busy = issuing || redeeming

  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-brand" />
        <h2 className="font-semibold text-base">面交交易码</h2>
      </div>

      {isSeller ? (
        <>
          <p className="mt-3 text-ink-3 text-sm leading-6">
            当面出示给买家：对方可扫二维码，或输入下面的 6 位码。交易码随本单长期有效，
            交易进入终态时自动失效。
          </p>

          {token === null ? (
            <Button className="mt-5 w-full" disabled={busy} onClick={onTakeToken} type="button">
              {issuing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Ticket className="size-4" />
              )}
              {issuing ? '正在取码…' : '出示交易码'}
            </Button>
          ) : (
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl bg-surface-2 p-5 text-center">
                <p className="text-ink-3 text-xs">6 位交易码</p>
                <p className="mt-2 font-bold text-[34px] tracking-[0.35em] tabular-nums">
                  {token.code}
                </p>
              </div>
              {qrSrc !== null ? (
                <div className="flex flex-col items-center gap-2">
                  <img
                    alt="面交二维码"
                    className="size-44 rounded-xl border border-line bg-white p-2"
                    src={qrSrc}
                  />
                  <p className="text-ink-3 text-xs">也可以让对方用小程序扫这枚码</p>
                </div>
              ) : null}
              <Button
                className="w-full"
                disabled={busy}
                onClick={onTakeToken}
                type="button"
                variant="outline"
              >
                {issuing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                重新取码（码不变）
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-3 text-ink-3 text-sm leading-6">
            对方会当面出示 6 位交易码或二维码。输入交易码即可核销；扫码请用小程序。
          </p>
          <div className="mt-5 space-y-3">
            <Input
              aria-label="交易码"
              disabled={busy}
              id="meetup-code"
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="6 位交易码，或粘贴对方转来的交易码链接"
              value={draft}
            />
            <Button
              className="w-full"
              disabled={busy || draft.trim().length === 0}
              onClick={onRedeem}
              type="button"
            >
              {redeeming ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <QrCode className="size-4" />
              )}
              {redeeming ? '正在核销…' : '核销交易码'}
            </Button>
          </div>
        </>
      )}

      {status !== null ? (
        <p className="mt-4 text-ink-3 text-xs">
          凭证状态：{meetupStatusLabel(status)}
          {consumedAt !== null ? ` · ${formatRelativeTimeAt(consumedAt)}核销` : ''}
        </p>
      ) : null}

      {notice !== null ? (
        <p
          className={`mt-4 rounded-xl px-4 py-3 text-sm ${
            notice.tone === 'success' ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'
          }`}
          role="status"
        >
          {notice.text}
        </p>
      ) : null}
    </Card>
  )
}

type MeetupPanelProps = {
  ownerId: string
  transaction: TransactionDto
  /** 交易可能已进终态（服务端状态与手上这版不一致）时由页面重新取订单。 */
  onStale: () => void
}

/**
 * 容器：接 hooks 与组件状态。
 *
 * 明文码只留在组件状态里、不进任何查询缓存 —— 缓存会被 devtools 与序列化带出去，
 * 而状态端点本身刻意不返回明文。
 *
 * 核销成功后交易仍是待面交：契约用 `nextAction: 'CONFIRM_DELIVERY'` 表达下一步是双方
 * 各确认一次，页面据此引导到已有的「确认完成面交」，这里不代它推进终态。
 */
export function MeetupPanel({ ownerId, transaction, onStale }: MeetupPanelProps) {
  const status = useMeetupTokenStatus(ownerId, transaction.id, true)
  const issue = useIssueMeetupToken(ownerId)
  const redeem = useRedeemMeetupToken(ownerId)
  const [token, setToken] = useState<MeetupTokenResponse | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)

  // 二维码只依赖服务端下发的载荷：编码一次即可，不必每次渲染重画
  const qrSrc = useMemo(() => (token === null ? null : qrDataUrl(token.qrPayload)), [token])

  async function takeToken() {
    setNotice(null)
    try {
      setToken(await issue.mutateAsync(transaction.id))
    } catch (error) {
      const failure = meetupIssueFailure(error)
      setNotice({ tone: 'warn', text: failure.message })
      if (failure.refresh) {
        await status.refetch()
        onStale()
      }
    }
  }

  async function submitRedeem() {
    const input = classifyRedeemInput(draft, transaction.id)
    const inputMessage = redeemInputMessage(input)
    if (inputMessage !== null) {
      setNotice({ tone: 'warn', text: inputMessage })
      return
    }
    if (input.kind !== 'code' && input.kind !== 'qr') return

    setNotice(null)
    try {
      await redeem.mutateAsync({ transactionId: transaction.id, input })
      setDraft('')
      setNotice({
        tone: 'success',
        text: '交易码已核销。接下来请与对方各自点一次「确认完成面交」。',
      })
      await status.refetch()
    } catch (error) {
      const failure = meetupRedeemFailure(error)
      setNotice({ tone: 'warn', text: failure.message })
      if (failure.refresh) {
        await status.refetch()
        onStale()
      }
    }
  }

  return (
    <MeetupPanelView
      consumedAt={status.data?.consumedAt ?? null}
      draft={draft}
      issuing={issue.isPending}
      notice={notice}
      onDraftChange={(value) => {
        setDraft(value)
        setNotice(null)
      }}
      onRedeem={() => void submitRedeem()}
      onTakeToken={() => void takeToken()}
      qrSrc={qrSrc}
      redeeming={redeem.isPending}
      role={transaction.role}
      status={status.data?.status ?? null}
      token={token}
    />
  )
}
