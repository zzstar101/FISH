import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListingNoLine } from './listing-no-line'

/**
 * 详情页公开编号行（#382）。组件只收 `listingNo` 字符串：内部 UUID 传不进来，
 * 「不显示内部 UUID」由类型边界保证，这里钉渲染与复制入口。
 */
test('渲染编号与复制按钮，编号按字符串原样出现', () => {
  const html = renderToStaticMarkup(<ListingNoLine listingNo="348572910466" />)

  expect(html).toContain('编号')
  expect(html).toContain('348572910466')
  expect(html).toContain('复制')
  // 复制是无障碍可命中的真实按钮。
  expect(html).toContain('aria-label="复制商品编号 348572910466"')
})

test('不是内部 ID 的展示位：组件根本没有 uuid 入参', () => {
  // lst_ 前缀的 canonical ID 与 uuid 都不可能出现在这行——props 类型里没有它们。
  // （class 名里带连字符，所以 uuid 用 8-4-4-4-16 进制段形状断言，不能简单找 `-`。）
  const html = renderToStaticMarkup(<ListingNoLine listingNo="100000000000" />)
  expect(html).not.toContain('lst_')
  expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
})
