import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MyListingPrice } from './mylist-page'

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

test('0 元商品显示免费送，而不是 ¥0.00', () => {
  const html = renderToStaticMarkup(createElement(MyListingPrice, { cents: 0 }))

  expect(html).toContain('免费送')
  expect(html).not.toContain('¥0.00')
})

test('付费商品保持价格展示', () => {
  const html = renderToStaticMarkup(createElement(MyListingPrice, { cents: 16000 }))

  expect(textOf(html)).toContain('¥160')
})
