import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FollowButtonView, followButtonState } from './follow-button'

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

const base = {
  read: 'notFollowing' as const,
  pending: false,
  errorMessage: null as string | null,
}

test('未关注：可点关注', () => {
  const state = followButtonState(base)
  expect(state).toEqual({ label: '关注', followed: false, enabled: true, hint: null })
})

test('已关注：永远可点（DELETE 幂等，再点即取关）', () => {
  const state = followButtonState({ ...base, read: 'following' })
  expect(state.enabled).toBe(true)
  expect(state.followed).toBe(true)
})

test('状态读到之前禁用——避免把「未知」当「未关注」假翻转', () => {
  expect(followButtonState({ ...base, read: 'loading' }).enabled).toBe(false)
})

test('404 降级「无法关注」，读取失败禁用并保留提示', () => {
  const notFound = followButtonState({ ...base, read: 'notFound' })
  expect(notFound.label).toBe('无法关注')
  expect(notFound.enabled).toBe(false)

  const unknown = followButtonState({
    ...base,
    read: 'unknown',
    errorMessage: '网络异常，请稍后重试',
  })
  expect(unknown.enabled).toBe(false)
  expect(unknown.hint).toBe('网络异常，请稍后重试')
})

test('写请求进行中禁用，label 区分关注中/取消中', () => {
  const following = followButtonState({ ...base, pending: true })
  expect(following.label).toBe('关注中…')
  expect(following.enabled).toBe(false)

  const unfollowing = followButtonState({ ...base, read: 'following', pending: true })
  expect(unfollowing.label).toBe('取消中…')
  expect(unfollowing.enabled).toBe(false)
})

test('渲染：互相关注提示只由 mutual prop 决定', () => {
  const state = followButtonState({ ...base, read: 'following' })
  const withMutual = renderToStaticMarkup(
    createElement(FollowButtonView, { mutual: true, state, onToggle: () => undefined }),
  )
  const withoutMutual = renderToStaticMarkup(
    createElement(FollowButtonView, { mutual: false, state, onToggle: () => undefined }),
  )

  expect(textOf(withMutual)).toContain('你们互相关注')
  expect(textOf(withoutMutual)).not.toContain('你们互相关注')
})

test('渲染：hint 非空时显示在按钮下方', () => {
  const state = followButtonState({ ...base, read: 'notFound' })
  const html = renderToStaticMarkup(
    createElement(FollowButtonView, { mutual: false, state, onToggle: () => undefined }),
  )

  expect(textOf(html)).toContain('无法关注')
  expect(textOf(html)).toContain('用户不存在或不可见')
})
