import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthPageShell } from './form'

test('登录外壳渲染标题、说明、表单与页脚', () => {
  const html = renderToStaticMarkup(
    <AuthPageShell description="用微信扫码登录" footer={<span>页脚提示</span>} title="欢迎回来">
      <span>扫码面板</span>
    </AuthPageShell>,
  )

  expect(html).toContain('欢迎回来')
  expect(html).toContain('用微信扫码登录')
  expect(html).toContain('扫码面板')
  expect(html).toContain('页脚提示')
  expect(html).toContain('auth-glass-card')
})
