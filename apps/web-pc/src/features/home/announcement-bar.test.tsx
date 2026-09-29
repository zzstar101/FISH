import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnouncementBar } from './announcement-bar'

/**
 * 滚动、暂停与「减少动效」只存在于 `styles.css`：只断言组件 class 名的话，
 * 把动画规则删掉测试也不会红。这里直接读真实样式表，断言生成出来的 CSS。
 */
const styles = await Bun.file(new URL('../../styles.css', import.meta.url)).text()

function rule(selector: string, source = styles): string {
  // 选择器可能只是选择器列表里的一项（如 `.a:hover .b,\n.a:focus-within .b {`），
  // 所以到 `{` 之间允许出现逗号与换行，但不允许穿过别的规则块。
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}]*\\{[^}]*\\}`)
  return source.match(pattern)?.[0] ?? ''
}

/** 样式表里有多个 `prefers-reduced-motion` 块（登录页旋转动画也有），取提到轨道动画的那个。 */
function reducedMotionBlock(): string {
  const blocks = styles.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) ?? []
  return blocks.find((block) => block.includes('.announcement-track')) ?? ''
}

test('公告栏渲染文案与无障碍副本，且没有暂停控件', () => {
  const html = renderToStaticMarkup(<AnnouncementBar />)

  expect(html).toContain('发布闲置只要 30 秒')
  // 滚动轨道由两组相同副本组成；除第一组第一遍外都必须对屏幕阅读器隐藏。
  expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThan(0)
  expect(html.match(/发布闲置只要 30 秒/g)?.length).toBe(6)
  // 按 Owner 要求移除暂停键：栏内不再有任何按钮。
  expect(html).not.toContain('<button')
  // 键盘可达的停止方式：区域本身可聚焦，:focus-within 才可能被触发。
  expect(html).toContain('tabindex="0"')
})

test('公告栏高度受 20dvh 上限约束', () => {
  const html = renderToStaticMarkup(<AnnouncementBar />)

  expect(html).toContain('min(72px,20dvh)')
})

test('样式表里真的有轨道动画，且位移 50% 对应一组副本的宽度', () => {
  const track = rule('.announcement-track')
  expect(track).toContain('animation: announcement-marquee 36s linear infinite')
  expect(track).toContain('width: max-content')

  // 两组等宽副本：位移 -50% 正好是一组宽度，回到起点时视觉连续（无缝）。
  const keyframes = styles.match(/@keyframes announcement-marquee\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(keyframes).toContain('translateX(0)')
  expect(keyframes).toContain('translateX(-50%)')

  // 副本不能被压缩，否则两组宽度不等、位移 50% 会露出空档。
  expect(rule('.announcement-group')).toContain('flex-shrink: 0')
})

test('悬停与键盘聚焦都能暂停自动滚动（WCAG 2.2.2 的暂停手段）', () => {
  expect(rule('.announcement-bar:hover .announcement-track')).toContain(
    'animation-play-state: paused',
  )
  expect(rule('.announcement-bar:focus-within .announcement-track')).toContain(
    'animation-play-state: paused',
  )
})

test('prefers-reduced-motion 下关闭自动滚动，但内容仍可手动横向查看', () => {
  const reduced = reducedMotionBlock()
  expect(reduced).not.toBe('')

  expect(rule('.announcement-track', reduced)).toContain('animation: none')
  expect(rule('.announcement-viewport', reduced)).toContain('overflow-x: auto')
})
