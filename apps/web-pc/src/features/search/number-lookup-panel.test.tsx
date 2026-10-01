import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NumberLookupPanel, NumberQueryHint } from './number-lookup-panel'

/**
 * 编号查询面板的静态渲染（web-pc 没有 jsdom）。钉 #382 验收里渲染层才说得清的事：
 * **未命中是明确空态**（不是把编号当关键词模糊搜的兜底）、加载与限频可辨识。
 */
const VALID_NO = '348572910466'

test('未命中：明确空态带编号，说明 404 的三种可能，不给「模糊搜索」兜底', () => {
  const html = renderToStaticMarkup(
    <NumberLookupPanel onRetry={() => undefined} phase={{ kind: 'miss', listingNo: VALID_NO }} />,
  )

  expect(html).toContain(`编号 ${VALID_NO} 没有对应的商品`)
  expect(html).toContain('已下架或当前不可见')
  expect(html).not.toContain('换个关键词')
})

test('加载中与错误态可辨识，错误给重试', () => {
  const loading = renderToStaticMarkup(
    <NumberLookupPanel
      onRetry={() => undefined}
      phase={{ kind: 'loading', listingNo: VALID_NO }}
    />,
  )
  expect(loading).toContain(`正在查询编号 ${VALID_NO}`)

  const error = renderToStaticMarkup(
    <NumberLookupPanel
      onRetry={() => undefined}
      phase={{ kind: 'error', message: '查询太频繁，请 30 秒后再试' }}
    />,
  )
  expect(error).toContain('查询太频繁，请 30 秒后再试')
  expect(error).toContain('重试')
})

test('idle 与 hit 不渲染任何东西（hit 由容器负责跳详情）', () => {
  expect(
    renderToStaticMarkup(<NumberLookupPanel onRetry={() => undefined} phase={{ kind: 'idle' }} />),
  ).toBe('')
  expect(
    renderToStaticMarkup(
      <NumberLookupPanel
        onRetry={() => undefined}
        phase={{ kind: 'hit', listingId: 'lst_01jc000000e00800000000000t' }}
      />,
    ),
  ).toBe('')
})

test('「像编号但不合法」的行内提示，合法编号与普通关键词都不提示', () => {
  expect(
    renderToStaticMarkup(
      <NumberQueryHint hint="这串数字像商品编号但不合法：编号是 12 位数字且首位不为 0，已按关键词搜索。" />,
    ),
  ).toContain('已按关键词搜索')
  expect(renderToStaticMarkup(<NumberQueryHint hint={null} />)).toBe('')
})
