import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiPolishPanel } from './ai-polish-panel'

test('non-retryable AI failure disables the primary polish button', () => {
  const html = renderToStaticMarkup(
    createElement(AiPolishPanel, {
      state: {
        phase: 'failed',
        view: { message: '润色能力暂未开通', detail: null, canRetry: false },
      },
      disabledReason: null,
      coolingDown: false,
      onPolish: () => undefined,
      onSelect: () => undefined,
      onApply: () => undefined,
    }),
  )

  expect(html).toContain('disabled=""')
  expect(html).not.toContain('手动重试')
})
