import { LoginRequestSchema } from '@fish/contracts/auth/session'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
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
      description="使用 12 位学号和密码登录 PC Web"
      footer={
        <p className="mt-5 text-center text-ink-3 text-sm">
          还没有账号？
          <Link className="ml-1 font-medium text-brand" search={{ redirect }} to="/register">
            注册
          </Link>
        </p>
      }
      title="登录鱼小应"
    >
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
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
        <SubmitButton pending={login.isPending}>登录</SubmitButton>
      </form>
    </AuthPageShell>
  )
}
