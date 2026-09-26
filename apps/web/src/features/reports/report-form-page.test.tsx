import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { ReportFormPage, reportFormScopeKey } from './report-form-page'

test('相同目标切换身份会重挂载表单，旧账号的 mutation 结果不会留给新账号', () => {
  const target = 'lst_01jc000000e00800000000000k'
  const scopeA = reportFormScopeKey('LISTING', target, 'usr_01jc000000e00800000000000a')
  const scopeB = reportFormScopeKey('LISTING', target, 'usr_01jc000000e00800000000000b')
  expect(scopeA).not.toBe(scopeB)
  expect(scopeA).toBe(reportFormScopeKey('LISTING', target, 'usr_01jc000000e00800000000000a'))
})

test('公开深链的错误目标或前缀不会展示举报提交表单', () => {
  const html = renderToString(
    createElement(ReportFormPage, {
      targetType: 'LISTING',
      targetId: 'usr_01jc000000e00800000000000a',
    }),
  )
  expect(html).toContain('举报目标不可用')
  expect(html).not.toContain('提交举报')
})
