import { LoginRequestSchema } from '@fish/contracts/auth/session'
import { Checkbox } from '@fish/ui/checkbox'
import { Label } from '@fish/ui/label'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { describeAuthFailure } from '../features/auth/error-messages'
import { AuthPageShell, FormAlert, SubmitButton, TextField } from '../features/auth/form'
import { useLogin } from '../features/auth/queries'
import { type FieldErrors, issuesToFieldErrors } from '../lib/form-errors'
import { sanitizeRedirect } from '../lib/redirect'

/** `redirect` 必须是可选：标成必填会让 `<Link to="/login">` 也要求传 search。 */
type LoginSearch = { redirect?: string }

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect } = Route.useSearch()
  const login = useLogin()
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [agreed, setAgreed] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  const target = sanitizeRedirect(redirect)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    // 与后端同一份 zod 契约做行内校验，字段名与规则天然一致（契约第 5 节）。
    const parsed = LoginRequestSchema.safeParse({ studentNo, password })
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues))
      return
    }
    if (!agreed) {
      setFormError('请先阅读并同意《用户协议》和《隐私政策》')
      return
    }

    setFieldErrors({})
    login.mutate(parsed.data, {
      // `target` 是任意站内路径，可能尚未在本版路由表里；整页跳转能保证
      // 登录 cookie 生效后的应用状态是干净的，也不会踩 SPA 的未知路由。
      onSuccess: () => window.location.assign(target),
      onError: (error) => {
        const failure = describeAuthFailure(error)
        setFieldErrors(failure.fieldErrors ?? {})
        setFormError(failure.formError ?? null)
      },
    })
  }

  return (
    <AuthPageShell
      description="同校面交 · 让闲置在校园里流动起来"
      footer={
        <p className="mt-4 text-center text-ink-3 text-xs leading-relaxed">
          登录接口来自 #3 冻结契约（学号 + 密码,httpOnly cookie）
        </p>
      }
      iconSrc="/brand-fish.png"
      title={
        <img alt="鱼小应 YUXIAOYING" className="mx-auto h-10 w-auto" src="/brand-wordmark.png" />
      }
    >
      <form className="space-y-4" noValidate onSubmit={handleSubmit}>
        {formError !== null && <FormAlert message={formError} />}

        <TextField
          autoComplete="username"
          error={fieldErrors.studentNo}
          inputMode="numeric"
          label="学号"
          onChange={(event) => setStudentNo(event.target.value)}
          placeholder="12 位学号"
          value={studentNo}
        />
        <TextField
          autoComplete="current-password"
          error={fieldErrors.password}
          label="密码"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="8–32 位"
          type="password"
          value={password}
        />

        <Label className="flex items-start gap-2 text-ink-2 text-xs">
          <Checkbox
            checked={agreed}
            className="mt-0.5"
            onCheckedChange={(checked) => setAgreed(checked === true)}
          />
          <span>
            我已阅读并同意 <span className="text-brand">《用户协议》</span> 和{' '}
            <span className="text-brand">《隐私政策》</span>
          </span>
        </Label>

        <SubmitButton pending={login.isPending}>登录</SubmitButton>
      </form>

      <p className="mt-4 text-center text-ink-3 text-sm">
        还没有账号？
        <Link className="font-medium text-brand" to="/register">
          注册
        </Link>
      </p>
    </AuthPageShell>
  )
}
