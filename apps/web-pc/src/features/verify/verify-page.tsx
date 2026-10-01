import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { currentSessionGeneration } from '../../lib/session-cache'
import { useAuth } from '../auth/auth-provider'
import {
  CAMPUS_EMAIL_REQUIREMENT,
  fetchVerificationStatus,
  isCampusEmail,
  sendVerificationCode,
  verifyCampusCode,
} from './api'
import { sendErrorMessage, verifyErrorMessage, verifyNeedsResend } from './messages'
import { applyVerificationResult, verificationStatusKey } from './queries'
import { VerifyPanelView } from './verify-panel-view'
import { RESEND_COOLDOWN_MS, resendSecondsLeft, stageFromStatus, type VerifyStage } from './view'

/**
 * 校园认证页（#380）。三个端点（发码 / 校验 / 状态）整段挂 `requireAuth`，
 * 登录守卫与 PC 外壳由 `routes/__root.tsx` 统一覆盖，本页不再自己判登录。
 */
export function VerifyPage() {
  const { me } = useAuth()
  if (!me) return null
  // 与 `ProfilePage` 同构：换号时整体重建，表单状态不会跨账号残留。
  return <VerifyContent key={me.id} ownerId={me.id} />
}

function VerifyContent({ ownerId }: { ownerId: string }) {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeSent, setCodeSent] = useState(false)
  const [resendAt, setResendAt] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const status = useQuery({
    queryKey: verificationStatusKey(),
    queryFn: fetchVerificationStatus,
    staleTime: 30_000,
  })

  // 倒计时只在真的有发码之后才走：进页面**不发任何请求**，刷新页面也不会自动补发
  // （补发会扣服务端配额）。见 `view.ts` 的 `RESEND_COOLDOWN_MS`。
  useEffect(() => {
    if (resendAt === null || Date.now() >= resendAt) return
    const timer = setInterval(() => {
      const now = Date.now()
      setNowMs(now)
      // 到点就停表：否则停在页面上会每秒空转重渲染一次，直到组件卸载。
      if (now >= resendAt) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [resendAt])

  const secondsLeft = resendSecondsLeft(nowMs, resendAt)
  const stage: VerifyStage = status.isError ? 'error' : stageFromStatus(status.data, codeSent)

  const send = useMutation({
    mutationFn: sendVerificationCode,
    onMutate: () => ({ generation: currentSessionGeneration() }),
  })

  const verify = useMutation({
    mutationFn: (input: { email: string; code: string }) =>
      verifyCampusCode(input.email, input.code),
    onMutate: () => ({ generation: currentSessionGeneration() }),
    onSuccess: (result, _input, context) => {
      // 迟到的响应不能把上一个账号的认证状态写进当前会话（与 profile/queries.ts 同一守卫）。
      if (context.generation !== currentSessionGeneration()) return
      void applyVerificationResult(queryClient, ownerId, result)
    },
  })

  function handleEmailChange(value: string) {
    setEmail(value)
    setEmailError(null)
    if (!codeSent) return
    // 改了收件邮箱，手上这枚码就对不上了：退回未发码态，别让用户拿旧码去撞 CODE_INVALID。
    setCodeSent(false)
    setCode('')
    setCodeError(null)
    setResendAt(null)
  }

  function handleSend() {
    setEmailError(null)
    setCodeError(null)
    const trimmed = email.trim()
    // 域白名单在提交前收口（契约 `CampusEmailSchema`）：不给服务端 422/500 的机会。
    if (!isCampusEmail(trimmed)) {
      setEmailError(CAMPUS_EMAIL_REQUIREMENT)
      return
    }
    send.mutate(trimmed, {
      onSuccess: () => {
        setEmail(trimmed)
        setCodeSent(true)
        setCode('')
        setNowMs(Date.now())
        setResendAt(Date.now() + RESEND_COOLDOWN_MS)
      },
      onError: (error) => {
        setEmailError(sendFailureMessage(error))
        // 服务端认定该账号已认证：以服务端状态为准，别让用户对着输入框干瞪眼。
        if (error instanceof ApiError && error.code === 'ALREADY_VERIFIED') void status.refetch()
      },
    })
  }

  function handleVerify() {
    setEmailError(null)
    setCodeError(null)
    verify.mutate(
      { email: email.trim(), code },
      {
        onError: (error) => {
          const errorCode = error instanceof ApiError ? error.code : ''
          setCodeError(verifyFailureMessage(error))
          if (verifyNeedsResend(errorCode)) {
            // 这枚码已不可用（过期 / 已用 / 尝试过多）：解锁重发，否则用户被自己的倒计时锁住。
            setCode('')
            setResendAt(null)
          }
          if (errorCode === 'ALREADY_VERIFIED') void status.refetch()
        },
      },
    )
  }

  return (
    <VerifyPanelView
      code={code}
      codeError={codeError}
      email={email}
      emailError={emailError}
      maskedEmail={status.data?.maskedEmail ?? null}
      onCodeChange={(value) => {
        setCode(value.replace(/\D/g, '').slice(0, 6))
        setCodeError(null)
      }}
      onEmailChange={handleEmailChange}
      onRetryStatus={() => void status.refetch()}
      onSend={handleSend}
      onVerify={handleVerify}
      secondsLeft={secondsLeft}
      sending={send.isPending}
      stage={stage}
      verifiedAt={status.data?.verifiedAt ?? null}
      verifying={verify.isPending}
    />
  )
}

/** 发码失败的文案：契约错误码优先，网络/未知错误兜底。 */
function sendFailureMessage(error: unknown): string {
  if (error instanceof ApiError) return sendErrorMessage(error.code, error.message)
  return '网络异常，请稍后重试'
}

/** 校验失败的文案：口径同 `sendFailureMessage`。 */
function verifyFailureMessage(error: unknown): string {
  if (error instanceof ApiError) return verifyErrorMessage(error.code, error.message)
  return '网络异常，请稍后重试'
}
