import { RegisterRequestSchema } from '@fish/contracts/auth/session'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useLayoutEffect, useState } from 'react'
import { describeAuthFailure, toAuthFieldErrors } from '../features/auth/error-messages'
import { AuthPageShell, FormAlert, SubmitButton, TextField } from '../features/auth/form'
import { useRegister } from '../features/auth/queries'
import type { FieldErrors } from '../lib/form-errors'
import { sanitizeRedirect } from '../lib/redirect'

type RegisterSearch = { redirect?: string }

export const Route = createFileRoute('/register')({
  validateSearch: (search: Record<string, unknown>): RegisterSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: RegisterPage,
})

function RegisterPage() {
  const { redirect } = Route.useSearch()
  const register = useRegister()

  // 与登录页同口径：玻璃页不继承 PC 外壳的 1280px 最小宽度，窄视口走自身断点。
  useLayoutEffect(() => {
    document.body.classList.add('auth-glass-body')
    return () => document.body.classList.remove('auth-glass-body')
  }, [])
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    const parsed = RegisterRequestSchema.safeParse({ studentNo, password, nickname })
    if (!parsed.success) {
      setFieldErrors(toAuthFieldErrors(parsed.error.issues))
      return
    }

    setFieldErrors({})
    register.mutate(parsed.data, {
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
      description="注册后自动登录。校园认证需另行完成教育邮箱验证。"
      footer={
        <p className="mt-5 text-center text-[#78909b] text-sm">
          已经有账号？
          <Link
            className="ml-1 font-semibold text-[#1677a1] underline decoration-[#a7dbe0] underline-offset-4"
            search={{ redirect }}
            to="/login"
          >
            登录
          </Link>
        </p>
      }
      title="注册鱼小应"
    >
      <form aria-busy={register.isPending} className="space-y-5" noValidate onSubmit={handleSubmit}>
        {formError !== null ? <FormAlert message={formError} /> : null}
        <TextField
          autoComplete="username"
          disabled={register.isPending}
          error={fieldErrors.studentNo}
          hint="12 位数字"
          inputMode="numeric"
          label="学号"
          onChange={(event) => setStudentNo(event.target.value)}
          placeholder="例如 202101000001"
          value={studentNo}
        />
        <TextField
          autoComplete="new-password"
          disabled={register.isPending}
          error={fieldErrors.password}
          label="密码"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="8–32 位"
          type="password"
          value={password}
        />
        <TextField
          autoComplete="nickname"
          disabled={register.isPending}
          error={fieldErrors.nickname}
          label="昵称"
          onChange={(event) => setNickname(event.target.value)}
          placeholder="1–20 个字符"
          value={nickname}
        />
        <SubmitButton pending={register.isPending}>注册并登录</SubmitButton>
        <div aria-live="polite" className="auth-loading-status" role="status">
          {register.isPending ? '正在创建账号，请稍候…' : null}
        </div>
      </form>
    </AuthPageShell>
  )
}
