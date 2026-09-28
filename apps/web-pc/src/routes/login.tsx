import { LoginRequestSchema } from '@fish/contracts/auth/session'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { describeAuthFailure, toAuthFieldErrors } from '../features/auth/error-messages'
import {
  AuthPageShell,
  CheckboxField,
  FormAlert,
  SubmitButton,
  TextField,
} from '../features/auth/form'
import { useLogin } from '../features/auth/queries'
import {
  clearRememberedCredentials,
  consumeExplicitLogout,
  decideAutoLogin,
  disableAutoLogin,
  loadRememberedCredentials,
  saveRememberedCredentials,
} from '../features/auth/remembered-credentials'
import { ApiError } from '../lib/api-client'
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
  const [remember, setRemember] = useState(false)
  const [autoLogin, setAutoLogin] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  // 自动登录每次进页只尝试一次；StrictMode 会双跑 effect，用 ref 挡住第二次。
  const autoLoginAttempted = useRef(false)

  // 挂载时回填本机记住的凭据；勾了自动登录就代用户提交一次。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 挂载一次性读取本机凭据，login/redirect 取首挂值即可
  useEffect(() => {
    // 每次挂载只做一次「决策 + 标志消费」；StrictMode 双跑在开头就被短路，
    // 否则第 1 跑消费登出标志后，第 2 跑会因标志丢失而翻转成自动登录。
    if (autoLoginAttempted.current) return
    autoLoginAttempted.current = true
    const logoutMarked = consumeExplicitLogout()
    const stored = loadRememberedCredentials()
    if (stored === null) return
    setStudentNo(stored.studentNo)
    setPassword(stored.password)
    setRemember(true)
    setAutoLogin(stored.autoLogin)
    const decision = decideAutoLogin(stored, logoutMarked, false)
    if (decision.action !== 'submit') return
    login.mutate(
      { password: decision.password, studentNo: decision.studentNo },
      {
        onSuccess: () => window.location.assign(sanitizeRedirect(redirect)),
        onError: (error) => {
          // 凭据已被服务端拒绝（改密等）就关掉自动登录，避免每次进页都报错；
          // 网络抖动等非凭据失败保留开关，凭据本身仍保留。
          if (error instanceof ApiError && error.status === 401) {
            saveRememberedCredentials(disableAutoLogin(stored))
            setAutoLogin(false)
          }
          const failure = describeAuthFailure(error)
          setFieldErrors(failure.fieldErrors ?? {})
          setFormError(failure.formError ?? null)
        },
      },
    )
  }, [])

  function handleRememberChange(next: boolean) {
    setRemember(next)
    if (next) return
    setAutoLogin(false)
    // 直接取消勾选也要立刻清掉本机凭据，不等下一次登录。
    clearRememberedCredentials()
  }

  function handleAutoLoginChange(next: boolean) {
    setAutoLogin(next)
    if (next) setRemember(true)
  }

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
      onSuccess: () => {
        if (remember) {
          saveRememberedCredentials({
            autoLogin,
            password: parsed.data.password,
            studentNo: parsed.data.studentNo,
          })
        } else {
          clearRememberedCredentials()
        }
        window.location.assign(sanitizeRedirect(redirect))
      },
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
        <div className="flex items-center gap-6 pl-1">
          <CheckboxField
            checked={remember}
            label="记住账号密码"
            onCheckedChange={handleRememberChange}
          />
          <CheckboxField
            checked={autoLogin}
            disabled={!remember}
            label="自动登录"
            onCheckedChange={handleAutoLoginChange}
          />
        </div>
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
