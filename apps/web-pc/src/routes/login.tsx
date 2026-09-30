import { LoginRequestSchema } from '@fish/contracts/auth/session'
import { Checkbox } from '@fish/ui/checkbox'
import { Label } from '@fish/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { INITIAL_LOGIN_AGREEMENT_ACCEPTED } from '../features/auth/agreement'
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
import { ScanLoginPanel } from '../features/auth/scan-login'
import { type AuthSubmissionGate, createAuthSubmissionGate } from '../features/auth/submission-gate'
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
  const [tab, setTab] = useState<'scan' | 'password'>('scan')
  const [agreed, setAgreed] = useState(INITIAL_LOGIN_AGREEMENT_ACCEPTED)
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
      <Tabs
        className="gap-4"
        onValueChange={(value) => {
          if (!submitting) setTab(value as 'scan' | 'password')
        }}
        value={tab}
      >
        <TabsList>
          <TabsTrigger disabled={submitting} value="scan">
            扫码登录
          </TabsTrigger>
          <TabsTrigger disabled={submitting} value="password">
            账号密码
          </TabsTrigger>
        </TabsList>

        <Label className="flex items-start gap-2 text-[#527281] text-xs">
          <Checkbox
            checked={agreed}
            className="mt-0.5"
            onCheckedChange={(checked) => setAgreed(checked === true)}
          />
          <span>
            我已阅读并同意 <span className="text-[#1677a1]">《用户协议》</span> 和{' '}
            <span className="text-[#1677a1]">《隐私政策》</span>
          </span>
        </Label>

        {/* forceMount + data-[state=inactive]:hidden：切到密码页不清掉扫码轮询状态，
            反之亦然——两个面板共享同一把提交闸，切页时也不丢各自的填写进度。 */}
        <TabsContent className="data-[state=inactive]:hidden" forceMount value="scan">
          <ScanLoginPanel
            active={tab === 'scan'}
            agreed={agreed}
            claimSubmission={submissionGate.claim}
            target={target}
          />
        </TabsContent>
        <TabsContent className="data-[state=inactive]:hidden" forceMount value="password">
          <PasswordLoginForm
            agreed={agreed}
            claimSubmission={submissionGate.claim}
            submitting={submitting}
            target={target}
          />
        </TabsContent>
      </Tabs>
    </AuthPageShell>
  )
}

function PasswordLoginForm({
  agreed,
  claimSubmission,
  submitting,
  target,
}: {
  agreed: boolean
  claimSubmission: AuthSubmissionGate['claim']
  submitting: boolean
  target: string
}) {
  const login = useLogin()
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [autoLogin, setAutoLogin] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  // 自动登录每次进页只尝试一次；StrictMode 会双跑 effect，用 ref 挡住第二次。
  const autoLoginAttempted = useRef(false)

  // 挂载时回填本机记住的凭据；勾了自动登录就代用户提交一次。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 挂载一次性读取本机凭据，login/target/claimSubmission 取首挂值即可
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
    // 自动登录也走同一把提交闸：pending 期间两个面板都不能再提交、也不能切页。
    const finishSubmission = claimSubmission()
    if (finishSubmission === null) return
    login.mutate(
      { password: decision.password, studentNo: decision.studentNo },
      {
        onSuccess: () => window.location.assign(target),
        onError: (error) => {
          finishSubmission()
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
    if (!agreed) {
      setFormError('请先阅读并同意《用户协议》和《隐私政策》')
      return
    }

    const finishSubmission = claimSubmission()
    if (finishSubmission === null) return
    setFieldErrors({})
    login.mutate(parsed.data, {
      // `target` 是任意站内路径，可能尚未在本版路由表里；整页跳转能保证
      // 登录 cookie 生效后的应用状态是干净的，也不会踩 SPA 的未知路由。
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
        window.location.assign(target)
      },
      onError: (error) => {
        finishSubmission()
        const failure = describeAuthFailure(error)
        setFieldErrors(failure.fieldErrors ?? {})
        setFormError(failure.formError ?? null)
      },
    })
  }

  return (
    <form aria-busy={login.isPending} className="space-y-5" noValidate onSubmit={handleSubmit}>
      {formError !== null ? <FormAlert message={formError} variant="login" /> : null}
      <TextField
        autoComplete="username"
        disabled={submitting || login.isPending}
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
        disabled={submitting || login.isPending}
        error={fieldErrors.password}
        label="密码"
        onChange={(event) => setPassword(event.target.value)}
        placeholder="8–32 位"
        type="password"
        value={password}
        variant="login"
      />
      <div className="flex items-center gap-6 pl-1">
        {/* onSuccess 持有的是提交时闭包值，pending 期间必须锁死勾选，否则取消勾选后旧凭据仍会被写回存储 */}
        <CheckboxField
          checked={remember}
          disabled={submitting || login.isPending}
          label="记住账号密码"
          onCheckedChange={handleRememberChange}
        />
        <CheckboxField
          checked={autoLogin}
          disabled={submitting || login.isPending || !remember}
          label="自动登录"
          onCheckedChange={handleAutoLoginChange}
        />
      </div>
      <SubmitButton disabled={submitting} pending={login.isPending} variant="login">
        登录
      </SubmitButton>
      <div aria-live="polite" className="auth-loading-status" role="status">
        {login.isPending ? '正在验证账号，请稍候…' : null}
      </div>
    </form>
  )
}
