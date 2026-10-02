import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FavoriteButtonView, favoriteButtonState } from './favorite-button'

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

const base = {
  read: 'notFavorited' as const,
  status: 'ACTIVE' as const,
  pending: false,
  errorMessage: null as string | null,
}

test('在售且未收藏：可点收藏', () => {
  const state = favoriteButtonState(base)
  expect(state).toEqual({ label: '收藏', filled: false, enabled: true, hint: null })
})

test('已收藏：永远可点（DELETE 无条件幂等，失效条目也能取消）', () => {
  expect(favoriteButtonState({ ...base, read: 'favorited', status: 'SOLD' }).enabled).toBe(true)
  expect(favoriteButtonState({ ...base, read: 'favorited', status: 'OFFLINE' }).filled).toBe(true)
})

test('失效商品未收藏：不可点（POST 只对在售可用）', () => {
  for (const status of ['RESERVED', 'SOLD', 'OFFLINE'] as const) {
    const state = favoriteButtonState({ ...base, status })
    expect(state.enabled).toBe(false)
    expect(state.hint).not.toBeNull()
  }
})

test('状态读到之前禁用——避免把「未知」当「未收藏」假翻转', () => {
  expect(favoriteButtonState({ ...base, read: 'loading' }).enabled).toBe(false)
})

test('404 降级「不可收藏」，读取失败禁用并保留提示', () => {
  const notFound = favoriteButtonState({ ...base, read: 'notFound' })
  expect(notFound.label).toBe('不可收藏')
  expect(notFound.enabled).toBe(false)

  const unknown = favoriteButtonState({
    ...base,
    read: 'unknown',
    errorMessage: '网络异常，请稍后重试',
  })
  expect(unknown.enabled).toBe(false)
  expect(unknown.hint).toBe('网络异常，请稍后重试')
})

test('写请求进行中禁用，label 区分收藏中/取消中', () => {
  const favoriting = favoriteButtonState({ ...base, pending: true })
  expect(favoriting.label).toBe('收藏中…')
  expect(favoriting.enabled).toBe(false)

  const unfavoriting = favoriteButtonState({ ...base, read: 'favorited', pending: true })
  expect(unfavoriting.label).toBe('取消中…')
})

test('渲染：已收藏是实心心形 + 已收藏文案，未收藏是空心', () => {
  const favorited = renderToStaticMarkup(
    createElement(FavoriteButtonView, {
      state: favoriteButtonState({ ...base, read: 'favorited' }),
      onToggle: () => {},
    }),
  )
  expect(textOf(favorited)).toContain('已收藏')
  expect(favorited).toContain('fill-current')

  const plain = renderToStaticMarkup(
    createElement(FavoriteButtonView, {
      state: favoriteButtonState(base),
      onToggle: () => {},
    }),
  )
  expect(textOf(plain)).toContain('收藏')
  expect(plain).not.toContain('fill-current')
})

test('渲染：hint 以小字跟随按钮', () => {
  const html = renderToStaticMarkup(
    createElement(FavoriteButtonView, {
      state: favoriteButtonState({ ...base, read: 'notFound' }),
      onToggle: () => {},
    }),
  )
  expect(textOf(html)).toContain('商品当前不可收藏')
})
