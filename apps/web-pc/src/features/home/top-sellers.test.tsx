import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopSellers } from './top-sellers'

test('优质商家区块渲染四张卡片', () => {
  const html = renderToStaticMarkup(<TopSellers />)

  expect(html).toContain('优质商家')
  expect(html.match(/<article/g)?.length).toBe(4)
  expect(html.match(/校内面交/g)?.length).toBe(4)
})
