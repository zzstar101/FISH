import { expect, test } from 'bun:test'

// #657 新增「改邮箱」是可点胶囊，不属于 #634 的不可点 label 档。
test('认证页改邮箱按钮沿用 S 档高度与左右留白', async () => {
  const scss = await Bun.file(
    new URL('../src/pkg-auth/pages/verify/index.scss', import.meta.url),
  ).text()
  const edit = scss.match(/\.verify__edit\s*\{([^}]+)\}/)?.[1] ?? ''
  expect(edit).toContain('min-height: var(--btn-h-sm)')
  expect(edit).toContain('padding: 0 var(--btn-px-sm)')
  expect(edit).toContain('border-radius: var(--r-pill)')
})
