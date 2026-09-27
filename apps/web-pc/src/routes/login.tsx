import { LoginRequestSchema } from '@fish/contracts/auth/session'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useLayoutEffect, useState } from 'react'
import { describeAuthFailure, toAuthFieldErrors } from '../features/auth/error-messages'
import { AuthPageShell, FormAlert, SubmitButton, TextField } from '../features/auth/form'
import { useLogin } from '../features/auth/queries'
import type { FieldErrors } from '../lib/form-errors'
import { sanitizeRedirect } from '../lib/redirect'

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

  // 液态玻璃页铺满整屏，需要撤掉 PC 外壳的 1280px 最小宽度，避免窄视口横向滚动。
  useLayoutEffect(() => {
    document.body.classList.add('auth-glass-body')
    return () => document.body.classList.remove('auth-glass-body')
  }, [])

  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    const parsed = LoginRequestSchema.safeParse({ studentNo, password })
    if (!parsed.success) {
      setFieldErrors(toAuthFieldErrors(parsed.error.issues))
      return
    }

    setFieldErrors({})
    login.mutate(parsed.data, {
      onSuccess: () => window.location.assign(sanitizeRedirect(redirect)),
      onError: (error) => {
        const failure = describeAuthFailure(error)
        setFieldErrors(failure.fieldErrors ?? {})
        setFormError(failure.formError ?? null)
      },
    })
  }

  return (
    <AuthPageShell
      description="用校园账号登录，开启你的下一次发现。"
      footer={
        <p className="mt-6 text-center text-[#78909b] text-sm">
          还没有账号？
          <Link
            className="ml-1 font-semibold text-[#1677a1] underline decoration-[#a7dbe0] underline-offset-4"
            search={{ redirect }}
            to="/register"
          >
            注册
          </Link>
        </p>
      }
      title="欢迎回来"
      variant="login"
    >
      <form aria-busy={login.isPending} className="space-y-5" noValidate onSubmit={handleSubmit}>
        {formError !== null ? <FormAlert message={formError} variant="login" /> : null}
        <TextField
          autoComplete="username"
          disabled={login.isPending}
          error={fieldErrors.studentNo}
          inputMode="numeric"
          label="学号"
          onChange={(event) => setStudentNo(event.target.value)}
          placeholder="12 位学号"
          value={studentNo}
          variant="login"
        />
        <TextField
          autoComplete="current-password"
          disabled={login.isPending}
          error={fieldErrors.password}
          label="密码"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="8–32 位"
          type="password"
          value={password}
          variant="login"
        />
        <SubmitButton pending={login.isPending} variant="login">
          登录
        </SubmitButton>
        <div aria-live="polite" className="auth-loading-status" role="status">
          {login.isPending ? '正在验证账号，请稍候…' : null}
        </div>
      </form>
    </AuthPageShell>
  )
}
