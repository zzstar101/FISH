import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { VerifyPanelView, type VerifyPanelViewProps } from './verify-panel-view'

/**
 * 展示层的静态渲染（web-pc 没有 jsdom）。交互逻辑在 `view.ts` / `messages.ts` 里单测，
 * 这里只钉两件渲染层才说得清的事：**已认证态不回显明文邮箱**、**倒计时内重发真的点不动**。
 */
const noop = () => {}

function render(overrides: Partial<VerifyPanelViewProps> = {}): string {
  return renderToStaticMarkup(
    <VerifyPanelView
      code=""
      codeError={null}
      email=""
      emailError={null}
      maskedEmail={null}
      onCodeChange={noop}
      onEmailChange={noop}
      onRetryStatus={noop}
      onSend={noop}
      onVerify={noop}
      secondsLeft={0}
      sending={false}
      stage="unverified"
      verifiedAt={null}
      verifying={false}
      {...overrides}
    />,
  )
}

function disabledCount(html: string): number {
  return (html.match(/disabled=""/g) ?? []).length
}

test('未认证态给出邮箱输入、域名要求与获取验证码', () => {
  const html = render()

  expect(html).toContain('校园认证')
  expect(html).toContain('type="email"')
  expect(html).toContain('获取验证码')
  expect(html).toContain('@gzasc.edu.cn')
})

test('已发码态给验证码输入，倒计时内「完成认证」与「重新发送」都点不动', () => {
  const waiting = render({
    stage: 'codeSent',
    email: 'zhangsan@gzasc.edu.cn',
    secondsLeft: 42,
  })

  // React 的服务端渲染输出保留 camelCase（`inputMode` / `maxLength`），不是 DOM 上的小写属性名。
  expect(waiting).toContain('inputMode="numeric"')
  expect(waiting).toContain('maxLength="6"')
  expect(waiting).toContain('重新发送 (42s)')
  // 码没填完 + 倒计时未走完 → 两个按钮都禁用。
  expect(disabledCount(waiting)).toBe(2)

  const ready = render({
    stage: 'codeSent',
    email: 'zhangsan@gzasc.edu.cn',
    code: '123456',
    secondsLeft: 0,
  })
  expect(ready).toContain('重新发送')
  expect(ready).not.toContain('重新发送 (')
  expect(disabledCount(ready)).toBe(0)
})

test('已认证态只展示脱敏邮箱与认证日期，且不再给输入框', () => {
  const html = render({
    stage: 'verified',
    maskedEmail: 'z***@gzasc.edu.cn',
    verifiedAt: '2026-10-01T02:03:04.000Z',
  })

  expect(html).toContain('z***@gzasc.edu.cn')
  expect(html).toContain('2026-10-01')
  expect(html).toContain('已认证')
  // 明文邮箱与输入框都必须消失：已认证用户没有可填的东西。
  expect(html).not.toContain('zhangsan@gzasc.edu.cn')
  expect(html).not.toContain('type="email"')
})

test('状态加载失败给出重试，而不是永远转圈', () => {
  const html = render({ stage: 'error' })

  expect(html).toContain('认证状态加载失败')
  expect(html).toContain('重试')
  expect(html).not.toContain('正在读取认证状态')
})

test('错误文案落到对应字段的行内提示上', () => {
  const html = render({
    stage: 'codeSent',
    email: 'zhangsan@gzasc.edu.cn',
    emailError: '必须是 @gzasc.edu.cn 教育邮箱',
    codeError: '验证码已被使用，请重新获取',
  })

  expect(html).toContain('必须是 @gzasc.edu.cn 教育邮箱')
  expect(html).toContain('验证码已被使用，请重新获取')
})
