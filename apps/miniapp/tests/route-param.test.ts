import { describe, expect, test } from 'bun:test'
import { routeParam } from '../src/lib/route-param'

describe('routeParam', () => {
  test('undefined 与空串都返回空串', () => {
    expect(routeParam(undefined)).toBe('')
    expect(routeParam('')).toBe('')
  })

  test('解出跳转方 encodeURIComponent 拼进去的中文标题', () => {
    // 端上联调实测：举报填写页曾把这一串原样渲染给用户
    expect(routeParam('%E7%BD%97%E6%8A%80%20K380')).toBe('罗技 K380')
    expect(routeParam(encodeURIComponent('高等数学上册（同济第七版）'))).toBe(
      '高等数学上册（同济第七版）',
    )
  })

  test('解出被编码的 URL（封面图、头像）', () => {
    const cover = 'https://example.com/a b.png?x=1&y=2'
    expect(routeParam(encodeURIComponent(cover))).toBe(cover)
  })

  test('纯 ASCII 参数原样返回', () => {
    expect(routeParam('lst_01jc000000e00800000000000h')).toBe('lst_01jc000000e00800000000000h')
    expect(routeParam('638294017526')).toBe('638294017526')
  })

  test('不是合法百分号编码时原样返回，不抛错', () => {
    expect(routeParam('%')).toBe('%')
    expect(routeParam('%E7%BD')).toBe('%E7%BD')
    expect(routeParam('100% 纯棉')).toBe('100% 纯棉')
  })
})
