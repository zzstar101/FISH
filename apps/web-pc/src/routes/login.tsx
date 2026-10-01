import { Checkbox } from '@fish/ui/checkbox'
import { Label } from '@fish/ui/label'
import { createFileRoute } from '@tanstack/react-router'
import { useLayoutEffect, useState } from 'react'
import { AuthPageShell } from '../features/auth/form'
import { ScanLoginPanel } from '../features/auth/scan-login'
import { createAuthSubmissionGate } from '../features/auth/submission-gate'
import { sanitizeRedirect } from '../lib/redirect'

type LoginSearch = { redirect?: string }

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginPage,
})

/**
 * 登录页只提供微信扫码。账号密码与注册已下线（#391）：账号由小程序侧的微信登录创建，
 * 用户在 PC 上通过扫码把小程序会话兑换成浏览器会话。
 */
function LoginPage() {
  const { redirect } = Route.useSearch()
  const [agreed, setAgreed] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submissionGate] = useState(() => createAuthSubmissionGate(setSubmitting))
  const target = sanitizeRedirect(redirect)

  // 液态玻璃页铺满整屏，需要撤掉 PC 外壳的 1280px 最小宽度，避免窄视口横向滚动。
  useLayoutEffect(() => {
    document.body.classList.add('auth-glass-body')
    return () => document.body.classList.remove('auth-glass-body')
  }, [])

  return (
    <AuthPageShell
      description="用微信扫码登录，开启你的下一次发现。"
      footer={
        <p className="mt-6 text-center text-[#78909b] text-sm leading-6">
          还没有账号？请先在小程序内用微信登录，再回到这里扫码。
        </p>
      }
      title="欢迎回来"
    >
      <Label className="flex items-start gap-2 text-[#527281] text-xs">
        <Checkbox
          checked={agreed}
          className="mt-0.5"
          disabled={submitting}
          onCheckedChange={(checked) => setAgreed(checked === true)}
        />
        <span>
          我已阅读并同意 <span className="text-[#1677a1]">《用户协议》</span> 和{' '}
          <span className="text-[#1677a1]">《隐私政策》</span>
        </span>
      </Label>

      <div className="mt-4">
        <ScanLoginPanel
          active
          agreed={agreed}
          claimSubmission={submissionGate.claim}
          target={target}
        />
      </div>
    </AuthPageShell>
  )
}
