import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DialogErrorAlert } from './admin-dialog-parts'

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

/**
 * 四个高风险写操作弹窗（治理 / 人工审核决定 / 举报处理 / 争议处理）共用这一块（#465 审查
 * S1）：抽件前四处各写一份 `shownError = localError ?? errorMessage` + 同形条件渲染，
 * 抽件后只有这里一份。用例钉住两种色（本地校验 warn / 服务端 danger）与「无错误不渲染」，
 * 免得日后有人把 tone 写死成 danger 而本地校验不再可辨。
 */
describe('DialogErrorAlert（四弹窗共用错误态，#465 审查 S1）', () => {
  test('本地校验失败：warn 底色，本地文案优先于服务端文案', () => {
    const html = renderToStaticMarkup(
      createElement(DialogErrorAlert, {
        errorMessage: '服务端说：该争议已被其他管理员处理',
        localError: '请填写原因（必填）',
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('bg-warn-soft text-warn')
    const text = textOf(html)
    expect(text).toContain('请填写原因（必填）')
    expect(text).not.toContain('服务端说')
  })

  test('服务端失败：danger 底色，显示服务端文案', () => {
    const html = renderToStaticMarkup(
      createElement(DialogErrorAlert, {
        errorMessage: '该争议已被其他管理员处理',
        localError: null,
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('bg-danger-soft text-danger')
    expect(textOf(html)).toContain('该争议已被其他管理员处理')
  })

  test('没有错误时整块不渲染（调用处不必再写条件）', () => {
    expect(
      renderToStaticMarkup(
        createElement(DialogErrorAlert, { errorMessage: null, localError: null }),
      ),
    ).toBe('')
  })
})
