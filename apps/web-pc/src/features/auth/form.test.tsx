import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthPageShell, CheckboxField, SubmitButton, TextField } from './form'

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

test('勾选框渲染选中态与禁用态', () => {
  const checked = renderToStaticMarkup(
    <CheckboxField checked label="记住账号密码" onCheckedChange={() => {}} />,
  )
  expect(checked).toContain('记住账号密码')
  expect(checked).toContain('data-state="checked"')
  expect(checked).not.toContain('disabled')

  const disabled = renderToStaticMarkup(
    <CheckboxField checked={false} disabled label="自动登录" onCheckedChange={() => {}} />,
  )
  expect(disabled).toContain('自动登录')
  expect(disabled).toContain('disabled')
  expect(disabled).not.toContain('data-state="checked"')
})
