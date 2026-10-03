import { describe, expect, test } from 'bun:test'
import { SHEET_BODY, sheetVariant } from '../src/pkg-legal/pages/feedback/sheet'

/**
 * 反馈结果弹层的档位与正文。
 *
 * 这一层是页面对用户的**承诺**：后端接口不存在 + 客服邮箱待定，所以「已暂存在本机」
 * 「复制后通过客服邮箱发给我们」这两句只在对应条件成立时才能说。
 * 钉住它是因为把某个分支删掉时，typecheck / lint / 其它测试都不会红。
 */

describe('sheetVariant —— 什么时候说哪一档', () => {
  test('暂存失败优先：落盘都没成功时，任何一档都不能说「已暂存在本机」', () => {
    expect(sheetVariant(false, true)).toBe('stored-failed')
    expect(sheetVariant(false, false)).toBe('stored-failed')
  })

  test('暂存成功时按客服邮箱定没定分档', () => {
    expect(sheetVariant(true, true)).toBe('with-mail')
    expect(sheetVariant(true, false)).toBe('no-mail')
    expect(sheetVariant(null, true)).toBe('with-mail')
    expect(sheetVariant(null, false)).toBe('no-mail')
  })
})

describe('SHEET_BODY —— 三档正文与档位一一对应', () => {
  test('三个档位都有正文，且不是空数组', () => {
    const variants = ['stored-failed', 'with-mail', 'no-mail'] as const
    expect(Object.keys(SHEET_BODY).sort()).toEqual([...variants].sort())
    for (const variant of variants) expect(SHEET_BODY[variant].length).toBeGreaterThan(0)
  })

  test('「已暂存在本机」这句只在暂存没失败的两档出现', () => {
    expect(SHEET_BODY['with-mail'].some((r) => r.t.includes('已暂存在本机'))).toBe(true)
    expect(SHEET_BODY['no-mail'].some((r) => r.t.includes('已暂存在本机'))).toBe(true)
    expect(SHEET_BODY['stored-failed'].some((r) => r.t.includes('已暂存在本机'))).toBe(false)
  })

  test('邮箱未定的那一档不指引用户去复制邮箱（那个按钮这一档不渲染）', () => {
    const text = SHEET_BODY['no-mail'].map((r) => r.t).join('')
    expect(text).toContain('客服邮箱待定')
    expect(text).not.toContain('复制后通过')
  })
})
