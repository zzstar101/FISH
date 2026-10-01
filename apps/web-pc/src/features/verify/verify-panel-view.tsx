import { CAMPUS_EMAIL_DOMAIN } from '@fish/contracts/auth/verification'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { MailCheck, ShieldCheck } from 'lucide-react'
import { useId } from 'react'
import { canRequestCode, formatVerifiedDate, isCodeComplete, type VerifyStage } from './view'

/**
 * 校园认证面板的展示层（#380）。**props 驱动、不 import router 也不读 query**：
 * web-pc 没有 jsdom，页面级验证只能靠 `renderToStaticMarkup`，展示层越笨越好测
 * （用例见 `./verify-panel-view.test.tsx`）。
 *
 * 已认证态只渲染服务端下发的 `maskedEmail`（`g***@gzasc.edu.cn`），
 * 组件不持有也不回显明文邮箱。
 */
export type VerifyPanelViewProps = {
  stage: VerifyStage
  /** 服务端脱敏邮箱；未绑定为 null。 */
  maskedEmail: string | null
  /** 认证时间（ISO）；未认证为 null。 */
  verifiedAt: string | null
  email: string
  code: string
  emailError: string | null
  codeError: string | null
  sending: boolean
  verifying: boolean
  /** 距可重发的剩余秒数，0 表示可重发。 */
  secondsLeft: number
  onEmailChange: (value: string) => void
  onCodeChange: (value: string) => void
  onSend: () => void
  onVerify: () => void
  /** `stage === 'error'` 时的重试入口。 */
  onRetryStatus: () => void
}

export function VerifyPanelView({
  stage,
  maskedEmail,
  verifiedAt,
  email,
  code,
  emailError,
  codeError,
  sending,
  verifying,
  secondsLeft,
  onEmailChange,
  onCodeChange,
  onSend,
  onVerify,
  onRetryStatus,
}: VerifyPanelViewProps) {
  const emailId = useId()
  const emailErrorId = `${emailId}-error`
  const codeId = useId()
  const codeErrorId = `${codeId}-error`

  return (
    <div className="mx-auto w-full max-w-[560px] space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">校园认证</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          用学校邮箱验证教育邮箱归属，公开页面只展示认证徽章。
        </p>
      </div>

      {stage === 'loading' ? <LoadingState label="正在读取认证状态…" /> : null}

      {stage === 'error' ? (
        <Card className="gap-0 border border-line p-6">
          <ErrorState message="认证状态加载失败" onRetry={onRetryStatus} />
        </Card>
      ) : null}

      {stage === 'verified' ? (
        <Card className="gap-0 border border-line p-6">
          <div className="flex items-center gap-2.5">
            <Badge shape="pill" variant="success">
              已认证
            </Badge>
            <span className="text-ink-3 text-sm">完成于 {formatVerifiedDate(verifiedAt)}</span>
          </div>
          <p className="mt-4 text-sm">
            认证邮箱：<span className="font-medium">{maskedEmail ?? '—'}</span>
          </p>
          <p className="mt-3 text-ink-3 text-xs leading-5">
            公开页面只展示认证徽章，不展示邮箱、学号与班级；当前暂不支持自助更换认证邮箱。
          </p>
        </Card>
      ) : null}

      {stage === 'unverified' || stage === 'codeSent' ? (
        <Card className="gap-0 border border-line p-6">
          <Field className="gap-1.5" data-invalid={emailError !== null}>
            <FieldLabel className="text-ink-2 text-sm" htmlFor={emailId}>
              校园邮箱
            </FieldLabel>
            <Input
              aria-describedby={emailError === null ? undefined : emailErrorId}
              aria-invalid={emailError === null ? undefined : true}
              autoComplete="email"
              // 发码在途时锁住输入框：发码成功会把界面推进到「填验证码」并回填发出请求的地址，
              // 若此时允许编辑，用户刚敲的地址会被静默覆盖成旧的那个。
              disabled={sending}
              id={emailId}
              inputMode="email"
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder={`如 zhangsan${CAMPUS_EMAIL_DOMAIN}`}
              type="email"
              value={email}
            />
            {emailError === null ? null : <FieldError id={emailErrorId}>{emailError}</FieldError>}
          </Field>

          {stage === 'unverified' ? (
            <Button className="mt-4 w-full" disabled={sending} onClick={onSend} type="button">
              {sending ? '正在发送…' : '获取验证码'}
            </Button>
          ) : null}

          {stage === 'codeSent' ? (
            <div className="mt-4 space-y-4">
              <Field className="gap-1.5" data-invalid={codeError !== null}>
                <FieldLabel className="text-ink-2 text-sm" htmlFor={codeId}>
                  验证码
                </FieldLabel>
                <Input
                  aria-describedby={codeError === null ? undefined : codeErrorId}
                  aria-invalid={codeError === null ? undefined : true}
                  autoComplete="one-time-code"
                  id={codeId}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => onCodeChange(event.target.value)}
                  placeholder="6 位数字"
                  value={code}
                />
                {codeError === null ? (
                  <FieldDescription className="text-xs">
                    验证码已发送，请到校园邮箱查收。
                  </FieldDescription>
                ) : (
                  <FieldError id={codeErrorId}>{codeError}</FieldError>
                )}
              </Field>

              <div className="flex gap-3">
                <Button
                  className="flex-1"
                  disabled={verifying || !isCodeComplete(code)}
                  onClick={onVerify}
                  type="button"
                >
                  {verifying ? '正在验证…' : '完成认证'}
                </Button>
                <Button
                  disabled={!canRequestCode({ pending: sending, secondsLeft })}
                  onClick={onSend}
                  type="button"
                  variant="outline"
                >
                  {sending
                    ? '正在发送…'
                    : secondsLeft > 0
                      ? `重新发送 (${secondsLeft}s)`
                      : '重新发送'}
                </Button>
              </div>
            </div>
          ) : null}

          <p className="mt-5 text-ink-3 text-xs leading-5">
            认证信息仅用于核验教育邮箱，不会公开展示邮箱、学号与班级。
          </p>
        </Card>
      ) : null}

      {stage === 'unverified' ? (
        <p className="flex items-start gap-1.5 text-ink-3 text-xs leading-5">
          <MailCheck className="mt-0.5 size-3.5 shrink-0" />
          只接受 {CAMPUS_EMAIL_DOMAIN} 后缀的校园邮箱。
        </p>
      ) : null}

      {stage === 'verified' ? (
        <p className="flex items-start gap-1.5 text-ink-3 text-xs leading-5">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          认证状态变更后，全站徽章会立即同步，无需重新登录。
        </p>
      ) : null}
    </div>
  )
}
