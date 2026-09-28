import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnouncementBar } from './announcement-bar'

test('公告栏渲染文案、暂停控件与无障碍副本', () => {
  const html = renderToStaticMarkup(<AnnouncementBar />)

  expect(html).toContain('发布闲置只要 30 秒')
  expect(html).toContain('aria-label="暂停公告滚动"')
  expect(html).toContain('aria-pressed="false"')

  // 滚动轨道由两组相同副本组成；除第一组第一遍外都必须对屏幕阅读器隐藏。
  expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThan(0)
  expect(html.match(/发布闲置只要 30 秒/g)?.length).toBe(6)
})

test('公告栏高度受 20dvh 上限约束', () => {
  const html = renderToStaticMarkup(<AnnouncementBar />)

  expect(html).toContain('min(72px,20dvh)')
})
