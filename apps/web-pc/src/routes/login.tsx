import { LoginRequestSchema } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Check } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { describeAuthFailure, toAuthFieldErrors } from '../features/auth/error-messages'
import { AuthPageShell, FormAlert, SubmitButton, TextField } from '../features/auth/form'
import { useLogin } from '../features/auth/queries'
import type { FieldErrors } from '../lib/form-errors'
import { sanitizeRedirect } from '../lib/redirect'

type LoginSearch = { redirect?: string }

const LOGIN_TRANSITION_MS = 420

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect } = Route.useSearch()
  const navigate = useNavigate()
  const login = useLogin()
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [transitionUser, setTransitionUser] = useState<Me | null>(null)
  const target = sanitizeRedirect(redirect)

  useEffect(() => {
    if (transitionUser === null) return

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      void navigate({ href: target, replace: true })
      return
    }

    const timer = window.setTimeout(() => {
      void navigate({ href: target, replace: true, viewTransition: true })
    }, LOGIN_TRANSITION_MS)

    return () => window.clearTimeout(timer)
  }, [navigate, target, transitionUser])

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
      onSuccess: (user) => setTransitionUser(user),
      onError: (error) => {
        const failure = describeAuthFailure(error)
        setFieldErrors(failure.fieldErrors ?? {})
        setFormError(failure.formError ?? null)
      },
    })
  }

  return (
    <>
      <AuthPageShell
        description="用 12 位学号和密码继续进入鱼小应。你的发布、消息和订单，会在登录后回到原来的位置。"
        footer={
          <p className="mt-7 text-center text-ink-3 text-sm">
            还没有账号？
            <Link
              className="ml-1 font-medium text-brand hover:text-lavender"
              search={{ redirect }}
              to="/register"
            >
              注册
            </Link>
          </p>
        }
        title="登录鱼小应"
      >
        <form className="space-y-6" noValidate onSubmit={handleSubmit}>
          {formError !== null ? <FormAlert message={formError} /> : null}
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
          <SubmitButton
            className="group/auth-submit"
            disabled={transitionUser !== null}
            pending={login.isPending}
            pendingLabel="正在登录…"
          >
            登录
            <ArrowRight className="size-4 transition-transform group-hover/auth-submit:translate-x-0.5" />
          </SubmitButton>
        </form>
      </AuthPageShell>
      {transitionUser === null ? null : (
        <LoginSuccessTransition nickname={transitionUser.nickname} />
      )}
    </>
  )
}

function LoginSuccessTransition({ nickname }: { nickname: string }) {
  return (
    <div aria-live="polite" className="auth-transition" role="status">
      <div className="auth-transition__card">
        <div className="auth-transition__icon">
          <Check className="size-5" />
        </div>
        <p className="mt-5 font-semibold text-lg">已登录</p>
        <p className="mt-1 max-w-full truncate text-ink-3 text-sm">欢迎回来，{nickname}</p>
        <div aria-hidden className="auth-transition__line mt-6">
          <span />
        </div>
      </div>
    </div>
  )
}
