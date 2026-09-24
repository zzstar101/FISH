import { CAMPUS_EMAIL_DOMAIN, type VerificationStatus } from '@fish/contracts/auth/verification'
import { Button } from '@fish/ui/button'
import { Field, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { NavBar } from '@fish/ui/nav-bar'
import { Spinner } from '@fish/ui/spinner'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { AuthBadge } from '../auth/auth-badge'
import { describeAuthFailure } from '../auth/error-messages'
import {
  useSendVerificationCode,
  useVerificationStatus,
  useVerifyCampusEmail,
} from '../auth/verification-queries'

/**
 * 校园认证页（#68）：认证状态 + 教育邮箱验证码流程。
 * 邮箱脱敏展示由后端完成（`maskedEmail`），前端不拿完整邮箱。
 */
export function VerificationPage() {
  const status = useVerificationStatus()

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="校园认证" />
      </div>
      {status.isPending ? <LoadingState /> : null}
      {status.isError ? (
        <ErrorState message="认证状态加载失败" onRetry={() => void status.refetch()} />
      ) : null}
      {status.data ? <VerificationBody status={status.data} /> : null}
    </div>
  )
}

function VerificationBody({ status }: { status: VerificationStatus }) {
  const verified = status.authStatus === 'VERIFIED'

  return (
    <div className="mx-3 mt-4 space-y-4">
      <section className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm">
        {verified ? (
          <ShieldCheck className="size-9 shrink-0 text-brand" />
        ) : (
          <ShieldX className="size-9 shrink-0 text-ink-3" />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-semibold text-[15px]">
            {verified ? '教育邮箱已验证' : '尚未完成教育邮箱验证'}
            <AuthBadge status={status.authStatus} />
          </p>
          <p className="mt-0.5 truncate text-ink-3 text-xs">
            {verified
              ? `绑定邮箱 ${status.maskedEmail ?? ''} · ${formatDateTime(status.verifiedAt)}`
              : '完成认证后，你的商品会带上可信认证徽章'}
          </p>
        </div>
      </section>

      {verified ? null : <VerificationForm />}
    </div>
  )
}

function VerificationForm() {
  const send = useSendVerificationCode()
  const verify = useVerifyCampusEmail()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)

  // 60s 发送间隔与后端限频对齐；倒计时归零前禁用「发送验证码」。
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  const failureOf = (error: unknown) =>
    describeAuthFailure(error).formError ?? '操作失败，请稍后重试'

  function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    send.mutate(
      { email },
      {
        onSuccess: () => setCountdown(60),
        onError: (error) => setFormError(failureOf(error)),
      },
    )
  }

  function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    verify.mutate(
      { email, code },
      {
        onError: (error) => setFormError(failureOf(error)),
      },
    )
  }

  return (
    <section className="space-y-4 rounded-2xl bg-surface p-4 shadow-sm">
      <form className="space-y-3" noValidate onSubmit={handleSend}>
        <Field className="gap-1.5">
          <FieldLabel className="text-ink-2 text-sm" htmlFor="campus-email">
            校园邮箱
          </FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              autoComplete="email"
              className="focus:rounded-full"
              id="campus-email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder={`前缀，如 zhangsan${CAMPUS_EMAIL_DOMAIN}`}
              type="email"
              value={email}
            />
            <Button
              className="shrink-0"
              disabled={countdown > 0 || send.isPending || email.trim().length === 0}
              type="submit"
              variant="secondary"
            >
              {send.isPending ? (
                <Spinner className="size-4" />
              ) : countdown > 0 ? (
                `${countdown}s`
              ) : (
                '发送验证码'
              )}
            </Button>
          </div>
          <p className="text-ink-3 text-xs">仅支持 {CAMPUS_EMAIL_DOMAIN} 结尾的教育邮箱</p>
        </Field>
      </form>

      <form className="space-y-3" noValidate onSubmit={handleVerify}>
        <Field className="gap-1.5">
          <FieldLabel className="text-ink-2 text-sm" htmlFor="verification-code">
            验证码
          </FieldLabel>
          <Input
            autoComplete="one-time-code"
            className="focus:rounded-full"
            id="verification-code"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            placeholder="6 位数字"
            value={code}
          />
          <FieldError>{formError ?? undefined}</FieldError>
        </Field>
        <Button
          className="w-full"
          disabled={code.length !== 6 || verify.isPending || email.trim().length === 0}
          type="submit"
        >
          {verify.isPending ? <Spinner className="size-4" /> : '提交认证'}
        </Button>
      </form>

      <p className="text-ink-3 text-xs leading-relaxed">
        验证码 5 分钟内有效，输入即失效；一个校园邮箱只能绑定一个账号。
      </p>
    </section>
  )
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
