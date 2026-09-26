import { RegisterRequestSchema } from '@fish/contracts/auth/session'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
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
        <p className="mt-5 text-center text-ink-3 text-sm">
          已经有账号？
          <Link className="ml-1 font-medium text-brand" search={{ redirect }} to="/login">
            登录
          </Link>
        </p>
      }
      title="注册鱼小应"
    >
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        {formError !== null ? <FormAlert message={formError} /> : null}
        <TextField
          autoComplete="username"
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
          error={fieldErrors.password}
          label="密码"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="8–32 位"
          type="password"
          value={password}
        />
        <TextField
          autoComplete="nickname"
          error={fieldErrors.nickname}
          label="昵称"
          onChange={(event) => setNickname(event.target.value)}
          placeholder="1–20 个字符"
          value={nickname}
        />
        <SubmitButton pending={register.isPending}>注册并登录</SubmitButton>
      </form>
    </AuthPageShell>
  )
}
