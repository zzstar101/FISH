import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockButtonView, blockButtonState } from './block-button'

const base = {
  read: 'notBlocked' as const,
  pending: false,
  errorMessage: null as string | null,
}

describe('blockButtonState', () => {
  test('未拉黑：可点「拉黑」', () => {
    expect(blockButtonState(base)).toEqual({
      label: '拉黑',
      blocked: false,
      enabled: true,
      hint: null,
    })
  })

  test('已拉黑：可点「解除拉黑」（DELETE 幂等）', () => {
    const state = blockButtonState({ ...base, read: 'blocked' })
    expect(state.blocked).toBe(true)
    expect(state.enabled).toBe(true)
    expect(state.label).toBe('解除拉黑')
  })

  test('状态读到之前禁用——避免把「未知」当「未拉黑」假翻转', () => {
    expect(blockButtonState({ ...base, read: 'loading' }).enabled).toBe(false)
  })

  test('404 降级「无法拉黑」，读取失败禁用并保留提示', () => {
    const notFound = blockButtonState({ ...base, read: 'notFound' })
    expect(notFound.label).toBe('无法拉黑')
    expect(notFound.enabled).toBe(false)

    const unknown = blockButtonState({
      ...base,
      read: 'unknown',
      errorMessage: '网络异常，请稍后重试',
    })
    expect(unknown.enabled).toBe(false)
    expect(unknown.hint).toBe('网络异常，请稍后重试')
  })

  test('pending 时禁用且文案随当前状态（拉黑中 / 解除中）', () => {
    expect(blockButtonState({ ...base, pending: true }).label).toBe('拉黑中…')
    expect(blockButtonState({ ...base, read: 'blocked', pending: true }).label).toBe('解除中…')
    expect(blockButtonState({ ...base, pending: true }).enabled).toBe(false)
  })
})

describe('BlockButtonView', () => {
  const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

  test('未拉黑渲染「拉黑」，已拉黑渲染「解除拉黑」', () => {
    const notBlocked = renderToStaticMarkup(
      createElement(BlockButtonView, {
        onBlock: () => {},
        onUnblock: () => {},
        state: blockButtonState(base),
      }),
    )
    expect(textOf(notBlocked)).toContain('拉黑')
    expect(textOf(notBlocked)).not.toContain('解除拉黑')

    const blocked = renderToStaticMarkup(
      createElement(BlockButtonView, {
        onBlock: () => {},
        onUnblock: () => {},
        state: blockButtonState({ ...base, read: 'blocked' }),
      }),
    )
    expect(textOf(blocked)).toContain('解除拉黑')
  })
})
