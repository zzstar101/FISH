import { RegisterRequestSchema } from '@fish/contracts/auth/session'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { describeAuthFailure } from '../features/auth/error-messages'
import { AuthPageShell, FormAlert, SubmitButton, TextField } from '../features/auth/form'
import { useRegister } from '../features/auth/queries'
import { type FieldErrors, issuesToFieldErrors } from '../lib/form-errors'

export const Route = createFileRoute('/register')({ component: RegisterPage })

function RegisterPage() {
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
      setFieldErrors(issuesToFieldErrors(parsed.error.issues))
      return
    }

    setFieldErrors({})
    register.mutate(parsed.data, {
      // 注册即登录（契约第 1 节），成功后直接进首页，不需要再打 /auth/login。
      onSuccess: () => window.location.assign('/'),
      onError: (error) => {
        const failure = describeAuthFailure(error)
        setFieldErrors(failure.fieldErrors ?? {})
        setFormError(failure.formError ?? null)
      },
    })
  }

  return (
    <AuthPageShell
      // #86 D 节：VERIFIED 只能由教育邮箱验证产生，注册不承诺认证结论
      description="注册后即完成登录。校园认证需另行完成教育邮箱验证"
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
          hint="12 位数字，作为登录账号"
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

      <p className="mt-4 text-center text-ink-3 text-sm">
        已经有账号？
        <Link className="font-medium text-brand" to="/login">
          登录
        </Link>
      </p>
    </AuthPageShell>
  )
}
