import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthPageShell, SubmitButton, TextField } from './form'

test('登录请求中禁用按钮并展示可读的加载状态', () => {
  const html = renderToStaticMarkup(
    <SubmitButton pending variant="login">
      登录
    </SubmitButton>,
  )

  expect(html).toContain('disabled=""')
  expect(html).toContain('正在连接校园…')
  expect(html).toContain('aria-hidden="true"')
  expect(html).not.toContain('登录</button>')
})

test('字段错误与输入框关联，登录与注册各自使用独立外壳', () => {
  const field = renderToStaticMarkup(<TextField error="学号格式不正确" label="学号" />)
  const id = field.match(/aria-describedby="([^"]+)"/)?.[1]
  expect(id).toBeDefined()
  expect(field).toContain(`id="${id}"`)
  expect(field).toContain('学号格式不正确')

  const registerShell = renderToStaticMarkup(
    <AuthPageShell description="注册说明" title="注册鱼小应">
      <span>注册表单</span>
    </AuthPageShell>,
  )
  expect(registerShell).toContain('注册表单')
  expect(registerShell).toContain('auth-register-page')
  expect(registerShell).not.toContain('auth-glass-card')

  const loginShell = renderToStaticMarkup(
    <AuthPageShell description="登录说明" title="登录鱼小应" variant="login">
      <span>登录表单</span>
    </AuthPageShell>,
  )
  expect(loginShell).toContain('登录表单')
  expect(loginShell).toContain('auth-glass-card')
  expect(loginShell).not.toContain('auth-register-page')
})
