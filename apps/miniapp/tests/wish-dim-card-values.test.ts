import { describe, expect, test } from 'bun:test'

/**
 * 终态愿望卡（`.mw.mw--dim`）的材质常量（#346 审查 unresolved）。
 *
 * Owner 拍板的终态口径是「白玻璃垫层 **80%** + `--fg` 灰罩 10%」。这些值以裸 `rgba`
 * 躺在 SCSS 里，抄错不会有任何编译/运行时错误，只是卡片颜色偏一档 —— 而在多层半透明
 * 叠层里，偏一档肉眼几乎定位不到。所以把「垫层必须是 80%」钉在源码上。
 *
 * 断言切到 `.mw.mw--dim` **这一个规则块**，不查整份文件：同文件里还有命中卡的
 * `rgba(255, 255, 255, 0.72)` 和白玻璃的 `0.56`，按整份文件做子串命中挡不住终态卡的
 * 值被换回去。
 */

const WISH_SCSS = new URL('../src/pages/wish/index.scss', import.meta.url)

/** 取 `.mw.mw--dim` 这一个规则块的源码（选择器到首个 `}`） */
async function dimCardBlock(): Promise<string> {
  const source = await Bun.file(WISH_SCSS).text()
  const start = source.indexOf('.mw.mw--dim')
  expect(start, 'wish/index.scss 里找不到 `.mw.mw--dim`').toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, '`.mw.mw--dim` 规则块没有闭合').toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('终态愿望卡材质（#346）', () => {
  test('白玻璃垫层是 80%（Owner 拍板口径，不是 70%）', async () => {
    const block = await dimCardBlock()
    expect(block).toContain('background-color: rgba(255, 255, 255, 0.8)')
  })

  test('白玻璃垫层不是 70% —— 精确匹配，避免被 0.72 之类的值蒙混', async () => {
    const block = await dimCardBlock()
    expect(block).not.toContain('background-color: rgba(255, 255, 255, 0.7)')
  })

  test('灰罩保持 --fg 10%，未随垫层一起漂移', async () => {
    const block = await dimCardBlock()
    expect(block).toContain(
      'background-image: linear-gradient(rgba(23, 35, 61, 0.1), rgba(23, 35, 61, 0.1))',
    )
  })

  test('注释不再是过期的 --fg 16% 口径', async () => {
    const source = await Bun.file(WISH_SCSS).text()
    expect(source).not.toContain('--fg 16%')
  })
})
