import { describe, expect, test } from 'bun:test'
import { signatureFirstLine } from '../src/features/profile/signature-text'

/**
 * 签名展示口径：**只取首行**（Owner 明确的验收点）。多行输入（粘贴带换行）时
 * 其余行不展示，首行过长由 CSS 省略号收尾 —— 这里只锁「取首行」这一步。
 */
describe('signatureFirstLine', () => {
  test('单行原样返回', () => {
    expect(signatureFirstLine('诚信面交，先验货后付款')).toBe('诚信面交，先验货后付款')
  })

  test('多行只取首行', () => {
    expect(signatureFirstLine('第一行\n第二行\n第三行')).toBe('第一行')
  })

  test('CRLF 换行的首行不带 \\r', () => {
    expect(signatureFirstLine('第一行\r\n第二行')).toBe('第一行')
  })

  test('首行全是空白 / 整体为空 → 空串（调用方按未设置渲染占位）', () => {
    expect(signatureFirstLine('   \n第二行')).toBe('')
    expect(signatureFirstLine('')).toBe('')
    expect(signatureFirstLine('\n')).toBe('')
  })
})
